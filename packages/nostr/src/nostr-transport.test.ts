import { beforeEach, describe, expect, it, vi } from "vitest";

// `deliveredToPeer` decides whether a send is reported as SUCCESS, and it is a
// TRI-STATE: false (their relays refused), true (one took it), undefined (we
// could not resolve their relays, so we do not know). `egress.ts` and the CLI
// both branch on `!== false`, so collapsing `undefined` into `false` would turn
// every send to a peer without a NIP-65 list into a reported failure, and
// collapsing it into `true` would restore the bug this whole mechanism exists
// to fix. The derivation lives here; egress's own tests supply `deliveredToPeer`
// ready-made, so without this file the half that computes it is never exercised.

const publishToRelays = vi.fn();
const resolvePeerRelays = vi.fn();

vi.mock("./relay-pool", () => ({
	publishToRelays: (...args: unknown[]) => publishToRelays(...args),
	pollInbox: vi.fn(async () => ({ events: [], complete: true })),
	listenEvents: vi.fn(async () => []),
}));
vi.mock("./discovery", async (importOriginal) => ({
	...(await importOriginal<typeof import("./discovery")>()),
	resolvePeerRelays: (...args: unknown[]) => resolvePeerRelays(...args),
}));

import { MAX_BODY } from "@nostr-agx/core";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
	__resetPeerRelayCacheForTests,
	NostrTransport,
} from "./nostr-transport";
import type { RelayFailureKind } from "./relay-pool";
import { localSigner } from "./signer";

const OURS = "wss://ours.example";
const THEIRS = "wss://theirs.example";
const SHARED = "wss://shared.example";

const peerSecret = generateSecretKey();
const PEER = getPublicKey(peerSecret);

/** What `publishToRelays` resolves to, shaped like the real return value.
 * `kind` defaults to "refused" — the verdict case — so a test that means
 * "unreachable" has to say so rather than get it by omission. */
function published(opts: {
	targets: string[];
	rejected?: { relay: string; error: string; kind?: RelayFailureKind }[];
}) {
	const rejected = (opts.rejected ?? []).map((r) => ({
		kind: "refused" as RelayFailureKind,
		...r,
	}));
	const accepted = opts.targets.length - rejected.length;
	return {
		ok: accepted > 0,
		accepted,
		total: opts.targets.length,
		rejected,
		errors: rejected.map((r) => r.error),
	};
}

function transport(relays: string[] = [OURS]): Promise<NostrTransport> {
	return NostrTransport.create({
		signer: localSigner(generateSecretKey()),
		relays,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resolvePeerRelays.mockResolvedValue([]);
	// Module-scoped cache outlives each transport() — clear between cases.
	__resetPeerRelayCacheForTests();
});

describe("publishMessage derives deliveredToPeer", () => {
	it("is FALSE, and ok is false, when every relay the peer advertises refused", async () => {
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: [{ relay: THEIRS, error: "event too large" }],
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		// Ours accepted — so this is NOT a publish failure, it is a DELIVERY
		// failure, and the two need opposite remediations.
		expect(res.accepted).toBe(1);
		expect(res.deliveredToPeer).toBe(false);
		expect(res.ok).toBe(false);
	});

	it("is UNDEFINED, and ok stays true, when the peer advertises no relays", async () => {
		// THE CASE `!== false` EXISTS FOR. A peer with no NIP-65 list is the
		// common case, not an edge one: we published to our own relays and have
		// no way to know whether they read from them. `?? false` here would fail
		// every such send; `?? true` would re-hide a real refusal.
		resolvePeerRelays.mockResolvedValue([]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(res.deliveredToPeer).toBeUndefined();
		expect(res.ok).toBe(true);
	});

	it("is TRUE when a relay we share with the peer accepted", async () => {
		// The peer's relay is also one of ours, so `targets` dedupes to one entry
		// and that single acceptance has to count for BOTH sides.
		resolvePeerRelays.mockResolvedValue([SHARED]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		const res = await (await transport([OURS, SHARED])).publishMessage(
			PEER,
			{
				text: "hi",
			},
		);

		expect(publishToRelays.mock.calls[0][0]).toEqual([OURS, SHARED]);
		expect(res.deliveredToPeer).toBe(true);
		expect(res.ok).toBe(true);
	});

	it("does not blame the peer when NOTHING was reachable", async () => {
		// Our own total outage. Every relay — ours and theirs — failed to dial, so
		// we learned nothing about what the peer's relays would have done:
		// deliveredToPeer is UNKNOWN, not false. `ok` is still false, but via
		// `accepted === 0`, which points at our infrastructure rather than
		// theirs. Those are opposite diagnoses and the reason callers must test
		// `accepted > 0` rather than deliveredToPeer alone.
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: targets.map((relay) => ({
					relay,
					error: "dial failed",
					kind: "unreachable" as RelayFailureKind,
				})),
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(res.accepted).toBe(0);
		expect(res.deliveredToPeer).toBeUndefined();
		expect(res.ok).toBe(false);
	});

	it("counts a duplicated peer relay once", async () => {
		// A peer is free to list the same relay twice. Counting it twice would
		// make `peerAccepted` disagree with how many distinct endpoints exist.
		resolvePeerRelays.mockResolvedValue([THEIRS, THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: [{ relay: THEIRS, error: "blocked: not allowed" }],
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(publishToRelays.mock.calls[0][0]).toEqual([OURS, THEIRS]);
		expect(res.deliveredToPeer).toBe(false);
	});

	it("does NOT call a peer undelivered when their relay was merely unreachable", async () => {
		// THE PAGING BUG. `publishToRelays` used to bucket a connect timeout, a
		// DNS failure and an `OK false` into one undifferentiated `rejected[]`, so
		// a peer's relay restarting during THEIR deploy came back as "every relay
		// they advertise refused it" -> ok:false. Per claude.md, ok:false feeds
		// `escalatePersistentToolBlockers` and pages a human — so a routine
		// restart on someone else's infrastructure woke someone on ours, and the
		// agent resent onto a contextId that already had an audit row.
		//
		// Unreachable is an ABSENCE of information, not a verdict: a relay we
		// could not reach might well have stored it.
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: [
					{
						relay: THEIRS,
						error: "relay connect wss://theirs.example timed out after 8000ms",
						kind: "unreachable",
					},
				],
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(res.deliveredToPeer).toBeUndefined();
		expect(res.ok).toBe(true);
	});

	it("is UNKNOWN, not false, when one peer relay refused and another was unreachable", async () => {
		// Mixed evidence is not a verdict. The unreachable one might have taken
		// it, so "every relay they advertise said no" is not a claim we can make.
		resolvePeerRelays.mockResolvedValue([THEIRS, "wss://other.example"]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: [
					{
						relay: THEIRS,
						error: "event too large",
						kind: "refused",
					},
					{
						relay: "wss://other.example",
						error: "dial failed",
						kind: "unreachable",
					},
				],
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(res.deliveredToPeer).toBeUndefined();
		expect(res.ok).toBe(true);
	});

	it("treats an UNCLASSIFIED rejection as not-accepted, never as accepted", async () => {
		// `kind` is optional on the AgxTransport interface, so a rejection with
		// none is reachable by contract. Subtracting only the two classified
		// buckets counted it as an ACCEPTANCE — deliveredToPeer true, ok true,
		// for a relay that demonstrably did not take the event. Membership in
		// `rejected[]` is the complete answer here.
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) => ({
			ok: true,
			accepted: targets.length - 1,
			total: targets.length,
			// No `kind` — the shape the interface permits.
			rejected: [{ relay: THEIRS, error: "no reason given" }],
			errors: ["no reason given"],
		}));

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		// Not accepted, so not delivered to the peer — and certainly not `true`.
		expect(res.deliveredToPeer).not.toBe(true);
	});

	it("attributes refusals by the SAME string it published to", async () => {
		// The silent-failure mode: `refused` is a Set of `rejected[].relay`, and
		// membership is string identity. If a normalization step ever landed
		// between the resolved peer relay and what comes back attributed, every
		// refusal would miss the set and a refused send would report delivered.
		// Pin that the URL published to is the URL attributed back.
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({
				targets,
				rejected: [
					{ relay: THEIRS, error: "restricted: not authorized" },
				],
			}),
		);

		const res = await (await transport()).publishMessage(PEER, {
			text: "hi",
		});

		expect(publishToRelays.mock.calls[0][0]).toContain(THEIRS);
		expect(res.rejected?.map((r) => r.relay)).toEqual([THEIRS]);
		expect(res.deliveredToPeer).toBe(false);
	});
});

describe("publishMessage measures what it will actually sign", () => {
	// The regression the size guard was added for, asserted for the first time.
	// `canCarry` takes only `text` — that is all the AgxTransport interface gives
	// it — so it substitutes a 200-BYTE subject placeholder. A real subject is 200
	// CHARACTERS, which in CJK is ~600 bytes. That ~500-byte gap would not matter
	// except that the ceiling sits exactly on a NIP-44 chunk boundary, so a body
	// near the limit crosses it only once the real subject is counted.
	//
	// Without this, "simplifying" the guard back to `canCarry(message.text)` —
	// the exact edit its comment is written to prevent — passes every test.
	it("rejects a body canCarry accepts, once the REAL subject is counted", async () => {
		// The literal is deliberate — calibrated to straddle a NIP-44 chunk
		// boundary once the real subject is counted — so it must not quietly
		// become a different case if MAX_BODY moves. @nostr-agx/core pins the value;
		// this asserts it HERE too, so the failure lands in the suite that
		// actually breaks rather than one package over.
		expect(MAX_BODY).toBe(27_400);
		const text = "a".repeat(27_400);
		const subject = "案".repeat(200); // 200 chars = 600 UTF-8 bytes

		const t = await transport();
		// canCarry, with its placeholder, measures a 28,601-byte rumor -> a
		// ~55KB gift wrap, inside the 65,536 interop ceiling.
		expect(t.canCarry(text)).toBe(true);

		// Signed for real the rumor is 29,001 bytes — over the 28,672 chunk
		// boundary — so both NIP-44 layers pad up a step and the wrap is ~66KB,
		// which every default-configured peer relay refuses.
		const res = await t.publishMessage(PEER, { text, subject });

		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		// Never reached the network: a relay that rejects an oversize event does
		// not tell the sender, which is the whole reason this is caught here.
		expect(publishToRelays).not.toHaveBeenCalled();
		// Reported against the interop ceiling, not the character cap — this body
		// is under MAX_BODY and shortening by characters is not the remedy.
		expect(res.errors?.join(" ")).toContain("65536");
	});
});

describe("publishReceipt routes to peer relays", () => {
	// Mirrors the publishMessage routing test above.
	it("publishes to this.relays UNION the peer's cached relays", async () => {
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		const res = await (await transport([OURS])).publishReceipt(PEER, {
			refEventId: "0".repeat(64),
			contextId: "ctx-1",
			status: "delivered",
		});

		expect(publishToRelays.mock.calls[0][0]).toEqual([OURS, THEIRS]);
		expect(res.ok).toBe(true);
	});

	it("dedupes when a relay we share with the peer is in both sets", async () => {
		resolvePeerRelays.mockResolvedValue([SHARED]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		const res = await (await transport([OURS, SHARED])).publishReceipt(
			PEER,
			{
				refEventId: "0".repeat(64),
				contextId: "ctx-1",
				status: "quarantined",
			},
		);

		expect(publishToRelays.mock.calls[0][0]).toEqual([OURS, SHARED]);
		expect(res.ok).toBe(true);
	});

	it("stays best-effort ({ ok }) even when peer relay resolution fails", async () => {
		// cachedPeerRelays already swallows resolvePeerRelays failures via
		// .catch(() => []) — this pins that publishReceipt does not need its
		// own try/catch on top of it.
		resolvePeerRelays.mockRejectedValue(new Error("boom"));
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		const res = await (await transport([OURS])).publishReceipt(PEER, {
			refEventId: "0".repeat(64),
			contextId: "ctx-1",
			status: "delivered",
		});

		expect(publishToRelays.mock.calls[0][0]).toEqual([OURS]);
		expect(res.ok).toBe(true);
	});

	// The cache is module-scoped so it survives ingest.ts's fresh transport
	// per tick — a second instance for the SAME peer must reuse the result.
	it("reuses a cached relay resolution across a NEW transport instance for the SAME team", async () => {
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		// Same team's next tick = same secretKey, not a fresh one.
		const teamSecret = generateSecretKey();
		const teamTransport = () =>
			NostrTransport.create({
				signer: localSigner(teamSecret),
				relays: [OURS],
			});

		await (await teamTransport()).publishReceipt(PEER, {
			refEventId: "0".repeat(64),
			contextId: "ctx-1",
			status: "delivered",
		});
		expect(resolvePeerRelays).toHaveBeenCalledTimes(1);

		// A brand new instance, same team, same peer — simulates the next
		// cron tick.
		await (await teamTransport()).publishReceipt(PEER, {
			refEventId: "1".repeat(64),
			contextId: "ctx-2",
			status: "delivered",
		});
		expect(resolvePeerRelays).toHaveBeenCalledTimes(1);
	});

	it("does NOT share a cached resolution between two different teams' transports", async () => {
		// runExchangeIngest polls several teams concurrently; one team's
		// resolution must not leak to another asking about the same peer.
		resolvePeerRelays.mockResolvedValue([THEIRS]);
		publishToRelays.mockImplementation(async (targets: string[]) =>
			published({ targets }),
		);

		await (await transport([OURS])).publishReceipt(PEER, {
			refEventId: "0".repeat(64),
			contextId: "ctx-1",
			status: "delivered",
		});
		expect(resolvePeerRelays).toHaveBeenCalledTimes(1);

		// A DIFFERENT team (fresh secretKey) asking about the SAME peer.
		await (await transport([OURS])).publishReceipt(PEER, {
			refEventId: "1".repeat(64),
			contextId: "ctx-2",
			status: "delivered",
		});
		expect(resolvePeerRelays).toHaveBeenCalledTimes(2);
	});
});
