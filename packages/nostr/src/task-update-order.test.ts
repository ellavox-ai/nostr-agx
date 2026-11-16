import {
	AgxClient,
	buildExchangePayload,
	encodeTaskEnvelope,
	parseTaskEnvelope,
	TASK_CONTENT_TYPE,
	type TaskEnvelope,
} from "@nostr-agx/core";
import {
	type Event,
	type Filter,
	finalizeEvent,
	generateSecretKey,
	nip44,
} from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Gift wraps are backdated by a random amount up to two days, and `pollInbox`
// sorts a poll's wraps by that backdated time. So when several messages of one
// task land in the same poll, the order they are handled in has nothing to do
// with the order the responder sent them. These tests run the whole receive
// path (the real pollInbox, NostrTransport.poll and AgxClient.pump, over a fake
// relay) with wraps stamped in the order that scrambles a task.

const { connectRelay } = vi.hoisted(() => ({ connectRelay: vi.fn() }));
vi.mock("nostr-tools/relay", () => ({ Relay: { connect: connectRelay } }));

import { createRumor, WRAP_TTL_SEC } from "./giftwrap";
import { openMessageEvent } from "./events";
import { GIFT_WRAP_KIND, MESSAGE_KIND, SEAL_KIND } from "./kinds";
import { NostrTransport } from "./nostr-transport";
import { localSigner } from "./signer";

const aliceSigner = localSigner(generateSecretKey());
const bobSigner = localSigner(generateSecretKey());

/** Wraps the fake relay holds, and every event Alice published to it. */
let stored: Event[] = [];
let published: Event[] = [];

beforeEach(() => {
	stored = [];
	published = [];
	connectRelay.mockReset();
	connectRelay.mockImplementation(async () => ({
		onauth: undefined,
		close: vi.fn(),
		publish: async (event: Event) => {
			published.push(event);
			return "";
		},
		subscribe(
			filters: Filter[],
			handlers: {
				onevent: (event: Event) => void | Promise<void>;
				oneose?: () => void;
			},
		) {
			const filter = filters[0];
			// What a relay does with the REQ: kinds, since, until, newest first, limit.
			const events = stored
				.filter(
					(event) =>
						(filter.kinds ?? [event.kind]).includes(event.kind) &&
						(filter.since === undefined || event.created_at >= filter.since) &&
						(filter.until === undefined || event.created_at <= filter.until),
				)
				.sort((a, b) => b.created_at - a.created_at)
				.slice(0, filter.limit ?? 500);
			queueMicrotask(() => {
				for (const event of events) {
					void handlers.onevent(event);
				}
				handlers.oneose?.();
			});
			return { close: vi.fn() };
		},
	}));
});

/** A gift wrap from Bob to Alice whose rumor says it was sent at `sentAt` and
 * whose wrap is stamped `wrapAt` (the random backdate, chosen by the test). */
async function wrapFromBob(
	envelope: TaskEnvelope,
	taskId: string,
	sentAt: number,
	wrapAt: number,
): Promise<Event> {
	const alice = await aliceSigner.getPublicKey();
	const payload = buildExchangePayload({
		text: encodeTaskEnvelope(envelope),
		subject: null,
		contextId: taskId,
		messageId: `m-${Math.random().toString(36).slice(2)}`,
		role: "user",
		contentType: TASK_CONTENT_TYPE,
	});
	const rumor = createRumor({
		pubkey: await bobSigner.getPublicKey(),
		kind: MESSAGE_KIND,
		tags: [
			["p", alice],
			["content-type", payload.contentType],
		],
		content: JSON.stringify(payload),
		nowSec: sentAt,
	});
	const seal = await bobSigner.signEvent({
		kind: SEAL_KIND,
		created_at: wrapAt,
		tags: [],
		content: await bobSigner.nip44Encrypt(alice, JSON.stringify(rumor)),
	});
	const ephemeral = generateSecretKey();
	return finalizeEvent(
		{
			kind: GIFT_WRAP_KIND,
			created_at: wrapAt,
			tags: [
				["p", alice],
				["expiration", String(wrapAt + WRAP_TTL_SEC)],
			],
			content: nip44.encrypt(
				JSON.stringify(seal),
				nip44.getConversationKey(ephemeral, alice),
			),
		},
		ephemeral,
	);
}

/** Alice, over the real transport, with a request out to Bob. */
async function aliceWithRequest() {
	const transport = await NostrTransport.create({
		signer: aliceSigner,
		relays: ["ws://127.0.0.1:1"],
	});
	const onMessage = vi.fn();
	const client = new AgxClient({ transport, onMessage });
	const bob = await bobSigner.getPublicKey();
	return { client, onMessage, bob };
}

/** The task id Alice put on the wire (read by opening her request as Bob). */
async function sentTaskId(): Promise<string> {
	await vi.waitFor(() => expect(published).toHaveLength(1));
	const opened = await openMessageEvent({
		signer: bobSigner,
		event: published[0],
	});
	const envelope = parseTaskEnvelope(opened?.text ?? "");
	if (envelope?.t !== "req") {
		throw new Error("Alice's first event was not a task request");
	}
	return envelope.taskId;
}

const NOW = Math.floor(Date.now() / 1000) - 60;

describe("a task's messages handled in one poll, over the real receive path", () => {
	// Every case stamps the wraps so the relay's order (oldest wrap first) is
	// [seq 2, seq 1, completed, seq 3]: the order that scrambles the task.
	it.each([
		["all sent within one second", [NOW, NOW, NOW, NOW]],
		["sent a second apart", [NOW, NOW + 1, NOW + 2, NOW + 3]],
	])("delivers every working update in seq order and none to onMessage (%s)", async (_label, sent) => {
		const { client, onMessage, bob } = await aliceWithRequest();
		const onTaskStatus = vi.fn();
		const result = client.request(bob, "long.task", {}, {
			timeoutMs: 30_000,
			onTaskStatus,
		});
		const taskId = await sentTaskId();
		const working = (seq: number): TaskEnvelope => ({
			t: "res",
			taskId,
			status: "working",
			seq,
		});
		const done: TaskEnvelope = { t: "res", taskId, status: "completed", output: "done" };
		const [s1, s2, s3, sDone] = sent;
		stored = await Promise.all([
			wrapFromBob(working(2), taskId, s2, NOW - 4000),
			wrapFromBob(working(1), taskId, s1, NOW - 3000),
			wrapFromBob(done, taskId, sDone, NOW - 2000),
			wrapFromBob(working(3), taskId, s3, NOW - 1000),
		]);

		await client.pump();

		expect(await result).toBe("done");
		// Soft, so a failing run names every effect, not only the first.
		expect.soft(onTaskStatus.mock.calls.map(([update]) => update.seq)).toEqual([1, 2, 3]);
		expect.soft(onMessage.mock.calls.map(([msg]) => msg.text)).toEqual([]);
	}, 30_000);

	it("keeps a working update that reaches a later poll than the result out of onMessage", async () => {
		const { client, onMessage, bob } = await aliceWithRequest();
		const onTaskStatus = vi.fn();
		const result = client.request(bob, "long.task", {}, {
			timeoutMs: 30_000,
			onTaskStatus,
		});
		const taskId = await sentTaskId();
		// The relay has the result and not yet the update sent just before it.
		stored = [
			await wrapFromBob(
				{ t: "res", taskId, status: "completed", output: "done" },
				taskId,
				NOW,
				NOW - 2000,
			),
		];
		await client.pump();
		expect(await result).toBe("done");

		stored.push(
			await wrapFromBob({ t: "res", taskId, status: "working", seq: 1 }, taskId, NOW, NOW - 1000),
		);
		await client.pump();

		expect(onTaskStatus).not.toHaveBeenCalled();
		expect(onMessage.mock.calls.map(([msg]) => msg.text)).toEqual([]);
	}, 30_000);

	it("shows a streamed working update before input-required, not after it", async () => {
		const { client, bob } = await aliceWithRequest();
		const stream = await client.streamRequest(bob, "long.task", {}, { timeoutMs: 30_000 });
		const taskId = await sentTaskId();
		const statuses: string[] = [];
		stream.on("statusUpdate", (status) => statuses.push(status));
		stored = await Promise.all([
			wrapFromBob(
				{
					t: "res",
					taskId,
					status: "input-required",
					inputRequestId: "q1",
					requirement: { prompt: "which one?" },
				},
				taskId,
				NOW,
				NOW - 3000,
			),
			wrapFromBob({ t: "res", taskId, status: "working", seq: 1 }, taskId, NOW, NOW - 2000),
		]);

		await client.pump();

		expect(statuses).toEqual(["working", "input-required"]);
		await client.stop();
	}, 30_000);
});
