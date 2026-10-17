import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgxClient } from "./client";
import { AgxPublicError } from "./errors";
import { randomId } from "./id";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";
import type {
	AgxIncomingMessage,
	AgxIncomingReceipt,
	AgxPollResult,
	AgxResolvedPeer,
	AgxTransport,
} from "./transport";
import { TASK_CONTENT_TYPE } from "./wire";

/** An in-memory transport pair sharing a bus — lets two AgxClients converse
 * without a relay. `poll` returns everything for the recipient each call (replay
 * is the client's concern via the SeenStore). */
class MemoryBus {
	private seq = 1;
	private now = 1000;
	readonly inbox = new Map<string, AgxIncomingMessage[]>();
	readonly receipts = new Map<
		string,
		{ from: string; refEventId: string }[]
	>();
	/** Receipt EVENTS surfaced by poll() (a peer acking our outbound). */
	readonly receiptEvents = new Map<string, AgxIncomingReceipt[]>();

	pushMessage(
		to: string,
		msg: Omit<AgxIncomingMessage, "eventId" | "createdAt">,
		/** Override the auto-assigned created_at (e.g. to simulate a future date). */
		createdAt?: number,
	) {
		const list = this.inbox.get(to) ?? [];
		list.push({
			...msg,
			eventId: `e${this.seq++}`,
			createdAt: createdAt ?? this.now++,
		});
		this.inbox.set(to, list);
	}
	pushReceipt(to: string, from: string, refEventId: string) {
		const list = this.receipts.get(to) ?? [];
		list.push({ from, refEventId });
		this.receipts.set(to, list);
	}
	/** Push a receipt event into `to`'s inbox (returned by poll().receipts). */
	pushReceiptEvent(
		to: string,
		receipt: Omit<AgxIncomingReceipt, "eventId" | "createdAt">,
		createdAt?: number,
	): string {
		const list = this.receiptEvents.get(to) ?? [];
		const eventId = `r${this.seq++}`;
		list.push({ ...receipt, eventId, createdAt: createdAt ?? this.now++ });
		this.receiptEvents.set(to, list);
		return eventId;
	}
	transport(id: string): AgxTransport {
		const bus = this;
		return {
			whoami: () => id,
			async publishMessage(to, message) {
				const contextId = message.contextId || randomId();
				bus.pushMessage(to, {
					from: id,
					text: message.text,
					contextId,
					messageId: randomId(),
					subject: message.subject ?? null,
					autoDepth: message.autoDepth ?? null,
					contentType: message.contentType ?? "application/a2a+json",
				});
				return { ok: true, eventId: `sent-${bus["seq"]}`, contextId };
			},
			async publishReceipt(to, receipt) {
				bus.pushReceipt(to, id, receipt.refEventId);
				return { ok: true };
			},
			async poll(): Promise<AgxPollResult> {
				return {
					messages: [...(bus.inbox.get(id) ?? [])],
					receipts: [...(bus.receiptEvents.get(id) ?? [])],
					complete: true,
				};
			},
			async resolvePeer(): Promise<AgxResolvedPeer> {
				return { relays: [], card: null };
			},
		};
	}
}

let bus: MemoryBus;
const ALICE = "alice";
const BOB = "bob";

beforeEach(() => {
	bus = new MemoryBus();
});

describe("AgxClient task request/response", () => {
	it("routes a request to the peer's capability handler and returns the result", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle<{ a: number; b: number }, number>(
			"math.add",
			(t) => t.payload.a + t.payload.b,
		);

		const pending = alice.request<number>(BOB, "math.add", { a: 2, b: 3 });
		await bob.pump(); // Bob receives the request, runs the handler, replies
		await alice.pump(); // Alice receives the correlated result
		expect(await pending).toBe(5);
	});

	it("does not auto-reply to a task whose capability has no handler; routes it to onMessage", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const onMessage = vi.fn();
		// Bob serves no `unknown.capability` and (crucially) must NOT reply — an error
		// reply to an arbitrary peer would make the identity a reflector. The message
		// falls through to onMessage so a host's trust flow can triage it.
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			onMessage,
		});

		const pending = alice.request(
			BOB,
			"unknown.capability",
			{},
			{ timeoutMs: 50 },
		);
		await bob.pump();
		// No reply was published back to Alice (nothing in her inbox).
		expect(bus.inbox.get(ALICE) ?? []).toHaveLength(0);
		// The task-labelled message reached Bob's plain-message handler instead.
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage.mock.calls[0][0].contentType).toBe(TASK_CONTENT_TYPE);
		// The initiator gets a timeout, not a forged/auto "unsupported" result.
		await expect(pending).rejects.toThrow(/timed out/);
	});

	it("rejects with a public handler error message (AgxPublicError)", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("boom", () => {
			throw new AgxPublicError("kaboom");
		});

		const pending = alice.request(BOB, "boom", {});
		await bob.pump();
		await alice.pump();
		await expect(pending).rejects.toThrow("kaboom");
	});

	it("advertises registered handler keys as capabilities", () => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		bob.handle("invoice.review", () => null).handle(
			"invoice.pay",
			() => null,
		);
		expect(bob.capabilities()).toEqual(["invoice.review", "invoice.pay"]);
	});

	it("does not run a handler twice for a redelivered request (replay protection)", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const handler = vi.fn(() => "ok");
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("noop", handler);

		void alice.request(BOB, "noop", {});
		await bob.pump();
		await bob.pump(); // same event redelivered — must be a no-op
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("denied task never runs the handler, sends no reply, and falls through to onMessage", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const handler = vi.fn(() => "ok");
		const onMessage = vi.fn();
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: ({ from }) => from === "trusted",
			onMessage,
		});
		bob.handle("noop", handler);

		void alice.request(BOB, "noop", {});
		await bob.pump();
		expect(handler).not.toHaveBeenCalled();
		// No reply published to the denied sender…
		expect(bus.inbox.get(ALICE) ?? []).toHaveLength(0);
		// …but the host's trust flow still sees it (audit / peer registration).
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage.mock.calls[0][0].contentType).toBe(TASK_CONTENT_TYPE);
	});

	it("routes a task-labelled message to onMessage (no handlers, no authorize) without replying", async () => {
		// A host-managed config: one that registers NO handlers and NO authorize and
		// gates everything in its own onMessage trust flow. A peer must not be able to
		// use a task content-type label to skip that flow or coax a signed reply.
		const onMessage = vi.fn();
		const bob = new AgxClient({ transport: bus.transport(BOB), onMessage });
		bus.pushMessage(BOB, {
			from: "attacker",
			text: encodeTaskEnvelope({
				t: "req",
				taskId: "t1",
				capability: "invoice.review",
				payload: {},
			}),
			contextId: "t1",
			messageId: "m1",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		// Delivered to the trust flow, and NOTHING published back to the sender.
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage.mock.calls[0][0].from).toBe("attacker");
		expect(bus.inbox.get("attacker") ?? []).toHaveLength(0);
	});

	it("surfaces plain (non-task) messages via onMessage", async () => {
		const onMessage = vi.fn();
		const bob = new AgxClient({ transport: bus.transport(BOB), onMessage });
		// A plain message (default content type, not a task envelope).
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "hello",
			contextId: "ctx",
			messageId: "m1",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		await bob.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage.mock.calls[0][0].text).toBe("hello");
	});

	it("retries a message whose dispatch throws (left unseen, cursor held)", async () => {
		let calls = 0;
		const onMessage = vi.fn(() => {
			calls += 1;
			if (calls === 1) {
				throw new Error("transient host error");
			}
		});
		const bob = new AgxClient({ transport: bus.transport(BOB), onMessage });
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "hi",
			contextId: "c",
			messageId: "m",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		await bob.pump(); // throws → caught, left unseen, cursor held
		await bob.pump(); // retried → succeeds
		expect(onMessage).toHaveBeenCalledTimes(2);
	});

	it("dead-letters a poison message after the attempt cap (cursor advances, alerts)", async () => {
		const onMessage = vi.fn(() => {
			throw new Error("poison"); // deterministic failure every time
		});
		const error = vi.fn();
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			onMessage,
			maxDispatchAttempts: 2,
			logger: { error, warn: vi.fn(), info: vi.fn() },
		});
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "poison",
			contextId: "c",
			messageId: "m",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		const r1 = await bob.pump(); // attempt 1 → still under cap → cursor held
		expect(r1.complete).toBe(false);
		const r2 = await bob.pump(); // attempt 2 → cap hit → dead-letter, cursor frees
		expect(r2.complete).toBe(true);
		const r3 = await bob.pump(); // now seen → never dispatched again
		expect(r3.complete).toBe(true);
		expect(onMessage).toHaveBeenCalledTimes(2); // not retried forever
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("dead-lettering"),
			expect.objectContaining({ attempts: 2 }),
		);
	});

	it("DENIES task requests (default-deny) and warns once when no authorize hook is configured", async () => {
		const warn = vi.fn();
		const handler = vi.fn(() => "ok");
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			logger: { warn, error: vi.fn(), info: vi.fn() },
		});
		bob.handle("noop", handler);
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		void alice.request(BOB, "noop", {});
		void alice.request(BOB, "noop", {});
		await bob.pump(); // both denied (fail closed)
		expect(handler).not.toHaveBeenCalled();
		// No reply is emitted to a denied peer, and the warning fires exactly once.
		expect(bus.inbox.get(ALICE) ?? []).toHaveLength(0);
		const noAuthWarnings = warn.mock.calls.filter((c) =>
			String(c[0]).includes("no `authorize` hook"),
		);
		expect(noAuthWarnings).toHaveLength(1);
	});

	it("runs handlers (and does not warn) when accept-all is opted into explicitly", async () => {
		const warn = vi.fn();
		const handler = vi.fn(() => "ok");
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			logger: { warn, error: vi.fn(), info: vi.fn() },
		});
		bob.handle("noop", handler);
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		void alice.request(BOB, "noop", {});
		await bob.pump();
		expect(handler).toHaveBeenCalledTimes(1); // accept-all runs the handler
		const noAuthWarnings = warn.mock.calls.filter((c) =>
			String(c[0]).includes("no `authorize` hook"),
		);
		expect(noAuthWarnings).toHaveLength(0);
	});

	it("rejects in-flight request() callers on stop()", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const pending = alice.request(BOB, "noop", {});
		await alice.stop();
		await expect(pending).rejects.toThrow("AGX client stopped");
	});

	it("does not double-run a handler under concurrent pumps", async () => {
		const handler = vi.fn(() => "ok");
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("noop", handler);
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		void alice.request(BOB, "noop", {});
		await Promise.all([bob.pump(), bob.pump()]); // second pump is a no-op
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("rejects an oversized request payload instead of truncating", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const big = "x".repeat(70_000); // beyond the wire char cap
		await expect(alice.request(BOB, "noop", { big })).rejects.toThrow(
			/exceeds the transport size limit/,
		);
	});

	it("forwards an AgxPublicError message but hides an internal error", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("pub", () => {
			throw new AgxPublicError("invoice not found");
		});
		bob.handle("priv", () => {
			throw new Error("connection to db-host:5432 (user=admin) failed");
		});

		const p1 = alice.request(BOB, "pub", {});
		const p2 = alice.request(BOB, "priv", {});
		await bob.pump();
		await alice.pump();

		await expect(p1).rejects.toThrow("invoice not found");
		// The generic message is used; the internal detail (db-host, user) is absent.
		await expect(p2).rejects.toThrow("handler failed");
		await expect(p2).rejects.not.toThrow(/db-host/);
	});

	it("drops a future-dated event so an attacker cannot freeze the inbox (cursor poisoning)", async () => {
		const onMessage = vi.fn();
		const bob = new AgxClient({ transport: bus.transport(BOB), onMessage });
		const nowSec = Math.floor(Date.now() / 1000);
		// An event dated far in the future — if it advanced the cursor, every later
		// legitimate event would be skipped forever.
		bus.pushMessage(
			BOB,
			{
				from: ALICE,
				text: "from-the-future",
				contextId: "c1",
				messageId: "m1",
				subject: null,
				autoDepth: null,
				contentType: "application/a2a+json",
			},
			nowSec + 10_000,
		);
		const first = await bob.pump();
		expect(onMessage).not.toHaveBeenCalled(); // future-dated → never dispatched
		expect(first.cursor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

		// The inbox is not frozen: a normal message still gets delivered.
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "normal",
			contextId: "c2",
			messageId: "m2",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		await bob.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage.mock.calls[0][0].text).toBe("normal");
	});

	it("drops a task result from a peer other than the request's target (result forgery)", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle<string, string>("echo", (t) => t.payload);

		const pending = alice.request<string>(BOB, "echo", "real");
		// Recover the taskId the way a malicious responder could — it's in the wire
		// envelope the request just published.
		const reqMsg = (bus.inbox.get(BOB) ?? []).find(
			(m) => m.contentType === TASK_CONTENT_TYPE,
		);
		const env = reqMsg ? parseTaskEnvelope(reqMsg.text) : null;
		const taskId = env && env.t === "req" ? env.taskId : "";
		expect(taskId).not.toBe("");

		// A third party forges a completed result carrying that taskId.
		bus.pushMessage(ALICE, {
			from: "carol",
			text: encodeTaskEnvelope({
				t: "res",
				taskId,
				status: "completed",
				output: "forged",
			}),
			contextId: taskId,
			messageId: "forged-1",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		await alice.pump(); // forged result must be dropped, pending left open

		// The real peer answers; the caller resolves with ITS output, never "forged".
		await bob.pump();
		await alice.pump();
		expect(await pending).toBe("real");
	});

	it("dispatches inbound receipts once and dedupes redelivery (onReceipt)", async () => {
		const onReceipt = vi.fn();
		const bob = new AgxClient({ transport: bus.transport(BOB), onReceipt });
		bus.pushReceiptEvent(BOB, {
			from: ALICE,
			receipt: {
				v: 1,
				kind: "receipt",
				refEventId: "our-outbound-1",
				contextId: "ctx",
				status: "delivered",
			},
		});
		const first = await bob.pump();
		expect(onReceipt).toHaveBeenCalledTimes(1);
		expect(onReceipt.mock.calls[0][0].receipt.refEventId).toBe(
			"our-outbound-1",
		);
		expect(first.cursor).toBeGreaterThan(0); // a receipt advances the cursor

		await bob.pump(); // same receipt redelivered in the overlap window
		expect(onReceipt).toHaveBeenCalledTimes(1); // deduped via the SeenStore
	});
});

describe("AgxClient polls far enough back for a backdating transport", () => {
	/** A transport that records the `since` it is asked for. */
	function recordingTransport(pollLookbackSec?: number) {
		const sinces: number[] = [];
		const transport: AgxTransport = {
			whoami: () => ALICE,
			pollLookbackSec,
			async publishMessage() {
				return { ok: true, eventId: "x", contextId: "c" };
			},
			async publishReceipt() {
				return { ok: true };
			},
			async poll(opts) {
				sinces.push(opts.since);
				return { messages: [], receipts: [], complete: true };
			},
			async resolvePeer() {
				return { relays: [], card: null };
			},
		};
		return { transport, sinces };
	}

	it("subtracts only the overlap when timestamps are honest", async () => {
		const { transport, sinces } = recordingTransport();
		const client = new AgxClient({
			transport,
			startCursor: 1_000_000,
			pollOverlapSec: 120,
		});
		await client.pump();
		expect(sinces).toEqual([1_000_000 - 120]);
	});

	it("adds the transport's pollLookbackSec on top of the overlap", async () => {
		// NIP-59 wraps are stamped up to two days early. An event sent after our
		// last poll can therefore carry a created_at well BEFORE our cursor, and
		// a poll that starts at `cursor - overlap` never asks for it.
		const lookback = 2 * 24 * 60 * 60;
		const { transport, sinces } = recordingTransport(lookback);
		const client = new AgxClient({
			transport,
			startCursor: 1_000_000,
			pollOverlapSec: 120,
		});
		await client.pump();
		expect(sinces).toEqual([1_000_000 - 120 - lookback]);
	});

	it("clamps at zero rather than asking for a negative since", async () => {
		const { transport, sinces } = recordingTransport(10_000);
		const client = new AgxClient({ transport, startCursor: 500 });
		await client.pump();
		expect(sinces).toEqual([0]);
	});

	it("still dedupes a backdated event it has already processed", async () => {
		// The widened window re-delivers everything in it on every poll; the
		// SeenStore is what makes that a no-op.
		const onMessage = vi.fn();
		const now = Math.floor(Date.now() / 1000);
		const message: AgxIncomingMessage = {
			from: BOB,
			eventId: "rumor-1",
			createdAt: now - 36 * 60 * 60, // a wrap backdated 36h
			text: "hi",
			contextId: "c",
			messageId: "m",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		};
		const transport: AgxTransport = {
			...recordingTransport(2 * 24 * 60 * 60).transport,
			async poll() {
				return { messages: [message], receipts: [], complete: true };
			},
		};
		const client = new AgxClient({
			transport,
			startCursor: now,
			onMessage,
		});
		await client.pump();
		await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
	});
});

describe("AgxClient cursor tracks poll time, not event time", () => {
	const LOOKBACK = 2 * 24 * 60 * 60;

	/** A transport whose inbox the test controls, recording each `since`. */
	function controlledTransport() {
		const state = {
			messages: [] as AgxIncomingMessage[],
			complete: true,
			sinces: [] as number[],
		};
		const transport: AgxTransport = {
			whoami: () => ALICE,
			pollLookbackSec: LOOKBACK,
			async publishMessage() {
				return { ok: true, eventId: "x", contextId: "c" };
			},
			async publishReceipt() {
				return { ok: true };
			},
			async poll(opts) {
				state.sinces.push(opts.since);
				return {
					messages: state.messages.filter(
						(m) => m.createdAt >= opts.since,
					),
					receipts: [],
					complete: state.complete,
				};
			},
			async resolvePeer() {
				return { relays: [], card: null };
			},
		};
		return { transport, state };
	}

	function message(id: string, createdAt: number): AgxIncomingMessage {
		return {
			from: BOB,
			eventId: id,
			createdAt,
			text: "hi",
			contextId: "c",
			messageId: id,
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		};
	}

	it("advances a quiet inbox's cursor to now, so its last event leaves the window", async () => {
		// Event time would pin the cursor at the last (backdated) event forever,
		// keeping that event inside every future poll window until the relay
		// expires it — long after any SeenStore row for it is pruned.
		const now = Math.floor(Date.now() / 1000);
		const { transport, state } = controlledTransport();
		state.messages = [message("only", now - 36 * 60 * 60)];
		const client = new AgxClient({
			transport,
			startCursor: now - 10 * 24 * 60 * 60,
			onMessage: () => {},
		});
		const { cursor } = await client.pump();
		expect(cursor).toBeGreaterThanOrEqual(now);
		expect(cursor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});

	it("still fetches a wrap sent after the cursor but stamped up to the lookback earlier", async () => {
		const onMessage = vi.fn();
		const { transport, state } = controlledTransport();
		const client = new AgxClient({ transport, onMessage });
		const { cursor } = await client.pump(); // empty inbox; cursor -> now
		// Published after that poll, backdated almost the full two days.
		state.messages = [message("late", cursor - LOOKBACK + 60)];
		await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(state.sinces[1]).toBeLessThanOrEqual(cursor - LOOKBACK);
	});

	it("holds the cursor when the poll was incomplete", async () => {
		const { transport, state } = controlledTransport();
		state.complete = false;
		const client = new AgxClient({ transport, startCursor: 1_000 });
		const { cursor, complete } = await client.pump();
		expect(complete).toBe(false);
		expect(cursor).toBe(1_000);
	});
});

describe("AgxClient records envelope ids so a binding can skip them", () => {
	function envelopeTransport(result: () => AgxPollResult) {
		const calls: { known: Set<string> }[] = [];
		const transport: AgxTransport = {
			whoami: () => ALICE,
			async publishMessage() {
				return { ok: true, eventId: "x", contextId: "c" };
			},
			async publishReceipt() {
				return { ok: true };
			},
			async poll(opts) {
				const res = result();
				const ids = [
					...res.messages.map((m) => m.transportId ?? m.eventId),
					...res.receipts.map((r) => r.transportId ?? r.eventId),
					...(res.discarded ?? []),
				];
				calls.push({ known: (await opts.isKnown?.(ids)) ?? new Set() });
				return res;
			},
			async resolvePeer() {
				return { relays: [], card: null };
			},
		};
		return { transport, calls };
	}

	const msg = (): AgxIncomingMessage => ({
		from: BOB,
		eventId: "rumor-1",
		transportId: "wrap-1",
		createdAt: Math.floor(Date.now() / 1000) - 60,
		text: "hi",
		contextId: "c",
		messageId: "m",
		subject: null,
		autoDepth: null,
		contentType: "application/a2a+json",
	});

	it("marks a processed message's wrap id seen, so the next poll reports it known", async () => {
		const { transport, calls } = envelopeTransport(() => ({
			messages: [msg()],
			receipts: [],
			complete: true,
		}));
		const client = new AgxClient({ transport, onMessage: () => {} });
		await client.pump();
		await client.pump();
		expect(calls[0].known.has("wrap-1")).toBe(false);
		expect(calls[1].known.has("wrap-1")).toBe(true);
		expect(calls[1].known.has("rumor-1")).toBe(false); // asked about wraps only
	});

	it("records discarded envelopes, so junk is opened once and then skipped", async () => {
		const { transport, calls } = envelopeTransport(() => ({
			messages: [],
			receipts: [],
			complete: true,
			discarded: ["junk-1", "junk-2"],
		}));
		const client = new AgxClient({ transport });
		await client.pump();
		await client.pump();
		expect(calls[0].known.size).toBe(0);
		expect([...calls[1].known].sort()).toEqual(["junk-1", "junk-2"]);
	});

	it("remembers a re-wrapped retry's new envelope without re-dispatching it", async () => {
		const onMessage = vi.fn();
		let wrap = "wrap-1";
		const { transport, calls } = envelopeTransport(() => ({
			messages: [{ ...msg(), transportId: wrap }],
			receipts: [],
			complete: true,
		}));
		const client = new AgxClient({ transport, onMessage });
		await client.pump();
		wrap = "wrap-2"; // same rumor, new wrap
		await client.pump();
		await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(calls[2].known.has("wrap-2")).toBe(true);
	});
});

describe("AgxClient dispatches a rumor once even when one poll carries it twice", () => {
	/** Two envelopes of the same event, both unknown to the store. */
	function twoWraps(result: () => AgxPollResult) {
		const known: Set<string>[] = [];
		const transport: AgxTransport = {
			whoami: () => ALICE,
			async publishMessage() {
				return { ok: true, eventId: "x", contextId: "c" };
			},
			async publishReceipt() {
				return { ok: true };
			},
			async poll(opts) {
				known.push(
					(await opts.isKnown?.(["wrap-a", "wrap-b"])) ?? new Set(),
				);
				return result();
			},
			async resolvePeer() {
				return { relays: [], card: null };
			},
		};
		return { transport, known };
	}
	const copy = (transportId: string): AgxIncomingMessage => ({
		from: BOB,
		eventId: "rumor-1",
		transportId,
		createdAt: Math.floor(Date.now() / 1000) - 60,
		text: "hi",
		contextId: "c",
		messageId: "m",
		subject: null,
		autoDepth: null,
		contentType: "application/a2a+json",
	});
	const both = (): AgxPollResult => ({
		messages: [copy("wrap-a"), copy("wrap-b")],
		receipts: [],
		complete: true,
	});

	it("calls onMessage once and records both envelopes (snapshot store)", async () => {
		const onMessage = vi.fn();
		const { transport, known } = twoWraps(both);
		const client = new AgxClient({ transport, onMessage });
		await client.pump();
		await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect([...known[1]].sort()).toEqual(["wrap-a", "wrap-b"]);
	});

	it("does the same with a store that has no hasMany", async () => {
		const ids = new Set<string>();
		const adds: string[] = [];
		const seen = {
			has: (id: string) => ids.has(id),
			add: (id: string) => {
				adds.push(id);
				ids.add(id);
			},
		};
		const onMessage = vi.fn();
		const { transport } = twoWraps(both);
		const client = new AgxClient({ transport, onMessage, seen });
		await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(ids.has("wrap-b")).toBe(true);
		// The skipped copy writes its envelope only, not the rumor id again.
		expect(adds).toEqual(["rumor-1", "wrap-a", "wrap-b"]);
	});

	it("does not re-dispatch the second copy when the first one failed", async () => {
		// Otherwise one failure would be counted twice toward the dead-letter cap.
		const failures = new Map<string, number>();
		const ids = new Set<string>();
		const seen = {
			has: (id: string) => ids.has(id),
			hasMany: (list: string[]) =>
				new Set(list.filter((i) => ids.has(i))),
			add: (id: string) => {
				ids.add(id);
			},
			recordFailure: (id: string) => {
				const n = (failures.get(id) ?? 0) + 1;
				failures.set(id, n);
				return n;
			},
		};
		const onMessage = vi.fn(() => {
			throw new Error("host down");
		});
		const { transport } = twoWraps(both);
		const client = new AgxClient({
			transport,
			onMessage,
			seen,
			startCursor: 5,
		});
		const { cursor, complete } = await client.pump();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(failures.get("rumor-1")).toBe(1);
		expect(ids.size).toBe(0); // nothing marked: it is a retry, not a dup
		expect(complete).toBe(false);
		expect(cursor).toBe(5);
	});

	it("dispatches a receipt once when two envelopes carry it", async () => {
		const onReceipt = vi.fn();
		const receipt = (transportId: string): AgxIncomingReceipt => ({
			from: BOB,
			eventId: "receipt-rumor",
			transportId,
			createdAt: Math.floor(Date.now() / 1000) - 60,
			receipt: {
				v: 1,
				kind: "receipt",
				refEventId: "r",
				contextId: "c",
				status: "delivered",
			} as AgxIncomingReceipt["receipt"],
		});
		const { transport } = twoWraps(() => ({
			messages: [],
			receipts: [receipt("wrap-a"), receipt("wrap-b")],
			complete: true,
		}));
		const client = new AgxClient({ transport, onReceipt });
		await client.pump();
		expect(onReceipt).toHaveBeenCalledTimes(1);
	});
});

describe("AgxClient batches seen-store writes when the store can", () => {
	function discardingTransport(discarded: string[]): AgxTransport {
		return {
			whoami: () => ALICE,
			async publishMessage() {
				return { ok: true, eventId: "x", contextId: "c" };
			},
			async publishReceipt() {
				return { ok: true };
			},
			async poll() {
				return {
					messages: [],
					receipts: [],
					complete: true,
					discarded,
				};
			},
			async resolvePeer() {
				return { relays: [], card: null };
			},
		};
	}
	const junk = Array.from({ length: 50 }, (_, i) => `junk-${i}`);

	it("records a poll's discarded envelopes in ONE addMany call", async () => {
		const addMany = vi.fn();
		const add = vi.fn();
		const seen = { has: () => false, add, addMany };
		await new AgxClient({
			transport: discardingTransport(junk),
			seen,
		}).pump();
		expect(addMany).toHaveBeenCalledTimes(1);
		expect(addMany.mock.calls[0][0]).toEqual(junk);
		expect(add).not.toHaveBeenCalled();
	});

	it("falls back to add per id for a store without addMany", async () => {
		const add = vi.fn();
		const seen = { has: () => false, add };
		await new AgxClient({
			transport: discardingTransport(junk),
			seen,
		}).pump();
		expect(add).toHaveBeenCalledTimes(junk.length);
	});
});

describe("AgxClient gives a host what it needs to keep its own replay records", () => {
	it("hands the handler the request's event id and send time", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		const seen = vi.fn();
		bob.handle("x.y", (task) => {
			seen(task);
			return null;
		});
		void alice.request(BOB, "x.y", {}, { timeoutMs: 0 });
		await new Promise((r) => setTimeout(r, 0));
		const [request] = bus.inbox.get(BOB) ?? [];
		await bob.pump();
		expect(seen).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: request.eventId, from: ALICE }),
		);
	});

	it("drops what `ignore` rejects before authorization, receipt or onMessage, and records it as seen", async () => {
		const authorize = vi.fn(() => true);
		const onMessage = vi.fn();
		const onReceipt = vi.fn();
		const handler = vi.fn(() => null);
		const ignore = vi.fn(() => true);
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize,
			onMessage,
			onReceipt,
			ignore,
		});
		bob.handle("x.y", handler);
		void alice.request(BOB, "x.y", {}, { timeoutMs: 0 });
		await new Promise((r) => setTimeout(r, 0));
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "hi",
			contextId: "c",
			messageId: "m",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		bus.pushReceiptEvent(BOB, {
			from: ALICE,
			receipt: {
				v: 1,
				kind: "receipt",
				refEventId: "x",
				contextId: "c",
				status: "delivered",
			},
		});
		const { dispatched, complete } = await bob.pump();
		expect(ignore).toHaveBeenCalledTimes(3);
		expect(authorize).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
		expect(onMessage).not.toHaveBeenCalled();
		expect(onReceipt).not.toHaveBeenCalled();
		expect(bus.receipts.get(ALICE) ?? []).toHaveLength(0);
		expect(bus.inbox.get(ALICE) ?? []).toHaveLength(0);
		expect({ dispatched, complete }).toEqual({ dispatched: 0, complete: true });
		// Seen: the next poll does not ask again.
		await bob.pump();
		expect(ignore).toHaveBeenCalledTimes(3);
	});
});
