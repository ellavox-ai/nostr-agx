import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HELD_FILE,
	MAX_HELD_PER_SENDER,
	MAX_NEW_SENDERS_PER_HOUR,
	MESSAGES_FILE,
	MessageStore,
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
		store.addInbound(msg({ subject: "a\nb\u001b[31m", text: "l1\r\nl2\u001b[2Jx y\ttab" }));
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
});
