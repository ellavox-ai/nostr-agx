import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HELD_FILE,
	MAX_HELD_PER_SENDER,
	MAX_NEW_SENDERS_PER_HOUR,
	MESSAGES_FILE,
	MessageStore,
	SPOOL_DIR,
	HELD_TTL_MS,
	MAX_HELD_TEXT_CHARS,
	MAX_HELD_TOTAL_BYTES,
} from "./message-store";
import type { NewMessage } from "./types";

const BOB = "npub1bobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobqqqqqq";
const MALLORY = "npub1mallorymallorymallorymallorymallorymallorymallorymallory00";

let dir: string;
let clock: Date;

function open(): MessageStore {
	return new MessageStore(dir, () => clock);
}

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
	return {
		id: "e1",
		peer: BOB,
		subject: "Hello",
		contextId: "ctx-1",
		text: "hi",
		at: "2026-10-07T10:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-store-"));
	clock = new Date("2026-10-07T12:00:00.000Z");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("messages", () => {
	it("stores an inbound message once and survives a reopen", () => {
		const store = open();
		expect(store.addInbound(msg())).toBe(true);
		expect(store.addInbound(msg())).toBe(false);
		store.flush();
		const again = open().listMessages();
		expect(again).toHaveLength(1);
		expect(again[0]).toMatchObject({ id: "e1", direction: "in", readAt: null, text: "hi" });
	});

	it("writes files readable only by the owner, one JSON record per line", () => {
		const store = open();
		store.addInbound(msg());
		store.addInbound(msg({ id: "e2", at: "2026-10-07T10:01:00.000Z" }));
		store.flush();
		const path = join(dir, MESSAGES_FILE);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("writes nothing when nothing changed", () => {
		open().flush();
		expect(() => statSync(join(dir, MESSAGES_FILE))).toThrow();
	});

	it("records outbound messages as already read", () => {
		const store = open();
		store.addOutbound({ ...msg({ id: "o1" }), deliveryStatus: "sent" });
		expect(store.listMessages({ direction: "out" })[0]).toMatchObject({
			direction: "out",
			deliveryStatus: "sent",
			readAt: "2026-10-07T10:00:00.000Z",
		});
		expect(store.listMessages({ unreadOnly: true })).toHaveLength(0);
	});

	it("neutralizes control characters but keeps line breaks in the body", () => {
		const store = open();
		store.addInbound(msg({ subject: "a\nb\u001b[31m", text: "l1\r\nl2\u001b[2Jx\u2028y\ttab" }));
		const [stored] = store.listMessages();
		expect(stored?.subject).toBe("a�b�[31m");
		expect(stored?.text).toBe("l1\nl2�[2Jx�y\ttab");
	});

	it("withholds an unsafe contextId instead of storing it", () => {
		const store = open();
		store.addInbound(msg({ contextId: "x; rm -rf ~" }));
		expect(store.listMessages()[0]).toMatchObject({ contextId: null, contextIdWithheld: true });
	});

	it("filters by thread, peer, direction and unread", () => {
		const store = open();
		store.addInbound(msg({ id: "a", contextId: "t1" }));
		store.addInbound(msg({ id: "b", contextId: "t2", at: "2026-10-07T10:05:00.000Z" }));
		store.addOutbound({ ...msg({ id: "c", contextId: "t1", at: "2026-10-07T10:10:00.000Z" }), deliveryStatus: "sent" });
		expect(store.getThread("t1").map((m) => m.id)).toEqual(["a", "c"]);
		expect(store.listMessages({ unreadOnly: true }).map((m) => m.id)).toEqual(["a", "b"]);
		expect(store.listMessages({ peer: MALLORY })).toHaveLength(0);
		expect(store.listMessages({ direction: "out" }).map((m) => m.id)).toEqual(["c"]);
	});

	it("marks a thread or ids read and reports how many changed", () => {
		const store = open();
		store.addInbound(msg({ id: "a", contextId: "t1" }));
		store.addInbound(msg({ id: "b", contextId: "t1", at: "2026-10-07T10:01:00.000Z" }));
		expect(store.markRead({ ids: ["a"] })).toBe(1);
		expect(store.markRead({ contextId: "t1" })).toBe(1);
		expect(store.markRead({ contextId: "t1" })).toBe(0);
		expect(store.listMessages({ unreadOnly: true })).toHaveLength(0);
	});

	it("skips a torn line and drops it on the next flush", () => {
		const store = open();
		store.addInbound(msg());
		store.flush();
		const path = join(dir, MESSAGES_FILE);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"torn"\nnot json\n`);
		const reopened = open();
		expect(reopened.listMessages()).toHaveLength(1);
		reopened.addInbound(msg({ id: "e2", at: "2026-10-07T10:01:00.000Z" }));
		reopened.flush();
		expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(2);
	});
});

describe("threads", () => {
	it("summarises by contextId, newest first, with unread counts", () => {
		const store = open();
		store.addInbound(msg({ id: "a", contextId: "t1", subject: "One" }));
		store.addInbound(msg({ id: "b", contextId: "t2", subject: "Two", at: "2026-10-07T11:00:00.000Z" }));
		store.addOutbound({ ...msg({ id: "c", contextId: "t1", subject: null, at: "2026-10-07T11:30:00.000Z" }), deliveryStatus: "sent" });
		const threads = store.listThreads();
		expect(threads.map((t) => t.contextId)).toEqual(["t1", "t2"]);
		expect(threads[0]).toMatchObject({ messages: 2, unread: 1, subject: "One", peer: BOB });
	});

	it("groups messages without a contextId by peer", () => {
		const store = open();
		store.addInbound(msg({ id: "a", contextId: null }));
		store.addInbound(msg({ id: "b", contextId: null, at: "2026-10-07T10:01:00.000Z" }));
		store.addInbound(msg({ id: "c", contextId: null, peer: MALLORY, at: "2026-10-07T10:02:00.000Z" }));
		expect(store.listThreads().map((t) => [t.peer, t.messages])).toEqual([
			[MALLORY, 1],
			[BOB, 2],
		]);
	});
});

describe("held senders", () => {
	it("keeps text and counts messages per sender", () => {
		const store = open();
		expect(store.hold(MALLORY, msg({ id: "h1", text: "let me in" }))).toBe("kept");
		expect(store.hold(MALLORY, msg({ id: "h2" }))).toBe("kept");
		expect(store.hold(MALLORY, msg({ id: "h2" }))).toBe("duplicate");
		const [held] = store.listHeld();
		expect(held).toMatchObject({ npub: MALLORY, status: "held", count: 2 });
		expect(held?.messages.map((m) => m.text)).toEqual(["let me in", "hi"]);
		store.flush();
		expect(statSync(join(dir, HELD_FILE)).mode & 0o777).toBe(0o600);
		expect(open().listHeld()[0]?.messages).toHaveLength(2);
	});

	it("never mixes held text into the history", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "h1" }));
		expect(store.listMessages()).toHaveLength(0);
		expect(store.listThreads()).toHaveLength(0);
	});

	it("caps stored messages per sender but keeps counting", () => {
		const store = open();
		for (let i = 0; i < MAX_HELD_PER_SENDER + 5; i += 1) {
			store.hold(MALLORY, msg({ id: `h${i}` }));
		}
		const [held] = store.listHeld();
		expect(held?.messages).toHaveLength(MAX_HELD_PER_SENDER);
		expect(held?.count).toBe(MAX_HELD_PER_SENDER + 5);
		expect(store.hold(MALLORY, msg({ id: "late" }))).toBe("capped");
	});

	it("limits new unknown senders per hour and recovers after it", () => {
		const store = open();
		for (let i = 0; i < MAX_NEW_SENDERS_PER_HOUR; i += 1) {
			expect(store.hold(`npub1sender${i}`, msg({ id: `s${i}` }))).toBe("kept");
		}
		expect(store.hold("npub1onetoomany", msg({ id: "x" }))).toBe("rate-limited");
		expect(store.listHeld()).toHaveLength(MAX_NEW_SENDERS_PER_HOUR);
		expect(store.hold("npub1sender0", msg({ id: "again" }))).toBe("kept");
		clock = new Date(clock.getTime() + 61 * 60 * 1000);
		expect(store.hold("npub1onetoomany", msg({ id: "x" }))).toBe("kept");
	});

	it("releases held text into the history, oldest first, and forgets the sender", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "h1", text: "second", at: "2026-10-07T10:02:00.000Z" }));
		store.hold(MALLORY, msg({ id: "h2", text: "first", at: "2026-10-07T10:01:00.000Z" }));
		expect(store.releaseHeld(MALLORY)).toBe(2);
		expect(store.listHeld()).toHaveLength(0);
		expect(store.listMessages().map((m) => [m.peer, m.text, m.readAt])).toEqual([
			[MALLORY, "first", null],
			[MALLORY, "second", null],
		]);
		expect(store.releaseHeld(MALLORY)).toBe(0);
	});

	it("drops the text on ignore or block and then keeps later messages out", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "h1", text: "secret plea" }));
		expect(store.dismissHeld(MALLORY, "blocked")).toBe(true);
		expect(store.listHeld()).toHaveLength(0);
		expect(store.heldStatus(MALLORY)).toBe("blocked");
		expect(store.hold(MALLORY, msg({ id: "h2" }))).toBe("suppressed");
		store.flush();
		expect(readFileSync(join(dir, HELD_FILE), "utf8")).not.toContain("secret plea");
		expect(store.dismissHeld("npub1nobody", "ignored")).toBe(false);
	});

	it("does not release an ignored sender's text, which is gone", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "h1" }));
		store.dismissHeld(MALLORY, "ignored");
		expect(store.releaseHeld(MALLORY)).toBe(0);
		expect(store.listMessages()).toHaveLength(0);
	});

	it("records a block for a sender who sent nothing and keeps their later messages out", () => {
		const store = open();
		store.setSenderStatus(MALLORY, "blocked");
		expect(store.heldStatus(MALLORY)).toBe("blocked");
		expect(store.listHeld()).toHaveLength(0);
		expect(store.hold(MALLORY, msg({ id: "h1" }))).toBe("suppressed");
	});

	it("turns an existing held sender into a block and drops the text", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "h1", text: "plea" }));
		store.setSenderStatus(MALLORY, "blocked");
		expect(store.heldStatus(MALLORY)).toBe("blocked");
		store.flush();
		expect(readFileSync(join(dir, HELD_FILE), "utf8")).not.toContain("plea");
	});
});

describe("delivery receipts", () => {
	it("updates only the outbound message it refers to, and only from the peer it went to", () => {
		const store = open();
		store.addInbound(msg({ id: "in1" }));
		store.addOutbound({ ...msg({ id: "out1", at: "2026-10-07T10:01:00.000Z" }), deliveryStatus: "sent" });
		expect(store.setDeliveryStatus("in1", "delivered", BOB)).toBe(false);
		expect(store.setDeliveryStatus("out1", "delivered", MALLORY)).toBe(false);
		expect(store.listMessages({ direction: "out" })[0]?.deliveryStatus).toBe("sent");
		expect(store.setDeliveryStatus("out1", "delivered", BOB)).toBe(true);
		expect(store.listMessages({ direction: "out" })[0]?.deliveryStatus).toBe("delivered");
	});
});

describe("the spool", () => {
	const sent = { id: "out1", peer: BOB, subject: "S", contextId: "ctx-1", text: "sent text", at: "2026-10-07T10:00:00.000Z", deliveryStatus: "sent" };
	const spoolFiles = (): string[] => (existsSync(join(dir, SPOOL_DIR)) ? readdirSync(join(dir, SPOOL_DIR)) : []);

	it("writes one private file per change and no temporary file", () => {
		MessageStore.spoolOutbound(dir, sent);
		MessageStore.spoolOutbound(dir, { ...sent, id: "out2" });
		const files = spoolFiles();
		expect(files).toHaveLength(2);
		expect(files.every((f) => f.endsWith(".json"))).toBe(true);
		expect(statSync(join(dir, SPOOL_DIR, files[0] as string)).mode & 0o777).toBe(0o600);
	});

	it("lets a reader see a sent message without changing any file", () => {
		MessageStore.spoolOutbound(dir, sent);
		const reader = open();
		expect(reader.listMessages({ direction: "out" }).map((m) => m.text)).toEqual(["sent text"]);
		reader.flush();
		expect(existsSync(join(dir, MESSAGES_FILE))).toBe(false);
		expect(spoolFiles()).toHaveLength(1);
	});

	it("is applied by the writer, written to the history, then removed", () => {
		MessageStore.spoolOutbound(dir, sent);
		MessageStore.spoolOutbound(dir, { ...sent, id: "out2", at: "2026-10-07T10:01:00.000Z" });
		const writer = new MessageStore(dir, () => clock, { claimSpool: true });
		expect(writer.listMessages({ direction: "out" })).toHaveLength(2);
		expect(spoolFiles()).toHaveLength(2);
		writer.flush();
		expect(spoolFiles()).toEqual([]);
		expect(open().listMessages({ direction: "out" })).toHaveLength(2);
	});

	it("keeps a send that lands while the writer is working, for the next flush", () => {
		MessageStore.spoolOutbound(dir, sent);
		const writer = new MessageStore(dir, () => clock, { claimSpool: true });
		MessageStore.spoolOutbound(dir, { ...sent, id: "late", at: "2026-10-07T10:02:00.000Z" });
		writer.flush();
		expect(spoolFiles()).toHaveLength(1);
		expect(open().listMessages({ direction: "out" }).map((m) => m.id)).toEqual(["out1", "late"]);
		const next = new MessageStore(dir, () => clock, { claimSpool: true });
		next.flush();
		expect(spoolFiles()).toEqual([]);
		expect(open().listMessages({ direction: "out" }).map((m) => m.id)).toEqual(["out1", "late"]);
	});

	it("applies a file left by a crash once, without duplicating", () => {
		MessageStore.spoolOutbound(dir, sent);
		new MessageStore(dir, () => clock, { claimSpool: true });
		const next = new MessageStore(dir, () => clock, { claimSpool: true });
		next.flush();
		expect(open().listMessages({ direction: "out" }).map((m) => m.id)).toEqual(["out1"]);
		expect(spoolFiles()).toEqual([]);
	});

	it("skips a spool file that is not valid and leaves it in place", () => {
		MessageStore.spoolOutbound(dir, sent);
		writeFileSync(join(dir, SPOOL_DIR, "000-bad.json"), "{not json");
		const writer = new MessageStore(dir, () => clock, { claimSpool: true });
		writer.flush();
		expect(open().listMessages({ direction: "out" })).toHaveLength(1);
		expect(spoolFiles()).toEqual(["000-bad.json"]);
	});

	it("queues a held decision and a mark-read for the lock holder", () => {
		const first = open();
		first.hold(MALLORY, msg({ id: "h1", peer: MALLORY, contextId: "ctx-2" }));
		first.addInbound(msg({ id: "in1" }));
		first.flush();
		MessageStore.spool(dir, { kind: "decision", action: "allow", npub: MALLORY });
		MessageStore.spool(dir, { kind: "read", contextId: "ctx-1" });
		const reader = open();
		expect(reader.listHeld()).toEqual([]);
		expect(reader.listMessages({ unreadOnly: true }).map((m) => m.id)).toEqual(["h1"]);
		const writer = new MessageStore(dir, () => clock, { claimSpool: true });
		writer.flush();
		expect(spoolFiles()).toEqual([]);
		const after = open();
		expect(after.listMessages({ unreadOnly: true }).map((m) => m.id)).toEqual(["h1"]);
		expect(after.listHeld()).toEqual([]);
		expect(after.listMessages().map((m) => m.id).sort()).toEqual(["h1", "in1"]);
	});

	it("queues a block", () => {
		MessageStore.spool(dir, { kind: "decision", action: "block", npub: MALLORY });
		new MessageStore(dir, () => clock, { claimSpool: true }).flush();
		expect(open().heldStatus(MALLORY)).toBe("blocked");
	});
});

describe("held limits", () => {
	it("cuts one very long held message", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "big", peer: MALLORY, text: "x".repeat(MAX_HELD_TEXT_CHARS * 3) }));
		const kept = store.listHeld()[0]?.messages[0]?.text ?? "";
		expect(kept.length).toBeLessThan(MAX_HELD_TEXT_CHARS + 20);
		expect(kept.endsWith("[cut off]")).toBe(true);
	});

	it("drops the oldest held text when the total is too large, and keeps the count", () => {
		const store = open();
		const chunk = "😀".repeat(MAX_HELD_TEXT_CHARS / 2);
		let n = 0;
		for (let sender = 0; sender < MAX_NEW_SENDERS_PER_HOUR; sender += 1) {
			const peer = `npub1sender${sender}`;
			for (let i = 0; i < MAX_HELD_PER_SENDER; i += 1) {
				n += 1;
				store.hold(peer, msg({ id: `m${n}`, peer, text: chunk, at: new Date(Date.UTC(2026, 9, 7, 10, 0, 0, n)).toISOString() }));
			}
		}
		const bytes = store.listHeld().flatMap((h) => h.messages).reduce((sum, m) => sum + Buffer.byteLength(m.text), 0);
		expect(bytes).toBeLessThanOrEqual(MAX_HELD_TOTAL_BYTES);
		expect(store.listHeld().reduce((sum, h) => sum + h.count, 0)).toBe(n);
		const ids = store.listHeld().flatMap((h) => h.messages.map((m) => m.id));
		expect(ids).not.toContain("m1");
		expect(ids).toContain(`m${n}`);
	});

	it("drops held text past its age limit when the store opens", () => {
		const store = open();
		store.hold(MALLORY, msg({ id: "old", peer: MALLORY, at: new Date(clock.getTime() - HELD_TTL_MS - 1000).toISOString() }));
		store.hold(MALLORY, msg({ id: "new", peer: MALLORY, at: clock.toISOString() }));
		store.flush();
		const later = open();
		const sender = later.listHeld()[0];
		expect(sender?.messages.map((m) => m.id)).toEqual(["new"]);
		expect(sender?.count).toBe(2);
	});
});

describe("records from a newer version", () => {
	it("keeps a line this version cannot read, and extra fields, when it rewrites a file", () => {
		const first = open();
		first.addInbound(msg({ id: "in1" }));
		first.flush();
		const path = join(dir, MESSAGES_FILE);
		const future = JSON.stringify({ id: "x1", direction: "sideways", kind: "reaction" });
		const known = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
		writeFileSync(path, `${JSON.stringify({ ...known, pinned: true })}\n${future}\ntorn{\n`);
		const store = open();
		store.markRead({ ids: ["in1"] });
		store.flush();
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toMatchObject({ id: "in1", pinned: true });
		expect(lines[1]).toBe(future);
	});

	it("keeps an unknown held record as written", () => {
		const path = join(dir, HELD_FILE);
		const future = JSON.stringify({ npub: MALLORY, status: "muted", firstSeenAt: "2026-10-07T10:00:00.000Z", count: 1, messages: [] });
		writeFileSync(path, `${future}\n`);
		const store = open();
		store.hold(BOB, msg({ id: "h1" }));
		store.flush();
		expect(readFileSync(path, "utf8")).toContain(future);
	});
});
