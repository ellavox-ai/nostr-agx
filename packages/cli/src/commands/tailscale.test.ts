import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TailscaleStartOptions } from "@nostr-agx/tailscale";
import { getProfile } from "../lib/config.js";
import { createIdentity } from "../lib/identity.js";
import { configPath, tailscaleSecretsPath } from "../lib/paths.js";
import { setStdinForTests } from "../lib/stdin.js";
import { setTailscaleStarterForTests } from "../lib/tailscale/index.js";
import { type HeldConfigLock, holdConfigLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../test/config-lock-helpers.js";
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

describe("agx tailscale while another agx command is writing config.json", () => {
	// Each test starts another process that holds the config lock, waits until the command under
	// test is queued behind it, changes config.json and lets go. A command that read the profile
	// before it asked for the lock then writes back a copy that is out of date.
	let held: HeldConfigLock | undefined;

	afterEach(() => {
		held?.child.kill("SIGKILL");
		held = undefined;
	});

	async function enabledProfile(): Promise<void> {
		fakeStarter();
		const run = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin", "--no-up"));
		expect(run.code, run.stderr).toBe(0);
		calls = [];
	}

	it("disable keeps a hostname another command stored while it waited for the lock", async () => {
		await enabledProfile();
		held = await holdConfigLockUntilSomeoneWaits('c.profiles.default.tailscale.hostname = "agx-from-another";');

		const run = await agx("tailscale", "disable");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: false, hostname: "agx-from-another" });
	}, PATIENT_TEST_MS);

	it("up does not switch Tailscale back on when a disable finished while it waited for the lock", async () => {
		await enabledProfile();
		held = await holdConfigLockUntilSomeoneWaits("c.profiles.default.tailscale.enabled = false;");

		const run = await agx("tailscale", "up", "--hostname", "agx-new");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: false, hostname: "agx-new" });
	}, PATIENT_TEST_MS);

	it("enable keeps a state directory another command stored while it waited for the lock", async () => {
		await enabledProfile();
		held = await holdConfigLockUntilSomeoneWaits('c.profiles.default.tailscale.stateDir = "/state/from-another";');

		const run = await agx("tailscale", "enable", "--no-up", "--hostname", "agx-next");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({
			enabled: true,
			hostname: "agx-next",
			stateDir: "/state/from-another",
		});
	}, PATIENT_TEST_MS);

	it("disable also keeps an allowlist entry another command added while it waited", async () => {
		await enabledProfile();
		const peer = createIdentity().publicKey;
		held = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow.push(${JSON.stringify(peer)});`);

		const run = await agx("tailscale", "disable");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").allow).toEqual([peer]);
		expect(getProfile("default").tailscale.enabled).toBe(false);
	}, PATIENT_TEST_MS);

	it("up with no other writer stores the new hostname and leaves the rest as it was", async () => {
		await enabledProfile();
		const before = getProfile("default").tailscale;

		const run = await agx("tailscale", "up", "--hostname", "agx-new");

		expect(run.code, run.stderr).toBe(0);
		expect(getProfile("default").tailscale).toEqual({ ...before, hostname: "agx-new" });
	});
});
