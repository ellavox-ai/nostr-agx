import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { savePendingLogin } from "../lib/device-flow.js";
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
