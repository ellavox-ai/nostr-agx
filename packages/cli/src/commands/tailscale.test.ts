import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TailscaleStartOptions } from "@nostr-agx/tailscale";
import { getProfile, updateProfile } from "../lib/config.js";
import { configPath, tailscaleSecretsPath } from "../lib/paths.js";
import { setRuntimeForTests } from "../lib/runtime.js";
import { setStdinForTests } from "../lib/stdin.js";
import { saveTailscaleSecret } from "../lib/tailscale/credentials.js";
import { setTailscaleStarterForTests } from "../lib/tailscale/index.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const CLIENT_SECRET = "oauth-client-secret-value";
const PROXY_URL = "socks5h://agx:secret@127.0.0.1:49152";
const REDACTED_PROXY_URL = "socks5h://redacted@127.0.0.1:49152";

interface StartedCall {
	options: TailscaleStartOptions;
	stopped: boolean;
}

let box: ReturnType<typeof sandbox>;
let calls: StartedCall[];
let restoreStarter: (() => void) | null = null;

/** Install a fake bundled launcher; the CLI must never shell out to `tailscale`. */
function fakeStarter(): void {
	calls = [];
	restoreStarter = setTailscaleStarterForTests(async (options) => {
		const call: StartedCall = { options, stopped: false };
		calls.push(call);
		return {
			url: PROXY_URL,
			stop: async () => {
				call.stopped = true;
			},
		};
	});
}

beforeEach(() => {
	box = sandbox();
	calls = [];
	delete process.env.TS_AUTHKEY;
});
afterEach(() => {
	restoreStarter?.();
	restoreStarter = null;
	box.restore();
});

async function withStdin<T>(input: string | null, fn: () => Promise<T>): Promise<T> {
	const restore = setStdinForTests(input);
	try {
		return await fn();
	} finally {
		restore();
	}
}

/** The SDK resolves providers before handing options to the launcher. */
function resolvedKey(call: StartedCall): string | undefined {
	return call.options.authKey;
}

describe("agx tailscale enable", () => {
	it("--no-up stores the opt-in and the key privately, without starting a proxy", async () => {
		fakeStarter();
		const run = await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--no-up"),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(0);

		const profile = getProfile("default");
		expect(profile.tailscale).toMatchObject({
			enabled: true,
			authMode: "key",
			stateDir: null,
			ephemeral: true,
		});

		const secretPath = tailscaleSecretsPath("default");
		expect(statSync(secretPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(secretPath, "utf8")).toContain(KEY);
		expect(readFileSync(configPath(), "utf8")).not.toContain(KEY);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});

	it("starts and stops the SDK proxy with the configured hostname and key", async () => {
		fakeStarter();
		const run = await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--json"),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].options.hostname).toBe("agx-default");
		expect(calls[0].options.ephemeral).toBe(true);
		expect(resolvedKey(calls[0])).toBe(KEY);
		expect(calls[0].stopped).toBe(true);
		expect(`${run.stdout}${run.stderr}`).toContain(REDACTED_PROXY_URL);
		expect(`${run.stdout}${run.stderr}`).not.toContain(PROXY_URL);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
		expect(jsonDocuments(run.stdout).at(-1)).toMatchObject({
			profile: "default",
			enabled: true,
			authMode: "key",
			hostname: "agx-default",
			relayProxy: REDACTED_PROXY_URL,
		});
	});

	it("stores an OAuth client id in config and the secret privately", async () => {
		fakeStarter();
		const run = await withStdin(CLIENT_SECRET, () =>
			agx(
				"tailscale",
				"enable",
				"--oauth-url",
				"https://auth.example.test/token",
				"--oauth-client-id",
				"client-id",
				"--oauth-client-secret-stdin",
				"--oauth-scope",
				"auth_keys",
				"--no-up",
			),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(0);
		const profile = getProfile("default");
		expect(profile.tailscale.authMode).toBe("oauth");
		expect(profile.tailscale.oauth).toMatchObject({
			tokenUrl: "https://auth.example.test/token",
			clientId: "client-id",
			scope: "auth_keys",
		});
		const secretPath = tailscaleSecretsPath("default");
		expect(readFileSync(secretPath, "utf8")).toContain(CLIENT_SECRET);
		expect(readFileSync(configPath(), "utf8")).not.toContain(CLIENT_SECRET);
		expect(`${run.stdout}${run.stderr}`).not.toContain(CLIENT_SECRET);
	});

	it("refuses both auth routes at once (exit 2)", async () => {
		const run = await withStdin(`${KEY}\n${CLIENT_SECRET}`, () =>
			agx(
				"tailscale",
				"enable",
				"--auth-key-stdin",
				"--oauth-url",
				"https://auth.example.test/token",
				"--oauth-client-id",
				"client-id",
				"--oauth-client-secret-stdin",
			),
		);
		expect(run.code).toBe(2);
		expect(getProfile("default").tailscale.enabled).toBe(false);
	});

	it("refuses to join when no route was given on a terminal (exit 2)", async () => {
		const run = await withStdin(null, () => agx("tailscale", "enable"));
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/No Tailscale auth route was given/);
		expect(getProfile("default").tailscale.enabled).toBe(false);
	});
});

describe("agx tailscale status", () => {
	it("reports readiness without printing the stored key", async () => {
		fakeStarter();
		await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--no-up"),
		);
		const run = await agx("tailscale", "status", "--json");
		expect(run.code, run.stderr).toBe(0);
		const payload = jsonDocuments(run.stdout).at(-1) as {
			enabled: boolean;
			authReady: boolean;
			storedAuthKey: boolean;
			hostname: string;
			stateDir: string | null;
		};
		expect(payload).toMatchObject({
			enabled: true,
			authReady: true,
			storedAuthKey: true,
			hostname: "agx-default",
			stateDir: null,
		});
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
		expect(calls).toHaveLength(0);
	});

	it("reports not ready before enabling", async () => {
		const run = await agx("tailscale", "status", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(jsonDocuments(run.stdout).at(-1)).toMatchObject({
			enabled: false,
			authReady: false,
		});
	});
});

describe("agx tailscale up / disable", () => {
	it("up uses a one-off key without storing it and stops the proxy", async () => {
		fakeStarter();
		await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--no-up"),
		);
		calls = [];
		const OTHER = "tskey-auth-k0000000000CNTRL-zyxwvutsrqponmlk";
		const run = await withStdin(OTHER, () =>
			agx("tailscale", "up", "--auth-key-stdin", "--hostname", "agx-other", "--json"),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].options.hostname).toBe("agx-other");
		expect(resolvedKey(calls[0])).toBe(OTHER);
		expect(calls[0].stopped).toBe(true);
		expect(`${run.stdout}${run.stderr}`).not.toContain(OTHER);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).toContain(KEY);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).not.toContain(OTHER);
	});

	it("disable turns the opt-in off and forgets secrets without a node command", async () => {
		fakeStarter();
		await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--no-up"),
		);
		calls = [];
		const run = await agx("tailscale", "disable", "--forget", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(getProfile("default").tailscale.enabled).toBe(false);
		expect(existsSync(tailscaleSecretsPath("default"))).toBe(false);
		expect(calls).toHaveLength(0);
		expect(jsonDocuments(run.stdout).at(-1)).toMatchObject({
			profile: "default",
			enabled: false,
			forgot: true,
		});
	});
});

describe("agx tailscale enable checks the node before it saves anything", () => {
	// Made fresh for every run.
	const OTHER = `tskey-auth-k0000000000CNTRL-${Math.random().toString(16).slice(2, 18)}`;
	const MINTED = `tskey-auth-k7777777777CNTRL-${Math.random().toString(16).slice(2, 18)}`;
	let restoreFetch: (() => void) | null = null;
	afterEach(() => {
		restoreFetch?.();
		restoreFetch = null;
	});

	function rejectingStarter(): void {
		calls = [];
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			calls.push({ options, stopped: false });
			throw new Error("fake launcher: the control server refused the key");
		});
	}

	it("saves neither the opt-in nor the key when the node cannot start", async () => {
		rejectingStarter();
		const run = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin"));
		expect(run.code).not.toBe(0);
		expect(calls).toHaveLength(1);
		expect(getProfile("default").tailscale.enabled).toBe(false);
		expect(existsSync(tailscaleSecretsPath("default"))).toBe(false);
		expect(existsSync(configPath())).toBe(false);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});

	it("saves neither the opt-in nor the client secret when the OAuth service refuses", async () => {
		fakeStarter();
		restoreFetch = setRuntimeForTests({
			fetch: async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
		});
		const run = await withStdin(CLIENT_SECRET, () =>
			agx(
				"tailscale",
				"enable",
				"--oauth-url",
				"https://auth.example.test/token",
				"--oauth-client-id",
				"client-id",
				"--oauth-client-secret-stdin",
			),
		);
		expect(run.code).not.toBe(0);
		expect(calls).toHaveLength(0);
		const profile = getProfile("default");
		expect(profile.tailscale.enabled).toBe(false);
		expect(profile.tailscale.oauth.clientId).toBeNull();
		expect(existsSync(tailscaleSecretsPath("default"))).toBe(false);
		expect(`${run.stdout}${run.stderr}`).not.toContain(CLIENT_SECRET);
	});

	it("keeps an earlier opt-in and key as they were when a new key is refused", async () => {
		fakeStarter();
		const first = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin"));
		expect(first.code, first.stderr).toBe(0);
		const before = readFileSync(tailscaleSecretsPath("default"), "utf8");

		calls = [];
		restoreStarter?.();
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			calls.push({ options, stopped: false });
			throw new Error("fake launcher: the control server refused the key");
		});
		const second = await withStdin(OTHER, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--hostname", "agx-changed"),
		);
		expect(second.code).not.toBe(0);
		expect(calls).toHaveLength(1);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).toBe(before);
		expect(statSync(tailscaleSecretsPath("default")).mode & 0o777).toBe(0o600);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: true, hostname: null });
	});

	it("leaves the profile as it was when the key file cannot be written after a good check", async () => {
		calls = [];
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			const call: StartedCall = { options, stopped: false };
			calls.push(call);
			// While the node starts, a folder takes the place of the key file: the
			// check passes and the write that follows it fails.
			mkdirSync(tailscaleSecretsPath("default"), { recursive: true });
			return { url: PROXY_URL, stop: async () => void (call.stopped = true) };
		});
		const run = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin"));
		expect(run.code).not.toBe(0);
		expect(calls, "the node was not checked first").toHaveLength(1);
		expect(calls[0].stopped).toBe(true);
		expect(getProfile("default").tailscale.enabled, "opted in without a key").toBe(false);
		expect(existsSync(configPath())).toBe(false);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});

	it("leaves the profile as it was when the OAuth client secret cannot be written after a good check", async () => {
		calls = [];
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			const call: StartedCall = { options, stopped: false };
			calls.push(call);
			// While the node starts, a folder takes the place of the secret file: the
			// check passes and the write that follows it fails.
			mkdirSync(tailscaleSecretsPath("default"), { recursive: true });
			return { url: PROXY_URL, stop: async () => void (call.stopped = true) };
		});
		restoreFetch = setRuntimeForTests({
			fetch: async () => new Response(JSON.stringify({ authKey: MINTED }), { status: 200 }),
		});
		const run = await withStdin(CLIENT_SECRET, () =>
			agx(
				"tailscale",
				"enable",
				"--oauth-url",
				"https://auth.example.test/token",
				"--oauth-client-id",
				"client-id",
				"--oauth-client-secret-stdin",
			),
		);
		expect(run.code).not.toBe(0);
		expect(calls, "the node was not checked first").toHaveLength(1);
		expect(resolvedKey(calls[0])).toBe(MINTED);
		expect(calls[0].stopped).toBe(true);
		const profile = getProfile("default");
		expect(profile.tailscale.enabled, "opted in without a client secret").toBe(false);
		expect(profile.tailscale.authMode).toBe("key");
		expect(profile.tailscale.oauth.clientId).toBeNull();
		expect(existsSync(configPath())).toBe(false);
		expect(`${run.stdout}${run.stderr}`).not.toContain(CLIENT_SECRET);
	});

	it("checks the key it is about to store, even when another key is in the environment", async () => {
		fakeStarter();
		process.env.AGX_TAILSCALE_AUTH_KEY = OTHER;
		const run = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin"));
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(1);
		expect(resolvedKey(calls[0])).toBe(KEY);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).toContain(KEY);
	});

	it("saves the opt-in and the key, privately, once the node has started", async () => {
		fakeStarter();
		const run = await withStdin(KEY, () =>
			agx("tailscale", "enable", "--auth-key-stdin", "--hostname", "agx-saved"),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].stopped).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: true, authMode: "key", hostname: "agx-saved" });
		expect(statSync(tailscaleSecretsPath("default")).mode & 0o777).toBe(0o600);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).toContain(KEY);
	});

	it("checks an OAuth client secret before storing it, then stores it privately", async () => {
		fakeStarter();
		const bodies: string[] = [];
		restoreFetch = setRuntimeForTests({
			fetch: async (_url, init) => {
				bodies.push(String(init?.body ?? ""));
				return new Response(JSON.stringify({ authKey: MINTED }), { status: 200 });
			},
		});
		const run = await withStdin(CLIENT_SECRET, () =>
			agx(
				"tailscale",
				"enable",
				"--oauth-url",
				"https://auth.example.test/token",
				"--oauth-client-id",
				"client-id",
				"--oauth-client-secret-stdin",
			),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(bodies).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(resolvedKey(calls[0])).toBe(MINTED);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: true, authMode: "oauth" });
		expect(statSync(tailscaleSecretsPath("default")).mode & 0o777).toBe(0o600);
		expect(readFileSync(tailscaleSecretsPath("default"), "utf8")).toContain(CLIENT_SECRET);
		expect(`${run.stdout}${run.stderr}`).not.toContain(CLIENT_SECRET);
		expect(`${run.stdout}${run.stderr}`).not.toContain(MINTED);
	});

	it("checks the client secret that was piped, not the one in the environment, and stores that one", async () => {
		fakeStarter();
		const fromEnvironment = `env-secret-${Math.random().toString(16).slice(2, 12)}`;
		process.env.AGX_TAILSCALE_OAUTH_CLIENT_SECRET = fromEnvironment;
		const bodies: string[] = [];
		restoreFetch = setRuntimeForTests({
			fetch: async (_url, init) => {
				bodies.push(String(init?.body ?? ""));
				return new Response(JSON.stringify({ authKey: MINTED }), { status: 200 });
			},
		});
		try {
			const run = await withStdin(CLIENT_SECRET, () =>
				agx(
					"tailscale",
					"enable",
					"--oauth-url",
					"https://auth.example.test/token",
					"--oauth-client-id",
					"client-id",
					"--oauth-token-auth",
					"post",
					"--oauth-client-secret-stdin",
				),
			);
			expect(run.code, run.stderr).toBe(0);
			expect(bodies).toHaveLength(1);
			expect(bodies[0], "the check did not use the secret about to be stored").toContain(CLIENT_SECRET);
			expect(bodies[0]).not.toContain(fromEnvironment);
			const stored = readFileSync(tailscaleSecretsPath("default"), "utf8");
			expect(stored).toContain(CLIENT_SECRET);
			expect(stored).not.toContain(fromEnvironment);
		} finally {
			delete process.env.AGX_TAILSCALE_OAUTH_CLIENT_SECRET;
		}
	});

	it("still uses the hostname from the environment while checking the node", async () => {
		fakeStarter();
		process.env.AGX_TAILSCALE_HOSTNAME = "agx-from-env";
		const run = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin"));
		expect(run.code, run.stderr).toBe(0);
		expect(calls[0].options.hostname).toBe("agx-from-env");
		expect(getProfile("default").tailscale.hostname).toBeNull();
	});
});

describe("an OAuth service that repeats the client secret in its error", () => {
	const RESERVED_PORTS = new Set([7447, 53505]);
	const hex = (length: number): string => Math.random().toString(16).slice(2).padEnd(length, "0").slice(0, length);
	let servers: Server[] = [];
	afterEach(async () => {
		for (const server of servers) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		servers = [];
	});

	/** A token endpoint on a free local port that refuses every request and repeats the client secret it was sent. */
	async function repeatingService(): Promise<{ url: string; received: string[] }> {
		for (;;) {
			const received: string[] = [];
			const server = createServer((request, response) => {
				let body = "";
				request.on("data", (chunk) => (body += chunk));
				request.on("end", () => {
					const sent = new URLSearchParams(body).get("client_secret") ?? "";
					received.push(sent);
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: "invalid_client", error_description: `bad secret ${sent}` }));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			if (!RESERVED_PORTS.has(port)) {
				servers.push(server);
				return { url: `http://127.0.0.1:${port}/oauth/token`, received };
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	/** A profile that has opted in to OAuth against `tokenUrl`, with no secret stored. */
	function oauthProfile(tokenUrl: string): void {
		const stored = getProfile("default").tailscale;
		updateProfile("default", {
			tailscale: {
				...stored,
				enabled: true,
				authMode: "oauth",
				oauth: { ...stored.oauth, tokenUrl, tokenAuth: "post", clientId: "client-id" },
			},
		});
	}

	function expectRefusedWithoutTheSecret(run: { code: number; stdout: string; stderr: string }, secret: string, received: string[]): void {
		expect(received, "the service did not get the secret, so the test proves nothing").toEqual([secret]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toMatch(/HTTP 400/);
		expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
	}

	it("is not shown the secret that is piped to `enable`", async () => {
		fakeStarter();
		const secret = `piped-${hex(16)}`;
		const service = await repeatingService();
		const run = await withStdin(secret, () =>
			agx(
				"tailscale",
				"enable",
				"--oauth-url",
				service.url,
				"--oauth-client-id",
				"client-id",
				"--oauth-token-auth",
				"post",
				"--oauth-client-secret-stdin",
			),
		);
		expectRefusedWithoutTheSecret(run, secret, service.received);
		expect(existsSync(tailscaleSecretsPath("default"))).toBe(false);
	});

	it("is not shown the secret that the environment names", async () => {
		fakeStarter();
		const secret = `env-${hex(16)}`;
		const service = await repeatingService();
		oauthProfile(service.url);
		process.env.AGX_TAILSCALE_OAUTH_CLIENT_SECRET = secret;
		try {
			const run = await agx("tailscale", "up");
			expectRefusedWithoutTheSecret(run, secret, service.received);
		} finally {
			delete process.env.AGX_TAILSCALE_OAUTH_CLIENT_SECRET;
		}
	});

	it("is not shown the secret that is stored for the profile", async () => {
		fakeStarter();
		const secret = `stored-${hex(16)}`;
		const service = await repeatingService();
		oauthProfile(service.url);
		saveTailscaleSecret("default", { oauthClientSecret: secret });
		const run = await agx("tailscale", "up");
		expectRefusedWithoutTheSecret(run, secret, service.received);
	});
});
