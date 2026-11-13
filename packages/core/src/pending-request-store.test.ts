import { describe, expect, it, vi } from "vitest";
import { AgxClient } from "./client";
import { randomId } from "./id";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";
import type { AgxIncomingMessage, AgxTransport } from "./transport";
import { TASK_CONTENT_TYPE } from "./wire";

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

type PendingPhase = "publishing" | "waiting";
type PendingRecord = {
	key: string;
	taskId: string;
	peer: string;
	capability: string;
	deadlineAt: number | null;
	phase: PendingPhase;
};
type Recovered = { key: string; taskId: string; result: Promise<unknown> };
type RecoveringClient = AgxClient & {
	restorePendingRequests(): Promise<Recovered[]>;
	stop(opts?: { preservePending?: boolean }): Promise<void>;
};

class MemoryPendingStore {
	readonly records = new Map<string, PendingRecord>();
	readonly removed: string[] = [];
	readonly saves: PendingPhase[] = [];
	failSavePhase?: PendingPhase;
	failRemove = false;
	/** Refuse to save a key that was already removed, as a settled gateway operation does. */
	rejectSaveAfterRemove = false;
	/** When set, the next list() or remove() waits for it (an asynchronous store). */
	listGate?: Promise<void>;
	removeGate?: Promise<void>;
	/** When set, the next save() records its write only once this opens (an asynchronous store). */
	saveGate?: Promise<void>;

	list(): PendingRecord[] | Promise<PendingRecord[]> {
		const read = () => [...this.records.values()].map((record) => ({ ...record }));
		const gate = this.listGate;
		this.listGate = undefined;
		return gate ? gate.then(read) : read();
	}

	save(record: PendingRecord): void | Promise<void> {
		this.saves.push(record.phase);
		const gate = this.saveGate;
		this.saveGate = undefined;
		if (gate) {
			return gate.then(() => this.write(record));
		}
		this.write(record);
	}

	private write(record: PendingRecord): void {
		if (this.failSavePhase === record.phase) {
			throw new Error("disk full");
		}
		if (this.rejectSaveAfterRemove && this.removed.includes(record.key)) {
			throw new Error("operation already settled");
		}
		this.records.set(record.key, { ...record });
	}

	remove(key: string): void | Promise<void> {
		const gate = this.removeGate;
		this.removeGate = undefined;
		if (gate) return gate.then(() => this.remove(key));
		if (this.failRemove) {
			throw new Error("read-only disk");
		}
		this.removed.push(key);
		this.records.delete(key);
	}
}

class MemoryTransport {
	private sequence = 0;
	readonly inbox = new Map<string, AgxIncomingMessage[]>();
	readonly sent: Array<{ from: string; to: string; text: string; contextId: string }> = [];

	constructor(private readonly identity: string) {}

	transport(): AgxTransport {
		return {
			whoami: () => this.identity,
			publishMessage: async (to, message) => {
				const contextId = message.contextId ?? randomId();
				this.sent.push({ from: this.identity, to, text: message.text, contextId });
				this.push(to, this.identity, message.text, contextId);
				return { ok: true, eventId: `sent-${this.sequence}`, contextId };
			},
			publishReceipt: async () => ({ ok: true }),
			poll: async () => ({
				messages: [...(this.inbox.get(this.identity) ?? [])],
				receipts: [],
				complete: true,
			}),
			resolvePeer: async () => ({ relays: [], card: null }),
		};
	}

	push(to: string, from: string, text: string, contextId: string): string {
		const eventId = `event-${++this.sequence}`;
		const messages = this.inbox.get(to) ?? [];
		messages.push({
			from,
			text,
			contextId,
			eventId,
			createdAt: this.sequence,
			messageId: eventId,
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		this.inbox.set(to, messages);
		return eventId;
	}

	result(to: string, from: string, taskId: string, contextId = taskId): string {
		return this.push(
			to,
			from,
			encodeTaskEnvelope({ t: "res", taskId, status: "completed", output: { ok: true } }),
			contextId,
		);
	}

	requests(to: string): string[] {
		return this.sent
			.filter((message) => message.to === to)
			.map((message) => parseTaskEnvelope(message.text))
			.filter((envelope) => envelope?.t === "req")
			.map((envelope) => envelope && envelope.t === "req" ? envelope.taskId : "");
	}
}

function durableClient(
	bus: MemoryTransport,
	store: MemoryPendingStore,
	extra: { maxRestoredRequests?: number; onMessage?: ReturnType<typeof vi.fn> } = {},
): RecoveringClient {
	return new AgxClient({
		transport: bus.transport(),
		pendingRequests: store,
		startCursor: 0,
		...extra,
	} as unknown as ConstructorParameters<typeof AgxClient>[0]) as RecoveringClient;
}

async function restore(client: RecoveringClient): Promise<Recovered[]> {
	return client.restorePendingRequests();
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not become true");
}

function seed(
	store: MemoryPendingStore,
	record: Partial<PendingRecord> & { key: string; taskId: string },
): PendingRecord {
	const full: PendingRecord = {
		peer: BOB,
		capability: "math.add",
		deadlineAt: Date.now() + 60_000,
		phase: "waiting",
		...record,
	};
	store.records.set(full.key, full);
	return full;
}

describe("durable pending-request recovery", () => {
	it("accepts the original peer's result after restart without publishing another task", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const first = durableClient(bus, store);
		await restore(first);
		const original = first.request(BOB, "math.add", { a: 2, b: 3 }, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => bus.requests(BOB).length === 1);
		const taskId = bus.requests(BOB)[0];
		await first.stop({ preservePending: true });
		await expect(original).rejects.toThrow("AGX client stopped");

		const second = durableClient(bus, store);
		const recovered = await restore(second);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ key: taskId, taskId });
		bus.result(ALICE, BOB, taskId);
		await second.pump();
		await expect(recovered[0].result).resolves.toEqual({ ok: true });
		expect(bus.requests(BOB)).toEqual([taskId]);
		await second.stop();
	});

	it("keeps wrong-peer and context-mismatch forgeries pending after restart", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		let settled = false;
		void recovered.result.finally(() => { settled = true; }).catch(() => undefined);

		bus.result(ALICE, CAROL, "task-1");
		await client.pump();
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);
		bus.result(ALICE, BOB, "task-1", "another-context");
		await client.pump();
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);

		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		await client.stop();
	});

	it("settles a duplicate result only once and removes correlation once", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const onMessage = vi.fn();
		const client = durableClient(bus, store, { onMessage });
		const [recovered] = await restore(client);
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		expect(store.removed).toEqual(["local-1"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		await client.stop();
	});

	it("expires a restored request against its original deadline", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: Date.now() - 1 });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		await expect(recovered.result).rejects.toThrow(/timed out/);
		expect(store.records.has("local-1")).toBe(false);
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await client.stop();
	});

	it("does not give a restored request a fresh timeout window", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: Date.now() + 20 });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		let timedOut = false;
		void recovered.result.catch((error: Error) => {
			timedOut = /timed out/.test(error.message);
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(timedOut).toBe(true);
		expect(store.records.has("local-1")).toBe(false);
		await client.stop();
	});

	it("recovers a publishing record as unknown and never republishes it", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", phase: "publishing" });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		await expect(recovered.result).rejects.toThrow(/unknown/i);
		expect(store.records.has("local-1")).toBe(false);
		expect(bus.requests(BOB)).toEqual([]);
		await client.stop();
	});

	it("does not publish when the initial durable write fails", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		store.failSavePhase = "publishing";
		const client = durableClient(bus, store);
		await restore(client);
		await expect(
			client.request(BOB, "math.add", {}, { timeoutMs: 0 }),
		).rejects.toThrow(/storage failed/i);
		expect(bus.requests(BOB)).toEqual([]);
		await client.stop();
	});

	it("reports an uncertain outcome and cancels when the waiting write fails after publish", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		store.failSavePhase = "waiting";
		const client = durableClient(bus, store);
		await restore(client);
		await expect(
			client.request(BOB, "math.add", {}, { timeoutMs: 0 }),
		).rejects.toThrow(/storage failed/i);
		expect(bus.requests(BOB)).toHaveLength(1);
		await waitFor(() => bus.sent.some((message) => parseTaskEnvelope(message.text)?.t === "cancel"));
		await client.stop();
	});

	it("holds dispatch and does not settle when final correlation removal fails", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		store.failRemove = true;
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		let settled = false;
		void recovered.result.finally(() => { settled = true; }).catch(() => undefined);
		bus.result(ALICE, BOB, "task-1");
		const failedPump = await client.pump();
		expect(failedPump.complete).toBe(false);
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);

		store.failRemove = false;
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		await client.stop();
	});

	it("preserves waiting records only for an explicit restart stop", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const first = durableClient(bus, store);
		await restore(first);
		const pending = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		pending.catch(() => undefined);
		await waitFor(() => bus.requests(BOB).length === 1);
		const taskId = bus.requests(BOB)[0];
		await first.stop({ preservePending: true });
		expect(store.records.has(taskId)).toBe(true);
		expect(bus.sent.filter((message) => parseTaskEnvelope(message.text)?.t === "cancel")).toHaveLength(0);

		const second = durableClient(bus, store);
		const [recovered] = await restore(second);
		recovered.result.catch(() => undefined);
		await second.stop();
		expect(store.records.has(taskId)).toBe(false);
		await waitFor(() => bus.sent.some((message) => parseTaskEnvelope(message.text)?.t === "cancel"));
	});

	it("requires restoration before polling or starting live delivery", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const client = durableClient(bus, store);
		await expect(client.pump()).rejects.toThrow(/restore/i);
		await expect(client.start({ pollIntervalMs: 0, advertise: false })).rejects.toThrow(/restore/i);
		await restore(client);
		await client.pump();
		await client.stop();
	});

	it("bounds restored records and rejects malformed records before receiving", async () => {
		const bus = new MemoryTransport(ALICE);
		const crowded = new MemoryPendingStore();
		seed(crowded, { key: "local-1", taskId: "task-1" });
		seed(crowded, { key: "local-2", taskId: "task-2" });
		const limited = durableClient(bus, crowded, { maxRestoredRequests: 1 });
		await expect(restore(limited)).rejects.toThrow(/too many|limit/i);

		const malformed = new MemoryPendingStore();
		seed(malformed, { key: "local-1", taskId: "task-1", peer: "" });
		const client = durableClient(bus, malformed);
		await expect(restore(client)).rejects.toThrow(/invalid|record/i);
	});
});

/** Holds task requests (not cancels) until released, like a slow relay acknowledgement. */
function gatedTransport(bus: MemoryTransport) {
	const base = bus.transport();
	let gate: Promise<void> | undefined;
	let open: () => void = () => undefined;
	const transport: AgxTransport = {
		...base,
		publishMessage: async (to, message) => {
			if (gate && parseTaskEnvelope(message.text)?.t === "req") await gate;
			return base.publishMessage(to, message);
		},
	};
	return {
		transport,
		hold() {
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
		},
		release: () => open(),
	};
}

function clientOn(transport: AgxTransport, store: MemoryPendingStore): RecoveringClient {
	return new AgxClient({
		transport,
		pendingRequests: store,
		startCursor: 0,
	} as unknown as ConstructorParameters<typeof AgxClient>[0]) as RecoveringClient;
}

function cancels(bus: MemoryTransport): number {
	return bus.sent.filter((message) => parseTaskEnvelope(message.text)?.t === "cancel").length;
}

function gate(): { promise: Promise<void>; open: () => void } {
	let open: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("durable pending-request races", () => {
	it("keeps the waiting record and sends no cancel when a restart stop lands during publish", async () => {
		const bus = new MemoryTransport(ALICE);
		const gated = gatedTransport(bus);
		const store = new MemoryPendingStore();
		const first = clientOn(gated.transport, store);
		await restore(first);
		gated.hold();
		const original = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => store.records.size === 1);
		const stopping = first.stop({ preservePending: true });
		gated.release();
		await stopping;
		await expect(original).rejects.toThrow("AGX client stopped");
		await waitFor(() => bus.requests(BOB).length === 1);
		await settle();
		const [taskId] = bus.requests(BOB);
		expect([...store.records.values()]).toEqual([expect.objectContaining({ taskId, phase: "waiting" })]);
		expect(cancels(bus)).toBe(0);

		const second = durableClient(bus, store);
		const [recovered] = await restore(second);
		bus.result(ALICE, BOB, taskId);
		await second.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		expect(bus.requests(BOB)).toEqual([taskId]);
		await second.stop();
	});

	it("leaves no orphan record when the same process restarts as soon as a restart stop returns mid-publish", async () => {
		const bus = new MemoryTransport(ALICE);
		const gated = gatedTransport(bus);
		const store = new MemoryPendingStore();
		const first = clientOn(gated.transport, store);
		await restore(first);
		gated.hold();
		const original = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => store.records.size === 1);
		// The host builds its next client on the same store the moment stop() returns.
		const restarted = first.stop({ preservePending: true }).then(async () => {
			const second = durableClient(bus, store);
			return { second, recovered: await restore(second) };
		});
		await settle();
		gated.release();
		const { second, recovered } = await restarted;
		await settle();
		const [taskId] = bus.requests(BOB);
		expect(recovered).toEqual([expect.objectContaining({ taskId })]);
		bus.result(ALICE, BOB, taskId);
		await second.pump();
		await expect(recovered[0].result).resolves.toEqual({ ok: true });
		expect(store.records.size).toBe(0);
		expect(await restore(durableClient(bus, store))).toEqual([]);
		expect(bus.requests(BOB)).toEqual([taskId]);
		expect(cancels(bus)).toBe(0);
		await second.stop();
	});

	it("leaves no record to recover as unknown when a restart stop lands during the first save", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const firstSave = gate();
		store.saveGate = firstSave.promise;
		const first = durableClient(bus, store);
		await restore(first);
		const original = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => store.saves.length === 1);
		const stopping = first.stop({ preservePending: true });
		await settle();
		firstSave.open();
		await stopping;
		await expect(original).rejects.toThrow("AGX client stopped");
		await settle();
		expect(bus.requests(BOB)).toEqual([]);
		expect(store.records.size).toBe(0);

		const second = durableClient(bus, store);
		expect(await restore(second)).toEqual([]);
		await second.stop();
	});

	it("still reports the stop when the store throws while removing the first record", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const firstSave = gate();
		store.saveGate = firstSave.promise;
		const first = durableClient(bus, store);
		await restore(first);
		const original = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => store.saves.length === 1);
		const stopping = first.stop({ preservePending: true });
		await settle();
		store.failRemove = true;
		firstSave.open();
		await stopping;
		await expect(original).rejects.toThrow("AGX client stopped");
		expect(bus.requests(BOB)).toEqual([]);
	});

	it("keeps the record of a request sent earlier under a reused storage key when a restart stop lands during the first save", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const first = durableClient(bus, store);
		await restore(first);
		const earlier = first.request(BOB, "math.add", {}, { timeoutMs: 0, storageKey: "k" });
		earlier.catch(() => undefined);
		await waitFor(() => bus.requests(BOB).length === 1);
		const sentTaskId = bus.requests(BOB)[0];
		await first.stop({ preservePending: true });
		await expect(earlier).rejects.toThrow("AGX client stopped");

		const second = durableClient(bus, store);
		const [recovered] = await restore(second);
		recovered.result.catch(() => undefined);
		const firstSave = gate();
		store.saveGate = firstSave.promise;
		const savesBefore = store.saves.length;
		const reused = second.request(BOB, "math.add", {}, { timeoutMs: 0, storageKey: "k" });
		reused.catch(() => undefined);
		await waitFor(() => store.saves.length === savesBefore + 1);
		const stopping = second.stop({ preservePending: true });
		await settle();
		firstSave.open();
		await stopping;
		await settle();
		expect(bus.requests(BOB)).toEqual([sentTaskId]);

		// The earlier request was sent: its key must still come back, so a caller
		// that retries with it is told the outcome is unknown instead of sending twice.
		const third = durableClient(bus, store);
		expect((await restore(third)).map((entry) => entry.key)).toEqual(["k"]);
		await third.stop();
	});

	it("does not write back or cancel a request whose result beats the publish acknowledgement", async () => {
		const bus = new MemoryTransport(ALICE);
		const gated = gatedTransport(bus);
		const store = new MemoryPendingStore();
		store.rejectSaveAfterRemove = true;
		const client = clientOn(gated.transport, store);
		await restore(client);
		gated.hold();
		const result = client.request(BOB, "math.add", {}, { timeoutMs: 0 });
		await waitFor(() => store.records.size === 1);
		const [{ taskId }] = [...store.records.values()];
		bus.result(ALICE, BOB, taskId);
		await client.pump();
		gated.release();
		await expect(result).resolves.toEqual({ ok: true });
		await settle();
		expect(store.saves).toEqual(["publishing"]);
		expect(store.records.size).toBe(0);
		expect(cancels(bus)).toBe(0);
		await client.stop();
	});

	it("lets a genuine result win when the deadline passes while its record is being removed", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: Date.now() + 60 });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		const removal = gate();
		store.removeGate = removal.promise;
		bus.result(ALICE, BOB, "task-1");
		const pumping = client.pump();
		await new Promise((resolve) => setTimeout(resolve, 120));
		removal.open();
		await pumping;
		await expect(recovered.result).resolves.toEqual({ ok: true });
		expect(store.records.size).toBe(0);
		expect(cancels(bus)).toBe(0);
		await client.stop();
	});

	it("still expires on its deadline when the result's record removal fails", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: Date.now() + 60 });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		store.failRemove = true;
		bus.result(ALICE, BOB, "task-1");
		expect((await client.pump()).complete).toBe(false);
		await expect(recovered.result).rejects.toThrow(/original deadline/);
		await client.stop();
	});

	it("does not register restored requests on a client stopped during restore", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: null });
		const listing = gate();
		store.listGate = listing.promise;
		const client = durableClient(bus, store);
		const restoring = restore(client);
		restoring.catch(() => undefined);
		await client.stop({ preservePending: true });
		listing.open();
		await expect(restoring).rejects.toThrow("AGX client stopped");
		expect(store.records.has("local-1")).toBe(true);
	});

	it("says whether a storage failure happened before anything was published", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		store.failSavePhase = "publishing";
		const client = durableClient(bus, store);
		await restore(client);
		await expect(client.request(BOB, "math.add", {}, { timeoutMs: 0 })).rejects.toMatchObject({
			code: "pending_request_store_failed",
			mayHavePublished: false,
		});
		expect(bus.requests(BOB)).toEqual([]);
		store.failSavePhase = "waiting";
		await expect(client.request(BOB, "math.add", {}, { timeoutMs: 0 })).rejects.toMatchObject({
			code: "pending_request_store_failed",
			mayHavePublished: true,
		});
		expect(bus.requests(BOB)).toHaveLength(1);
		await client.stop();
	});
});
