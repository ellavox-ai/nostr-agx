import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, loadConfig, resolveProfileName, saveProfile } from "../lib/config.js";
import { getCredential } from "../lib/credentials.js";
import { createIdentity } from "../lib/identity.js";
import { setRuntimeForTests } from "../lib/runtime.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, type CliRun, capture, jsonDocuments, sandbox } from "../test/helpers.js";
import { startMockIndexServer } from "../test/mock-index-server.js";

const KEY = "ela_ManualKeyManualKeyManualKeyManualKeyWXYZ";

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
	process.env.AGX_API_URL = "https://app.ellaworks.ai";
});
afterEach(() => box.restore());

async function withStdin<T>(input: string | null, fn: () => Promise<T>): Promise<T> {
	const restore = setStdinForTests(input);
	try {
		return await fn();
	} finally {
		restore();
	}
}

/** Run `fn` recording every URL agx requests; each request fails as offline. */
async function recordingRequests<T>(fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
	const urls: string[] = [];
	const restore = setRuntimeForTests({
		fetch: async (input) => {
			urls.push(input instanceof Request ? input.url : String(input));
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		},
	});
	try {
		return { result: await fn(), urls };
	} finally {
		restore();
	}
}

function storeKey(key = KEY): Promise<CliRun> {
	return withStdin(key, () => agx("config", "set", "apiKey", "--stdin"));
}

describe("agx config set apiKey", () => {
	it("--stdin stores a manual key in credentials.json, bound to the effective origin", async () => {
		const run = await withStdin(`${KEY}\n`, () => agx("config", "set", "apiKey", "--stdin", "--json"));
		expect(run.code, run.stderr).toBe(0);
		expect(getCredential("default")).toMatchObject({
			apiKey: KEY,
			apiKeyId: null,
			source: "manual",
			apiBaseUrl: "https://app.ellaworks.ai",
		});
		const config = join(box.home, "config.json");
		expect(existsSync(config) ? readFileSync(config, "utf8") : "").not.toContain(KEY);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});

	it("reads a piped stdin even without --stdin", async () => {
		const run = await withStdin(KEY, () => agx("config", "set", "apiKey"));
		expect(run.code).toBe(0);
		expect(getCredential("default")?.apiKey).toBe(KEY);
	});

	it("refuses an empty or multi-line stdin, and a terminal with nothing piped (exit 2)", async () => {
		expect((await withStdin("", () => agx("config", "set", "apiKey", "--stdin"))).code).toBe(2);
		expect((await withStdin("a\nb\n", () => agx("config", "set", "apiKey", "--stdin"))).code).toBe(2);
		expect((await withStdin(null, () => agx("config", "set", "apiKey"))).code).toBe(2);
		expect(getCredential("default")).toBeNull();
	});

	it("a positional key still works but prints a deprecation on stderr, even under --json", async () => {
		const run = await withStdin(null, () => agx("config", "set", "apiKey", KEY, "--json"));
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/deprecated/);
		expect(run.stderr).toMatch(/--stdin/);
		expect(run.stdout).not.toMatch(/deprecated/);
		expect(getCredential("default")?.source).toBe("manual");
	});

	it("clears a 0.3 key from config.json", async () => {
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({ version: 1, currentProfile: "default", profiles: { default: { apiKey: "ela_OLD" } } }),
		);
		const run = await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		expect(run.code).toBe(0);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
		expect(getCredential("default")?.apiKey).toBe(KEY);
	});
});

describe("agx config set apiKey: looking up the key's id", () => {
	beforeEach(() => {
		delete process.env.AGX_API_URL;
	});

	it("a key stored before apiBaseUrl is set (the 0.3 order) is sent nowhere, and stored without an id", async () => {
		const { result: run, urls } = await recordingRequests(() => storeKey());
		expect(run.code, run.stderr).toBe(0);
		expect(run.stderr).toBe("");
		expect(urls).toEqual([]);
		expect(getCredential("default")).toMatchObject({
			apiKey: KEY,
			apiKeyId: null,
			apiBaseUrl: "https://app.ellaworks.ai",
		});
	});

	it("nor when config.json stores the default only because another setting wrote the profile", async () => {
		expect((await agx("config", "set", "orgSlug", "acme")).code).toBe(0);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).toContain('"apiBaseUrl": "https://app.ellaworks.ai"');
		const { result: run, urls } = await recordingRequests(() => storeKey());
		expect(run.code, run.stderr).toBe(0);
		expect(urls).toEqual([]);
		expect(getCredential("default")?.apiKeyId).toBeNull();
	});

	it("nor when a 0.3 profile still stores the 0.3 default, http://localhost:3000", async () => {
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", orgSlug: "acme" } },
			}),
		);
		const { result: run, urls } = await recordingRequests(() => storeKey());
		expect(run.code, run.stderr).toBe(0);
		expect(urls).toEqual([]);
		expect(getCredential("default")).toMatchObject({ apiKeyId: null, apiBaseUrl: "http://localhost:3000" });
	});

	it("a profile pointed at a server first asks that server once, and records the id", async () => {
		const mock = await startMockIndexServer();
		try {
			const settingsKey = mock.addKey();
			expect((await agx("config", "set", "apiBaseUrl", mock.origin)).code).toBe(0);
			const run = await storeKey(settingsKey.key);
			expect(run.code, run.stderr).toBe(0);
			expect(run.stderr).toBe("");
			expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
			expect(mock.calls("/api/rpc/account/principal/get")[0]?.headers["x-api-key"]).toBe(settingsKey.key);
			expect(getCredential("default")).toMatchObject({ apiKey: settingsKey.key, apiKeyId: settingsKey.id });
		} finally {
			await mock.close();
		}
	});

	it("AGX_API_URL is a choice, even when it names the default server", async () => {
		process.env.AGX_API_URL = "https://app.ellaworks.ai";
		const { result: run, urls } = await recordingRequests(() => storeKey());
		expect(run.code, run.stderr).toBe(0);
		expect(urls).toEqual(["https://app.ellaworks.ai/api/rpc/account/principal/get"]);
		expect(getCredential("default")?.apiKeyId).toBeNull();
	});
});

describe("agx config show", () => {
	it("never prints a key, in either mode, and summarises the credential", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		const human = await agx("config", "show");
		const json = await agx("config", "show", "--json");
		for (const run of [human, json]) {
			expect(run.code).toBe(0);
			expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
		}
		expect(human.stdout).toMatch(/credentials\s+manual/);
		const [doc] = jsonDocuments(json.stdout) as Array<Record<string, any>>;
		expect(doc?.apiKey).toBeUndefined();
		expect(doc?.credentials).toEqual({
			source: "manual",
			origin: "https://app.ellaworks.ai",
			organization: null,
			expiresAt: null,
			key: "ela_…WXYZ",
		});
	});

	it("never prints AGX_API_KEY either", async () => {
		process.env.AGX_API_KEY = KEY;
		const run = await agx("config", "show", "--json");
		expect(run.stdout).not.toContain(KEY);
		expect((jsonDocuments(run.stdout)[0] as Record<string, any>).credentials.source).toBe("env (AGX_API_KEY)");
	});

	it("--reveal is a usage error (exit 2)", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		const run = await agx("config", "show", "--reveal");
		expect(run.code).toBe(2);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});
});

describe("migration of a 0.3 key", () => {
	it("moves on the next config write, with a stderr notice", async () => {
		delete process.env.AGX_API_URL;
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		const run = await agx("config", "set", "orgSlug", "acme-robotics", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/Moved the API key of profile "default"/);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
		expect(getCredential("default")).toMatchObject({
			apiKey: "ela_OLD",
			source: "migrated",
			apiBaseUrl: "http://localhost:3000",
		});
	});

	it("config set apiBaseUrl binds the key to the server it was used with, not the new one", async () => {
		delete process.env.AGX_API_URL;
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "https://app.ellaworks.ai", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		const run = await agx("config", "set", "apiBaseUrl", "http://localhost:4000", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(getCredential("default")).toMatchObject({
			apiKey: "ela_OLD",
			source: "migrated",
			apiBaseUrl: "https://app.ellaworks.ai",
		});
		expect(run.stderr).toMatch(/only ever sent to https:\/\/app\.ellaworks\.ai/);
		// And the mismatch is reported, with the fix for a Settings key.
		expect(run.stderr).toMatch(/belongs to https:\/\/app\.ellaworks\.ai/);
		expect(run.stderr).toMatch(/config set apiKey --stdin/);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
	});

	it("updateProfile binds a legacy key to its stored origin even when the same write changes apiBaseUrl", async () => {
		const { updateProfile } = await import("../lib/config.js");
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "https://app.ellaworks.ai", apiKey: "ela_OLD" } },
			}),
		);
		await capture(async () => updateProfile("default", { apiBaseUrl: "http://localhost:4000" }));
		expect(getCredential("default")?.apiBaseUrl).toBe("https://app.ellaworks.ai");
	});

	it("after the move, API commands refuse to send the old key to the new server", async () => {
		delete process.env.AGX_API_URL;
		const mock = await startMockIndexServer();
		try {
			const legacy = mock.addKey();
			writeFileSync(
				join(box.home, "config.json"),
				JSON.stringify({
					version: 1,
					currentProfile: "default",
					profiles: { default: { apiBaseUrl: "https://app.ellaworks.ai", apiKey: legacy.key, orgSlug: "acme-robotics" } },
				}),
			);
			expect((await agx("config", "set", "apiBaseUrl", mock.origin)).code).toBe(0);
			const run = await agx("listing", "list");
			expect(run.code).toBe(3);
			expect(run.stderr).toMatch(/Nothing was sent/);
			expect(mock.requests).toEqual([]);
		} finally {
			await mock.close();
		}
	});
});

describe("agx config set apiBaseUrl", () => {
	it("refuses plain http to a remote host (exit 2)", async () => {
		expect((await agx("config", "set", "apiBaseUrl", "http://app.ellaworks.ai")).code).toBe(2);
	});

	it("warns when the stored credential belongs to another origin", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		delete process.env.AGX_API_URL;
		const run = await agx("config", "set", "apiBaseUrl", "http://localhost:3000");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/belongs to https:\/\/app\.ellaworks\.ai/);
	});

	it("a Settings key stored before apiBaseUrl: the notice and the exit 3 both name the --stdin fix, which works", async () => {
		delete process.env.AGX_API_URL;
		const mock = await startMockIndexServer();
		try {
			const settingsKey = mock.addKey();
			// The 0.3 order: key first (bound to the default server, and sent
			// nowhere), then the URL.
			const first = await recordingRequests(() => storeKey(settingsKey.key));
			expect(first.result.code).toBe(0);
			expect(first.urls).toEqual([]);
			const setBase = await agx("config", "set", "apiBaseUrl", mock.origin);
			expect(setBase.code).toBe(0);
			expect(setBase.stderr).toMatch(/belongs to https:\/\/app\.ellaworks\.ai/);
			expect(setBase.stderr).toMatch(/printf %s "\$KEY" \| agx config set apiKey --stdin/);
			await agx("config", "set", "orgSlug", "acme-robotics");

			const refused = await agx("search", "x");
			expect(refused.code).toBe(3);
			expect(refused.stderr).toMatch(/Nothing was sent/);
			expect(refused.stderr).toMatch(/printf %s "\$KEY" \| agx config set apiKey --stdin/);
			expect(mock.requests).toEqual([]);

			// The fix the messages give: store the key again, now bound to the mock.
			expect((await withStdin(settingsKey.key, () => agx("config", "set", "apiKey", "--stdin"))).code).toBe(0);
			mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
			const run = await agx("search", "x");
			expect(run.code, run.stderr).toBe(0);
			expect(mock.calls("/api/rpc/agentIndex/searchListings")[0]?.headers["x-api-key"]).toBe(settingsKey.key);
		} finally {
			await mock.close();
		}
	});

	it("a login key's origin mismatch does not suggest storing it by hand", async () => {
		const { setCredential } = await import("../lib/credentials.js");
		setCredential("default", {
			apiBaseUrl: "https://app.ellaworks.ai",
			apiKey: KEY,
			apiKeyId: "k_1",
			source: "login",
			clientId: "agx",
			organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
			user: null,
			scopes: [],
			expiresAt: "2099-01-01T00:00:00.000Z",
			createdAt: "2026-09-30T00:00:00.000Z",
		});
		delete process.env.AGX_API_URL;
		const run = await agx("config", "set", "apiBaseUrl", "http://localhost:4000");
		expect(run.stderr).toMatch(/agx login/);
		expect(run.stderr).not.toMatch(/--stdin/);
		const refused = await agx("search", "x");
		expect(refused.code).toBe(3);
		expect(refused.stderr).not.toMatch(/--stdin/);
	});
});

describe("which profile is active", () => {
	const RELAY = "ws://127.0.0.1:9";

	/** The profile `agx config show` describes when no profile is named. */
	async function active(): Promise<string> {
		const run = await agx("config", "show", "--json");
		expect(run.code, run.stderr).toBe(0);
		return (jsonDocuments(run.stdout)[0] as { profile: string }).profile;
	}

	async function listed(): Promise<{ current: string; profiles: string[] }> {
		const run = await agx("config", "list", "--json");
		expect(run.code, run.stderr).toBe(0);
		return jsonDocuments(run.stdout)[0] as { current: string; profiles: string[] };
	}

	it("a fresh home has the default profile active", async () => {
		expect(await active()).toBe("default");
		expect(await listed()).toEqual({ current: "default", profiles: [] });
	});

	it("saving a named profile on a fresh home leaves the default profile active", async () => {
		const run = await agx("--profile", "work", "config", "set", "relays", RELAY);
		expect(run.code, run.stderr).toBe(0);
		expect(await active()).toBe("default");
		expect(await listed()).toEqual({ current: "default", profiles: ["work"] });
		expect(JSON.parse(readFileSync(join(box.home, "config.json"), "utf8")).currentProfile).toBe("default");
	});

	it("saving the allowlist of a named profile on a fresh home leaves the default profile active", async () => {
		const peer = createIdentity().npub;
		const run = await agx("--profile", "work", "identity", "allow", peer);
		expect(run.code, run.stderr).toBe(0);
		expect(await active()).toBe("default");
		expect((await listed()).current).toBe("default");
	});

	it("saveProfile alone does not change the stored active profile", () => {
		saveProfile("work", { ...getProfile("work"), relays: [RELAY] });
		expect(loadConfig().currentProfile).toBe("default");
		expect(resolveProfileName()).toBe("default");
		expect(loadConfig().profiles.work?.relays).toEqual([RELAY]);
	});

	it("still saves the named profile's own settings", async () => {
		await agx("--profile", "work", "config", "set", "relays", RELAY);
		await agx("--profile", "work", "config", "set", "org", "Work Org");
		const run = await agx("--profile", "work", "config", "show", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(jsonDocuments(run.stdout)[0]).toMatchObject({ profile: "work", relays: [RELAY], org: "Work Org" });
	});

	it("config use makes the named profile active, creating it, and nothing but config use changes that", async () => {
		const use = await agx("config", "use", "work");
		expect(use.code, use.stderr).toBe(0);
		expect(await active()).toBe("work");
		expect(await listed()).toEqual({ current: "work", profiles: ["work"] });
		await agx("--profile", "other", "config", "set", "relays", RELAY);
		expect(await active()).toBe("work");
		expect((await agx("config", "use", "other")).code).toBe(0);
		expect(await active()).toBe("other");
	});

	it("saving the active profile keeps it active", async () => {
		await agx("config", "use", "work");
		expect((await agx("--profile", "work", "config", "set", "relays", RELAY)).code).toBe(0);
		expect(await active()).toBe("work");
		expect((await listed()).current).toBe("work");
	});

	it("saving a profile other than the active one keeps the active one", async () => {
		await agx("config", "use", "main");
		expect((await agx("--profile", "other", "config", "set", "relays", RELAY)).code).toBe(0);
		expect((await agx("--profile", "third", "identity", "allow", createIdentity().npub)).code).toBe(0);
		expect(await active()).toBe("main");
		expect(await listed()).toEqual({ current: "main", profiles: ["main", "other", "third"] });
	});

	it("saving the default profile on a fresh home keeps it active and lists it", async () => {
		expect((await agx("config", "set", "orgSlug", "acme")).code).toBe(0);
		expect(await active()).toBe("default");
		expect(await listed()).toEqual({ current: "default", profiles: ["default"] });
	});
});
