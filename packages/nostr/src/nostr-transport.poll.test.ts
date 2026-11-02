import { beforeEach, describe, expect, it, vi } from "vitest";

// poll() is where a re-scanned window turns into CPU: every wrap it opens is
// two ECDHs, one against a key that is never seen twice. These pin that it
// opens only wraps the host has not already handled, and that a wrap it cannot
// accept is reported (once) instead of being re-opened on every poll.

const pollInbox = vi.fn();
vi.mock("./relay-pool", () => ({
	publishToRelays: vi.fn(),
	pollInbox: (...args: unknown[]) => pollInbox(...args),
	listenEvents: vi.fn(async () => [])
}));

import { type Event, finalizeEvent, generateSecretKey } from "nostr-tools";
import { signMessageEvent, signReceiptEvent } from "./events";
import { createRumor, wrapRumor } from "./giftwrap";
import { GIFT_WRAP_KIND, RECEIPT_KIND } from "./kinds";
import { NostrTransport } from "./nostr-transport";
import {
	type AgxSigner,
	AgxSignerUnavailableError,
	isSignerUnavailable,
	localSigner,
} from "./signer";

const aliceSecret = generateSecretKey();
const bobSecret = generateSecretKey();
const alice = localSigner(aliceSecret);

/** Bob's signer, counting decrypts — each one is an ECDH the poll paid for. */
function countingSigner(): { signer: AgxSigner; decrypts: () => number } {
	const inner = localSigner(bobSecret);
	let count = 0;
	return {
		signer: {
			...inner,
			nip44Decrypt: (peer, ciphertext) => {
				count += 1;
				return inner.nip44Decrypt(peer, ciphertext);
			},
		},
		decrypts: () => count,
	};
}

const NOW = Math.floor(Date.now() / 1000);

async function wrapsForBob() {
	const bob = await localSigner(bobSecret).getPublicKey();
	const message = await signMessageEvent({
		signer: alice,
		recipientPubkey: bob,
		text: "hello",
		nowSec: NOW,
	});
	const receipt = await signReceiptEvent({
		signer: alice,
		recipientPubkey: bob,
		refEventId: "0".repeat(64),
		contextId: "ctx",
		status: "delivered",
		nowSec: NOW,
	});
	return { bob, message, receipt };
}

/** A kind-1059 addressed to Bob that is not a real wrap: junk anyone can post. */
function junkWrap(bob: string): Event {
	return finalizeEvent(
		{
			kind: GIFT_WRAP_KIND,
			created_at: NOW,
			tags: [
				["p", bob],
				["expiration", String(NOW + 3600)],
			],
			content: "not-a-nip44-payload",
		},
		generateSecretKey(),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("NostrTransport.poll pre-filters by wrap id", () => {
	it("opens nothing the host already knows", async () => {
		const { message, receipt } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event, receipt.event],
			complete: true,
		});
		const { signer, decrypts } = countingSigner();
		const transport = await NostrTransport.create({ signer, relays: [] });

		const res = await transport.poll({
			since: 0,
			isKnown: async (ids) => new Set(ids),
		});

		expect(decrypts()).toBe(0);
		expect(res.messages).toEqual([]);
		expect(res.receipts).toEqual([]);
		expect(res.discarded).toEqual([]);
	});

	it("opens only the unknown wraps, and tags each result with its wrap id", async () => {
		const { message, receipt } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event, receipt.event],
			complete: true,
		});
		const { signer, decrypts } = countingSigner();
		const transport = await NostrTransport.create({ signer, relays: [] });

		const res = await transport.poll({
			since: 0,
			isKnown: async () => new Set([receipt.event.id]),
		});

		expect(decrypts()).toBe(2); // one wrap: outer + seal
		expect(res.receipts).toEqual([]);
		expect(res.messages).toHaveLength(1);
		expect(res.messages[0].eventId).toBe(message.rumorId);
		expect(res.messages[0].transportId).toBe(message.event.id);
	});

	it("still opens everything when the caller gives no isKnown", async () => {
		const { message, receipt } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event, receipt.event],
			complete: true,
		});
		const transport = await NostrTransport.create({
			signer: localSigner(bobSecret),
			relays: [],
		});
		const res = await transport.poll({ since: 0 });
		expect(res.messages).toHaveLength(1);
		expect(res.receipts).toHaveLength(1);
		expect(res.receipts[0].transportId).toBe(receipt.event.id);
	});
});

describe("NostrTransport.poll reports what it cannot accept", () => {
	it("discards junk wraps and expired wraps, and warns once per poll", async () => {
		const { bob, message } = await wrapsForBob();
		const expired = { ...message.event, tags: [["expiration", "1000"]] };
		const junk = [junkWrap(bob), junkWrap(bob), junkWrap(bob)];
		pollInbox.mockResolvedValue({
			events: [...junk, expired],
			complete: true,
		});
		const warn = vi.fn();
		const transport = await NostrTransport.create({
			signer: localSigner(bobSecret),
			relays: [],
			logger: { warn },
		});

		const res = await transport.poll({ since: 0 });

		expect(res.messages).toEqual([]);
		expect([...(res.discarded ?? [])].sort()).toEqual(
			[...junk.map((j) => j.id), expired.id].sort(),
		);
		// Rolled up: three junk wraps, one log line.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toMatchObject({
			undecryptableOrUnverifiable: 3,
		});
	});

	it("does not warn on a clean poll", async () => {
		const { message } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event],
			complete: true,
		});
		const warn = vi.fn();
		const transport = await NostrTransport.create({
			signer: localSigner(bobSecret),
			relays: [],
			logger: { warn },
		});
		await transport.poll({ since: 0 });
		expect(warn).not.toHaveBeenCalled();
	});
});

/** Bob's signer, whose decrypts start failing with `err` after `okDecrypts`. */
function failingSigner(err: Error, okDecrypts = 0): AgxSigner {
	const inner = localSigner(bobSecret);
	let count = 0;
	return {
		...inner,
		nip44Decrypt: (peer, ciphertext) => {
			count += 1;
			return count > okDecrypts
				? Promise.reject(err)
				: inner.nip44Decrypt(peer, ciphertext);
		},
	};
}

describe("NostrTransport.poll survives a signer outage", () => {
	it("discards nothing and reports the poll incomplete when the signer is unreachable", async () => {
		// A bunker that is offline says nothing about the wraps. Treating that
		// as "cannot open" would record every real message in the window as
		// discarded, and isKnown would skip them forever after.
		const { message, receipt } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event, receipt.event],
			complete: true,
		});
		const warn = vi.fn();
		const transport = await NostrTransport.create({
			signer: failingSigner(
				new AgxSignerUnavailableError("bunker offline"),
			),
			relays: [],
			logger: { warn },
		});

		const res = await transport.poll({ since: 0 });

		expect(res.discarded).toEqual([]);
		expect(res.complete).toBe(false);
		expect(res.messages).toEqual([]);
		expect(res.receipts).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toMatchObject({
			error: "bunker offline",
		});
	});

	it("returns what it opened before the outage and leaves the rest", async () => {
		const { message, receipt } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event, receipt.event],
			complete: true,
		});
		const transport = await NostrTransport.create({
			// Two decrypts open the first wrap (outer + seal); the third fails.
			signer: failingSigner(new AgxSignerUnavailableError(), 2),
			relays: [],
		});

		const res = await transport.poll({ since: 0 });

		expect(res.messages.map((m) => m.transportId)).toEqual([
			message.event.id,
		]);
		expect(res.receipts).toEqual([]);
		expect(res.discarded).toEqual([]);
		expect(res.complete).toBe(false);
	});

	it("still discards a wrap whose decrypt fails for any other reason", async () => {
		const { message } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [message.event],
			complete: true,
		});
		const transport = await NostrTransport.create({
			signer: failingSigner(new Error("invalid MAC")),
			relays: [],
		});

		const res = await transport.poll({ since: 0 });

		expect(res.discarded).toEqual([message.event.id]);
		expect(res.complete).toBe(true);
	});
});

describe("isSignerUnavailable", () => {
	it("recognises the error by class and by name, and nothing else", () => {
		// By name: a signer bundled with its own copy of this package throws an
		// instance of a different class.
		const foreign = new Error("offline");
		foreign.name = "AgxSignerUnavailableError";
		expect(isSignerUnavailable(new AgxSignerUnavailableError())).toBe(true);
		expect(isSignerUnavailable(foreign)).toBe(true);
		expect(isSignerUnavailable(new Error("invalid MAC"))).toBe(false);
		expect(isSignerUnavailable("AgxSignerUnavailableError")).toBe(false);
	});
});

describe("NostrTransport.poll forwards evidence", () => {
	it("hands the host the evidence the sender signed, and none when it sent none", async () => {
		const bob = await localSigner(bobSecret).getPublicKey();
		const evidence = {
			v: 1 as const,
			records: [
				{
					key: { field: "roNumber", value: "0057658556" },
					fields: { status: "Repair In Process" },
					observedAt: "2026-10-20T14:03:11.000Z",
				},
			],
		};
		const withEvidence = await signMessageEvent({
			signer: alice,
			recipientPubkey: bob,
			text: "status update",
			evidence,
			nowSec: NOW,
		});
		const { message: without } = await wrapsForBob();
		pollInbox.mockResolvedValue({
			events: [withEvidence.event, without.event],
			complete: true,
		});
		const transport = await NostrTransport.create({
			signer: localSigner(bobSecret),
			relays: [],
		});

		const res = await transport.poll({ since: 0 });

		const byId = new Map(res.messages.map((m) => [m.eventId, m]));
		expect(byId.get(withEvidence.rumorId)?.evidence).toEqual(evidence);
		expect(byId.get(without.rumorId)).not.toHaveProperty("evidence");
	});
});

/** A receipt rumor from Alice to Bob with whatever payload a test needs, wrapped
 * the way signReceiptEvent wraps one: how a NEWER peer's receipt (or a broken
 * one) arrives. */
async function receiptWrapWithPayload(payload: unknown): Promise<Event> {
	const bob = await localSigner(bobSecret).getPublicKey();
	const rumor = createRumor({
		pubkey: await alice.getPublicKey(),
		kind: RECEIPT_KIND,
		tags: [
			["p", bob],
			["e", "0".repeat(64)],
		],
		content: JSON.stringify(payload),
		nowSec: NOW,
	});
	return wrapRumor({ signer: alice, rumor, recipientPubkey: bob, nowSec: NOW });
}

describe("NostrTransport.poll and receipt statuses", () => {
	async function pollWith(events: Event[]) {
		pollInbox.mockResolvedValue({ events, complete: true });
		const warn = vi.fn();
		const transport = await NostrTransport.create({
			signer: localSigner(bobSecret),
			relays: [],
			logger: { warn },
		});
		return { res: await transport.poll({ since: 0 }), warn };
	}

	it("forwards a read receipt with when it was read", async () => {
		const bob = await localSigner(bobSecret).getPublicKey();
		const read = await signReceiptEvent({
			signer: alice,
			recipientPubkey: bob,
			refEventId: "0".repeat(64),
			contextId: "ctx",
			status: "read",
			readAt: "2026-10-20T15:36:12.000Z",
			nowSec: NOW,
		});

		const { res, warn } = await pollWith([read.event]);

		expect(res.receipts).toHaveLength(1);
		expect(res.receipts[0].receipt).toMatchObject({
			status: "read",
			readAt: "2026-10-20T15:36:12.000Z",
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("ignores a receipt whose status a newer peer added: no receipt, no warning", async () => {
		const wrap = await receiptWrapWithPayload({
			v: 1,
			kind: "receipt",
			refEventId: "0".repeat(64),
			contextId: "ctx",
			status: "replied",
		});

		const { res, warn } = await pollWith([wrap]);

		expect(res.receipts).toEqual([]);
		expect(res.messages).toEqual([]);
		// Recorded as seen, so the next poll does not open it again.
		expect(res.discarded).toEqual([wrap.id]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("still counts a broken receipt as malformed, and warns", async () => {
		const wrap = await receiptWrapWithPayload({ v: 1, kind: "receipt" });

		const { res, warn } = await pollWith([wrap]);

		expect(res.receipts).toEqual([]);
		expect(res.discarded).toEqual([wrap.id]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toMatchObject({ malformedRumor: 1 });
	});
});
