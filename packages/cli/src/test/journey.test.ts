import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { loadState } from "../lib/state.js";
import { agx, fakeClock, jsonDocuments, sandbox, useClock } from "./helpers.js";
import {
	CONTRACT,
	type KeyRecord,
	type MockIndexServer,
	type MockResponse,
	startMockIndexServer,
} from "./mock-index-server.js";

/**
 * The journey commands against the mock index: idempotent `register`,
 * `listing publish --wait`, the nostr.json body from `domain add`,
 * `domain verify --wait`, and the `peers` scope message.
 */

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;
let key: KeyRecord;

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
	key = mock.addKey({
		scoped: true,
		scopes: CONTRACT.scopes,
		clientId: "agx",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	setCredential("default", {
		apiBaseUrl: mock.origin,
		apiKey: key.key,
		apiKeyId: key.id,
		source: "login",
		clientId: "agx",
		organization: key.organization,
		user: { id: key.user.id, email: "a•••@acme.com" },
		scopes: CONTRACT.scopes,
		expiresAt: key.expiresAt,
		createdAt: new Date(clock.now()).toISOString(),
	});
	updateProfile("default", { apiBaseUrl: mock.origin, orgSlug: "acme-robotics" });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

const listing = (overrides: Record<string, unknown> = {}) => ({
	id: "l_7",
	slug: "invoice-desk",
	displayName: "Invoice Desk",
	handle: null,
	npub: "npub1test",
	verified: false,
	capabilities: ["invoice.review"],
	visibility: "private",
	status: "draft",
	source: "external",
	relays: [],
	...overrides,
});

const rpcError = (name: string): MockResponse => structuredClone(CONTRACT.rpcErrors[name] as MockResponse);
const notFound = (): MockResponse => ({
	status: 404,
	body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "No listing found for that address." } },
});

function lastJson(stdout: string): Record<string, any> {
	return jsonDocuments(stdout).at(-1) as Record<string, any>;
}

describe("agx register (idempotent)", () => {
	beforeEach(async () => {
		expect((await agx("identity", "new")).code).toBe(0);
	});

	it("an owned listing for this key is reported, with no challenge and no create", async () => {
		mock.setRpc("agentIndex/getOwnedListingByAddress", () => ({ output: { listingId: "l_7" } }));
		mock.setRpc("agentIndex/getListing", () => ({ output: { listing: listing(), verificationEvents: [] } }));
		const run = await agx("register", "--slug", "invoice-desk", "--capability", "invoice.review", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(lastJson(run.stdout)).toMatchObject({ resumed: true, listing: { id: "l_7" } });
		expect(mock.calls("/api/rpc/agentIndex/createKeyChallenge")).toHaveLength(0);
		expect(mock.calls("/api/rpc/agentIndex/createListing")).toHaveLength(0);
		expect(loadState("default").listingId).toBe("l_7");
		const lookup = mock.calls("/api/rpc/agentIndex/getOwnedListingByAddress")[0]?.body as { json: Record<string, string> };
		expect(lookup.json.orgSlug).toBe("acme-robotics");
		expect(lookup.json.address).toMatch(/^npub1/);
	});

	function proofFlow(create: () => MockResponse | { output: unknown }) {
		mock.setRpc("agentIndex/getOwnedListingByAddress", () => notFound());
		mock.setRpc("agentIndex/createKeyChallenge", () => ({
			output: { nonce: "n".repeat(32), expiresAt: "2026-09-30T19:00:00Z", pubkey: "x" },
		}));
		mock.setRpc("agentIndex/submitKeyProof", () => ({ output: { ok: true } }));
		mock.setRpc("agentIndex/createListing", create);
	}

	it("NOT_FOUND → the full proof flow and a create", async () => {
		proofFlow(() => ({ output: listing() }));
		const run = await agx("register", "--slug", "invoice-desk", "--capability", "invoice.review", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(mock.calls("/api/rpc/agentIndex/createListing")).toHaveLength(1);
		expect(lastJson(run.stdout).listing.id).toBe("l_7");
	});

	it("a 409 LISTING_ADDRESS_LIVE naming our listing resumes it", async () => {
		proofFlow(() => rpcError("LISTING_ADDRESS_LIVE"));
		mock.setRpc("agentIndex/getListing", () => ({ output: { listing: listing({ status: "listed" }), verificationEvents: [] } }));
		const run = await agx("register", "--slug", "invoice-desk", "--capability", "invoice.review", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(lastJson(run.stdout)).toMatchObject({ resumed: true, listing: { id: "l_7", status: "listed" } });
	});

	it("a 409 LISTING_SLUG_TAKEN is exit 6 with use --slug", async () => {
		proofFlow(() => rpcError("LISTING_SLUG_TAKEN"));
		const run = await agx("register", "--slug", "invoice-desk", "--capability", "invoice.review");
		expect(run.code).toBe(6);
		expect(run.stderr).toMatch(/--slug/);
	});
});

describe("agx listing publish --wait", () => {
	it("announces the confirmation once on stderr, polls getListing every 15 s, exits 0 once public", async () => {
		let reads = 0;
		mock.setRpc("agentIndex/updateListing", () => ({ output: listing({ visibility: "public" }) }));
		mock.setRpc("agentIndex/getListing", () => {
			reads += 1;
			return {
				output: {
					listing: reads < 3 ? listing({ visibility: "public" }) : listing({ visibility: "public", status: "listed" }),
					verificationEvents: [],
				},
			};
		});
		const run = await agx("listing", "publish", "l_7", "--visibility", "public", "--wait", "--json");
		expect(run.code, run.stderr).toBe(0);
		// PATCH, then POST, as in 0.3.
		const order = mock.requests.map((r) => r.path.replace("/api/rpc/agentIndex/", ""));
		expect(order.slice(0, 2)).toEqual(["updateListing", "publishListing"]);
		const handoff = run.stderr.split("\n").filter((l) => l.startsWith('{"actionRequired"'));
		expect(handoff).toHaveLength(1);
		expect(JSON.parse(handoff[0] ?? "{}").actionRequired.url).toBe(`${mock.origin}/elladex/listings/l_7?org=acme-robotics`);
		expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([15000, 15000, 15000]);
		expect(jsonDocuments(run.stdout)).toEqual([
			{ listing: listing({ visibility: "public", status: "listed" }), confirmed: true },
		]);
	});

	it("gives up after --timeout with exit 7 and the actionRequired on stdout", async () => {
		mock.setRpc("agentIndex/getListing", () => ({ output: { listing: listing(), verificationEvents: [] } }));
		const run = await agx("listing", "publish", "l_7", "--wait", "--timeout", "1m", "--json");
		expect(run.code).toBe(7);
		expect(lastJson(run.stdout).actionRequired.reason).toBe("HUMAN_CONFIRMATION_REQUIRED");
		expect(mock.calls("/api/rpc/agentIndex/getListing").length).toBe(4);
	});

	it("without --wait, a gated PATCH is exit 7 straight away", async () => {
		mock.setRpc("agentIndex/updateListing", () => rpcError("HUMAN_CONFIRMATION_REQUIRED"));
		const run = await agx("listing", "publish", "l_7", "--visibility", "public", "--json");
		expect(run.code).toBe(7);
		expect(mock.calls("/api/rpc/agentIndex/publishListing")).toHaveLength(0);
	});
});

describe("agx domain", () => {
	const domain = (verified: boolean) => ({
		id: "d_1",
		domain: "acme.com",
		method: "nip05",
		status: verified ? "verified" : "pending",
		verified,
		verifiedAt: null,
		lastCheckedAt: null,
		consecutiveFailures: 0,
		lastFailureReason: null,
	});

	it("add prints the exact nostr.json body and URL for this profile's key", async () => {
		expect((await agx("identity", "new")).code).toBe(0);
		const shown = jsonDocuments((await agx("identity", "show", "--json")).stdout)[0] as { pubkey: string };
		mock.setRpc("agentIndex/createDomain", () => ({ output: domain(false) }));
		const run = await agx("domain", "add", "acme.com", "--handle", "invoice-desk", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(lastJson(run.stdout).nostrJson).toEqual({
			url: "https://acme.com/.well-known/nostr.json?name=invoice-desk",
			path: "/.well-known/nostr.json",
			body: { names: { "invoice-desk": shown.pubkey } },
		});
		const human = await agx("domain", "add", "acme.com", "--handle", "invoice-desk");
		expect(human.stdout).toContain("https://acme.com/.well-known/nostr.json");
		expect(human.stdout).toContain(`"invoice-desk": "${shown.pubkey}"`);
	});

	it("add refuses a handle that is not a NIP-05 name before claiming the domain", async () => {
		mock.setRpc("agentIndex/createDomain", () => ({ output: domain(false) }));
		expect((await agx("domain", "add", "acme.com", "--handle", "Bad Name")).code).toBe(2);
		expect(mock.calls("/api/rpc/agentIndex/createDomain")).toEqual([]);
		expect(mock.requests).toEqual([]);
	});

	it("verify --wait polls no faster than every 15 s until verified", async () => {
		let calls = 0;
		mock.setRpc("agentIndex/verifyDomain", () => {
			calls += 1;
			return {
				output: { domain: domain(calls >= 3), results: [], checkedCount: 1, totalCandidates: 1 },
			};
		});
		const run = await agx("domain", "verify", "d_1", "--wait", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(calls).toBe(3);
		expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([15000, 15000]);
		expect(lastJson(run.stdout).domain.verified).toBe(true);
	});

	it("verify --wait gives up at --timeout with exit 6", async () => {
		mock.setRpc("agentIndex/verifyDomain", () => ({
			output: { domain: domain(false), results: [], checkedCount: 1, totalCandidates: 1 },
		}));
		const run = await agx("domain", "verify", "d_1", "--wait", "--timeout", "1m");
		expect(run.code).toBe(6);
		// t=0, 15, 30, 45 s; the deadline lands on the next wait.
		expect(mock.calls("/api/rpc/agentIndex/verifyDomain")).toHaveLength(4);
	});

	it("verify without --wait checks once", async () => {
		mock.setRpc("agentIndex/verifyDomain", () => ({
			output: { domain: domain(false), results: [], checkedCount: 1, totalCandidates: 1 },
		}));
		expect((await agx("domain", "verify", "d_1")).code).toBe(0);
		expect(mock.calls("/api/rpc/agentIndex/verifyDomain")).toHaveLength(1);
	});
});

describe("agx peers with a login key", () => {
	it("explains that exchange needs a Settings key (exit 4)", async () => {
		mock.setRpc("exchange/listPeers", () => rpcError("INSUFFICIENT_SCOPE"));
		const run = await agx("peers", "list", "--team", "t_1");
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/does not cover/);
		expect(run.stderr).toMatch(/Settings/);
		expect(run.stderr).toMatch(/--stdin/);
	});
});
