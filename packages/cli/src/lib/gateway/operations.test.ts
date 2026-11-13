import {
	AgxPendingRequestStoreError,
	AgxRequestUnknownError,
	type AgxTransport,
	type PendingRequestRecord,
	type PendingRequestStore,
	parseTaskEnvelope,
} from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import { describe, expect, it, vi } from "vitest";
import { type OperationDeps, runRecoveredTaskRequest, runTaskRequest } from "./operations.js";
import { Requester } from "./requester.js";

const PEER = "b".repeat(64);

function failingDeps(error: Error): OperationDeps {
	return {
		npub: "npub1gateway",
		requester: { request: () => Promise.reject(error) },
	} as unknown as OperationDeps;
}

async function recoveredFailure(error: Error): Promise<unknown> {
	const result = Promise.reject(error);
	result.catch(() => undefined);
	return runRecoveredTaskRequest(failingDeps(error), { taskId: "task-1", peer: PEER, capability: "x.y", result }).catch(
		(caught: unknown) => caught,
	);
}

async function taskFailure(error: Error): Promise<unknown> {
	return runTaskRequest(failingDeps(error), {
		peer: PEER,
		npub: "npub1peer",
		capability: "x.y",
		payload: {},
		timeoutSec: 30,
		checkCard: false,
		background: false,
	}).catch((caught: unknown) => caught);
}

describe("task result errors", () => {
	it("never reads the remote peer's failure text as a local gateway condition", async () => {
		// The peer's `failed` result reaches the gateway as a plain Error with its own text.
		for (const remoteText of ["AGX request outcome unknown", "AGX request storage failed"]) {
			expect(await recoveredFailure(new Error(remoteText))).toMatchObject({ status: 502, code: "task_failed" });
		}
		expect(await recoveredFailure(new AgxRequestUnknownError())).toMatchObject({ status: 409, code: "result_unknown" });
		expect(await recoveredFailure(new AgxPendingRequestStoreError())).toMatchObject({
			status: 500,
			code: "idempotency_store_failed",
		});
	});

	it("says nothing was sent when the first correlation write fails", async () => {
		const unsent = await taskFailure(new AgxPendingRequestStoreError({ mayHavePublished: false }));
		expect(unsent).toMatchObject({ status: 500, code: "idempotency_store_failed" });
		expect((unsent as { description?: string }).description).toMatch(/nothing was sent/i);
		const uncertain = await taskFailure(new AgxPendingRequestStoreError());
		expect((uncertain as { description?: string }).description).toMatch(/checked whether the remote agent executed/i);
	});

	it("reports a stale record found after an idle spell as the gateway's store failure, not the peer's", async () => {
		const records = new Map<string, PendingRequestRecord>();
		let failRemove = false;
		let failList = false;
		const store: PendingRequestStore = {
			list: () => {
				if (failList) throw new Error("EACCES: open '/home/agx/.agx/gateway-task-operations.json'");
				return [...records.values()];
			},
			save: (record) => {
				records.set(record.key, { ...record });
			},
			remove: (key) => {
				if (failRemove) throw new Error("EROFS: read-only file system");
				records.delete(key);
			},
		};
		let requestsSent = 0;
		const transport: AgxTransport = {
			whoami: () => "me",
			publishMessage: async (_to, message) => {
				if (parseTaskEnvelope(message.text)?.t === "req") requestsSent += 1;
				return { ok: true, eventId: "e", contextId: "c" };
			},
			publishReceipt: async () => ({ ok: true }),
			poll: async () => ({ messages: [], receipts: [], complete: true }),
			resolvePeer: async () => ({ relays: [], card: null }),
		};
		const requester = new Requester(transport, undefined, store);
		await requester.restore();
		const deps = { npub: "npub1gateway", requester } as unknown as OperationDeps;
		const task = (operationId: string) =>
			runTaskRequest(
				deps,
				{ peer: PEER, npub: "npub1peer", capability: "x.y", payload: {}, timeoutSec: 1, checkCard: false, background: false },
				undefined,
				operationId,
			).catch((caught: unknown) => caught);
		try {
			// The deadline passes while the disk refuses to remove the record.
			failRemove = true;
			expect(await task("operation-1")).toMatchObject({ status: 504, code: "timeout" });
			expect(records.size).toBe(1);
			failRemove = false;
			await new Promise((resolve) => setTimeout(resolve, 2_200));
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + (MAX_WRAP_BACKDATE_SEC + 60) * 1000);

			// First request after the idle spell: a fresh client restores the stale record.
			const stale = await task("operation-2");
			// Another idle spell, then a request when the store cannot even be read.
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + (MAX_WRAP_BACKDATE_SEC + 60) * 1000);
			failList = true;
			const unreadable = await task("operation-3");
			for (const failure of [stale, unreadable]) {
				expect(failure).toMatchObject({ status: 500, code: "idempotency_store_failed" });
				const text = `${(failure as Error).message} ${(failure as { description?: string }).description}`;
				expect(text).not.toMatch(/npub1peer|reported|recovered|EACCES|agx\//i);
				expect(text).toMatch(/nothing was sent/i);
			}
			expect(requestsSent).toBe(1);
		} finally {
			vi.restoreAllMocks();
			await requester.stop();
		}
	});
});
