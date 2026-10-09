import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "../store/message-store";
import { createAgxStore } from "./agx-store";
import type { UiStore } from "./store";

const BOB_HEX = "1".repeat(64);
const MALLORY_HEX = "2".repeat(64);
const CAROL_HEX = "3".repeat(64);
const BOB = toNpub(BOB_HEX);
const MALLORY = toNpub(MALLORY_HEX);
const AT = "2026-10-07T10:00:00.000Z";

let dir: string;
let messages: MessageStore;
let allowed: Set<string>;
let disk: Set<string>;
let store: UiStore;

function msg(id: string, overrides: Record<string, unknown> = {}) {
	return { id, peer: BOB, subject: "Hi", contextId: "ctx-1", text: "hello", at: AT, ...overrides };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-ui-store-"));
	messages = new MessageStore(dir);
	allowed = new Set();
	disk = new Set();
	store = createAgxStore({
		dir,
		store: messages,
		allowed,
		loadAllow: () => [...disk],
		changeAllow: (hex, on) => {
			if (on) {
				disk.add(hex);
			} else {
				disk.delete(hex);
			}
		},
	});
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("messages and threads", () => {
	it("lists newest first, searches subject, text and peer, and honours limit", () => {
		messages.addInbound(msg("a", { text: "alpha", at: "2026-10-07T10:00:00.000Z" }));
		messages.addInbound(msg("b", { text: "beta needle", at: "2026-10-07T11:00:00.000Z" }));
		messages.addInbound(msg("c", { text: "gamma", at: "2026-10-07T12:00:00.000Z" }));
		expect(store.listMessages({}).map((m) => m.id)).toEqual(["c", "b", "a"]);
		expect(store.listMessages({ query: "NEEDLE" }).map((m) => m.id)).toEqual(["b"]);
		expect(store.listMessages({ limit: 2 }).map((m) => m.id)).toEqual(["c", "b"]);
	});

	it("reports the direction of the newest message in each thread", () => {
		messages.addInbound(msg("a"));
		messages.addOutbound({ ...msg("o1", { at: "2026-10-07T10:05:00.000Z" }), deliveryStatus: "sent" });
		expect(store.listThreads()[0]).toMatchObject({ contextId: "ctx-1", lastDirection: "out", messages: 2 });
		messages.addInbound(msg("b", { at: "2026-10-07T10:10:00.000Z" }));
		expect(store.listThreads()[0]?.lastDirection).toBe("in");
	});

	it("marks a thread read and writes it to disk", () => {
		messages.addInbound(msg("a"));
		store.markThreadRead("ctx-1");
		expect(new MessageStore(dir).listMessages({ unreadOnly: true })).toHaveLength(0);
	});

	it("records an outbound message under the id it was published with", () => {
		const saved = store.recordOutbound({
			id: "event-1",
			direction: "out",
			peer: BOB,
			subject: null,
			contextId: "ctx-9",
			contextIdWithheld: false,
			text: "sent",
			at: AT,
			deliveryStatus: "sent",
		});
		expect(saved).toMatchObject({ id: "event-1", direction: "out", contextId: "ctx-9" });
		expect(new MessageStore(dir).getThread("ctx-9")).toHaveLength(1);
	});
});

describe("held senders", () => {
	beforeEach(() => {
		messages.hold(MALLORY, msg("h1", { peer: MALLORY, text: "let me in", subject: null, contextId: null }));
	});

	it("shows the kept text to the UI", () => {
		expect(store.listHeld()).toMatchObject([{ npub: MALLORY, count: 1, messages: [{ text: "let me in" }] }]);
	});

	it("allow adds the sender to the allowlist, persists it and releases the text", () => {
		store.decideHeld(MALLORY, "allow");
		expect(allowed.has(MALLORY_HEX)).toBe(true);
		expect([...disk]).toEqual([MALLORY_HEX]);
		expect(store.listHeld()).toHaveLength(0);
		expect(new MessageStore(dir).listMessages().map((m) => m.text)).toEqual(["let me in"]);
		expect(store.peerStatus(MALLORY)).toBe("allowed");
	});

	it("ignore drops the text without allowing; block also leaves the allowlist", () => {
		store.decideHeld(MALLORY, "ignore");
		expect(store.peerStatus(MALLORY)).toBe("ignored");
		expect(allowed.size).toBe(0);
		messages.hold(BOB, msg("h2", { peer: BOB }));
		disk.add(BOB_HEX);
		store.decideHeld(BOB, "block");
		expect(allowed.has(BOB_HEX)).toBe(false);
		expect(store.peerStatus(BOB)).toBe("blocked");
		expect(readFileSync(join(dir, "held.jsonl"), "utf8")).not.toContain("let me in");
	});

	it("keeps an allowlist change made elsewhere while the UI runs", () => {
		disk.add(BOB_HEX);
		store.listPeers();
		disk.delete(BOB_HEX);
		disk.add(CAROL_HEX);
		messages.hold(MALLORY, msg("h3", { peer: MALLORY }));
		store.decideHeld(MALLORY, "allow");
		expect([...disk].sort()).toEqual([CAROL_HEX, MALLORY_HEX].sort());
		expect(allowed.has(BOB_HEX)).toBe(false);
		expect(allowed.has(CAROL_HEX)).toBe(true);
	});

	it("rejects a decision about someone who is not held", () => {
		expect(() => store.decideHeld(BOB, "allow")).toThrow("No held sender");
	});
});

describe("peers", () => {
	it("lists allowed peers with their saved label and handle, and ignored or blocked ones", () => {
		store.setPeer({ npub: BOB, status: "allowed", label: "Bob", handle: "bob@example.com", verified: true });
		store.setPeer({ npub: MALLORY, status: "blocked", label: null, handle: null, verified: false });
		const peers = store.listPeers();
		expect(peers).toContainEqual({ npub: BOB, status: "allowed", label: "Bob", handle: "bob@example.com", verified: true });
		expect(peers).toContainEqual({ npub: MALLORY, status: "blocked", label: null, handle: null, verified: false });
		expect(statSync(join(dir, "ui-peers.json")).mode & 0o777).toBe(0o600);
	});

	it("moves a peer between statuses and removes one completely", () => {
		store.setPeer({ npub: BOB, status: "allowed", label: null, handle: null, verified: false });
		store.setPeer({ npub: BOB, status: "ignored", label: null, handle: null, verified: false });
		expect(store.peerStatus(BOB)).toBe("ignored");
		expect(allowed.size).toBe(0);
		store.removePeer(BOB);
		expect(store.peerStatus(BOB)).toBeNull();
		expect(store.listPeers()).toHaveLength(0);
	});
});
