import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENTLY_EXPIRED_MS } from "../commands/login.js";
import { setRpcTimeoutForTests } from "../lib/api.js";
import { fileMode } from "../lib/paths.js";
import { setRuntimeForTests } from "../lib/runtime.js";
import {
	agx,
	type CliRun,
	capture,
	fakeClock,
	jsonDocuments,
	sandbox,
	useClock,
} from "./helpers.js";
import { runCli } from "../program.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * `agx login` and the commands around it, end to end through the real
 * commander wiring, against the in-process mock index (which implements the
 * LOGIN-CONTRACT.md §1.3 rules), with a fake clock so minutes of polling take
 * milliseconds.
 */

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

const credentialsFile = () => join(box.home, "credentials.json");
const configFile = () => join(box.home, "config.json");
const pendingFile = (profile = "default") =>
	join(box.home, "profiles", profile, "pending-login.json");
const lockFile = (profile = "default") =>
	join(box.home, "profiles", profile, "pending-login.lock");

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** A 401 from a server that predates `data.code`: no code, just a message. */
function unauthorizedWithoutCode(message: string) {
	return {
		status: 401,
		body: { json: { defined: false, code: "UNAUTHORIZED", status: 401, message } },
	};
}

function onlyJson(run: CliRun): Record<string, any> {
	const docs = jsonDocuments(run.stdout);
	expect(docs, `stdout was:\n${run.stdout}\nstderr:\n${run.stderr}`).toHaveLength(1);
	return docs[0] as Record<string, any>;
}

/** `printf %s "$KEY" | agx config set apiKey --stdin`, bound to the mock. */
async function storeManualKey(key: string): Promise<CliRun> {
	process.env.AGX_API_URL = mock.origin;
	const { setStdinForTests } = await import("../lib/stdin.js");
	const restore = setStdinForTests(key);
	try {
		return await agx("config", "set", "apiKey", "--stdin");
	} finally {
		restore();
	}
}

/** Every request fails as on a machine without a network, until restored. */
function goOffline(): () => void {
	return setRuntimeForTests({
		fetch: async () => {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: { code: "ECONNREFUSED" },
			});
		},
	});
}

/** Log in with `--no-wait` twice around an approval. */
async function loginViaNoWait(...extra: string[]): Promise<CliRun> {
	const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, ...extra);
	expect(first.code).toBe(7);
	mock.approve();
	return agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, ...extra);
}

describe("agx login", () => {
	it("(a) blocking: survives slow_down, stores the key 0600, prints neither key nor device code", async () => {
		let polls = 0;
		mock.onTokenPoll = () => {
			polls += 1;
			if (polls === 2) {
				// The CLI must keep the raised interval for the rest of the code's life.
				mock.queueToken(CONTRACT.deviceToken.errors.slow_down as never);
			}
			if (polls === 3) {
				mock.approve();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);

		// Exactly one code was requested.
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);

		// The hand-off went to stderr once, as one JSON line.
		const handoff = run.stderr
			.split("\n")
			.filter((line) => line.startsWith('{"actionRequired"'));
		expect(handoff).toHaveLength(1);
		const action = JSON.parse(handoff[0] ?? "{}").actionRequired;
		expect(action).toMatchObject({
			reason: "LOGIN_APPROVAL_REQUIRED",
			url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
			userCode: "WDJB-MJHT",
			expiresIn: 1800,
			verificationUri: `${mock.origin}/auth/device`,
		});

		// Only the result on stdout, shaped like LOGIN-CONTRACT.md §1.8.
		const result = onlyJson(run);
		const key = mock.keys[0];
		expect(result).toEqual({
			loggedIn: true,
			alreadyLoggedIn: false,
			profile: "default",
			apiBaseUrl: mock.origin,
			user: { id: "u_1", email: "a•••@acme.com" },
			organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
			requestedOrg: null,
			scopes: CONTRACT.scopes,
			expiresAt: key?.expiresAt,
			apiKeyId: key?.id,
		});

		// Neither secret is printed anywhere.
		const deviceCode = mock.codes[0]?.deviceCode ?? "missing";
		for (const stream of [run.stdout, run.stderr]) {
			expect(stream).not.toContain(key?.key);
			expect(stream).not.toContain(deviceCode);
		}

		// credentials.json is 0600 in a 0700 home; config.json holds no key.
		expect(fileMode(credentialsFile())).toBe(0o600);
		expect(fileMode(box.home)).toBe(0o700);
		const creds = readJson(credentialsFile());
		expect(creds.profiles.default).toMatchObject({
			apiBaseUrl: mock.origin,
			apiKey: key?.key,
			apiKeyId: key?.id,
			source: "login",
			clientId: "agx",
			organization: { slug: "acme-robotics" },
			scopes: CONTRACT.scopes,
		});
		const config = readJson(configFile());
		expect(config.profiles.default.apiKey).toBeNull();
		expect(config.profiles.default.orgSlug).toBe("acme-robotics");
		expect(config.profiles.default.apiBaseUrl).toBe(mock.origin);
		expect(existsSync(pendingFile())).toBe(false);

		// The request bodies: JSON, client_id, the grant type URN.
		const codeCall = mock.calls("/api/auth/device/code")[0];
		expect(codeCall?.headers["content-type"]).toBe("application/json");
		expect(codeCall?.body).toMatchObject({
			client_id: "agx",
			scope: "listings:read listings:write domains:read domains:write",
		});
		for (const call of mock.calls("/api/auth/device/token")) {
			expect(call.body).toEqual({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode,
				client_id: "agx",
			});
		}

		// Pacing: 5 s, 5 s, then 10 s after slow_down and every poll after it.
		expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([5000, 5000, 10000]);
	});

	it("(b) --json --no-wait exits 7, then the re-run resumes the same code and exits 0", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		expect(onlyJson(first)).toEqual({
			actionRequired: {
				reason: "LOGIN_APPROVAL_REQUIRED",
				url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
				userCode: "WDJB-MJHT",
				expiresIn: 1800,
				expiresAt: new Date(clock.now() + 1800_000).toISOString(),
				verificationUri: `${mock.origin}/auth/device`,
			},
		});
		// A fresh code is never polled under --no-wait.
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);
		expect(fileMode(pendingFile())).toBe(0o600);

		// Still pending: same code, one poll, exit 7 again.
		const again = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(again.code).toBe(7);
		expect(onlyJson(again).actionRequired.userCode).toBe("WDJB-MJHT");
		expect(mock.calls("/api/auth/device/token")).toHaveLength(1);

		mock.approve();
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(done.code, done.stderr).toBe(0);
		expect(onlyJson(done)).toMatchObject({ loggedIn: true, alreadyLoggedIn: false });
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		const polled = new Set(
			mock.calls("/api/auth/device/token").map((c) => (c.body as { device_code: string }).device_code),
		);
		expect([...polled]).toEqual([mock.codes[0]?.deviceCode]);
		expect(existsSync(pendingFile())).toBe(false);

		// And once more: already logged in, confirmed by the server, no new code.
		const repeat = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(repeat.code).toBe(0);
		expect(onlyJson(repeat)).toMatchObject({ alreadyLoggedIn: true, organization: { slug: "acme-robotics" } });
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
	});

	it("(c) denied → exit 4 and the pending file is removed", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		mock.deny();
		const denied = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(denied.code).toBe(4);
		expect(denied.stderr).toMatch(/denied/);
		// A harness driving --no-wait is told to re-run THAT, never the blocking form.
		expect(denied.stderr).toContain("same command again for a fresh code");
		expect(denied.stderr).toContain("agx login --no-wait");
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(credentialsFile())).toBe(false);
	});

	it("(c) a key the server cannot mint: one retry, then exit 4 that says the code was closed (LOGIN-CONTRACT.md §1.3 row 15)", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.approve();
				mock.failNextMint("closes");
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/could not issue a key for this login and has closed the code/);
		expect(run.stderr).not.toMatch(/denied in the browser/);
		expect(run.stderr).toMatch(/^ +agx login$/m);
		// The 500, then the access_denied that ends it: no loop.
		expect(mock.calls("/api/auth/device/token")).toHaveLength(2);
		expect(mock.codes[0]?.status).toBe("denied");
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(credentialsFile())).toBe(false);
		expect(run.stdout).toBe("");
	});

	it("(c) --no-wait: the failed mint is exit 5, and the next run reports the closed code and removes it", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		mock.approve();
		mock.failNextMint("closes");

		const failed = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(failed.code).toBe(5);
		expect(existsSync(pendingFile())).toBe(true);
		expect(readJson(pendingFile()).lastPollServerError).toBe(true);

		const closed = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(closed.code).toBe(4);
		expect(closed.stderr).toMatch(/has closed the code/);
		expect(closed.stderr).toMatch(/^ +agx login --no-wait$/m);
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(credentialsFile())).toBe(false);

		// The run after that starts over with a fresh code.
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
	});

	it("(c) a mint failure that leaves the code approved is retried, and the login completes", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.approve();
				mock.failNextMint("retry");
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(2);
		expect(mock.keys).toHaveLength(1);
	});

	it("(c) expired → exit 4 and the pending file is removed", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.expire();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/expired/);
		expect(run.stderr).toMatch(/^ +agx login$/m);
		expect(run.stderr).not.toContain("--no-wait");
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("(c) --no-wait: a resumed code the server reports expired → exit 4, and the fix is the same --no-wait command", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		mock.expire();
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/expired before it was approved/);
		expect(run.stderr).toMatch(/^ +agx login --no-wait$/m);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(1);
		expect(existsSync(pendingFile())).toBe(false);

		const fresh = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(fresh.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
	});

	it("(c) a code that runs out locally is never polled past its deadline", async () => {
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/expired before it was approved/);
		const polls = mock.calls("/api/auth/device/token").length;
		// 1800 s at 5 s per poll, and not one more.
		expect(polls).toBeGreaterThan(300);
		expect(polls).toBeLessThanOrEqual(360);
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("(d) concurrent resumes poll once and mint one key", async () => {
		// The waiting run gives the polling one ~25 fake seconds in 1 s steps;
		// make each step 20 ms of real time, so the poller's real HTTP round
		// trip fits comfortably even on a slow machine.
		restoreClock();
		const slower = fakeClock(clock.now(), 20);
		restoreClock = useClock(slower);
		await mock.close();
		mock = await startMockIndexServer({ now: slower.now });
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		mock.approve();
		const args = ["login", "--json", "--no-wait", "--api-base-url", mock.origin];
		const { value: codes } = await capture(() =>
			Promise.all([runCli(args), runCli(args)]),
		);
		expect(codes.sort()).toEqual([0, 0]);
		const approvals = mock.calls("/api/auth/device/token");
		expect(approvals).toHaveLength(1);
		expect(mock.keys).toHaveLength(1);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[0]?.id);
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(join(box.home, "profiles", "default", "pending-login.lock"))).toBe(false);
	});

	it("(e) whoami reports the server's view, masked, and never the key", async () => {
		const notYet = await agx("whoami", "--json");
		expect(notYet.code).toBe(4);
		expect(onlyJson(notYet)).toEqual({ loggedIn: false, profile: "default" });

		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("whoami", "--json");
		expect(run.code, run.stderr).toBe(0);
		const key = mock.keys[0];
		expect(onlyJson(run)).toEqual({
			loggedIn: true,
			verified: true,
			profile: "default",
			apiBaseUrl: mock.origin,
			source: "login",
			user: { id: "u_1", email: "a•••@acme.com" },
			organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics", role: "owner" },
			apiKey: {
				id: key?.id,
				name: key?.name,
				scoped: true,
				scopes: CONTRACT.scopes,
				clientId: "agx",
				hostLabel: key?.hostLabel,
				expiresAt: key?.expiresAt,
			},
		});
		expect(run.stdout).not.toContain(key?.key);
		const call = mock.calls("/api/rpc/account/principal/get").at(-1);
		expect(call?.headers["x-api-key"]).toBe(key?.key);
		expect(String(call?.headers["user-agent"])).toMatch(/^agx\/\d+\.\d+\.\d+ \(node /);
	});

	it("(e) whoami against a server that never answers exits 5 instead of hanging", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("account/principal/get", () => new Promise(() => {}));
		const restore = setRpcTimeoutForTests(200);
		try {
			const run = await agx("whoami", "--json");
			expect(run.code).toBe(5);
			expect(run.stderr).toMatch(/did not answer in time/);
		} finally {
			restore();
		}
	});

	it("(e) whoami falls back to the local record on a server without the endpoint", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("account/principal/get", () => ({
			status: 404,
			body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
		}));
		const run = await agx("whoami", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run)).toMatchObject({
			verified: false,
			organization: { slug: "acme-robotics", role: null },
		});
	});

	it("(e) whoami: a key whose owner left its organization is reported as such, organization null, exit 4", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		if (key) {
			key.member = false;
		}
		const run = await agx("whoami", "--json");
		expect(run.code).toBe(4);
		// The server's word, not the organization agx remembers from the login.
		expect(onlyJson(run)).toMatchObject({
			loggedIn: true,
			verified: true,
			source: "login",
			user: { id: "u_1", email: "a•••@acme.com" },
			organization: null,
			apiKey: { id: key?.id, scoped: true },
		});
		expect(run.stderr).toMatch(
			/the account that owns this key is no longer a member of its organization \(acme-robotics\)/,
		);
		expect(run.stderr).toMatch(/agx login --force/);
		expect(`${run.stdout}${run.stderr}`).not.toContain(key?.key);

		const human = await agx("whoami");
		expect(human.code).toBe(4);
		expect(human.stdout).toMatch(/organization\s+—/);
		expect(human.stderr).toMatch(/no longer a member of its organization/);
	});

	it("(e) whoami against a server that still answers 403 API_KEY_OWNER_NOT_MEMBER exits 4 too", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("account/principal/get", () => structuredClone(CONTRACT.rpcErrors.API_KEY_OWNER_NOT_MEMBER as never));
		const run = await agx("whoami", "--json");
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/no longer a member of its organization/);
	});

	it("(f) org list shows a login key only its own organization", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("org", "list", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run)).toEqual({
			organizations: [
				{
					id: "o_1",
					name: "Acme Robotics",
					slug: "acme-robotics",
					logo: "https://…",
					role: "owner",
					current: true,
				},
			],
		});
	});

	it("(g) logout revokes a login key against its own origin, then whoami says logged out", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run)).toEqual({
			loggedOut: [{ profile: "default", revoked: true, reason: "revoked" }],
		});
		expect(key?.revoked).toBe(true);
		expect(mock.calls("/api/rpc/prm/apiKeys/delete")[0]?.body).toEqual({
			json: { apiKeyId: key?.id },
		});
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
		expect((await agx("whoami", "--json")).code).toBe(4);
	});

	it("(g) config set apiKey records a manual key's id, so logout revokes it without asking again", async () => {
		const manual = mock.addKey();
		const set = await storeManualKey(manual.key);
		expect(set.code, set.stderr).toBe(0);
		expect(set.stderr).toBe("");
		expect(readJson(credentialsFile()).profiles.default).toMatchObject({
			source: "manual",
			apiKey: manual.key,
			apiKeyId: manual.id,
		});
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);

		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: true, reason: "revoked" });
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
		expect(mock.calls("/api/rpc/prm/apiKeys/delete")[0]?.body).toEqual({ json: { apiKeyId: manual.id } });
		expect(manual.revoked).toBe(true);
	});

	it("(g) config set apiKey offline still stores the key, without an id; logout then asks the server for it", async () => {
		const manual = mock.addKey();
		const restore = goOffline();
		let set: CliRun;
		try {
			set = await storeManualKey(manual.key);
		} finally {
			restore();
		}
		expect(set.code, set.stderr).toBe(0);
		expect(set.stderr).toBe("");
		expect(readJson(credentialsFile()).profiles.default).toMatchObject({ apiKey: manual.key, apiKeyId: null });

		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: true, reason: "revoked" });
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
		expect(manual.revoked).toBe(true);
	});

	it("(g) config set apiKey: a lookup that never answers is bounded, and the key is stored without an id", async () => {
		const manual = mock.addKey();
		mock.setRpc("account/principal/get", () => new Promise(() => {}));
		const restore = setRpcTimeoutForTests(200);
		let set: CliRun;
		try {
			set = await storeManualKey(manual.key);
		} finally {
			restore();
		}
		expect(set.code, set.stderr).toBe(0);
		expect(readJson(credentialsFile()).profiles.default).toMatchObject({ apiKey: manual.key, apiKeyId: null });
	});

	it("(g) config set apiKey: a key the server refuses is stored all the same, with a notice", async () => {
		const set = await storeManualKey("ela_NotAKeyTheServerKnows");
		expect(set.code, set.stderr).toBe(0);
		expect(set.stderr).toMatch(/refused this key/);
		expect(set.stderr).toMatch(/agx whoami/);
		expect(set.stderr).not.toContain("ela_NotAKeyTheServerKnows");
		expect(readJson(credentialsFile()).profiles.default).toMatchObject({ apiKeyId: null });
	});

	it("(g) a key whose owner left its organization: config set apiKey still records its id, and logout revokes it", async () => {
		const manual = mock.addKey({ member: false });
		const set = await storeManualKey(manual.key);
		expect(set.code, set.stderr).toBe(0);
		expect(set.stderr).toMatch(/no longer a member of its organization/);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(manual.id);

		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: true, reason: "revoked" });
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
		expect(manual.revoked).toBe(true);
	});

	it("(g) logout of a manual key stored without its id, whose owner then left its organization, learns the id from whoami and revokes it", async () => {
		const manual = mock.addKey();
		const restore = goOffline();
		try {
			expect((await storeManualKey(manual.key)).code).toBe(0);
		} finally {
			restore();
		}
		manual.member = false;
		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: true, reason: "revoked" });
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
		expect(mock.calls("/api/rpc/prm/apiKeys/delete")[0]?.body).toEqual({ json: { apiKeyId: manual.id } });
		expect(manual.revoked).toBe(true);
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});

	it("(g) a server that will not let a former member's key revoke itself (403 API_KEY_OWNER_NOT_MEMBER): the key is kept, exit 4", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		if (key) {
			key.member = false;
		}
		mock.setRpc("prm/apiKeys/delete", () => structuredClone(CONTRACT.rpcErrors.API_KEY_OWNER_NOT_MEMBER as never));
		const run = await agx("logout", "--json");
		expect(run.code).toBe(4);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
		expect(run.stderr).toMatch(/Settings/);
		expect(readJson(credentialsFile()).profiles.default.apiKey).toBe(key?.key);
	});

	it("(g) logout forgets a key the server no longer knows (401)", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		if (key) {
			key.revoked = true; // revoked in Settings meanwhile
		}
		const run = await agx("logout", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "already-invalid" });
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});

	it("(g) logout forgets a key the server says has expired (401 API_KEY_EXPIRED)", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => structuredClone(CONTRACT.rpcErrors.API_KEY_EXPIRED as never));
		const run = await agx("logout", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "already-invalid" });
	});

	it("(g) a 404 is not 'already invalid': a manual key on a server without whoami is kept (exit 6), --local forgets it unrevoked", async () => {
		const manual = mock.addKey();
		mock.setRpc("account/principal/get", () => ({
			status: 404,
			body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
		}));
		const set = await storeManualKey(manual.key);
		// Storing it does not depend on the lookup, and a 404 is no refusal.
		expect(set.code, set.stderr).toBe(0);
		expect(set.stderr).toBe("");
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBeNull();
		const kept = await agx("logout", "--json");
		expect(kept.code).toBe(6);
		expect(onlyJson(kept).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
		expect(kept.stderr).toMatch(/kept/);
		expect(kept.stderr).toMatch(/Settings/);
		expect(readJson(credentialsFile()).profiles.default.apiKey).toBe(manual.key);
		expect(manual.revoked).toBe(false);

		const local = await agx("logout", "--json", "--local");
		expect(local.code).toBe(0);
		expect(onlyJson(local).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "not-revoked-local" });
		expect(local.stderr).toMatch(/without revoking it/);
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});

	it("(g) a 404 from the self-revoke itself keeps a login key (exit 6)", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => ({
			status: 404,
			body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
		}));
		const run = await agx("logout", "--json");
		expect(run.code).toBe(6);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
		expect(readJson(credentialsFile()).profiles.default).toBeDefined();
	});

	it("(g) a 401 without a data.code is 'already invalid' only as the 0.3 server's exact \"Invalid API key\"", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => unauthorizedWithoutCode("Invalid API key"));
		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "already-invalid" });
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});

	it.each(["Unauthorized", "API key is missing organization scope", "Invalid API key (gateway)"])(
		"(g) any other 401 without a data.code (%s) keeps the key and exits 4: it may still work",
		async (message) => {
			expect((await loginViaNoWait()).code).toBe(0);
			const key = mock.keys[0];
			mock.setRpc("prm/apiKeys/delete", () => unauthorizedWithoutCode(message));
			const run = await agx("logout", "--json");
			expect(run.code).toBe(4);
			expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
			expect(run.stderr).toMatch(/kept/);
			expect(run.stderr).toMatch(/agx logout --local/);
			expect(readJson(credentialsFile()).profiles.default.apiKey).toBe(key?.key);
		},
	);

	it("(g) a manual key whose whoami gets a 401 without a data.code is kept too", async () => {
		const manual = mock.addKey();
		mock.setRpc("account/principal/get", () => unauthorizedWithoutCode("Unauthorized"));
		const set = await storeManualKey(manual.key);
		expect(set.code, set.stderr).toBe(0);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBeNull();
		const run = await agx("logout", "--json");
		expect(run.code).toBe(4);
		expect(onlyJson(run).loggedOut[0]).toMatchObject({ reason: "revoke-failed" });
		expect(readJson(credentialsFile()).profiles.default.apiKey).toBe(manual.key);
	});

	it("(g) a disabled key still exists: it is kept, not forgotten as invalid", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => structuredClone(CONTRACT.rpcErrors.API_KEY_DISABLED as never));
		const run = await agx("logout", "--json");
		expect(run.code).toBe(4);
		expect(onlyJson(run).loggedOut[0]).toMatchObject({ reason: "revoke-failed" });
		expect(readJson(credentialsFile()).profiles.default).toBeDefined();
	});

	it("(g) logout keeps the key and exits 5 when the server is unreachable, unless --local", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		await mock.close();
		const kept = await agx("logout", "--json");
		expect(kept.code).toBe(5);
		expect(onlyJson(kept).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
		expect(readJson(credentialsFile()).profiles.default).toBeDefined();

		const local = await agx("logout", "--json", "--local");
		expect(local.code).toBe(0);
		expect(onlyJson(local).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "not-revoked-local" });
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
		mock = await startMockIndexServer({ now: clock.now }); // for afterEach
	});

	it("(g) logout clears a 0.3 config.json key without revoking it; logged out is exit 0", async () => {
		const legacy = mock.addKey();
		const { writePrivateJson } = await import("../lib/paths.js");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: mock.origin, apiKey: legacy.key, orgSlug: "acme-robotics" } },
		});
		const run = await agx("logout", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "legacy-key-cleared" });
		expect(run.stderr).toMatch(/NOT revoked/);
		expect(legacy.revoked).toBe(false);
		expect(mock.requests).toHaveLength(0);
		expect(readJson(configFile()).profiles.default.apiKey).toBeNull();

		const again = await agx("logout", "--json");
		expect(again.code).toBe(0);
		expect(onlyJson(again).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "not-logged-in" });
	});

	it("(g) logout --all covers every profile", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		expect((await loginViaNoWait("--profile", "second")).code).toBe(0);
		const run = await agx("logout", "--all", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut).toEqual([
			{ profile: "default", revoked: true, reason: "revoked" },
			{ profile: "second", revoked: true, reason: "revoked" },
		]);
		expect(mock.keys.every((k) => k.revoked)).toBe(true);
	});

	it("(h) a gated publish exits 7 with an absolute URL on the mock's origin", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("listing", "publish", "l_7", "--json");
		expect(run.code).toBe(7);
		expect(onlyJson(run)).toEqual({
			actionRequired: {
				reason: "HUMAN_CONFIRMATION_REQUIRED",
				url: `${mock.origin}/elladex/listings/l_7?org=acme-robotics`,
				userCode: null,
				expiresIn: null,
				listingId: "l_7",
			},
		});
	});

	it("(i) a login is never sent to another origin", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const other = await startMockIndexServer({ now: clock.now });
		try {
			process.env.AGX_API_URL = other.origin;
			for (const args of [["whoami", "--json"], ["search", "x", "--json"], ["org", "list"], ["listing", "publish", "l_7"]]) {
				const run = await agx(...args);
				expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(3);
				expect(run.stderr).toMatch(/Nothing was sent/);
			}
			expect(other.requests).toEqual([]);
		} finally {
			await other.close();
		}
	});

	it("(j) a redirect on /token is refused and never followed", async () => {
		const elsewhere = await startMockIndexServer({ now: clock.now });
		try {
			mock.queueToken({
				status: 307,
				headers: { Location: `${elsewhere.origin}/api/auth/device/token` },
				body: {},
			});
			const run = await agx("login", "--json", "--api-base-url", mock.origin);
			expect(run.code).toBe(6);
			expect(run.stderr).toMatch(/redirect/);
			expect(elsewhere.requests).toEqual([]);
			expect(existsSync(credentialsFile())).toBe(false);
		} finally {
			await elsewhere.close();
		}
	});
});

describe("agx login, more", () => {
	it("aborts before showing a code when the server does not echo a scope", async () => {
		await mock.close();
		mock = await startMockIndexServer({ now: clock.now, omitScopeEcho: true });
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(6);
		expect(run.stderr).toMatch(/unscoped key that never expires/);
		expect(run.stdout).not.toContain("WDJB-MJHT");
		expect(run.stderr).not.toContain("WDJB-MJHT");
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("aborts before showing a code when the verification page is on another origin", async () => {
		await mock.close();
		mock = await startMockIndexServer({ now: clock.now, verificationOrigin: "https://evil.example" });
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(6);
		expect(`${run.stdout}${run.stderr}`).not.toContain("WDJB-MJHT");
	});

	it("validates flags with exit 2", async () => {
		expect((await agx("login", "--org", "a", "--new-org")).code).toBe(2);
		expect((await agx("login", "--org-name", "Acme")).code).toBe(2);
		expect((await agx("login", "--api-base-url", "http://example.com")).code).toBe(2);
		expect((await agx("login", "--api-base-url", "https://u:p@example.com")).code).toBe(2);
		expect(mock.requests).toEqual([]);
	});

	it("passes the org prefill and reports an approved org that differs from --org", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--org", "acme");
		expect(first.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")[0]?.body).toMatchObject({ org_hint: "acme" });
		mock.approve();
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--org", "acme");
		expect(done.code).toBe(0);
		expect(onlyJson(done)).toMatchObject({ requestedOrg: "acme", organization: { slug: "acme-robotics" } });
		expect(done.stderr).toMatch(/You asked for organization "acme"/);
	});

	it("org create is login --new-org with the name and slug prefilled", async () => {
		const run = await agx("org", "create", "Acme Robotics", "--slug", "acme-robotics", "--no-wait", "--api-base-url", mock.origin, "--json");
		expect(run.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")[0]?.body).toMatchObject({
			new_org: true,
			new_org_name: "Acme Robotics",
			new_org_slug: "acme-robotics",
		});
	});

	it("a different request discards the pending code instead of resuming it", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--new-org")).code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
		expect(readJson(pendingFile()).request.newOrg).toBe(true);
	});

	it("a stored login whose owner left its organization is not 'already logged in': a new code, and the old key is revoked", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const old = mock.keys[0];
		if (old) {
			old.member = false;
		}
		const again = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(again.code, again.stderr).toBe(7);
		expect(onlyJson(again).actionRequired.reason).toBe("LOGIN_APPROVAL_REQUIRED");
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);

		mock.approve();
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(done.code, done.stderr).toBe(0);
		expect(onlyJson(done)).toMatchObject({ alreadyLoggedIn: false, apiKeyId: mock.keys[1]?.id });
		expect(old?.revoked).toBe(true);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[1]?.id);
	});

	it("--force logs in again and revokes the replaced login key", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const old = mock.keys[0];
		const run = await loginViaNoWait("--force");
		expect(run.code, run.stderr).toBe(0);
		expect(mock.keys).toHaveLength(2);
		expect(old?.revoked).toBe(true);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[1]?.id);
	});

	it("--force prints the result before revoking the old key, and a revoke that hangs is bounded", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		let stdoutWhenRevokeArrived = "";
		mock.setRpc("prm/apiKeys/delete", () => {
			// console.log is the capture spy while agx runs: what has it printed?
			const calls = (console.log as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
			stdoutWhenRevokeArrived = calls.flat().map(String).join("\n");
			return new Promise(() => {});
		});
		const restore = setRpcTimeoutForTests(200);
		try {
			const run = await loginViaNoWait("--force");
			expect(run.code, run.stderr).toBe(0);
			expect(onlyJson(run)).toMatchObject({ loggedIn: true, apiKeyId: mock.keys[1]?.id });
			expect(stdoutWhenRevokeArrived).toMatch(/"loggedIn": true/);
			expect(run.stderr).toMatch(/Could not revoke the previous login key/);
			expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[1]?.id);
		} finally {
			restore();
		}
	});

	it("--force says so when the old key could not be revoked (404), and stays quiet when it was already invalid", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => ({
			status: 404,
			body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
		}));
		const notFound = await loginViaNoWait("--force");
		expect(notFound.code, notFound.stderr).toBe(0);
		expect(notFound.stderr).toMatch(/Could not revoke the previous login key/);

		mock.setRpc("prm/apiKeys/delete", () => structuredClone(CONTRACT.rpcErrors.API_KEY_INVALID as never));
		const invalid = await loginViaNoWait("--force");
		expect(invalid.code, invalid.stderr).toBe(0);
		expect(invalid.stderr).not.toMatch(/Could not revoke/);
	});

	it("--force: a 401 without a data.code leaves the old key alive and says so, unless it is the 0.3 \"Invalid API key\"", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("prm/apiKeys/delete", () => unauthorizedWithoutCode("Unauthorized"));
		const walled = await loginViaNoWait("--force");
		expect(walled.code, walled.stderr).toBe(0);
		expect(walled.stderr).toMatch(/Could not revoke the previous login key \(k_1\)/);

		mock.setRpc("prm/apiKeys/delete", () => unauthorizedWithoutCode("Invalid API key"));
		const legacy = await loginViaNoWait("--force");
		expect(legacy.code, legacy.stderr).toBe(0);
		expect(legacy.stderr).not.toMatch(/Could not revoke/);
	});

	it("human mode: the URL and code go to stderr, the result to stdout", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.approve();
			}
		};
		const run = await agx("login", "--no-browser", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stderr).toContain(`Open ${mock.origin}/auth/device?code=WDJB-MJHT and check the code WDJB-MJHT (expires in 30 min)`);
		expect(run.stdout).toMatch(/Logged in as a•••@acme\.com · org acme-robotics/);
		expect(run.stdout).not.toContain("WDJB-MJHT");
	});

	it("human mode --no-wait: exit 7 with the URL and code on stderr, nothing on stdout but the host line", async () => {
		const run = await agx("login", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(7);
		expect(run.stderr).toContain(`${mock.origin}/auth/device?code=WDJB-MJHT`);
		expect(run.stderr).toContain("code WDJB-MJHT");
		expect(run.stdout).not.toContain("WDJB-MJHT");
	});

	it("a lock left with this process's own pid (an earlier crash, pid reuse) does not block polling", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }));
		mock.approve();
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(1);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("a live holder (pid 1) keeps the lock only while its heartbeat is fresh; exit 7 names the file", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		writeFileSync(
			lockFile(),
			JSON.stringify({
				pid: 1,
				token: "t",
				at: new Date(clock.now()).toISOString(),
				staleAfter: new Date(clock.now() + 75_000).toISOString(),
			}),
		);
		mock.approve();
		const blocked = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(blocked.code).toBe(7);
		expect(onlyJson(blocked).actionRequired.reason).toBe("LOGIN_APPROVAL_REQUIRED");
		expect(blocked.stderr).toContain(lockFile());
		expect(blocked.stderr).toMatch(/pid 1/);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);

		// The holder writes no more heartbeats: once they run out, the lock is taken over.
		clock.advance(120_000);
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(done.code, done.stderr).toBe(0);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(1);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("a blocking login keeps its heartbeat fresh on every poll", async () => {
		const seen: Array<{ pid: number; at: number; staleAfter: number; now: number }> = [];
		mock.onTokenPoll = (_code, n) => {
			const lock = readJson(lockFile());
			seen.push({ pid: lock.pid, at: Date.parse(lock.at), staleAfter: Date.parse(lock.staleAfter), now: clock.now() });
			if (n === 4) {
				mock.approve();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(seen).toHaveLength(4);
		for (const s of seen) {
			expect(s.pid).toBe(process.pid);
			// Written just before this poll's wait, and good for well past it.
			expect(s.now - s.at).toBeLessThanOrEqual(5_000);
			expect(s.staleAfter).toBeGreaterThan(s.now + 30_000);
		}
		expect(existsSync(lockFile())).toBe(false);
	});

	it.each(["SIGTERM", "SIGHUP"] as const)("%s while waiting releases the lock, keeps the code and exits 130", async (signal) => {
		const others = process.listeners(signal);
		process.removeAllListeners(signal);
		try {
			mock.onTokenPoll = (_code, n) => {
				if (n === 2) {
					expect(existsSync(lockFile())).toBe(true);
					process.emit(signal, signal);
				}
			};
			const run = await agx("login", "--json", "--api-base-url", mock.origin);
			expect(run.code).toBe(130);
			expect(existsSync(pendingFile())).toBe(true);
			expect(existsSync(lockFile())).toBe(false);
			for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
				expect(process.listeners(name).filter((l) => !others.includes(l as never))).toHaveLength(0);
			}
		} finally {
			for (const listener of others) {
				process.on(signal, listener as () => void);
			}
		}
	});

	it("SIGINT while waiting keeps the pending code and exits 130", async () => {
		const others = process.listeners("SIGINT");
		process.removeAllListeners("SIGINT");
		try {
			mock.onTokenPoll = (_code, n) => {
				if (n === 2) {
					process.emit("SIGINT");
				}
			};
			const run = await agx("login", "--json", "--api-base-url", mock.origin);
			expect(run.code).toBe(130);
			expect(existsSync(pendingFile())).toBe(true);
			expect(process.listenerCount("SIGINT")).toBe(0);
			// And the code resumes.
			mock.onTokenPoll = null;
			mock.approve();
			const resumed = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
			expect(resumed.code).toBe(0);
			expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		} finally {
			for (const listener of others) {
				process.on("SIGINT", listener as () => void);
			}
		}
	});

	it("--no-wait: a re-run after the code expired locally exits 4, then the next run starts over (LOGIN-CONTRACT.md §1.8)", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		const shown = onlyJson(first).actionRequired.userCode;
		clock.advance(1801_000);

		const expired = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(expired.code).toBe(4);
		expect(expired.stderr).toMatch(/expired before it was approved/);
		expect(expired.stderr).toMatch(/^ +agx login --no-wait$/m);
		// No new code was requested or shown, and nothing was polled.
		expect(jsonDocuments(expired.stdout)).toEqual([]);
		expect(`${expired.stdout}${expired.stderr}`).not.toContain(shown);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);
		expect(existsSync(pendingFile())).toBe(false);

		const fresh = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(fresh.code).toBe(7);
		expect(onlyJson(fresh).actionRequired.userCode).not.toBe(shown);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
	});

	it.each([
		["23 h 59 min", 4, RECENTLY_EXPIRED_MS - 60_000],
		["exactly 24 h", 4, RECENTLY_EXPIRED_MS],
		["24 h and a second", 7, RECENTLY_EXPIRED_MS + 1000],
		["a month", 7, 30 * 86_400_000],
	])("--no-wait: a code that expired %s ago → exit %i (older ones were abandoned: start over)", async (_label, exit, sinceExpiry) => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		const shown = onlyJson(first).actionRequired.userCode;
		clock.advance(1800_000 + sinceExpiry);

		const later = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(later.code, later.stderr).toBe(exit);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);
		if (exit === 4) {
			expect(jsonDocuments(later.stdout)).toEqual([]);
			expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
			expect(existsSync(pendingFile())).toBe(false);
		} else {
			// The first run of a later session: a fresh code, shown and saved.
			const action = onlyJson(later).actionRequired;
			expect(action).toMatchObject({ reason: "LOGIN_APPROVAL_REQUIRED", expiresIn: 1800 });
			expect(action.userCode).not.toBe(shown);
			expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
			expect(readJson(pendingFile()).deviceCode).toBe(mock.codes[1]?.deviceCode);
		}
	});

	it("blocking: a pending code that expired locally is replaced, not resumed", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		clock.advance(1801_000);
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.approve();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
		const polled = new Set(
			mock.calls("/api/auth/device/token").map((c) => (c.body as { device_code: string }).device_code),
		);
		expect([...polled]).toEqual([mock.codes[1]?.deviceCode]);
	});

	it("--no-wait: a different request still starts a fresh code even when the old one expired", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		clock.advance(1801_000);
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--org", "acme");
		expect(run.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
	});

	it("an expired login is refused for API calls (exit 4) and replaced by agx login", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		clock.advance(91 * 86_400_000);
		expect((await agx("search", "x")).code).toBe(4);
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
	});

	it("warns when AGX_API_KEY would override the new login", async () => {
		process.env.AGX_API_KEY = "ela_FromTheEnvironment";
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(7);
		expect(run.stderr).toMatch(/AGX_API_KEY is set/);
		expect(run.stdout).not.toContain("ela_FromTheEnvironment");
	});

	it("without --api-base-url, a stored 0.3 localhost default is ignored in favour of the production server", async () => {
		const { resolveLoginBaseUrl } = await import("../commands/login.js");
		const { writePrivateJson } = await import("../lib/paths.js");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: "http://localhost:3000" } },
		});
		expect(resolveLoginBaseUrl("default", undefined)).toBe("https://app.ellaworks.ai");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: "http://localhost:4000" } },
		});
		expect(resolveLoginBaseUrl("default", undefined)).toBe("http://localhost:4000");
		process.env.AGX_API_URL = "https://staging.example.com";
		expect(resolveLoginBaseUrl("default", undefined)).toBe("https://staging.example.com");
		expect(resolveLoginBaseUrl("default", "http://127.0.0.1:9/")).toBe("http://127.0.0.1:9");
	});

	it("--profile after the subcommand is honoured", async () => {
		expect((await loginViaNoWait("--profile", "work")).code).toBe(0);
		expect(readJson(credentialsFile()).profiles.work).toBeDefined();
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});
});
