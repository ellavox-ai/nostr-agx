import { describe, expect, it, vi } from "vitest";
import { TaskEventStream, TaskEventStreams } from "./task-events";

const working = (seq: number, message?: string) => ({
	taskId: "remote",
	status: "working" as const,
	seq,
	...(message === undefined ? {} : { message }),
});

describe("TaskEventStream", () => {
	it("assigns ordered IDs and replays only later events", () => {
		const stream = new TaskEventStream();
		stream.push(working(1, "one"));
		stream.push(working(2, "two"));
		expect(stream.after(0).map((event) => event.id)).toEqual([1, 2]);
		expect(stream.after(1).map((event) => event.data.message)).toEqual(["two"]);
	});

	it("takes one terminal ID after its events and ignores later updates", () => {
		const stream = new TaskEventStream();
		stream.push(working(1));
		stream.markTerminal();
		stream.markTerminal();
		stream.push(working(2));
		expect(stream.isTerminal()).toBe(true);
		expect(stream.getTerminalId()).toBe(2);
		expect(stream.after(0).map((event) => event.id)).toEqual([1]);
	});

	it("stores no terminal view", () => {
		const stream = new TaskEventStream();
		stream.push(working(1, "one"));
		const before = stream.bytes();
		stream.markTerminal();
		expect(stream.bytes()).toBe(before);
		expect(stream).not.toHaveProperty("complete");
		expect(stream.after(0).every((event) => event.event === "working")).toBe(true);
	});

	it("keeps at most 128 buffered events", () => {
		const stream = new TaskEventStream();
		for (let seq = 1; seq <= 130; seq += 1) {
			stream.push(working(seq));
		}
		const events = stream.after(0);
		expect(events).toHaveLength(128);
		expect(events[0].id).toBe(3);
		expect(events.at(-1)?.id).toBe(130);
	});

	it("caps one stream's buffered events at 64 KiB, dropping the oldest", () => {
		const stream = new TaskEventStream();
		// Control characters are escaped as \u00XX in JSON: about 12 KB each.
		for (let seq = 1; seq <= 10; seq += 1) {
			stream.push(working(seq, "\u0001".repeat(2_000)));
		}
		expect(stream.bytes()).toBeLessThanOrEqual(64 * 1024);
		const events = stream.after(0);
		expect(events[0].id).toBeGreaterThan(1);
		expect(events.at(-1)?.id).toBe(10);
	});

	it("places a recreated terminal after the client's last ID", () => {
		const fresh = new TaskEventStream();
		fresh.markTerminal(58);
		expect(fresh.getTerminalId()).toBe(58);

		const used = new TaskEventStream();
		for (let seq = 1; seq <= 4; seq += 1) {
			used.push(working(seq));
		}
		used.markTerminal(2);
		expect(used.getTerminalId()).toBe(5);
	});

	it("notifies subscribers on push and terminal, and not after unsubscribe", () => {
		const stream = new TaskEventStream();
		const listener = vi.fn();
		const unsubscribe = stream.subscribe(listener);
		stream.push(working(1));
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		stream.push(working(2));
		stream.markTerminal();
		expect(listener).toHaveBeenCalledTimes(1);

		const terminal = vi.fn();
		const other = new TaskEventStream();
		other.subscribe(terminal);
		other.markTerminal();
		expect(terminal).toHaveBeenCalledTimes(1);
	});
});

describe("TaskEventStreams", () => {
	it("keeps the existing stream for an idempotent background handle", () => {
		const streams = new TaskEventStreams();
		const first = streams.ensure("task_public");
		first.push(working(1));
		expect(streams.ensure("task_public")).toBe(first);
		expect(streams.get("task_public")?.after(0)).toHaveLength(1);
	});

	it("keeps buffered events of all streams under the total budget, evicting finished streams first", () => {
		const streams = new TaskEventStreams({ maxTotalBytes: 30_000, firstEventId: 1 });
		const big = "\u0001".repeat(2_000); // about 12 KB once escaped
		const a = streams.ensure("A");
		// The finished stream holds the least, so only the finished-first rule picks it.
		a.push(working(1, "\u0001".repeat(1_000)));
		a.markTerminal();
		const b = streams.ensure("B");
		b.push(working(1, big));
		const c = streams.ensure("C");
		c.push(working(1, big));

		expect(a.after(0)).toHaveLength(0);
		expect(b.after(0)).toHaveLength(1);
		expect(c.after(0)).toHaveLength(1);
		expect(streams.totalBytes()).toBeLessThanOrEqual(30_000);
		expect(a.getTerminalId()).toBe(2);
	});

	it("drops the largest running stream's oldest event once no finished stream has any", () => {
		const streams = new TaskEventStreams({ maxTotalBytes: 30_000, firstEventId: 1 });
		const big = "\u0001".repeat(2_000);
		const a = streams.ensure("A");
		a.push(working(1, big));
		a.push(working(2, big));
		const b = streams.ensure("B");
		b.push(working(1, big));

		expect(streams.totalBytes()).toBeLessThanOrEqual(30_000);
		expect(a.after(0).map((event) => event.id)).toEqual([2]);
		expect(b.after(0)).toHaveLength(1);
	});

	it("never evicts a running stream while a finished one can go", () => {
		const streams = new TaskEventStreams({ maxStreams: 2 });
		streams.ensure("A");
		streams.ensure("B").markTerminal();
		streams.ensure("C");
		expect(streams.get("A")).toBeDefined();
		expect(streams.get("B")).toBeUndefined();
		expect(streams.get("C")).toBeDefined();
	});

	it("numbers events from one rising counter shared by every stream", () => {
		const streams = new TaskEventStreams({ firstEventId: 500 });
		const a = streams.ensure("A");
		const b = streams.ensure("B");
		a.push(working(1));
		b.push(working(1));
		a.markTerminal();
		expect(a.after(0)[0].id).toBe(500);
		expect(b.after(0)[0].id).toBe(501);
		expect(a.getTerminalId()).toBe(502);
		// Default: start time in microseconds, above any earlier process's IDs.
		const before = Date.now() * 1000;
		const fresh = new TaskEventStreams().ensure("C");
		fresh.markTerminal();
		expect(fresh.getTerminalId()).toBeGreaterThanOrEqual(before);
	});

	it("drops streams untouched for 24 hours", () => {
		let now = 1_000_000;
		const retentionMs = 24 * 60 * 60 * 1000;
		const streams = new TaskEventStreams({ now: () => now });
		streams.ensure("A");
		now += retentionMs - 1;
		expect(streams.get("A")).toBeDefined();
		now += retentionMs + 1;
		expect(streams.get("A")).toBeUndefined();
	});
});
