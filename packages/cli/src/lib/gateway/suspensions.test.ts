import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../../test/helpers.js";
import { gatewayTaskSuspensionsPath, writePrivateText } from "../paths.js";
import { FileSuspensionStore } from "./suspensions";

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

function record() {
	return {
		taskId: "task-1",
		capability: "approval",
		payload: { invoice: 42 },
		from: "requester",
		contextId: "task-1",
		question: { kind: "text" as const, prompt: "Answer?" },
		resumeSchema: { type: "object" },
		expiresAt: 4_000_000_000,
		seq: 1,
		state: { durable: true },
		createdAt: 1_000,
		resuming: false,
	};
}

describe("FileSuspensionStore", () => {
	it("persists suspended state across instances and deletes it after completion", async () => {
		const store = new FileSuspensionStore("test");
		await store.put(record());
		expect(await new FileSuspensionStore("test").list()).toEqual([record()]);
		expect(JSON.parse(readFileSync(gatewayTaskSuspensionsPath("test"), "utf8"))).toMatchObject({
			version: 1,
			suspensions: [{ taskId: "task-1", state: { durable: true } }],
		});

		await store.delete("task-1");
		expect(await new FileSuspensionStore("test").list()).toEqual([]);
	});

	it("fails loudly for a corrupt store instead of discarding suspended work", async () => {
		writePrivateText(gatewayTaskSuspensionsPath("test"), "not json");
		await expect(new FileSuspensionStore("test").list()).rejects.toThrow();
	});
});
