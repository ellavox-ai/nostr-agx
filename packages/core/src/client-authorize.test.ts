import { describe, expect, it, vi } from "vitest";
import { AgxClient } from "./client";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";
import type { TaskEnvelope, TaskResultEnvelope } from "./task";
import type { AgxIncomingMessage, AgxTransport } from "./transport";
import { TASK_CONTENT_TYPE } from "./wire";

// An owner can change who is allowed while a task is still waiting: in the
// queue, for a free slot, or for the requester's answer. These tests pin that
// `authorize` is asked again at the two points where a waiting task would go on
// (start, resume), and that a "no" ends the task the way a "no" at intake does:
// nothing is sent to the peer, and the request goes to `onMessage`.

const BOB = "bob";
const X = "peer-x";
const Z = "peer-z";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await pause(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function gate() {
	let open: () => void = () => undefined;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

let sequence = 0;

function message(from: string, envelope: TaskEnvelope): AgxIncomingMessage {
	const id = `event-${++sequence}`;
	return {
		from,
		eventId: id,
		createdAt: Math.floor(Date.now() / 1000),
		transportId: `wrap-${id}`,
		text: encodeTaskEnvelope(envelope),
		contextId: envelope.taskId,
		messageId: `message-${id}`,
		subject: null,
		autoDepth: null,
		contentType: TASK_CONTENT_TYPE,
	};
}

function request(from: string, taskId: string, supportsInput = false): AgxIncomingMessage {
	return message(from, {
		t: "req",
		taskId,
		capability: "work",
		payload: {},
		...(supportsInput ? { supportsInput: true } : {}),
	});
}

/** The agent's side of the wire: records what it publishes, takes a live
 * delivery the way a relay subscription would, and serves `pump()` from `inbox`. */
function wire() {
	const published: Array<{ to: string; text: string }> = [];
	const inbox: AgxIncomingMessage[] = [];
	const listeners: Array<(msg: AgxIncomingMessage) => void | Promise<void>> = [];
	const transport: AgxTransport = {
		whoami: () => BOB,
		async publishMessage(to, msg) {
			published.push({ to, text: msg.text });
			return { ok: true, eventId: "sent", contextId: msg.contextId ?? "context" };
		},
		async publishReceipt() {
			return { ok: true };
		},
		async poll() {
			return { messages: [...inbox], receipts: [], complete: true };
		},
		async resolvePeer() {
			return { relays: [], card: null };
		},
		onMessage(listener) {
			listeners.push(listener);
			return () => {
				listeners.splice(listeners.indexOf(listener), 1);
			};
		},
	};
	const results = (peer: string): TaskResultEnvelope[] =>
		published
			.filter((entry) => entry.to === peer)
			.map((entry) => parseTaskEnvelope(entry.text))
			.filter((env): env is TaskResultEnvelope => env?.t === "res");
	return {
		transport,
		inbox,
		/** What was sent to `peer` about tasks, as "taskId:status". */
		resultsTo: (peer: string) => results(peer).map((r) => `${r.taskId}:${r.status}`),
		inputRequestId(peer: string, taskId: string): string {
			for (const r of results(peer)) {
				if (r.taskId === taskId && r.status === "input-required") return r.inputRequestId;
			}
			throw new Error(`no input requirement was sent for ${taskId}`);
		},
		deliver: async (msg: AgxIncomingMessage) => {
			await Promise.all(listeners.map((listener) => listener(msg)));
		},
	};
}

describe("AgxClient asks authorize again when a waiting task would start or go on", () => {
	it("does not start a queued task once its peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const onMessage = vi.fn();
		const client = new AgxClient({ transport: peer.transport, authorize, onMessage });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return `done ${task.taskId}`;
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queued = request(X, "queued");
		const queuedDelivery = peer.deliver(queued);
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");

		allowed.delete(X);
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first"]);
		expect(peer.resultsTo(X)).toEqual(["first:completed"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith(queued);
		expect(authorize).toHaveBeenCalledTimes(3);
		await client.stop();
	});

	it("does not start a task waiting for a free slot once its peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const onMessage = vi.fn();
		const client = new AgxClient({
			transport: peer.transport,
			authorize,
			onMessage,
			maxConcurrentTasks: 2,
		});
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			await running.opened;
			return "ok";
		});
		const third = request(X, "c");
		peer.inbox.push(request(X, "a"), request(X, "b"), third);

		const pumping = client.pump();
		await until(
			() => ran.length === 2 && authorize.mock.calls.length === 3,
			"two handlers to run and the third request to be authorized",
		);
		allowed.delete(X);
		running.open();
		await pumping;
		await client.tasksSettled();

		expect(ran).toEqual(["a", "b"]);
		expect(peer.resultsTo(X).sort()).toEqual(["a:completed", "b:completed"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith(third);
	});

	it("does not continue a task waiting for input once its peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const onMessage = vi.fn();
		const client = new AgxClient({ transport: peer.transport, authorize, onMessage });
		const continued: unknown[] = [];
		client.handle("work", async (_task, ctx) => {
			const answer = await ctx.requestInput({ prompt: "Proceed?" });
			continued.push(answer);
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const original = request(X, "ask", true);
		await peer.deliver(original);
		const inputRequestId = peer.inputRequestId(X, "ask");

		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(continued).toEqual([]);
		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith(original);
		expect(authorize).toHaveBeenCalledTimes(2);
		await client.stop();
	});

	it("gives the slot and the task id back when a queued task is turned down", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		allowed.delete(X);
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		void peer.deliver(request(Z, "later"));
		await until(() => ran.includes("later"), "a later task to get the slot");
		await client.tasksSettled();
		expect(ran).toEqual(["first", "later"]);

		// The same task id from the same peer is taken afresh once it is allowed again.
		allowed.add(X);
		await peer.deliver(request(X, "queued"));
		await client.tasksSettled();
		expect(ran).toEqual(["first", "later", "queued"]);
		await client.stop();
	});

	it("gives the slot back and frees the task id when a task waiting for input is turned down", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const continued: unknown[] = [];
		const ran: string[] = [];
		client.handle("work", async (task, ctx) => {
			ran.push(task.taskId);
			if (task.taskId === "ask") continued.push(await ctx.requestInput({ prompt: "Proceed?" }));
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();
		expect(continued).toEqual([]);

		// The slot is free for someone else.
		void peer.deliver(request(Z, "later"));
		await until(() => ran.includes("later"), "a later task to get the slot");
		await client.tasksSettled();

		// And the same task id from the same peer is taken afresh once it is allowed again.
		allowed.add(X);
		await peer.deliver(request(X, "ask", true));
		expect(peer.resultsTo(X)).toEqual(["ask:input-required", "ask:input-required"]);
		await client.stop();
	});

	it("treats an authorize that throws when asked again as a no, and tells the peer nothing", async () => {
		const peer = wire();
		let failing = false;
		const authorize = vi.fn(async () => {
			if (failing) throw new Error("directory unavailable: db-7.internal");
			return true;
		});
		const error = vi.fn();
		const onMessage = vi.fn();
		const client = new AgxClient({
			transport: peer.transport,
			authorize,
			onMessage,
			logger: { error },
		});
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		failing = true;
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first"]);
		expect(peer.resultsTo(X)).toEqual(["first:completed"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalled();
		await client.stop();
	});

	it("sends no result for a task turned down while waiting for input, even if its handler catches the error", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		client.handle("work", async (_task, ctx) => {
			try {
				await ctx.requestInput({ prompt: "Proceed?" });
			} catch {
				// carries on regardless
			}
			return "finished anyway";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		await client.stop();
	});

	it("sends nothing and frees the slot even when onMessage throws for the turned-down task", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const error = vi.fn();
		const client = new AgxClient({
			transport: peer.transport,
			authorize,
			onMessage: () => {
				throw new Error("host failure");
			},
			logger: { error },
		});
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		allowed.delete(X);
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first"]);
		expect(peer.resultsTo(X)).toEqual(["first:completed"]);
		expect(error).toHaveBeenCalled();
		void peer.deliver(request(Z, "later"));
		await until(() => ran.includes("later"), "a later task to get the slot");
		await client.tasksSettled();
		await client.stop();
	});

	it("does not start a task that was canceled while authorize was being asked again", async () => {
		const peer = wire();
		let slow = false;
		const answer = gate();
		const authorize = vi.fn(async () => {
			if (slow) await answer.opened;
			return true;
		});
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		slow = true;
		running.open();
		await until(() => authorize.mock.calls.length === 3, "authorize to be asked again");

		await peer.deliver(message(X, { t: "cancel", taskId: "queued" }));
		answer.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first"]);
		expect(peer.resultsTo(X)).toEqual(["first:completed"]);
		await client.stop();
	});
});

describe("AgxClient does not ask again about a task the requester canceled", () => {
	it("skips the second ask, and onMessage, for a queued task that was canceled before it started", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const onMessage = vi.fn();
		const client = new AgxClient({ transport: peer.transport, authorize, onMessage });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		await peer.deliver(message(X, { t: "cancel", taskId: "queued" }));
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first"]);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(onMessage).not.toHaveBeenCalled();
		expect(peer.resultsTo(X)).toEqual(["first:completed"]);
		await client.stop();
	});
});

describe("AgxClient keeps its task limit when it turns a waiting task down", () => {
	/** Handler body for tasks that should count towards the limit: how many run at
	 * once is the check. */
	function limitProbe() {
		const hold = gate();
		let running = 0;
		let most = 0;
		return {
			hold,
			most: () => most,
			async run(): Promise<void> {
				running += 1;
				most = Math.max(most, running);
				await hold.opened;
				running -= 1;
			},
		};
	}

	it("runs two later tasks one at a time after a queued task was turned down", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const running = gate();
		const probe = limitProbe();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			if (task.taskId.startsWith("later")) await probe.run();
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		allowed.delete(X);
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		void peer.deliver(request(Z, "later-1"));
		await until(() => ran.includes("later-1"), "the first later task to start");
		void peer.deliver(request(Z, "later-2"));
		await until(() => authorize.mock.calls.length === 5, "the second later request to be authorized");
		await pause(30);
		expect(ran).toEqual(["first", "later-1"]);
		probe.hold.open();
		await client.tasksSettled();

		expect(ran).toEqual(["first", "later-1", "later-2"]);
		expect(probe.most()).toBe(1);
		await client.stop();
	});

	it("runs two later tasks one at a time after a task waiting for input was turned down", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const probe = limitProbe();
		client.handle("work", async (task, ctx) => {
			ran.push(task.taskId);
			if (task.taskId === "ask") await ctx.requestInput({ prompt: "Proceed?" });
			if (task.taskId.startsWith("later")) await probe.run();
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		void peer.deliver(request(Z, "later-1"));
		await until(() => ran.includes("later-1"), "the first later task to start");
		void peer.deliver(request(Z, "later-2"));
		await until(() => authorize.mock.calls.length === 4, "the second later request to be authorized");
		await pause(30);
		expect(ran).toEqual(["ask", "later-1"]);
		probe.hold.open();
		await client.tasksSettled();

		expect(ran).toEqual(["ask", "later-1", "later-2"]);
		expect(probe.most()).toBe(1);
		await client.stop();
	});

	it("asks again for a task that waited for input only once it has its slot back", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const continued: unknown[] = [];
		const blocker = gate();
		client.handle("work", async (task, ctx) => {
			ran.push(task.taskId);
			if (task.taskId === "ask") continued.push(await ctx.requestInput({ prompt: "Proceed?" }));
			if (task.taskId === "blocker") await blocker.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		// Another task takes the slot the waiting task gave up.
		void peer.deliver(request(Z, "blocker"));
		await until(() => ran.includes("blocker"), "the blocking task to start");
		// The answer arrives, but the slot is busy; the owner removes the peer meanwhile.
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await pause(30);
		allowed.delete(X);
		blocker.open();
		await client.tasksSettled();

		expect(continued).toEqual([]);
		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		await client.stop();
	});
});

describe("AgxClient tells a handler why its input wait ended", () => {
	/** Registers a handler that asks for input and records the message of the
	 * error it gets, if any. */
	function askingHandler(client: AgxClient, messages: string[]): void {
		client.handle("work", async (_task, ctx) => {
			try {
				await ctx.requestInput({ prompt: "Proceed?" });
			} catch (error) {
				messages.push(error instanceof Error ? error.message : String(error));
			}
			return "finished";
		});
	}

	it("says the task was turned down, not canceled by its requester, when the answer arrives for a peer no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const messages: string[] = [];
		askingHandler(client, messages);
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(messages).toHaveLength(1);
		expect(messages[0]).not.toMatch(/requester/);
		expect(messages[0]).toMatch(/authorize/);
		await client.stop();
	});

	it("says the same when the wait times out for a peer no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize, maxInputTimeoutMs: 30 });
		const messages: string[] = [];
		askingHandler(client, messages);
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		allowed.delete(X);
		await client.tasksSettled();

		expect(messages).toHaveLength(1);
		expect(messages[0]).not.toMatch(/requester/);
		expect(messages[0]).toMatch(/authorize/);
		await client.stop();
	});

	it("still says the requester canceled when it did", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const client = new AgxClient({ transport: peer.transport, authorize });
		const messages: string[] = [];
		askingHandler(client, messages);
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		await peer.deliver(message(X, { t: "cancel", taskId: "ask" }));
		await client.tasksSettled();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatch(/requester/);
		await client.stop();
	});
});

describe("AgxClient keeps running tasks whose peer is still allowed", () => {
	it("starts a queued task whose peer is still allowed", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "first") await running.opened;
			return `done ${task.taskId}`;
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => ran.length === 1, "the first handler to start");
		const queuedDelivery = peer.deliver(request(X, "queued"));
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		expect(ran).toEqual(["first", "queued"]);
		expect(peer.resultsTo(X)).toEqual(["first:completed", "queued:completed"]);
		await client.stop();
	});

	it("continues a task waiting for input when its peer is still allowed", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const client = new AgxClient({ transport: peer.transport, authorize });
		const continued: unknown[] = [];
		client.handle("work", async (_task, ctx) => {
			continued.push(await ctx.requestInput({ prompt: "Proceed?" }));
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(continued).toEqual(["yes"]);
		expect(peer.resultsTo(X)).toEqual(["ask:input-required", "ask:completed"]);
		await client.stop();
	});

	it("asks authorize only once for a task that starts straight away", async () => {
		const peer = wire();
		const answered = new Set<string | undefined>();
		// A host whose answer is not repeatable: it says yes to a request once.
		const authorize = vi.fn(async ({ eventId }: { eventId?: string }) => {
			if (answered.has(eventId)) return false;
			answered.add(eventId);
			return true;
		});
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "only"));
		await client.tasksSettled();

		expect(ran).toEqual(["only"]);
		expect(peer.resultsTo(X)).toEqual(["only:completed"]);
		expect(authorize).toHaveBeenCalledTimes(1);
		await client.stop();
	});

	it("turns the next task down at intake when pump() runs one task at a time", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		const ran: string[] = [];
		const running = gate();
		client.handle("work", async (task) => {
			ran.push(task.taskId);
			if (task.taskId === "q1") await running.opened;
			return "ok";
		});
		peer.inbox.push(request(X, "q1"), request(X, "q2"));

		const pumping = client.pump();
		await until(() => ran.length === 1, "the first handler to start");
		allowed.delete(X);
		running.open();
		await pumping;
		await client.tasksSettled();

		expect(ran).toEqual(["q1"]);
		expect(peer.resultsTo(X)).toEqual(["q1:completed"]);
		expect(authorize).toHaveBeenCalledTimes(2);
	});
});

describe("AgxClient asks authorize again when an input wait ends without an answer", () => {
	it("ends the task silently when the wait times out, the handler catches the error, and the peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X, Z]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const onMessage = vi.fn();
		const client = new AgxClient({
			transport: peer.transport,
			authorize,
			onMessage,
			maxInputTimeoutMs: 30,
		});
		const ran: string[] = [];
		client.handle("work", async (task, ctx) => {
			ran.push(task.taskId);
			if (task.taskId === "ask") {
				try {
					await ctx.requestInput({ prompt: "Proceed?" });
				} catch {
					// carries on with a default
				}
			}
			return "finished anyway";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const original = request(X, "ask", true);
		await peer.deliver(original);
		allowed.delete(X);
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(onMessage).toHaveBeenCalledWith(original);
		expect(authorize).toHaveBeenCalledTimes(2);

		// The slot is free for someone else, and the task id can be used again.
		void peer.deliver(request(Z, "later"));
		await until(() => ran.includes("later"), "a later task to get the slot");
		await client.tasksSettled();
		allowed.add(X);
		await peer.deliver(request(X, "ask", true));
		expect(peer.resultsTo(X).filter((r) => r === "ask:input-required")).toHaveLength(2);
		await client.stop();
	});

	it("sends no failed result when the wait times out, the handler does not catch the error, and the peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize, maxInputTimeoutMs: 30 });
		client.handle("work", async (_task, ctx) => {
			await ctx.requestInput({ prompt: "Proceed?" });
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		allowed.delete(X);
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		await client.stop();
	});

	it("sends no result when the client stops during the wait and the peer is no longer allowed", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const client = new AgxClient({ transport: peer.transport, authorize });
		client.handle("work", async (_task, ctx) => {
			await ctx.requestInput({ prompt: "Proceed?" });
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		allowed.delete(X);
		await client.stop();
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
	});

	it("still reports a timed-out wait to a peer that is still allowed", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const client = new AgxClient({ transport: peer.transport, authorize, maxInputTimeoutMs: 30 });
		client.handle("work", async (_task, ctx) => {
			await ctx.requestInput({ prompt: "Proceed?" });
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required", "ask:failed"]);
		await client.stop();
	});

	it("does not ask authorize again, or tell onMessage, when the requester cancels the wait", async () => {
		const peer = wire();
		const authorize = vi.fn(async () => true);
		const onMessage = vi.fn();
		const client = new AgxClient({ transport: peer.transport, authorize, onMessage });
		client.handle("work", async (_task, ctx) => {
			await ctx.requestInput({ prompt: "Proceed?" });
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		await peer.deliver(message(X, { t: "cancel", taskId: "ask" }));
		await client.tasksSettled();

		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(onMessage).not.toHaveBeenCalled();
		await client.stop();
	});
});

describe("AgxClient tells authorize when it is asking again", () => {
	/** A host that keeps its own record of requests it has handled: it says yes to
	 * a request once, and turns a repeat of the same request down. */
	function recordKeeping(allowed: Set<string>) {
		const handled = new Set<string | undefined>();
		return vi.fn(
			async ({ from, eventId, recheck }: { from: string; eventId?: string; recheck?: boolean }) => {
				if (recheck) return allowed.has(from);
				if (handled.has(eventId)) return false;
				handled.add(eventId);
				return allowed.has(from);
			},
		);
	}

	it("lets a task that waited for input finish when such a host says yes to the second ask", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = recordKeeping(allowed);
		const client = new AgxClient({ transport: peer.transport, authorize });
		const continued: unknown[] = [];
		client.handle("work", async (_task, ctx) => {
			continued.push(await ctx.requestInput({ prompt: "Proceed?" }));
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(continued).toEqual(["yes"]);
		expect(peer.resultsTo(X)).toEqual(["ask:input-required", "ask:completed"]);
		expect(authorize.mock.calls[0][0]).not.toHaveProperty("recheck");
		expect(authorize.mock.calls[1][0]).toMatchObject({ recheck: true });
		await client.stop();
	});

	it("still ends the task when such a host says no to the second ask", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = recordKeeping(allowed);
		const client = new AgxClient({ transport: peer.transport, authorize });
		const continued: unknown[] = [];
		client.handle("work", async (_task, ctx) => {
			continued.push(await ctx.requestInput({ prompt: "Proceed?" }));
			return "finished";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		await peer.deliver(request(X, "ask", true));
		const inputRequestId = peer.inputRequestId(X, "ask");
		allowed.delete(X);
		await peer.deliver(message(X, { t: "input", taskId: "ask", inputRequestId, input: "yes" }));
		await client.tasksSettled();

		expect(continued).toEqual([]);
		expect(peer.resultsTo(X)).toEqual(["ask:input-required"]);
		await client.stop();
	});

	it("asks again with the context of the request, marked as a second ask, and logs a no", async () => {
		const peer = wire();
		const allowed = new Set([X]);
		const authorize = vi.fn(async ({ from }: { from: string }) => allowed.has(from));
		const info = vi.fn();
		const client = new AgxClient({ transport: peer.transport, authorize, logger: { info } });
		const running = gate();
		client.handle("work", async (task) => {
			if (task.taskId === "first") await running.opened;
			return "ok";
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		const firstDelivery = peer.deliver(request(X, "first"));
		await until(() => authorize.mock.calls.length === 1, "the first request to be authorized");
		const queued = request(X, "queued");
		const queuedDelivery = peer.deliver(queued);
		await until(() => authorize.mock.calls.length === 2, "the queued request to be authorized");
		allowed.delete(X);
		running.open();
		await Promise.all([firstDelivery, queuedDelivery]);
		await client.tasksSettled();

		const context = { from: X, capability: "work", eventId: queued.eventId, transportId: queued.transportId };
		expect(authorize).toHaveBeenCalledTimes(3);
		expect(authorize.mock.calls[1][0]).toStrictEqual(context);
		expect(authorize.mock.calls[2][0]).toStrictEqual({ ...context, recheck: true });
		expect(info).toHaveBeenCalledWith("AGX: task rejected by authorize", {
			from: X,
			capability: "work",
			taskId: "queued",
		});
		await client.stop();
	});
});
