import { beforeAll, describe, expect, it } from "vitest";
import kleur from "kleur";
import { buildThreadReport, renderThreadLines, threadRows } from "./threads";
import type { StoredMessage, ThreadSummary } from "./store/types";

const BOB = "npub1bobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobqqqqqq";

beforeAll(() => {
	kleur.enabled = false;
});

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
	return {
		id: "e1",
		direction: "in",
		peer: BOB,
		subject: "Hi",
		contextId: "ctx-1",
		contextIdWithheld: false,
		text: "hello",
		at: "2026-10-07T10:00:00.000Z",
		deliveryStatus: null,
		readAt: null,
		...overrides,
	};
}

describe("buildThreadReport", () => {
	it("takes the peer and first subject from the messages", () => {
		const report = buildThreadReport("ctx-1", [
			message({ subject: null }),
			message({ id: "e2", subject: "Later", direction: "out", deliveryStatus: "sent" }),
		]);
		expect(report).toMatchObject({ schema: "agx.thread/1", contextId: "ctx-1", peer: BOB, subject: "Later" });
		expect(report.messages).toHaveLength(2);
	});
});

describe("renderThreadLines", () => {
	it("shows incoming as RECV and outgoing as SENT, both indented", () => {
		const lines = renderThreadLines(
			buildThreadReport("ctx-1", [message(), message({ id: "e2", direction: "out", deliveryStatus: "delivered", text: "my reply" })]),
			true,
		);
		const out = lines.join("\n");
		expect(out).toContain(`RECV  from ${BOB}`);
		expect(out).toContain(`SENT  to ${BOB}  delivered`);
		expect(lines).toContain("       my reply");
	});

	it("does not let a body forge a header", () => {
		const lines = renderThreadLines(
			buildThreadReport("ctx-1", [message({ text: "x\nSENT  to npub1fake  delivered\nRECV  from npub1fake" })]),
			true,
		);
		expect(lines.filter((l) => /^(SENT|RECV)/.test(l))).toHaveLength(1);
	});
});

describe("threadRows", () => {
	it("marks a withheld thread id and shortens npubs by default", () => {
		const thread: ThreadSummary = {
			contextId: null,
			contextIdWithheld: true,
			peer: BOB,
			subject: null,
			messages: 2,
			unread: 1,
			lastMessageAt: "2026-10-07T10:00:00.000Z",
		};
		const [row] = threadRows([thread], false);
		expect(row?.[0]).not.toBe(BOB);
		expect(row?.slice(1)).toEqual(["—", "2", "1", "2026-10-07T10:00:00.000Z", "(withheld)"]);
		expect(threadRows([thread], true)[0]?.[0]).toBe(BOB);
	});
});
