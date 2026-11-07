import { describe, expect, it } from "vitest";
import { TaskEventStream, TaskEventStreams } from "./task-events";

describe("TaskEventStream", () => {
	it("assigns ordered IDs and replays only later events", () => {
		const stream = new TaskEventStream();
		stream.push({ taskId: "remote", status: "working", seq: 1, message: "one" });
		stream.push({ taskId: "remote", status: "working", seq: 2, message: "two" });
		expect(stream.after(0).map((event) => event.id)).toEqual([1, 2]);
		expect(stream.after(1).map((event) => event.data.message)).toEqual(["two"]);
	});

	it("emits one terminal event and ignores later updates", () => {
		const stream = new TaskEventStream();
		stream.push({ taskId: "remote", status: "working", seq: 1 });
		stream.complete({ id: "task_public", status: "completed", result: { ok: true } });
		stream.complete({ id: "task_public", status: "failed" });
		stream.push({ taskId: "remote", status: "working", seq: 2 });
		expect(stream.isTerminal()).toBe(true);
		expect(stream.after(0)).toHaveLength(2);
		expect(stream.after(0)[1]).toMatchObject({
			event: "completed",
			data: { id: "task_public", result: { ok: true } },
		});
	});

	it("bounds intermediate replay without losing the terminal view", () => {
		const stream = new TaskEventStream();
		for (let seq = 1; seq <= 130; seq += 1) {
			stream.push({ taskId: "remote", status: "working", seq });
		}
		stream.complete({ id: "task_public", status: "failed", error: { code: "task_failed" } });
		const events = stream.after(0);
		expect(events).toHaveLength(128);
		expect(events.at(-1)).toMatchObject({ event: "failed", data: { id: "task_public" } });
	});
});

describe("TaskEventStreams", () => {
	it("keeps the existing stream for an idempotent background handle", () => {
		const streams = new TaskEventStreams();
		const first = streams.ensure("task_public");
		first.push({ taskId: "remote", status: "working", seq: 1 });
		expect(streams.ensure("task_public")).toBe(first);
		expect(streams.get("task_public")?.after(0)).toHaveLength(1);
	});
});
