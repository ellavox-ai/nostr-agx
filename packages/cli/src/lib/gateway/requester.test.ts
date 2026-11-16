import type { AgxPollResult, AgxTransport, PendingRequestStore } from "@nostr-agx/core";
import { describe, expect, it } from "vitest";
import { Requester } from "./requester.js";

/** A transport that sends, and never brings a result back. */
function silentTransport() {
	let polls = 0;
	const transport: AgxTransport = {
		whoami: () => "me",
		publishMessage: async () => ({ ok: true, eventId: "e", contextId: "c" }),
		publishReceipt: async () => ({ ok: true }),
		poll: async (): Promise<AgxPollResult> => {
			polls += 1;
			return { messages: [], receipts: [], complete: true };
		},
		resolvePeer: async () => ({ relays: [], card: null }),
	};
	return { transport, polls: () => polls };
}

describe("Requester", () => {
	it("stops waiting, and polling, when its caller goes away", async () => {
		const { transport, polls } = silentTransport();
		const requester = new Requester(transport);
		const gone = new AbortController();
		const result = requester.request("peer", "x.y", {}, 60_000, gone.signal);
		await new Promise((r) => setTimeout(r, 1500));
		expect(polls()).toBeGreaterThan(0);
		gone.abort();
		await expect(result).rejects.toThrow("abandoned");
		const after = polls();
		await new Promise((r) => setTimeout(r, 2500));
		// Nobody waits: the result poll has stopped.
		expect(polls()).toBeLessThanOrEqual(after + 1);
		requester.stop();
	});

	it("restores the full gateway waiting capacity", async () => {
		const { transport } = silentTransport();
		const records = Array.from({ length: 320 }, (_, index) => ({
			key: `operation-${index}`,
			taskId: `task-${index}`,
			peer: "peer",
			capability: "x.y",
			deadlineAt: null,
			phase: "waiting" as const,
		}));
		const store: PendingRequestStore = {
			list: () => records,
			save: () => undefined,
			remove: () => undefined,
		};
		const requester = new Requester(transport, undefined, store);
		const recovered = await requester.restore();
		expect(recovered).toHaveLength(320);
		await requester.stop();
	});
});
