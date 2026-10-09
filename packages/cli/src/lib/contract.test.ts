import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heldList, INBOX_SCHEMA, type InboxReport, summarize } from "./inbox";
import { MessageStore } from "./store/message-store";
import { buildThreadReport, HELD_SCHEMA } from "./threads";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/samples");
const NOW = new Date("2026-10-07T12:00:00.000Z");
const BOB = "npub1bobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobqqqqqq";
const MALLORY = "npub1mallorymallorymallorymallorymallorymallorymallorymallory00";

type Json = Record<string, unknown>;

function sample(name: string): Json {
	return JSON.parse(readFileSync(join(SAMPLES, name), "utf8")) as Json;
}

/** Field names at every level; an array is reduced to the union of its elements' fields. */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) {
		const keys = new Set(value.flatMap((item) => (item !== null && typeof item === "object" ? Object.keys(item) : [])));
		return value.length > 0 && keys.size > 0 ? [Object.fromEntries([...keys].sort().map((key) => [key, "field"]))] : value.length > 0 ? [shape(value[0])] : [];
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, shape((value as Json)[key])]),
		);
	}
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? "leaf" : "null";
}

let dir: string;
let store: MessageStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-contract-"));
	store = new MessageStore(dir, () => NOW);
	store.addInbound({ id: "e1", peer: BOB, subject: "S", contextId: "ctx-1", text: "t", at: NOW.toISOString() });
	store.addOutbound({ id: "o1", peer: BOB, subject: null, contextId: "ctx-1", text: "r", at: "2026-10-07T12:01:00.000Z", deliveryStatus: "sent" });
	store.hold(MALLORY, { id: "h1", peer: MALLORY, subject: null, contextId: null, text: "x", at: NOW.toISOString() });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("docs/samples match what the CLI produces", () => {
	it("agx.inbox/1", () => {
		const report: InboxReport = {
			schema: INBOX_SCHEMA,
			fetchedAt: NOW.toISOString(),
			npub: BOB,
			relays: [{ url: "wss://a", status: "ok" }],
			messages: store.listMessages(),
			held: heldList(store),
			receipts: [{ from: BOB, ref: "r", status: "delivered", at: NOW.toISOString() }],
			truncated: false,
		};
		expect(Object.keys(report).sort()).toEqual(Object.keys(sample("inbox.json")).sort());
		const expected = shape(sample("inbox.json")) as Json;
		expect(shape(report)).toEqual(expected);
	});

	it("agx.inbox.summary/1", () => {
		const report = { relays: [{ url: "a", status: "ok" }], held: heldList(store) } as InboxReport;
		expect(shape(summarize(report, 1, 1))).toEqual(shape(sample("inbox-summary.json")));
	});

	it("agx.threads/1", () => {
		const out = { schema: "agx.threads/1", threads: store.listThreads() };
		expect(shape(out)).toEqual(shape(sample("threads.json")));
	});

	it("agx.thread/1", () => {
		const out = buildThreadReport("ctx-1", store.getThread("ctx-1"));
		expect(shape(out)).toEqual(shape(sample("thread.json")));
	});

	it("agx.held/1 carries a count and no text", () => {
		const out = { schema: HELD_SCHEMA, held: heldList(store) };
		expect(Object.keys(out.held[0] ?? {}).sort()).toEqual(["count", "firstSeenAt", "from"]);
		expect(JSON.stringify(out)).not.toContain('"text"');
	});
});
