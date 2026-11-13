import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { savePendingLogin } from "../lib/device-flow.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { credentialsPath, identityPath, pendingLoginLockPath, pendingLoginPath } from "../lib/paths.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, fakeClock, jsonDocuments, sandbox, useClock } from "../test/helpers.js";
import { type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
	// No relays: doctor would otherwise probe ws://127.0.0.1:7447.
	updateProfile("default", { apiBaseUrl: mock.origin, relays: [] });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

type Check = { name: string; verdict: string; detail: string; remediation?: string };

async function doctor(): Promise<{ code: number; checks: Check[] }> {
	const run = await agx("doctor", "--json");
	const doc = jsonDocuments(run.stdout)[0] as { checks: Check[] };
	return { code: run.code, checks: doc.checks };
}

const check = (checks: Check[], name: string) => checks.find((c) => c.name === name);

function login(expiresAt: string, apiBaseUrl = mock.origin) {
	const key = mock.addKey({ scoped: true, clientId: "agx", expiresAt });
	setCredential("default", {
		apiBaseUrl,
		apiKey: key.key,
		apiKeyId: key.id,
		source: "login",
		clientId: "agx",
		organization: key.organization,
		user: null,
		scopes: ["listings:read"],
		expiresAt,
		createdAt: new Date(clock.now()).toISOString(),
	});
	return key;
}

describe("agx doctor", () => {
	it("reports the credential source and fails nothing for a fresh login", async () => {
		login("2099-01-01T00:00:00.000Z");
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const { checks } = await doctor();
		expect(check(checks, "credential source")).toMatchObject({
			verdict: "pass",
			detail: 'credentials.json (login), org "acme-robotics"',
		});
		expect(check(checks, "api credentials")?.verdict).toBe("pass");
		expect(check(checks, "login expiry")).toBeUndefined();
	});

	it("warns when the login expires within 7 days", async () => {
		login(new Date(clock.now() + 3 * 86_400_000).toISOString());
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const { checks } = await doctor();
		expect(check(checks, "login expiry")).toMatchObject({ verdict: "warn", remediation: "agx login --force" });
	});

	it("fails an origin mismatch without sending the key", async () => {
		login("2099-01-01T00:00:00.000Z", "https://app.ellaworks.ai");
		const { code, checks } = await doctor();
		expect(code).toBe(3);
		expect(check(checks, "api credentials")).toMatchObject({ verdict: "fail" });
		expect(check(checks, "api credentials")?.detail).toMatch(/Nothing was sent/);
		expect(mock.requests.filter((r) => r.path.startsWith("/api/rpc/"))).toEqual([]);
	});

	it("warns about a legacy key and points at agx login", async () => {
		const legacy = mock.addKey();
		const { writePrivateJson } = await import("../lib/paths.js");
		writePrivateJson(join(box.home, "config.json"), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: mock.origin, apiKey: legacy.key, orgSlug: "acme-robotics", relays: [] } },
		});
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const { checks } = await doctor();
		expect(check(checks, "credential source")).toMatchObject({ verdict: "warn" });
		expect(check(checks, "credential source")?.remediation).toMatch(/agx login/);
	});

	it("checks credentials.json and pending-login.json permissions, and flags a stale pending login", async () => {
		login("2099-01-01T00:00:00.000Z");
		savePendingLogin("default", {
			version: 1,
			apiBaseUrl: mock.origin,
			clientId: "agx",
			deviceCode: "dc",
			userCode: "WDJB-MJHT",
			verificationUri: `${mock.origin}/auth/device`,
			verificationUriComplete: `${mock.origin}/auth/device?code=WDJB-MJHT`,
			scope: "listings:read",
			interval: 5,
			expiresAt: new Date(clock.now() - 1000).toISOString(),
			createdAt: new Date(clock.now() - 1_801_000).toISOString(),
			lastPolledAt: null,
			hostLabel: "h",
			request: { orgHint: null, newOrg: false, newOrgName: null, newOrgSlug: null },
			replacesApiKeyId: null,
		});
		chmodSync(join(box.home, "credentials.json"), 0o644);
		chmodSync(join(box.home, "profiles", "default", "pending-login.json"), 0o644);
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const { code, checks } = await doctor();
		expect(code).toBe(3);
		const perms = check(checks, "file permissions");
		expect(perms?.verdict).toBe("fail");
		expect(perms?.detail).toContain("credentials.json");
		expect(perms?.detail).toContain("pending-login.json");
		expect(check(checks, "pending login")).toMatchObject({ verdict: "warn", remediation: "agx login" });
	});

	it("reports an abandoned login lock, and --fix-perms removes it; a live one is left alone", async () => {
		login("2099-01-01T00:00:00.000Z");
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const lockPath = join(box.home, "profiles", "default", "pending-login.lock");
		mkdirSync(join(box.home, "profiles", "default"), { recursive: true });

		// Live: pid 1 exists, and its heartbeat is fresh.
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 1, at: new Date(clock.now()).toISOString(), staleAfter: new Date(clock.now() + 60_000).toISOString() }),
		);
		expect(check((await doctor()).checks, "login lock")).toBeUndefined();

		// Abandoned: the heartbeat ran out.
		clock.advance(120_000);
		const stale = check((await doctor()).checks, "login lock");
		expect(stale).toMatchObject({ verdict: "warn" });
		expect(stale?.detail).toContain(lockPath);
		expect(stale?.detail).toMatch(/agx process 1/);
		expect(stale?.remediation).toMatch(/--fix-perms/);
		expect(existsSync(lockPath)).toBe(true);

		const fixed = await agx("doctor", "--fix-perms", "--json");
		const doc = jsonDocuments(fixed.stdout)[0] as { checks: Check[] };
		expect(check(doc.checks, "login lock")).toMatchObject({ verdict: "pass" });
		expect(existsSync(lockPath)).toBe(false);
	});

	it("not logged in: fails with agx login", async () => {
		const { checks } = await doctor();
		expect(check(checks, "api credentials")).toMatchObject({ verdict: "fail" });
		expect(check(checks, "api credentials")?.remediation).toMatch(/agx login/);
	});
});

/** What `--local` leaves out, named as the full doctor names its checks. */
const LOCAL_SKIPPED = [
	"index",
	"api credentials",
	"credential source",
	"login expiry",
	"pending login",
	"login lock",
	"state files",
	"listing",
	"nip-05",
];

describe("agx doctor --local", () => {
	let relay: RunningRelay;
	let relayUrl: string;
	let secretKeyHex: string;
	let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
	const hostedCalls: string[] = [];

	/** The hosted index must never be contacted: every fetch fails the test loudly. */
	function forbidFetch(): void {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			hostedCalls.push(String(input));
			throw new Error("the hosted index was contacted under --local");
		});
	}

	function allowFetch(): void {
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
	}

	beforeEach(async () => {
		hostedCalls.length = 0;
		relay = await startRelay({ port: 0 });
		relayUrl = `ws://127.0.0.1:${relay.port}`;
		const identity = createIdentity();
		secretKeyHex = identity.secretKeyHex;
		saveIdentity("default", identity);
		updateProfile("default", { relays: [relayUrl], allow: [createIdentity().publicKey] });
	});

	afterEach(async () => {
		allowFetch();
		await relay.close();
	});

	async function local(...extra: string[]) {
		const run = await agx("doctor", "--local", "--json", ...extra);
		const doc = jsonDocuments(run.stdout)[0] as { checks?: Check[]; skipped?: string[] } | undefined;
		return { run, code: run.code, checks: doc?.checks ?? [], skipped: doc?.skipped };
	}

	it("passes with an identity, a loopback relay and an allowlist, and never contacts the hosted index", async () => {
		forbidFetch();
		const { run, code, checks } = await local();
		expect(run.stderr).toBe("");
		expect(code).toBe(0);
		expect(checks.map((c) => `${c.verdict} ${c.name}`)).toEqual([
			"pass file permissions",
			"pass identity",
			`pass relay ${relayUrl}`,
			"pass allowlist",
		]);
		// Two independent observers: the fetch double, and the mock index's own log.
		expect(hostedCalls).toEqual([]);
		expect(mock.requests).toEqual([]);
		expect(`${run.stdout}${run.stderr}`).not.toContain(secretKeyHex);
	});

	it("passes when the hosted index is unreachable and no login was ever made", async () => {
		forbidFetch();
		updateProfile("default", { apiBaseUrl: "http://127.0.0.1:1" });
		const { code, checks } = await local();
		expect(code).toBe(0);
		expect(checks.map((c) => c.name)).not.toContain("index");
		expect(hostedCalls).toEqual([]);
	});

	it("does not read the API credential file, nor use AGX_API_KEY", async () => {
		writeFileSync(credentialsPath(), "{ not json", { mode: 0o600 });
		writeFileSync(pendingLoginPath("default"), "{ not json", { mode: 0o600 });
		process.env.AGX_API_KEY = "ela_SENTINELSENTINEL";
		// The control: the full doctor does read it, and fails on it.
		const full = await doctor();
		expect(full.code).toBe(3);
		expect(check(full.checks, "api credentials")).toMatchObject({ verdict: "fail" });

		forbidFetch();
		const { run, code, checks } = await local();
		expect(code).toBe(0);
		expect(checks.map((c) => c.name)).not.toContain("api credentials");
		expect(`${run.stdout}${run.stderr}`).not.toContain("SENTINEL");
		expect(hostedCalls).toEqual([]);
	});

	it("prints each skipped check by name and the command for a full diagnosis", async () => {
		const run = await agx("doctor", "--local");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("agx doctor --local");
		for (const name of LOCAL_SKIPPED) {
			expect(run.stdout, name).toMatch(new RegExp(`^\\s+${name}$`, "m"));
		}
		expect(run.stdout).toMatch(/^\s+agx doctor$/m);
	});

	it("--json adds `skipped`; the full doctor's JSON keeps exactly its old shape", async () => {
		const { skipped } = await local();
		expect(skipped).toEqual(LOCAL_SKIPPED);
		const full = await agx("doctor", "--json");
		expect(Object.keys(jsonDocuments(full.stdout)[0] as object)).toEqual(["checks"]);
	});

	it("fails with exit 3 when the relay is down, and still names the relay", async () => {
		const gone = await startRelay({ port: 0 });
		const goneUrl = `ws://127.0.0.1:${gone.port}`;
		await gone.close();
		updateProfile("default", { relays: [goneUrl] });
		forbidFetch();
		const { code, checks } = await local();
		expect(code).toBe(3);
		expect(check(checks, `relay ${goneUrl}`)).toMatchObject({ verdict: "fail", detail: "unreachable" });
		expect(check(checks, `relay ${goneUrl}`)?.remediation).toMatch(/agx relay/);
		expect(hostedCalls).toEqual([]);
	});

	it("fails with exit 3 when no relay is configured, instead of passing with nothing probed", async () => {
		updateProfile("default", { relays: [] });
		const { code, checks } = await local();
		expect(code).toBe(3);
		expect(check(checks, "relays")).toMatchObject({ verdict: "fail" });
		expect(check(checks, "relays")?.remediation).toMatch(/agx config set relays/);
	});

	it("fails with exit 3 when the profile has no identity, and still checks the relay", async () => {
		const { rmSync } = await import("node:fs");
		rmSync(identityPath("default"));
		const { code, checks } = await local();
		expect(code).toBe(3);
		expect(check(checks, "identity")).toMatchObject({ verdict: "fail", remediation: "agx identity new" });
		expect(check(checks, `relay ${relayUrl}`)).toMatchObject({ verdict: "pass" });
	});

	it("reports a relay that needs NIP-42 AUTH exactly as the full doctor does", async () => {
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await new Promise((resolve) => wss.once("listening", resolve));
		wss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg[0] === "REQ") {
					socket.send(JSON.stringify(["CLOSED", msg[1], "auth-required: sign in first"]));
				}
			});
		});
		try {
			const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
			updateProfile("default", { relays: [url] });
			const full = await doctor();
			const { code, checks } = await local();
			expect(code).toBe(0);
			expect(check(checks, `relay ${url}`)).toMatchObject({ verdict: "warn" });
			expect(check(checks, `relay ${url}`)?.detail).toMatch(/NIP-42/);
			expect(check(checks, `relay ${url}`)).toEqual(check(full.checks, `relay ${url}`));
		} finally {
			await new Promise((resolve) => wss.close(resolve));
		}
	});

	it("fails with exit 3 on a loose secret file, and --fix-perms repairs it; a stale login lock is left alone", async () => {
		chmodSync(identityPath("default"), 0o644);
		writeFileSync(credentialsPath(), "{}", { mode: 0o644 });
		const lock = pendingLoginLockPath("default");
		mkdirSync(dirname(lock), { recursive: true });
		writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date(clock.now()).toISOString() }));
		expect(check((await doctor()).checks, "login lock")).toMatchObject({ verdict: "warn" });

		const broken = await local();
		expect(broken.code).toBe(3);
		const perms = check(broken.checks, "file permissions");
		expect(perms?.verdict).toBe("fail");
		expect(perms?.detail).toContain("identity.json");
		expect(perms?.detail).toContain("credentials.json");

		const fixed = await local("--fix-perms");
		expect(fixed.code).toBe(0);
		expect(check(fixed.checks, "file permissions")?.verdict).toBe("pass");
		expect(statSync(identityPath("default")).mode & 0o077).toBe(0);
		// Removing an abandoned login lock is a hosted-login repair: --local does not do it.
		expect(existsSync(lock)).toBe(true);
	});

	it("fails with exit 3 on an allowlist entry that is not a pubkey, and never prints the entry", async () => {
		const pasted = `nsec1${"q".repeat(58)}`;
		updateProfile("default", { allow: [createIdentity().publicKey, pasted] });
		const { run, code, checks } = await local();
		expect(code).toBe(3);
		expect(check(checks, "allowlist")).toMatchObject({ verdict: "fail" });
		expect(check(checks, "allowlist")?.detail).toMatch(/#2/);
		const human = await agx("doctor", "--local");
		expect(human.code).toBe(3);
		expect(`${run.stdout}${run.stderr}${human.stdout}${human.stderr}`).not.toContain(pasted);
	});

	it("warns, but passes, on an empty allowlist: default-deny is a posture, not a fault", async () => {
		updateProfile("default", { allow: [] });
		const { code, checks } = await local();
		expect(code).toBe(0);
		expect(check(checks, "allowlist")).toMatchObject({ verdict: "warn" });
		expect(check(checks, "allowlist")?.remediation).toMatch(/agx identity allow/);
	});
});
