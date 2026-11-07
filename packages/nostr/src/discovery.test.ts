import type { Event } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

// discovery.ts consumes attacker-controlled Agent Cards and NIP-65 relay lists.
// These tests pin the validation + SSRF-fanout caps + NIP-05 verification without
// a relay or network by mocking the relay fetch, the SSRF guard, and global fetch.

const mockFetchByAuthor = vi.fn();
const mockFetchByAuthorWithStatus = vi.fn();
const mockAssertPublicUrl = vi.fn();

vi.mock("./relay-pool", () => ({
	fetchByAuthor: (...a: unknown[]) => mockFetchByAuthor(...a),
	fetchByAuthorWithStatus: (...a: unknown[]) =>
		mockFetchByAuthorWithStatus(...a),
}));
vi.mock("./ssrf", () => ({
	assertPublicUrl: (...a: unknown[]) => mockAssertPublicUrl(...a),
}));

import {
	resolveNip05,
	resolvePeerCard,
	resolvePeerCardWithStatus,
	resolvePeerRelays,
} from "./discovery";
import { CARD_KIND, RELAY_LIST_KIND } from "./kinds";

const PUBKEY = "a".repeat(64);

function relayListEvent(relayUrls: string[]): Event {
	return {
		id: "relaylist",
		pubkey: PUBKEY,
		kind: RELAY_LIST_KIND,
		created_at: 1000,
		tags: relayUrls.map((r) => ["r", r]),
		content: "",
		sig: "s",
	} as Event;
}

function cardEvent(content: unknown): Event {
	return {
		id: "card",
		pubkey: PUBKEY,
		kind: CARD_KIND,
		created_at: 1000,
		tags: [],
		content:
			typeof content === "string" ? content : JSON.stringify(content),
		sig: "s",
	} as Event;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockAssertPublicUrl.mockResolvedValue({ ok: true });
});

describe("resolvePeerCard — attacker-controlled card validation", () => {
	it("returns null for non-JSON card content", async () => {
		mockFetchByAuthor.mockResolvedValue([cardEvent("}{ not json")]);
		expect(await resolvePeerCard(PUBKEY, ["wss://r"])).toBeNull();
	});

	it("returns null for a schema-invalid card (capabilities not string[])", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({ org: "Acme", capabilities: [{ not: "a string" }] }),
		]);
		expect(await resolvePeerCard(PUBKEY, ["wss://r"])).toBeNull();
	});

	it("parses a valid card", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({
				org: "Acme",
				nip05: "acme@example.com",
				capabilities: ["invoice.review"],
			}),
		]);
		const card = await resolvePeerCard(PUBKEY, ["wss://r"]);
		expect(card).toEqual({
			displayName: "Acme",
			capabilities: ["invoice.review"],
			nip05: "acme@example.com",
		});
	});

	it("returns validated typed metadata alongside legacy capabilities", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({
				org: "Acme",
				capabilities: ["invoice.review"],
				skills: [{ id: "invoice.review", description: "Review an invoice" }],
				extensions: [{ uri: "agx.task-status.v1", required: false }],
			}),
		]);
		expect(await resolvePeerCard(PUBKEY, ["wss://r"])).toEqual({
			displayName: "Acme",
			capabilities: ["invoice.review"],
			nip05: null,
			skills: [{ id: "invoice.review", description: "Review an invoice" }],
			extensions: [{ uri: "agx.task-status.v1", required: false }],
		});
	});

	it("preserves legacy discovery and warns when typed metadata is invalid", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({
				org: "Acme",
				nip05: "acme@example.com",
				capabilities: ["invoice.review"],
				skills: [
					{ id: "invoice.review", description: "one" },
					{ id: "invoice.review", description: "duplicate" },
				],
			}),
		]);
		const card = await resolvePeerCard(PUBKEY, ["wss://r"]);
		expect(card).toMatchObject({
			displayName: "Acme",
			capabilities: ["invoice.review"],
			nip05: "acme@example.com",
			typedMetadataWarning: { code: "invalid_typed_metadata" },
		});
		expect(card).not.toHaveProperty("skills");
	});
});

describe("resolvePeerCardWithStatus — an outage is not an empty answer", () => {
	it("no relay answered → no card, and NOT reachable", async () => {
		mockFetchByAuthorWithStatus.mockResolvedValue({
			events: [],
			answered: 0,
		});
		expect(await resolvePeerCardWithStatus(PUBKEY, ["wss://r"])).toEqual({
			card: null,
			reachable: false,
		});
	});

	it("a relay answered with no card → no card, but reachable", async () => {
		mockFetchByAuthorWithStatus.mockResolvedValue({
			events: [],
			answered: 1,
		});
		expect(await resolvePeerCardWithStatus(PUBKEY, ["wss://r"])).toEqual({
			card: null,
			reachable: true,
		});
	});

	it("parses the card the same way resolvePeerCard does", async () => {
		mockFetchByAuthorWithStatus.mockResolvedValue({
			events: [cardEvent({ org: "Acme", nip05: "acme@example.com" })],
			answered: 1,
		});
		expect(await resolvePeerCardWithStatus(PUBKEY, ["wss://r"])).toEqual({
			card: {
				displayName: "Acme",
				capabilities: [],
				nip05: "acme@example.com",
			},
			reachable: true,
		});
	});

	it("no relays at all is not reachable", async () => {
		expect(await resolvePeerCardWithStatus(PUBKEY, [])).toEqual({
			card: null,
			reachable: false,
		});
	});
});

describe("resolvePeerRelays — SSRF fan-out caps", () => {
	it("accepts at most MAX_PEER_RELAYS (10) safe relays", async () => {
		const urls = Array.from(
			{ length: 30 },
			(_, i) => `wss://r${i}.example`,
		);
		mockFetchByAuthor.mockResolvedValue([relayListEvent(urls)]);
		const safe = await resolvePeerRelays(PUBKEY, ["wss://seed"]);
		expect(safe).toHaveLength(10);
		// Stops checking once 10 are accepted (doesn't vet all 30).
		expect(mockAssertPublicUrl).toHaveBeenCalledTimes(10);
	});

	it("DNS-checks at most MAX_PEER_CANDIDATES (20) distinct candidates", async () => {
		const urls = Array.from(
			{ length: 50 },
			(_, i) => `wss://r${i}.example`,
		);
		mockFetchByAuthor.mockResolvedValue([relayListEvent(urls)]);
		mockAssertPublicUrl.mockResolvedValue({ ok: false }); // none pass
		const safe = await resolvePeerRelays(PUBKEY, ["wss://seed"]);
		expect(safe).toHaveLength(0);
		expect(mockAssertPublicUrl).toHaveBeenCalledTimes(20);
	});

	it("dedupes repeated relay URLs before vetting", async () => {
		mockFetchByAuthor.mockResolvedValue([
			relayListEvent(["wss://dup", "wss://dup", "wss://dup"]),
		]);
		await resolvePeerRelays(PUBKEY, ["wss://seed"]);
		expect(mockAssertPublicUrl).toHaveBeenCalledTimes(1);
	});
});

describe("resolveNip05 — domain verification", () => {
	function mockWellKnown(names: Record<string, string>) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				headers: { get: () => null },
				body: {
					getReader() {
						let done = false;
						return {
							read: async () => {
								if (done) {
									return { done: true, value: undefined };
								}
								done = true;
								return {
									done: false,
									value: new TextEncoder().encode(
										JSON.stringify({ names }),
									),
								};
							},
							cancel: async () => undefined,
						};
					},
				},
			})),
		);
	}

	it("rejects when the domain maps the name to a DIFFERENT pubkey", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({ org: "Acme", nip05: "acme@example.com" }),
		]);
		mockWellKnown({ acme: "f".repeat(64) }); // not PUBKEY → mismatch
		expect(
			await resolveNip05({ pubkey: PUBKEY, relays: ["wss://r"] }),
		).toBeNull();
	});

	it("verifies when the domain maps the name back to the peer's pubkey", async () => {
		mockFetchByAuthor.mockResolvedValue([
			cardEvent({ org: "Acme", nip05: "acme@example.com" }),
		]);
		mockWellKnown({ acme: PUBKEY });
		expect(
			await resolveNip05({ pubkey: PUBKEY, relays: ["wss://r"] }),
		).toEqual({
			nip05: "acme@example.com",
			nip05Domain: "example.com",
			nip05Verified: true,
		});
	});
});
