import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgxClient, type AgxTaskContract } from "./client";
import {
	AgxInvalidInputError,
	AgxPublicError,
	AgxTaskDeclined,
	AgxTaskFailedError,
} from "./errors";
import { randomId } from "./id";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";
import type {
	AgxIncomingMessage,
	AgxIncomingReceipt,
	AgxPeerCard,
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

function liveTransport(id: string) {
	const base = bus.transport(id);
	const messageHandlers: Array<
		(msg: AgxIncomingMessage) => void | Promise<void>
	> = [];
	const receiptHandlers: Array<
		(receipt: AgxIncomingReceipt) => void | Promise<void>
	> = [];
	return {
		transport: {
			...base,
			onMessage(handler) {
				messageHandlers.push(handler);
				return () => {
					const index = messageHandlers.indexOf(handler);
					if (index >= 0) messageHandlers.splice(index, 1);
				};
			},
			onReceipt(handler) {
				receiptHandlers.push(handler);
				return () => {
					const index = receiptHandlers.indexOf(handler);
					if (index >= 0) receiptHandlers.splice(index, 1);
				};
			},
		} satisfies AgxTransport,
		async deliverMessage(msg: AgxIncomingMessage) {
			await Promise.all(messageHandlers.map((handler) => handler(msg)));
		},
		async deliverReceipt(receipt: AgxIncomingReceipt) {
			await Promise.all(receiptHandlers.map((handler) => handler(receipt)));
		},
		listenerCounts() {
			return {
				messages: messageHandlers.length,
				receipts: receiptHandlers.length,
			};
		},
	};
}

let bus: MemoryBus;
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

beforeEach(() => {
	bus = new MemoryBus();
});

describe("AgxClient listener lifecycle", () => {
	it("can disable live dispatch for hosts that pump explicitly", async () => {
		const live = liveTransport(BOB);
		const start = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		const client = new AgxClient({
			transport: { ...live.transport, start, stop },
		});

		await client.start({
			pollIntervalMs: 0,
			advertise: false,
			liveDispatch: false,
		});
		expect(live.listenerCounts()).toEqual({ messages: 0, receipts: 0 });
		expect(start).not.toHaveBeenCalled();
		await client.stop();
		expect(stop).not.toHaveBeenCalled();
	});

	it("keeps a shared transport running until its last client stops", async () => {
		const live = liveTransport(BOB);
		const start = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		const transport = { ...live.transport, start, stop };
		const first = new AgxClient({ transport });
		const second = new AgxClient({ transport });

		await first.start({ pollIntervalMs: 0, advertise: false });
		await second.start({ pollIntervalMs: 0, advertise: false });
		expect(start).toHaveBeenCalledOnce();
		expect(live.listenerCounts()).toEqual({ messages: 2, receipts: 2 });

		await first.stop();
		expect(stop).not.toHaveBeenCalled();
		expect(live.listenerCounts()).toEqual({ messages: 1, receipts: 1 });
		await live.deliverMessage({
			from: ALICE,
			eventId: "still-live",
			createdAt: 1,
			text: "still live",
			contextId: "ctx",
			messageId: "still-live",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});

		await second.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("registers listeners on start and removes only its own listeners on stop", async () => {
		const live = liveTransport(BOB);
		const externalMessage = vi.fn();
		const removeExternalMessage = live.transport.onMessage!(externalMessage);
		const onMessage = vi.fn();
		const client = new AgxClient({ transport: live.transport, onMessage });

		expect(live.listenerCounts()).toEqual({ messages: 1, receipts: 0 });
		await live.deliverMessage({
			from: ALICE,
			eventId: "before-start",
			createdAt: 1,
			text: "before start",
			contextId: "ctx",
			messageId: "before-start",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		expect(onMessage).not.toHaveBeenCalled();
		expect(externalMessage).toHaveBeenCalledOnce();

		await client.start({ pollIntervalMs: 0, advertise: false });
		expect(live.listenerCounts()).toEqual({ messages: 2, receipts: 1 });
		await client.stop();
		expect(live.listenerCounts()).toEqual({ messages: 1, receipts: 0 });

		await client.start({ pollIntervalMs: 0, advertise: false });
		expect(live.listenerCounts()).toEqual({ messages: 2, receipts: 1 });
		await live.deliverMessage({
			from: ALICE,
			eventId: "after-restart",
			createdAt: 1,
			text: "after restart",
			contextId: "ctx",
			messageId: "after-restart",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(externalMessage).toHaveBeenCalledTimes(2);
		await client.stop();
		if (typeof removeExternalMessage === "function") {
			removeExternalMessage();
		}
		expect(live.listenerCounts()).toEqual({ messages: 0, receipts: 0 });
	});
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

	it("preflights a typed peer skill before publishing", async () => {
		const transport: AgxTransport = {
			...bus.transport(ALICE),
			resolvePeer: vi.fn(async () => ({
				relays: [],
				card: {
					displayName: "Billing",
					capabilities: ["invoice.review"],
					nip05: null,
					skills: [{
						id: "invoice.review",
						description: "Review an invoice",
						inputSchema: {
							type: "object",
							required: ["amount"],
							properties: { amount: { type: "number" } },
						},
					}],
				},
			})),
		};
		const publishMessage = vi.spyOn(transport, "publishMessage");
		const alice = new AgxClient({ transport });

		const pending = alice.request(
			BOB,
			"invoice.review",
			{ amount: "hello" },
			{ validate: true },
		);
		await expect(pending).rejects.toThrow(/invalid_input.*expected number/);
		await expect(pending).rejects.toBeInstanceOf(AgxInvalidInputError);
		expect(publishMessage).not.toHaveBeenCalled();
	});

	describe("validate preflight checks only against a valid peer schema", () => {
		const invoiceSkill = {
			id: "invoice.review",
			description: "Review an invoice",
			inputSchema: {
				type: "object",
				required: ["amount"],
				properties: { amount: { type: "number" } },
			},
		};

		function cardWith(extra: Partial<AgxPeerCard>): AgxPeerCard {
			return {
				displayName: "Billing",
				capabilities: ["invoice.review"],
				nip05: null,
				...extra,
			};
		}

		function peerTransport(card: AgxPeerCard | null | Error) {
			return {
				...bus.transport(ALICE),
				resolvePeer: vi.fn(async () => {
					if (card instanceof Error) throw card;
					return { relays: [], card };
				}),
			} satisfies AgxTransport;
		}

		async function expectSentUnchecked(card: AgxPeerCard | null | Error) {
			const transport = peerTransport(card);
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });
			await expect(
				alice.request(
					BOB,
					"invoice.review",
					{ amount: "hello" },
					{ validate: true, timeoutMs: 20 },
				),
			).rejects.toThrow(/timed out/);
			expect(publishMessage).toHaveBeenCalled();
		}

		it("throws AgxInvalidInputError for a payload the peer schema refuses", async () => {
			const transport = peerTransport(cardWith({ skills: [invoiceSkill] }));
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			const error = await alice
				.request(BOB, "invoice.review", { amount: "hello" }, { validate: true })
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AgxInvalidInputError);
			expect(error).not.toBeInstanceOf(AgxTaskFailedError);
			expect((error as AgxInvalidInputError).problem).toContain(
				"expected number",
			);
			expect(publishMessage).not.toHaveBeenCalled();
		});

		it("throws AgxInvalidInputError from streamRequest too", async () => {
			const transport = peerTransport(cardWith({ skills: [invoiceSkill] }));
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			await expect(
				alice.streamRequest(
					BOB,
					"invoice.review",
					{ amount: "hello" },
					{ validate: true },
				),
			).rejects.toBeInstanceOf(AgxInvalidInputError);
			expect(publishMessage).not.toHaveBeenCalled();
		});

		it("sends without checking when the peer has no card", async () => {
			await expectSentUnchecked(null);
		});

		it("sends without checking when the card has no typed skills or carries only a metadata warning", async () => {
			await expectSentUnchecked(cardWith({}));
			await expectSentUnchecked(
				cardWith({
					typedMetadataWarnings: [
						{ code: "invalid_typed_metadata", message: "ignored" },
					],
				}),
			);
		});

		it("sends without checking when the peer skill has no input schema", async () => {
			await expectSentUnchecked(
				cardWith({
					skills: [{ id: "invoice.review", description: "Review an invoice" }],
				}),
			);
		});

		it("sends without checking when the peer skill schema is invalid", async () => {
			await expectSentUnchecked(
				cardWith({
					skills: [{ ...invoiceSkill, inputSchema: { pattern: "x" } }],
				}),
			);
		});

		it("sends without checking when the card lookup fails", async () => {
			await expectSentUnchecked(new Error("no relay answered"));
		});

		it("still checks a valid skill when another skill on the card was dropped", async () => {
			const transport = peerTransport(
				cardWith({
					skills: [invoiceSkill],
					typedMetadataWarnings: [
						{ code: "invalid_typed_skill", message: "skills.1 dropped" },
					],
				}),
			);
			const alice = new AgxClient({ transport });
			await expect(
				alice.request(
					BOB,
					"invoice.review",
					{ amount: "hello" },
					{ validate: true },
				),
			).rejects.toBeInstanceOf(AgxInvalidInputError);
		});

		it("a peer's invalid_input result rejects with AgxTaskFailedError", async () => {
			const alice = new AgxClient({ transport: bus.transport(ALICE) });
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			bob.handle("invoice.review", () => ({ approved: true }), {
				description: "Review an invoice",
				inputSchema: invoiceSkill.inputSchema,
			});

			const pending = alice.request(BOB, "invoice.review", { amount: "hello" });
			pending.catch(() => undefined);
			await bob.pump();
			await alice.pump();
			const error = await pending.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AgxTaskFailedError);
			expect(error).not.toBeInstanceOf(AgxInvalidInputError);
		});
	});

	describe("streamRequest preflight", () => {
		function typedPeerTransport() {
			return {
				...bus.transport(ALICE),
				resolvePeer: vi.fn(async () => ({
					relays: [],
					card: {
						displayName: "Billing",
						capabilities: ["invoice.review"],
						nip05: null,
						skills: [{
							id: "invoice.review",
							description: "Review an invoice",
							inputSchema: {
								type: "object",
								required: ["amount"],
								properties: { amount: { type: "number" } },
							},
						}],
					},
				})),
			} satisfies AgxTransport;
		}

		it("rejects a payload the peer's typed skill refuses, before publishing", async () => {
			const transport = typedPeerTransport();
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			await expect(
				alice.streamRequest(BOB, "invoice.review", { amount: "hello" }, { validate: true }),
			).rejects.toThrow(/invalid_input.*expected number/);
			expect(publishMessage).not.toHaveBeenCalled();
		});

		it("publishes a payload that satisfies the peer's typed skill", async () => {
			const transport = typedPeerTransport();
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			const stream = await alice.streamRequest(
				BOB,
				"invoice.review",
				{ amount: 5 },
				{ validate: true, timeoutMs: 20 },
			);
			expect(publishMessage).toHaveBeenCalledTimes(1);
			await expect(stream.result).rejects.toThrow(/timed out/);
		});

		it("accepts a payload whose undefined member the wire drops", async () => {
			const transport = typedPeerTransport();
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			const stream = await alice.streamRequest(
				BOB,
				"invoice.review",
				{ amount: 5, note: undefined },
				{ validate: true, timeoutMs: 20 },
			);
			expect(publishMessage).toHaveBeenCalledTimes(1);
			await expect(stream.result).rejects.toThrow(/timed out/);
		});

		it("does not look the peer up unless validate is set", async () => {
			const transport = typedPeerTransport();
			const alice = new AgxClient({ transport });

			const stream = await alice.streamRequest(
				BOB,
				"invoice.review",
				{ amount: "hello" },
				{ timeoutMs: 20 },
			);
			expect(transport.resolvePeer).not.toHaveBeenCalled();
			await expect(stream.result).rejects.toThrow(/timed out/);
		});
	});

	it("returns invalid_input for an authorized bad payload without invoking the handler", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const handler = vi.fn(() => ({ approved: true }));
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("invoice.review", handler, {
			description: "Review an invoice",
			inputSchema: {
				type: "object",
				required: ["amount"],
				properties: { amount: { type: "number" } },
			},
		});

		const pending = alice.request(BOB, "invoice.review", { amount: "hello" });
		await bob.pump();
		await alice.pump();
		await expect(pending).rejects.toThrow("invalid_input");
		expect(handler).not.toHaveBeenCalled();
	});

	it("runs a typed handler and returns output that satisfies its contract", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("invoice.review", () => ({ approved: true }), {
			description: "Review an invoice",
			inputSchema: {
				type: "object",
				required: ["amount"],
				properties: { amount: { type: "number" } },
			},
			outputSchema: {
				type: "object",
				required: ["approved"],
				properties: { approved: { type: "boolean" } },
			},
		});

		const pending = alice.request(BOB, "invoice.review", { amount: 5 });
		await bob.pump();
		await alice.pump();
		expect(await pending).toEqual({ approved: true });
	});

	it("returns invalid_output instead of completing with a bad handler result", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const handler = vi.fn(() => ({ approved: "yes" }));
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("invoice.review", handler, {
			description: "Review an invoice",
			outputSchema: {
				type: "object",
				required: ["approved"],
				properties: { approved: { type: "boolean" } },
			},
		});

		const pending = alice.request(BOB, "invoice.review", {});
		await bob.pump();
		await alice.pump();
		await expect(pending).rejects.toThrow("invalid_output");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	describe("validates the JSON a task value becomes on the wire", () => {
		async function runTyped(
			handler: () => unknown,
			outputSchema: Record<string, unknown>,
		): Promise<unknown> {
			const alice = new AgxClient({ transport: bus.transport(ALICE) });
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			bob.handle("invoice.review", handler, {
				description: "Review an invoice",
				outputSchema,
			});
			const pending = alice.request(BOB, "invoice.review", {});
			pending.catch(() => undefined);
			await bob.pump();
			await alice.pump();
			return pending;
		}

		it("completes when the handler result has an undefined member", async () => {
			await expect(
				runTyped(() => ({ approved: true, note: undefined }), {
					type: "object",
					required: ["approved"],
					properties: {
						approved: { type: "boolean" },
						note: { type: "string" },
					},
					additionalProperties: false,
				}),
			).resolves.toEqual({ approved: true });
		});

		it("completes when the handler returns a Date that encodes to a string", async () => {
			await expect(
				runTyped(() => new Date(0), { type: "string" }),
			).resolves.toBe("1970-01-01T00:00:00.000Z");
		});

		it("completes when the handler returns a class instance", async () => {
			class Row {
				id = 1;
			}
			await expect(
				runTyped(() => new Row(), { type: "object", required: ["id"] }),
			).resolves.toEqual({ id: 1 });
		});

		it("completes a void handler against an empty output schema", async () => {
			await expect(
				runTyped(() => {
					return;
				}, {}),
			).resolves.toBeUndefined();
		});

		it("returns invalid_output for a void handler when the schema needs an object", async () => {
			await expect(
				runTyped(() => undefined, { type: "object" }),
			).rejects.toThrow("invalid_output");
		});

		it("sends the output that was checked, not a second encoding of it", async () => {
			// A toJSON that answers differently on each call: the first answer
			// passes the schema, a later one would not.
			let calls = 0;
			const output = {
				toJSON: () => (calls++ === 0 ? { approved: true } : { approved: "no" }),
			};
			await expect(
				runTyped(() => output, {
					type: "object",
					required: ["approved"],
					properties: { approved: { type: "boolean" } },
				}),
			).resolves.toEqual({ approved: true });
		});

		it("preflight sends the input that was checked, not a second encoding of it", async () => {
			const transport: AgxTransport = {
				...bus.transport(ALICE),
				resolvePeer: vi.fn(async () => ({
					relays: [],
					card: {
						displayName: "Billing",
						capabilities: ["invoice.review"],
						nip05: null,
						skills: [{
							id: "invoice.review",
							description: "Review an invoice",
							inputSchema: {
								type: "object",
								required: ["a"],
								properties: { a: { type: "number" } },
							},
						}],
					},
				})),
			};
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });
			const received = vi.fn((task: { payload: unknown }) => task.payload);
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			bob.handle("invoice.review", received);
			let calls = 0;
			const input = {
				toJSON: () => (calls++ === 0 ? { a: 1 } : { a: "one" }),
			};

			const pending = alice.request(BOB, "invoice.review", input, {
				validate: true,
			});
			await vi.waitFor(() => expect(publishMessage).toHaveBeenCalled());
			await bob.pump();
			await alice.pump();
			await expect(pending).resolves.toEqual({ a: 1 });
		});

		it("preflight accepts a payload whose undefined member the wire drops", async () => {
			const transport: AgxTransport = {
				...bus.transport(ALICE),
				resolvePeer: vi.fn(async () => ({
					relays: [],
					card: {
						displayName: "Billing",
						capabilities: ["invoice.review"],
						nip05: null,
						skills: [{
							id: "invoice.review",
							description: "Review an invoice",
							inputSchema: {
								type: "object",
								properties: { a: { type: "number" } },
								additionalProperties: false,
							},
						}],
					},
				})),
			};
			const publishMessage = vi.spyOn(transport, "publishMessage");
			const alice = new AgxClient({ transport });

			const pending = alice.request(
				BOB,
				"invoice.review",
				{ a: 1, b: undefined },
				{ validate: true, timeoutMs: 20 },
			);
			await expect(pending).rejects.toThrow(/timed out/);
			// The request, then the cancel sent when it timed out.
			expect(publishMessage).toHaveBeenCalled();
		});
	});

	it("does not expose schema validation to a denied requester", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const handler = vi.fn(() => "ok");
		const onMessage = vi.fn();
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: () => false,
			onMessage,
		});
		bob.handle("invoice.review", handler, {
			description: "Review an invoice",
			inputSchema: { type: "object", required: ["amount"] },
		});

		const pending = alice.request(BOB, "invoice.review", {}, { timeoutMs: 20 });
		await bob.pump();
		expect(handler).not.toHaveBeenCalled();
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(bus.inbox.get(ALICE) ?? []).toHaveLength(0);
		await expect(pending).rejects.toThrow(/timed out/);
	});

	describe("contract checks keep their place in the task lifecycle", () => {
		const invoiceContract = {
			description: "Review an invoice",
			inputSchema: {
				type: "object",
				required: ["amount"],
				properties: { amount: { type: "number" } },
			},
			outputSchema: {
				type: "object",
				required: ["approved"],
				properties: { approved: { type: "boolean" } },
			},
		};
		const sendFromAlice = (envelope: Parameters<typeof encodeTaskEnvelope>[0]) =>
			bus.transport(ALICE).publishMessage(BOB, {
				text: encodeTaskEnvelope(envelope),
				contextId: envelope.taskId,
				contentType: TASK_CONTENT_TYPE,
			});
		const resultsSentToAlice = () =>
			(bus.inbox.get(ALICE) ?? []).flatMap((message) => {
				const envelope = parseTaskEnvelope(message.text);
				return envelope?.t === "res" ? [envelope] : [];
			});
		function gate() {
			let open: () => void = () => undefined;
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { opened, open };
		}

		it("accepts a retry under the same task id after invalid_input", async () => {
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			const handler = vi.fn(() => ({ approved: true }));
			bob.handle("invoice.review", handler, invoiceContract);
			const request = (payload: unknown) => ({
				t: "req" as const,
				taskId: "retry-1",
				capability: "invoice.review",
				payload,
			});

			await sendFromAlice(request({ amount: "hello" }));
			await bob.pump();
			await bob.tasksSettled();
			expect(handler).not.toHaveBeenCalled();
			expect(resultsSentToAlice()).toEqual([
				expect.objectContaining({ status: "failed", error: "invalid_input" }),
			]);

			await sendFromAlice(request({ amount: 5 }));
			await bob.pump();
			await bob.tasksSettled();
			expect(handler).toHaveBeenCalledTimes(1);
			expect(resultsSentToAlice().at(-1)).toEqual(
				expect.objectContaining({ status: "completed", output: { approved: true } }),
			);
		});

		it("refuses a bad-payload duplicate of a running task instead of answering invalid_input", async () => {
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
				maxConcurrentTasks: 2,
			});
			const running = gate();
			const handler = vi.fn(() => running.opened.then(() => ({ approved: true })));
			bob.handle("invoice.review", handler, invoiceContract);
			const request = (payload: unknown) => ({
				t: "req" as const,
				taskId: "dup-1",
				capability: "invoice.review",
				payload,
			});

			await sendFromAlice(request({ amount: 5 }));
			await bob.pump();
			expect(handler).toHaveBeenCalledTimes(1);

			// Same peer, same task id, payload that fails the input schema, while dup-1 runs.
			await sendFromAlice(request({ amount: "hello" }));
			await bob.pump();
			expect(resultsSentToAlice()).toEqual([]);

			running.open();
			await bob.tasksSettled();
			expect(handler).toHaveBeenCalledTimes(1);
			expect(resultsSentToAlice()).toEqual([
				expect.objectContaining({
					taskId: "dup-1",
					status: "completed",
					output: { approved: true },
				}),
			]);
		});

		it("answers invalid input at once instead of queueing it for a free slot", async () => {
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
				maxConcurrentTasks: 2,
			});
			const slow = gate();
			bob.handle("slow", () => slow.opened.then(() => "ok"));
			bob.handle("invoice.review", () => ({ approved: true }), invoiceContract);
			await sendFromAlice({ t: "req", taskId: "slow-1", capability: "slow", payload: {} });
			await sendFromAlice({ t: "req", taskId: "slow-2", capability: "slow", payload: {} });
			await sendFromAlice({
				t: "req",
				taskId: "bad-1",
				capability: "invoice.review",
				payload: { amount: "hello" },
			});

			let pumped = false;
			const pumping = bob.pump().then(() => {
				pumped = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Both slots are held by slow tasks, yet the bad request is already answered.
			expect(pumped).toBe(true);
			expect(resultsSentToAlice()).toEqual([
				expect.objectContaining({
					taskId: "bad-1",
					status: "failed",
					error: "invalid_input",
				}),
			]);
			slow.open();
			await pumping;
			await bob.tasksSettled();
		});

		it("sends no invalid_output for a task canceled while its handler ran", async () => {
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
				maxConcurrentTasks: 2,
			});
			const running = gate();
			const release = gate();
			bob.handle(
				"invoice.review",
				async () => {
					running.open();
					await release.opened;
					return { approved: "yes" };
				},
				invoiceContract,
			);
			await sendFromAlice({
				t: "req",
				taskId: "cancel-1",
				capability: "invoice.review",
				payload: { amount: 5 },
			});
			await bob.pump();
			await running.opened;

			await sendFromAlice({ t: "cancel", taskId: "cancel-1" });
			await bob.pump();
			release.open();
			await bob.tasksSettled();

			expect(resultsSentToAlice()).toEqual([]);
		});
	});

	it("rejects an invalid handler schema at registration", () => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		expect(() =>
			bob.handle("invoice.review", () => null, {
				description: "Review an invoice",
				inputSchema: { $ref: "https://example.com/schema" },
			}),
		).toThrow(/unsupported schema keyword/);
	});

	it.each([
		["a wildcard ID", "invoice.*", { description: "Review an invoice" }],
		[
			"17 tags",
			"invoice.review",
			{
				description: "Review an invoice",
				tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
			},
		],
		["an empty description", "invoice.review", { description: "" }],
	])("refuses a contract the card would refuse: %s", (_name, capability, contract) => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		bob.handle("other.task", () => null);
		expect(() => bob.handle(capability, () => null, contract)).toThrow(
			/AGX handler/,
		);
		expect(bob.capabilities()).toEqual(["other.task"]);
	});

	it.each([
		["exclusiveMinimum at maximum", { exclusiveMinimum: 4, maximum: 4 }],
		["minimum at exclusiveMaximum", { minimum: 4, exclusiveMaximum: 4 }],
	])("refuses a contract whose schema has bounds that cannot both hold: %s", (_name, bounds) => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		bob.handle("other.task", () => null);
		for (const contract of [
			{
				description: "Review an invoice",
				inputSchema: { type: "object", properties: { amount: bounds } },
			},
			{ description: "Review an invoice", outputSchema: bounds },
		]) {
			expect(() => bob.handle("invoice.review", () => null, contract)).toThrow(
				/AGX handler invoice\.review contract: invoice\.review (input|output)Schema: .*(minimum|maximum)/,
			);
		}
		expect(bob.capabilities()).toEqual(["other.task"]);
	});

	it("refuses an unknown contract field at registration", () => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		const contract = {
			description: "Review an invoice",
			inputschema: { type: "object" },
		} as unknown as AgxTaskContract;
		expect(() => bob.handle("invoice.review", () => null, contract)).toThrow(
			/AGX handler.*inputschema/,
		);
		expect(bob.capabilities()).toEqual([]);
	});

	it("keeps the registered contract when the caller mutates it later", async () => {
		const advertise = vi.fn(async () => ({ ok: true }));
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: { ...bus.transport(BOB), advertise },
			authorize: "accept-all",
		});
		const amount: Record<string, unknown> = { type: "number" };
		const inputSchema: Record<string, unknown> = {
			type: "object",
			required: ["a"],
			properties: { a: amount },
		};
		bob.handle("invoice.review", () => "ok", {
			description: "Review an invoice",
			inputSchema,
		});
		inputSchema.required = [42];
		// Two levels down, below the copy the schema parser makes anyway.
		amount.type = "string";

		const pending = alice.request(BOB, "invoice.review", { a: 1 });
		await bob.pump();
		await alice.pump();
		await expect(pending).resolves.toBe("ok");

		await bob.start({ pollIntervalMs: 0 });
		expect(advertise).toHaveBeenCalledWith(
			["invoice.review"],
			expect.objectContaining({
				skills: [{
					id: "invoice.review",
					description: "Review an invoice",
					inputSchema: {
						type: "object",
						required: ["a"],
						properties: { a: { type: "number" } },
					},
				}],
			}),
		);
	});

	it("refuses a contract that would push typed metadata over the card limit", async () => {
		const advertise = vi.fn(async () => ({ ok: true }));
		const bob = new AgxClient({
			transport: { ...bus.transport(BOB), advertise },
		});
		// About 11.6 KiB each once escaped inside the event: two fit in 32 KiB,
		// a third does not.
		const big = {
			description: "Review an invoice",
			inputSchema: { const: '"'.repeat(2_900) },
		};
		bob.handle("invoice.a", () => null, big);
		bob.handle("invoice.b", () => null, big);
		expect(() => bob.handle("invoice.c", () => null, big)).toThrow(
			/AGX handler invoice\.c.*32768/,
		);
		expect(bob.capabilities()).toEqual(["invoice.a", "invoice.b"]);

		// Replacing a contract counts the new one instead of the old one.
		bob.handle("invoice.b", () => null, big);
		bob.handle("invoice.b", () => null, { description: "Smaller" });
		bob.handle("invoice.c", () => null, big);

		await bob.start({ pollIntervalMs: 0 });
		const skills = (
			advertise.mock.calls[0] as unknown as [string[], { skills: { id: string }[] }]
		)[1].skills;
		expect(skills.map((skill) => skill.id)).toEqual([
			"invoice.a",
			"invoice.b",
			"invoice.c",
		]);
	});

	it("refuses a 65th typed contract", () => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		for (let index = 0; index < 64; index += 1) {
			bob.handle(`task.${index}`, () => null, { description: "A task" });
		}
		expect(() =>
			bob.handle("task.64", () => null, { description: "A task" }),
		).toThrow(/AGX handler task\.64.*64/);
		bob.handle("task.untyped", () => null);
		expect(bob.capabilities()).toHaveLength(65);
		expect(bob.capabilities()).not.toContain("task.64");
	});

	it("registers a contract whose schemas carry annotations", () => {
		const bob = new AgxClient({ transport: bus.transport(BOB) });
		expect(() =>
			bob.handle("invoice.review", () => null, {
				description: "Review an invoice",
				inputSchema: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					title: "Invoice",
					description: "An invoice to review",
					type: "object",
					properties: {
						amount: { type: "number", default: 0, examples: [10] },
					},
				},
			}),
		).not.toThrow();
	});

	it("advertises typed contracts without changing legacy capability keys", async () => {
		const advertise = vi.fn(async () => ({ ok: true }));
		const bob = new AgxClient({
			transport: { ...bus.transport(BOB), advertise },
		});
		bob.handle("invoice.review", () => null, {
			description: "Review an invoice",
			inputSchema: { type: "object" },
		});
		bob.handle("invoice.pay", () => null);

		await bob.start({ pollIntervalMs: 0 });
		expect(advertise).toHaveBeenCalledWith(
			["invoice.review", "invoice.pay"],
			expect.objectContaining({
				skills: [{
					id: "invoice.review",
					description: "Review an invoice",
					inputSchema: { type: "object" },
				}],
			}),
		);
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

	it("publishes results from running inbound tasks after stop()", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		bob.handle("slow", async () => {
			markStarted();
			await gate;
			return "finished";
		});

		const result = alice.request(BOB, "slow", {}, { timeoutMs: 0 });
		await bob.pump();
		await started;
		await bob.stop();
		release();
		await bob.tasksSettled();
		await alice.pump();

		await expect(result).resolves.toBe("finished");
		await alice.stop();
	});

	it("fails input-waiting tasks when the responder stops", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("approval", async (_task, ctx) =>
			ctx.requestInput({ prompt: "Approve?" }),
		);
		const stream = await alice.streamRequest(BOB, "approval", {}, {
			timeoutMs: 0,
		});

		await bob.pump();
		await alice.pump();
		await bob.stop();
		await bob.tasksSettled();
		await alice.pump();

		await expect(stream.result).rejects.toThrow("handler failed");
		expect(
			(bus.inbox.get(ALICE) ?? [])
				.map((message) => parseTaskEnvelope(message.text))
				.some((envelope) => envelope?.t === "res" && envelope.status === "failed"),
		).toBe(true);
		await alice.stop();
	});

	it("fails a slot-waiting task when the responder stops", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		let releaseBlockers!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseBlockers = resolve;
		});
		bob.handle("ask", async (_task, ctx) => ctx.requestInput({ prompt: "Continue?" }));
		bob.handle("block", async () => {
			await gate;
			return "blocked done";
		});

		const ask = await alice.streamRequest(BOB, "ask", {}, { timeoutMs: 0 });
		await bob.pump();

		// "ask" publishes its requirement and releases its slot.
		const waitForUpdate = async () => {
			for (;;) {
				const found = (bus.inbox.get(ALICE) ?? [])
					.map((message) => parseTaskEnvelope(message.text))
					.find(
						(envelope) =>
							envelope?.t === "res" && envelope.status === "input-required",
					);
				if (found?.t === "res" && found.status === "input-required") {
					return found;
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		};
		const update = await waitForUpdate();

		// Both slots fill, so "ask"'s continuation must queue to re-acquire one.
		const blockers = [
			alice.request(BOB, "block", {}, { timeoutMs: 0 }),
			alice.request(BOB, "block", {}, { timeoutMs: 0 }),
		];
		await bob.pump();

		// The answer arrives while both slots are held: "ask" queues for a
		// slot — a mid-task wait that stop() then breaks.
		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({
				t: "input",
				taskId: update.taskId,
				inputRequestId: update.inputRequestId,
				input: "the answer",
			}),
			contextId: update.taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		await new Promise((resolve) => setTimeout(resolve, 1));

		// stop() must FAIL "ask" with a published result (never silently
		// suppress it as if the requester had cancelled) while letting the
		// running "block" tasks publish once they finish.
		await bob.stop();
		releaseBlockers();
		await bob.tasksSettled();
		await alice.pump();

		await expect(ask.result).rejects.toThrow("handler failed");
		await Promise.all(blockers.map((b) => expect(b).resolves.toBe("blocked done")));
		await alice.stop();
	});

	it("scopes active task IDs and cancellation to the requesting peer", async () => {
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		const handler = vi.fn(async (_task, ctx) =>
			ctx.requestInput({ prompt: "Continue?" }),
		);
		bob.handle("wait", handler);
		const taskId = "shared-task";
		const requestText = encodeTaskEnvelope({
			t: "req",
			taskId,
			capability: "wait",
			payload: {},
			supportsInput: true,
			timeoutMs: 0,
		});
		for (const [peer, messageId] of [
			[ALICE, "alice-request"],
			[ALICE, "alice-duplicate"],
			[CAROL, "carol-request"],
		]) {
			bus.pushMessage(BOB, {
				from: peer,
				text: requestText,
				contextId: taskId,
				messageId,
				subject: null,
				autoDepth: null,
				contentType: TASK_CONTENT_TYPE,
			});
		}

		await bob.pump();
		const waitForInput = async (peer: string) => {
			for (;;) {
				const input = (bus.inbox.get(peer) ?? [])
					.map((message) => parseTaskEnvelope(message.text))
					.find(
						(envelope) =>
							envelope?.t === "res" &&
							envelope.status === "input-required" &&
							envelope.taskId === taskId,
					);
				if (input?.t === "res" && input.status === "input-required") {
					return input.inputRequestId;
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		};
		const [aliceInputRequestId, carolInputRequestId] = await Promise.all([
			waitForInput(ALICE),
			waitForInput(CAROL),
		]);
		expect(handler).toHaveBeenCalledTimes(2);

		await bus.transport(CAROL).publishMessage(BOB, {
			text: encodeTaskEnvelope({ t: "cancel", taskId }),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		expect(
			(bus.inbox.get(ALICE) ?? [])
				.map((message) => parseTaskEnvelope(message.text))
				.some(
					(envelope) =>
						envelope?.t === "res" &&
						(envelope.status === "completed" || envelope.status === "failed"),
				),
		).toBe(false);

		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({
				t: "input",
				taskId,
				inputRequestId: aliceInputRequestId,
				input: "continue",
			}),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		await bob.tasksSettled();

		const aliceResults = (bus.inbox.get(ALICE) ?? [])
			.map((message) => parseTaskEnvelope(message.text))
			.filter((envelope) => envelope?.t === "res" && envelope.status === "completed");
		expect(aliceResults).toEqual([
			expect.objectContaining({ taskId, status: "completed", output: "continue" }),
		]);
		expect(carolInputRequestId).not.toBe(aliceInputRequestId);
		await bob.stop();
	});

	it("keeps a task cancellable after another peer's task with the same id finishes", async () => {
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		const handler = vi.fn(async (_task, ctx) =>
			// Bounded prompt timeout so a cancel that wrongly misses this task
			// fails the test with a visible "failed" result instead of hanging.
			ctx.requestInput({ prompt: "Continue?", timeoutMs: 1000 }),
		);
		bob.handle("wait", handler);
		const taskId = "shared-finish";
		const requestText = encodeTaskEnvelope({
			t: "req",
			taskId,
			capability: "wait",
			payload: {},
			supportsInput: true,
			timeoutMs: 0,
		});
		for (const [peer, messageId] of [
			[ALICE, "alice-request"],
			[CAROL, "carol-request"],
		]) {
			bus.pushMessage(BOB, {
				from: peer,
				text: requestText,
				contextId: taskId,
				messageId,
				subject: null,
				autoDepth: null,
				contentType: TASK_CONTENT_TYPE,
			});
		}

		await bob.pump();
		const waitForInput = async (peer: string) => {
			for (;;) {
				const input = (bus.inbox.get(peer) ?? [])
					.map((message) => parseTaskEnvelope(message.text))
					.find(
						(envelope) =>
							envelope?.t === "res" &&
							envelope.status === "input-required" &&
							envelope.taskId === taskId,
					);
				if (input?.t === "res" && input.status === "input-required") {
					return input.inputRequestId;
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		};
		const [aliceInputRequestId, carolInputRequestId] = await Promise.all([
			waitForInput(ALICE),
			waitForInput(CAROL),
		]);

		// Carol finishes her task. Her cleanup must remove only HER active-task
		// entry — Alice's must survive it. (No `tasksSettled()` here: Alice's
		// task is still waiting on input, so settling would block on it.)
		await bus.transport(CAROL).publishMessage(BOB, {
			text: encodeTaskEnvelope({
				t: "input",
				taskId,
				inputRequestId: carolInputRequestId,
				input: "carol's answer",
			}),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		const waitForTerminal = async (peer: string) => {
			for (;;) {
				const done = (bus.inbox.get(peer) ?? [])
					.map((message) => parseTaskEnvelope(message.text))
					.find(
						(envelope) =>
							envelope?.t === "res" &&
							(envelope.status === "completed" || envelope.status === "failed"),
					);
				if (done?.t === "res") return done;
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		};
		expect(await waitForTerminal(CAROL)).toMatchObject({
			taskId,
			status: "completed",
			output: "carol's answer",
		});

		// Alice can still cancel her own task, and its cancellation is honored:
		// the pending input is rejected, the handler's AgxTaskCanceled is
		// suppressed, and no terminal result is ever published to her.
		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({ t: "cancel", taskId }),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		await bob.tasksSettled();

		const aliceTerminal = (bus.inbox.get(ALICE) ?? [])
			.map((message) => parseTaskEnvelope(message.text))
			.filter(
				(envelope) =>
					envelope?.t === "res" &&
					(envelope.status === "completed" || envelope.status === "failed"),
			);
		expect(aliceTerminal).toEqual([]);
		expect(handler).toHaveBeenCalledTimes(2);
		await bob.stop();
	});

	it("ignores cancellation messages for unknown tasks", async () => {
		const onMessage = vi.fn();
		const bob = new AgxClient({ transport: bus.transport(BOB), onMessage });
		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({ t: "cancel", taskId: "unknown-task" }),
			contextId: "unknown-task",
			contentType: TASK_CONTENT_TYPE,
		});

		await bob.pump();

		expect(onMessage).not.toHaveBeenCalled();
		expect(bus.inbox.get(ALICE)).toBeUndefined();
		await bob.stop();
	});

	it("ignores a cancellation that arrives after the task finished", async () => {
		const onMessage = vi.fn();
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			onMessage,
		});
		const handler = vi.fn(() => "done");
		bob.handle("quick", handler);
		const taskId = "finished-task";
		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({
				t: "req",
				taskId,
				capability: "quick",
				payload: {},
			}),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});

		await bob.pump();
		await bob.tasksSettled();
		expect(handler).toHaveBeenCalledTimes(1);
		// The completed result reached the requester, so the task really did
		// finish and its active-task entry was cleaned up.
		const inboxBefore = (bus.inbox.get(ALICE) ?? []).length;
		expect(inboxBefore).toBeGreaterThan(0);

		// This cancel now matches no active task — the other half of the
		// timeout race. It must be ignored without a reply and never surface
		// as a plain message.
		await bus.transport(ALICE).publishMessage(BOB, {
			text: encodeTaskEnvelope({ t: "cancel", taskId }),
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();

		expect(onMessage).not.toHaveBeenCalled();
		expect((bus.inbox.get(ALICE) ?? []).length).toBe(inboxBefore);
		await bob.stop();
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

	describe("a public error message longer than the 2000-character result limit", () => {
		/** Run one request whose handler throws `AgxPublicError(message)` and return
		 * what the requester's promise settled with. The short timeout turns a
		 * dropped result into a fast, clearly-labelled failure instead of a hang. */
		async function failureMessage(message: string): Promise<string> {
			const alice = new AgxClient({ transport: bus.transport(ALICE) });
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			bob.handle("long", () => {
				throw new AgxPublicError(message);
			});
			const pending = alice.request(BOB, "long", {}, { timeoutMs: 200 });
			await bob.pump();
			await alice.pump();
			const error = await pending.then(
				() => new Error("request unexpectedly completed"),
				(e: unknown) => e as Error,
			);
			return error.message;
		}

		it("delivers the first 2000 characters instead of letting the requester time out", async () => {
			const got = await failureMessage("x".repeat(2001));
			expect(got).toBe("x".repeat(2000));
		});

		it("sends a message of exactly 2000 characters unchanged", async () => {
			const message = `${"a".repeat(1999)}b`;
			expect(await failureMessage(message)).toBe(message);
		});

		it("does not cut a surrogate pair in half", async () => {
			// "😀" is two UTF-16 units. A cut at 2000 would leave only its first half.
			const got = await failureMessage(`${"a".repeat(1999)}😀`);
			expect(got).toBe("a".repeat(1999));
		});

		it("keeps a surrogate pair that fits whole", async () => {
			const message = `${"a".repeat(1998)}😀`;
			expect(message).toHaveLength(2000);
			expect(await failureMessage(message)).toBe(message);
		});
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

	it("dedupes a live subscription event against a concurrent poll", async () => {
		const base = bus.transport(BOB);
		let receiveLive: ((msg: AgxIncomingMessage) => void | Promise<void>) | undefined;
		const transport: AgxTransport = {
			...base,
			onMessage(handler) {
				receiveLive = handler;
			},
		};
		let finishDispatch: () => void = () => undefined;
		let startedDispatch: () => void = () => undefined;
		const dispatchStarted = new Promise<void>((resolve) => {
			startedDispatch = resolve;
		});
		const dispatchGate = new Promise<void>((resolve) => {
			finishDispatch = resolve;
		});
		const onMessage = vi.fn(async () => {
			startedDispatch();
			await dispatchGate;
		});
		const bob = new AgxClient({ transport, onMessage });
		await bob.start({ pollIntervalMs: 0, advertise: false });
		bus.pushMessage(BOB, {
			from: ALICE,
			text: "live and polled",
			contextId: "ctx",
			messageId: "same-event",
			subject: null,
			autoDepth: null,
			contentType: "application/a2a+json",
		});
		const [msg] = bus.inbox.get(BOB)!;

		const live = receiveLive!(msg);
		await dispatchStarted;
		const polling = bob.pump();
		finishDispatch();
		await Promise.all([live, polling]);

		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(await bob.pump()).toMatchObject({ dispatched: 0 });
	});
});

describe("AgxClient streamRequest", () => {
	function gate() {
		let open: () => void = () => undefined;
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { opened, open };
	}

	it("reports delivery and completion while an asynchronous handler is processing", async () => {
		const aliceLive = liveTransport(ALICE);
		const alice = new AgxClient({ transport: aliceLive.transport });
		await alice.start({ pollIntervalMs: 0, advertise: false });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		const processing = gate();
		bob.handle("slow", async () => {
			await processing.opened;
			return "finished";
		});

		const stream = await alice.streamRequest<string>(BOB, "slow", {});
		const statuses: string[] = [];
		const completed = vi.fn();
		stream.on("statusUpdate", (status) => statuses.push(status));
		stream.on("completed", completed);

		const request = bus.inbox.get(BOB)?.[0];
		expect(request).toBeDefined();
		const requestEnvelope = parseTaskEnvelope(request!.text);
		expect(requestEnvelope?.t).toBe("req");
		if (!requestEnvelope || requestEnvelope.t !== "req") {
			throw new Error("Expected the stream request envelope");
		}

		await bob.pump();
		expect(completed).not.toHaveBeenCalled();
		await aliceLive.deliverReceipt({
			from: BOB,
			eventId: "receipt-1",
			createdAt: 1,
			receipt: {
				v: 1,
				kind: "receipt",
				refEventId: request!.eventId,
				contextId: requestEnvelope.taskId,
				status: "delivered",
			},
		});
		expect(statuses).toEqual(["delivered"]);

		processing.open();
		await bob.tasksSettled();
		const result = bus.inbox.get(ALICE)?.[0];
		expect(result).toBeDefined();
		await alice.pump(); // Also settles streamRequest's correlated pending entry.
		await aliceLive.deliverMessage(result!);

		expect(statuses).toEqual(["delivered", "completed"]);
		expect(completed).toHaveBeenCalledWith("finished");
		await alice.stop();
	});

	it("resumes a handler after an input-required update without blocking pump", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("approval", async (_task, ctx) => {
			const approved = await ctx.requestInput({
				id: "approval",
				prompt: "Approve this request?",
			});
			return { approved };
		});

		const stream = await alice.streamRequest<{ approved: boolean }>(
			BOB,
			"approval",
			{},
		);
		const updates: string[] = [];
		let inputRequestId = "";
		const completed = vi.fn();
		stream.on("statusUpdate", (status) => updates.push(status));
		stream.on("inputRequired", (update) => {
			inputRequestId = update.inputRequestId;
			expect(update.requirement.prompt).toBe("Approve this request?");
		});
		stream.on("completed", completed);

		await bob.pump();
		expect(inputRequestId).toBe("");
		await alice.pump();
		expect(inputRequestId).not.toBe("");
		expect(updates).toEqual(["input-required"]);
		expect(completed).not.toHaveBeenCalled();

		const request = bus.inbox.get(BOB)?.[0];
		const requestEnvelope = request && parseTaskEnvelope(request.text);
		if (!requestEnvelope || requestEnvelope.t !== "req") {
			throw new Error("Expected the original task request");
		}
		bus.pushMessage(BOB, {
			from: "mallory",
			text: encodeTaskEnvelope({
				t: "input",
				taskId: requestEnvelope.taskId,
				inputRequestId,
				input: false,
			}),
			contextId: requestEnvelope.taskId,
			messageId: "forged-input",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		await bob.pump();
		expect(completed).not.toHaveBeenCalled();

		await stream.provideInput(inputRequestId, true);
		await bob.pump();
		await bob.tasksSettled();
		await alice.pump();

		expect(updates).toEqual(["input-required", "completed"]);
		expect(completed).toHaveBeenCalledWith({ approved: true });
	});

	it("releases the only task slot while a handler waits for input", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("approval", async (_task, ctx) => {
			await ctx.requestInput({ prompt: "Approve?" });
			return "approved";
		});
		bob.handle("quick", () => "quick result");

		const approval = await alice.streamRequest(BOB, "approval", {});
		let inputRequestId = "";
		approval.on("inputRequired", (update) => {
			inputRequestId = update.inputRequestId;
		});
		const quick = alice.request(BOB, "quick", {});
		await bob.pump();
		await alice.pump();
		await expect(quick).resolves.toBe("quick result");
		expect(inputRequestId).not.toBe("");
		await approval.provideInput(inputRequestId, true);
		await bob.pump();
		await bob.tasksSettled();
		await alice.pump();
		await expect(approval.result).resolves.toBe("approved");
	});

	it("uses a default for zero input timeout and caps it at the client maximum", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			requestTimeoutMs: 0,
			maxInputTimeoutMs: 25,
		});
		bob.handle("approval", async (_task, ctx) =>
			ctx.requestInput({ prompt: "Approve?", timeoutMs: 0 }),
		);
		const stream = await alice.streamRequest(BOB, "approval", {}, {
			timeoutMs: 0,
		});
		const requirements: number[] = [];
		stream.on("inputRequired", ({ requirement }) => {
			requirements.push(requirement.timeoutMs ?? -1);
		});

		await bob.pump();
		await alice.pump();
		expect(requirements).toEqual([25]);
		await bob.tasksSettled();
		await alice.pump();
		await expect(stream.result).rejects.toThrow("handler failed");
	});

	it("fails promptly and cancels input for requesters that did not opt in", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("approval", async (_task, ctx) =>
			ctx.requestInput({ prompt: "Approve?" }),
		);
		const result = alice.request(BOB, "approval", {}, { timeoutMs: 0 });

		await bob.pump();
		await alice.pump();
		await expect(result).rejects.toThrow(/requires input/);
		await bob.tasksSettled();
		const replies = (bus.inbox.get(ALICE) ?? [])
			.map((message) => parseTaskEnvelope(message.text))
			.filter((envelope) => envelope?.t === "res");
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({
			t: "res",
			status: "failed",
			error: expect.stringContaining("requires input"),
		});
	});

	it("cancels a legacy input-required update when a plain requester cannot answer", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const pending = alice.request(BOB, "legacy.input", {}, { timeoutMs: 0 });
		const request = bus.inbox.get(BOB)?.[0];
		const envelope = request && parseTaskEnvelope(request.text);
		if (!envelope || envelope.t !== "req") {
			throw new Error("Expected the task request");
		}
		bus.pushMessage(ALICE, {
			from: BOB,
			text: encodeTaskEnvelope({
				t: "res",
				taskId: envelope.taskId,
				status: "input-required",
				inputRequestId: "legacy-input",
				requirement: { prompt: "Need input" },
			}),
			contextId: envelope.taskId,
			messageId: "legacy-input-required",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});

		await alice.pump();
		await expect(pending).rejects.toThrow(/requires input/);
		expect(
			(bus.inbox.get(BOB) ?? [])
				.map((message) => parseTaskEnvelope(message.text))
				.some((message) => message?.t === "cancel" && message.taskId === envelope.taskId),
		).toBe(true);
	});

	it("caps the number of concurrent input requirements", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxPendingTaskInputs: 1,
		});
		bob.handle("approval", async (_task, ctx) =>
			ctx.requestInput({ prompt: "Approve?" }),
		);
		const first = await alice.streamRequest(BOB, "approval", {});
		const second = await alice.streamRequest(BOB, "approval", {});

		await bob.pump();
		await alice.pump();
		await expect(second.result).rejects.toThrow(
			/limit for pending input requirements/,
		);
		await alice.stop();
		await bob.pump();
		await bob.tasksSettled();
		await expect(first.result).rejects.toThrow(/AGX client stopped/);
	});

	it("cancels the responder on requester timeout and rejects late input", async () => {
		// Fake timers make the cancel-vs-timeout race deterministic: the
		// responder's input wait is capped by the requester's deadline, so
		// with real timers both fire at ~30 ms and a slow runner can let the
		// responder publish its own "failed" result before it sees the cancel.
		vi.useFakeTimers();
		try {
			const alice = new AgxClient({ transport: bus.transport(ALICE) });
			const bob = new AgxClient({
				transport: bus.transport(BOB),
				authorize: "accept-all",
			});
			let handlerError: unknown;
			bob.handle("approval", async (_task, ctx) => {
				try {
					return await ctx.requestInput({ prompt: "Approve?", timeoutMs: 5_000 });
				} catch (error) {
					handlerError = error;
					throw error;
				}
			});
			const stream = await alice.streamRequest(BOB, "approval", {}, {
				timeoutMs: 30,
			});
			let inputRequestId = "";
			stream.on("inputRequired", (update) => {
				inputRequestId = update.inputRequestId;
			});
			const rejected = expect(stream.result).rejects.toThrow(/timed out/);

			// The responder receives the request 10 ms later, so its input wait
			// (capped to the requester's 30 ms budget) ends at t=40, after the
			// requester's own timeout at t=30.
			await vi.advanceTimersByTimeAsync(10);
			await bob.pump();
			await alice.pump();
			expect(inputRequestId).not.toBe("");

			// Requester times out at t=30 and sends a cancel.
			await vi.advanceTimersByTimeAsync(20);
			await rejected;
			await expect(stream.provideInput(inputRequestId, true)).rejects.toThrow(
				/not pending/,
			);
			const cancels = (bus.inbox.get(BOB) ?? [])
				.map((message) => parseTaskEnvelope(message.text))
				.filter((envelope) => envelope?.t === "cancel");
			expect(cancels).toHaveLength(1);

			// The responder handles the cancel before its own input deadline.
			await bob.pump();
			await bob.tasksSettled();
			expect(handlerError).toBeDefined();
			expect(String(handlerError)).not.toMatch(/timed out/);

			// Running past the responder's deadline publishes nothing more.
			await vi.advanceTimersByTimeAsync(10_000);
			await bob.tasksSettled();
			const replies = (bus.inbox.get(ALICE) ?? [])
				.map((message) => parseTaskEnvelope(message.text))
				.filter((envelope) => envelope?.t === "res");
			expect(replies).toHaveLength(1);
			expect(replies[0]).toMatchObject({ status: "input-required" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("registers stream update handling before publishing the initial request", async () => {
		const live = liveTransport(ALICE);
		const base = bus.transport(ALICE);
		const transport: AgxTransport = {
			...live.transport,
			async publishMessage(to, message) {
				const sent = await base.publishMessage(to, message);
				const request = parseTaskEnvelope(message.text);
				if (request?.t === "req") {
					for (const [messageId, result] of [
						[
							"early-input-required",
							{
								t: "res" as const,
								taskId: request.taskId,
								status: "input-required" as const,
								inputRequestId: "early-input",
								requirement: { prompt: "Need input" },
							},
						],
						[
							"early-completed",
							{
								t: "res" as const,
								taskId: request.taskId,
								status: "completed" as const,
								output: "done",
							},
						],
					] as const) {
						bus.pushMessage(ALICE, {
							from: BOB,
							text: encodeTaskEnvelope(result),
							contextId: request.taskId,
							messageId,
							subject: null,
							autoDepth: null,
							contentType: TASK_CONTENT_TYPE,
						});
						const incoming = bus.inbox.get(ALICE)!.at(-1)!;
						await live.deliverMessage(incoming);
					}
				}
				return sent;
			},
		};
		const alice = new AgxClient({ transport });
		await alice.start({ pollIntervalMs: 0, advertise: false });
		const stream = await alice.streamRequest(BOB, "early", {}, {
			timeoutMs: 0,
		});
		const inputRequired = vi.fn();
		const completed = vi.fn();
		stream.on("inputRequired", inputRequired);
		stream.on("completed", completed);

		expect(inputRequired).toHaveBeenCalledWith({
			inputRequestId: "early-input",
			requirement: { prompt: "Need input" },
		});
		expect(completed).toHaveBeenCalledWith("done");
		await alice.stop();
	});

	it("reports failed task status and the peer's error", async () => {
		const aliceLive = liveTransport(ALICE);
		const alice = new AgxClient({ transport: aliceLive.transport });
		await alice.start({ pollIntervalMs: 0, advertise: false });
		const stream = await alice.streamRequest(BOB, "fails", {}, {
			timeoutMs: 0,
		});
		const statuses: string[] = [];
		const errors: string[] = [];
		stream.on("statusUpdate", (status) => statuses.push(status));
		stream.on("error", (error) => errors.push(error));

		const request = bus.inbox.get(BOB)?.[0];
		const envelope = request && parseTaskEnvelope(request.text);
		if (!envelope || envelope.t !== "req") {
			throw new Error("Expected the stream request envelope");
		}
		bus.pushMessage(ALICE, {
			from: BOB,
			text: encodeTaskEnvelope({
				t: "res",
				taskId: envelope.taskId,
				status: "failed",
				error: "handler failed",
			}),
			contextId: envelope.taskId,
			messageId: "result-1",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		const result = bus.inbox.get(ALICE)![0];
		await aliceLive.deliverMessage(result);
		await alice.pump();

		expect(statuses).toEqual(["failed"]);
		expect(errors).toEqual(["handler failed"]);
		await alice.stop();
	});

	it("emits TaskNotFoundError for a message that is not a task result", async () => {
		const aliceLive = liveTransport(ALICE);
		const alice = new AgxClient({ transport: aliceLive.transport });
		await alice.start({ pollIntervalMs: 0, advertise: false });
		const stream = await alice.streamRequest(BOB, "unknown", {}, {
			timeoutMs: 0,
		});
		const errors: string[] = [];
		stream.on("error", (error) => errors.push(error));

		const request = bus.inbox.get(BOB)?.[0];
		const envelope = request && parseTaskEnvelope(request.text);
		if (!envelope || envelope.t !== "req") {
			throw new Error("Expected the stream request envelope");
		}
		await aliceLive.deliverMessage({
			from: BOB,
			text: "not a task result",
			contextId: envelope.taskId,
			messageId: "invalid-result",
			eventId: "invalid-result",
			createdAt: 1,
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});

		expect(errors).toEqual(["TaskNotFoundError"]);
		await alice.stop();
	});

	it("resolves result and emits completion when polling receives the task response", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		bob.handle("poll-only", () => "polled result");

		const stream = await alice.streamRequest<string>(BOB, "poll-only", {});
		const completed = vi.fn();
		stream.on("completed", completed);

		await bob.pump();
		await alice.pump();

		await expect(stream.result).resolves.toBe("polled result");
		expect(completed).toHaveBeenCalledWith("polled result");
	});

	it("emits an error and rejects result when the request times out", async () => {
		const client = new AgxClient({ transport: bus.transport(ALICE) });
		const stream = await client.streamRequest(BOB, "never", {}, {
			timeoutMs: 10,
		});
		const errors: string[] = [];
		stream.on("error", (error) => errors.push(error));

		await expect(stream.result).rejects.toThrow("timed out");
		expect(errors).toEqual([expect.stringContaining("timed out")]);
	});

	it("emits an error and rejects result when publish fails", async () => {
		const base = bus.transport(ALICE);
		const transport: AgxTransport = {
			...base,
			async publishMessage(_to, message) {
				return {
					ok: false,
					eventId: "",
					contextId: message.contextId ?? "",
				};
			},
		};
		const client = new AgxClient({ transport });
		const stream = await client.streamRequest(BOB, "fails-to-send", {}, {
			timeoutMs: 0,
		});
		const errors: string[] = [];
		stream.on("error", (error) => errors.push(error));

		await expect(stream.result).rejects.toThrow("publish failed");
		expect(errors).toEqual([
			expect.stringContaining("publish failed"),
		]);
	});

	it("emits an error and rejects result when the client stops", async () => {
		const client = new AgxClient({ transport: bus.transport(ALICE) });
		const stream = await client.streamRequest(BOB, "stopped", {}, {
			timeoutMs: 0,
		});
		const errors: string[] = [];
		stream.on("error", (error) => errors.push(error));

		await client.stop();

		await expect(stream.result).rejects.toThrow("AGX client stopped");
		expect(errors).toEqual(["AGX client stopped"]);
	});

	it("reports only delivered receipts and removes stream receipt listeners at completion", async () => {
		const client = new AgxClient({ transport: bus.transport(ALICE) });
		const stream = await client.streamRequest(BOB, "receipt-status", {}, {
			timeoutMs: 0,
		});
		const statuses: string[] = [];
		stream.on("statusUpdate", (status) => statuses.push(status));
		const request = bus.inbox.get(BOB)?.[0];
		expect(request).toBeDefined();

		for (const [status, eventId] of [
			["quarantined", "receipt-quarantined"],
			["read", "receipt-read"],
			["delivered", "receipt-delivered"],
		] as const) {
			bus.pushReceiptEvent(ALICE, {
				from: BOB,
				transportId: eventId,
				receipt: {
					v: 1,
					kind: "receipt",
					refEventId: request!.eventId,
					contextId: request!.contextId,
					status,
				},
			});
			await client.pump();
		}
		expect(statuses).toEqual(["delivered"]);

		bus.pushMessage(ALICE, {
			from: BOB,
			text: encodeTaskEnvelope({
				t: "res",
				taskId: request!.contextId,
				status: "completed",
				output: "done",
			}),
			contextId: request!.contextId,
			messageId: "receipt-status-complete",
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		await client.pump();
		await expect(stream.result).resolves.toBe("done");

		bus.pushReceiptEvent(ALICE, {
			from: BOB,
			transportId: "late-delivered-receipt",
			receipt: {
				v: 1,
				kind: "receipt",
				refEventId: request!.eventId,
				contextId: request!.contextId,
				status: "delivered",
			},
		});
		await client.pump();
		expect(statuses).toEqual(["delivered", "completed"]);
		await client.stop();
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

	it("passes `authorize` the request's event id", async () => {
		const authorize = vi.fn(() => true);
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({ transport: bus.transport(BOB), authorize });
		bob.handle("x.y", () => null);
		void alice.request(BOB, "x.y", {}, { timeoutMs: 0 });
		await new Promise((r) => setTimeout(r, 0));
		const [request] = bus.inbox.get(BOB) ?? [];
		await bob.pump();
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({ from: ALICE, capability: "x.y", eventId: request.eventId }),
		);
	});

	it("sends nothing back for a task its handler declines, records it as handled, and goes on", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
		});
		const handler = vi.fn((task: { payload: unknown }) => {
			if ((task.payload as { n: number }).n === 1) {
				throw new AgxTaskDeclined("another instance has it");
			}
			return "answered";
		});
		bob.handle("x.y", handler);
		void alice.request(BOB, "x.y", { n: 1 }, { timeoutMs: 0 });
		const second = alice.request(BOB, "x.y", { n: 2 }, { timeoutMs: 0 });
		await new Promise((r) => setTimeout(r, 0));
		const { complete } = await bob.pump();
		expect(complete).toBe(true);
		const replies = (bus.inbox.get(ALICE) ?? []).map((m) => parseTaskEnvelope(m.text));
		expect(replies).toEqual([expect.objectContaining({ t: "res", status: "completed", output: "answered" })]);
		await alice.pump();
		await expect(second).resolves.toBe("answered");
		await bob.pump();
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("retries, then dead-letters, an event whose `ignore` check throws, and still dispatches the rest", async () => {
		const onMessage = vi.fn();
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			onMessage,
			maxDispatchAttempts: 2,
			ignore: (event) => {
				if ("text" in event && event.text === "poison") {
					throw new Error("filter broke");
				}
				return false;
			},
		});
		for (const [text, messageId] of [["poison", "m1"], ["fine", "m2"]]) {
			bus.pushMessage(BOB, {
				from: ALICE,
				text,
				contextId: "c",
				messageId,
				subject: null,
				autoDepth: null,
				contentType: "application/a2a+json",
			});
		}
		await expect(bob.pump()).resolves.toMatchObject({ complete: false });
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "fine" }));
		// Second failure hits the cap: dead-lettered, so the cursor can move on.
		await expect(bob.pump()).resolves.toMatchObject({ complete: true });
		await expect(bob.pump()).resolves.toMatchObject({ complete: true });
		expect(onMessage).toHaveBeenCalledTimes(1);
	});
});

describe("AgxClient runs tasks side by side when asked to", () => {
	function gate() {
		let open: () => void = () => undefined;
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { opened, open };
	}

	it("by default, waits in pump() for each handler", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({ transport: bus.transport(BOB), authorize: "accept-all" });
		const slow = gate();
		bob.handle("slow", () => slow.opened.then(() => "slow done"));
		void alice.request(BOB, "slow", {}).catch(() => undefined);
		let pumped = false;
		const pumping = bob.pump().then(() => {
			pumped = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(pumped).toBe(false);
		slow.open();
		await pumping;
		expect(pumped).toBe(true);
		await alice.stop();
	});

	it("does not let a slow handler hold up another task or a message", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const messages: string[] = [];
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 4,
			onMessage: (msg) => {
				messages.push(msg.text);
			},
		});
		const slow = gate();
		bob.handle("slow", () => slow.opened.then(() => "slow done"));
		bob.handle("fast", () => "fast done");
		const slowResult = alice.request(BOB, "slow", {});
		const fastResult = alice.request(BOB, "fast", {});
		await bus.transport(ALICE).publishMessage(BOB, { text: "hello" });

		// The pump returns with the slow task still running.
		await bob.pump();
		expect(messages).toEqual(["hello"]);
		// The fast task's result is sent from its own slot, just after.
		await new Promise((r) => setTimeout(r, 10));
		await alice.pump();
		await expect(fastResult).resolves.toBe("fast done");

		slow.open();
		await bob.tasksSettled();
		await alice.pump();
		await expect(slowResult).resolves.toBe("slow done");
	});

	it("runs no more than maxConcurrentTasks at once, and waits for a free slot", async () => {
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({ transport: bus.transport(BOB), authorize: "accept-all", maxConcurrentTasks: 2 });
		const slow = gate();
		let running = 0;
		let most = 0;
		bob.handle("slow", async () => {
			running += 1;
			most = Math.max(most, running);
			await slow.opened;
			running -= 1;
			return "ok";
		});
		const results = [1, 2, 3].map(() => alice.request(BOB, "slow", {}));
		const pumping = bob.pump();
		await new Promise((r) => setTimeout(r, 20));
		// Two running; the pump waits for a slot for the third.
		expect(running).toBe(2);
		slow.open();
		await pumping;
		await bob.tasksSettled();
		expect(most).toBe(2);
		await alice.pump();
		await expect(Promise.all(results)).resolves.toEqual(["ok", "ok", "ok"]);
	});

	it("does not start or mark queued tasks handled after stop", async () => {
		const seen = {
			has: vi.fn(async () => false),
			add: vi.fn(async () => undefined),
		};
		const alice = new AgxClient({ transport: bus.transport(ALICE) });
		const bob = new AgxClient({
			transport: bus.transport(BOB),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
			seen,
		});
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let starts = 0;
		bob.handle("slow", async () => {
			starts += 1;
			await gate;
			return "ok";
		});
		const requests = Array.from({ length: 3 }, () =>
			alice.request(BOB, "slow", {}, { timeoutMs: 100 }),
		);
		requests.forEach((request) => request.catch(() => undefined));
		while ((bus.inbox.get(BOB) ?? []).length < 3) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const eventIds = (bus.inbox.get(BOB) ?? []).map((message) => message.eventId);

		const pumping = bob.pump();
		while (starts < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await bob.stop();
		await pumping;
		expect(starts).toBe(2);
		expect(seen.add).not.toHaveBeenCalledWith(eventIds[2]);
		// Releasing the active handlers must not launch the cancelled third task.
		// Releasing the active handlers must not launch the cancelled third task.
		releaseGate();
		await bob.tasksSettled();
		expect(starts).toBe(2);
	});

	it("bounds live task queueing without marking overflow tasks seen", async () => {
		const live = liveTransport(BOB);
		const seen = {
			has: vi.fn(async () => false),
			add: vi.fn(async () => undefined),
		};
		const bob = new AgxClient({
			transport: live.transport,
			authorize: "accept-all",
			seen,
		});
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let starts = 0;
		bob.handle("slow", async () => {
			starts += 1;
			await gate;
			return "ok";
		});
		await bob.start({ pollIntervalMs: 0, advertise: false });

		const messages = Array.from({ length: 102 }, (_, index) => ({
			from: ALICE,
			eventId: `queue-event-${index}`,
			createdAt: Math.floor(Date.now() / 1000),
			text: encodeTaskEnvelope({
				t: "req" as const,
				taskId: `queue-task-${index}`,
				capability: "slow",
				payload: {},
			}),
			contextId: `queue-task-${index}`,
			messageId: `queue-message-${index}`,
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		}));
		const delivery = Promise.all(messages.map((message) => live.deliverMessage(message)));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(starts).toBe(1);
		expect(seen.add).not.toHaveBeenCalled();

		releaseGate();
		await delivery;
		await bob.tasksSettled();
		expect(starts).toBe(101);
		expect(seen.add).toHaveBeenCalledTimes(101);
		expect(seen.add).not.toHaveBeenCalledWith("queue-event-101");
		await bob.stop();
	});
});

describe("AgxClient request while its publish is slow", () => {
	it("times out cleanly when the timeout fires before the publish finishes", async () => {
		const slow = bus.transport(ALICE);
		let finishPublish: () => void = () => undefined;
		const transport = {
			...slow,
			publishMessage: () =>
				new Promise<{ ok: boolean; eventId: string; contextId: string }>((resolve) => {
					finishPublish = () => resolve({ ok: true, eventId: "e", contextId: "c" });
				}),
		};
		const alice = new AgxClient({ transport });
		const pending = alice.request(BOB, "slow.publish", {}, { timeoutMs: 20 });
		// The timeout fires while the publish is still in flight: before this
		// fix that rejection was unhandled, which ends a Node process.
		await new Promise((r) => setTimeout(r, 50));
		finishPublish();
		await expect(pending).rejects.toThrow(/timed out/);
	});
});
