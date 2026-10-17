import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import type { IDataObject, ITriggerResponse } from "n8n-workflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgxTrigger } from "../nodes/AgxTrigger/AgxTrigger.node";
import { __resetLiveClaimsForTests } from "../nodes/shared/trigger-state";
import {
	finishedRun,
	newAgent,
	peerClient,
	pumpUntil,
	relayUrl,
	type RunningRelay,
	startTestRelay,
	triggerContext,
	waitFor,
} from "./helpers";

let relay: RunningRelay;
beforeAll(async () => {
	relay = await startTestRelay();
});
afterAll(async () => {
	await relay.close();
});

const open: ITriggerResponse[] = [];
beforeEach(() => __resetLiveClaimsForTests());
afterEach(async () => {
	vi.restoreAllMocks();
	for (const response of open.splice(0)) {
		await response.closeFunction?.();
	}
});

async function startTrigger(ctx: ReturnType<typeof triggerContext>["ctx"]) {
	const response = await new AgxTrigger().trigger.call(ctx);
	open.push(response);
	if (response.manualTriggerFunction) {
		await response.manualTriggerFunction();
	}
	return response;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AGX Trigger: task requests", () => {
	it("runs the workflow for an allowed agent's task and sends its output back", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted, staticData } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: toNpub(requester.publicKey),
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);

		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", { amount: 4200 }, {
			timeoutMs: 20_000,
		});
		const run = pumpUntil(result, [client]);

		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({
			event: "task",
			capability: "invoice.review",
			payload: { amount: 4200 },
			from: toNpub(requester.publicKey),
			fromPubkey: requester.publicKey,
		});
		expect(typeof event.json.sentAt).toBe("string");
		// Claimed before the emit, so the save that goes with it carries the claim:
		// the request's event id and its gift wrap's, so a restart skips the wrap
		// without decrypting it.
		const saved = staticData["agx:trigger-node"] as { claimed: IDataObject };
		expect(Object.keys(saved.claimed)).toHaveLength(2);

		event.done?.resolve(finishedRun([{ approved: true, reviewer: "n8n" }]));
		await expect(run).resolves.toEqual({ approved: true, reviewer: "n8n" });
	});

	it("gives a requester that is not allowed no reply, and never runs the workflow", async () => {
		const n8nAgent = newAgent(relay);
		const allowed = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: allowed.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, stranger);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 4000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/timed out/);
		expect(emitted).toHaveLength(0);
	});

	it("reports a failed execution as `handler failed`, or verbatim when forwarding errors", async () => {
		for (const forwardErrors of [false, true]) {
			const n8nAgent = newAgent(relay);
			const requester = newAgent(relay);
			const { ctx, emitted } = triggerContext({
				credentials: n8nAgent.credentials,
				params: {
					events: ["task"],
					capabilities: "invoice.review",
					allowedPeers: requester.publicKey,
					options: { pollInterval: 1, forwardErrors },
				},
			});
			await startTrigger(ctx);
			const client = await peerClient(relay, requester);
			const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
			const run = pumpUntil(result, [client]);
			const event = await waitFor(() => emitted[0]);
			event.done?.resolve(finishedRun([], "getaddrinfo ENOTFOUND db.internal"));
			await expect(run).rejects.toThrow(
				forwardErrors ? "getaddrinfo ENOTFOUND db.internal" : /^handler failed$/,
			);
		}
	});

	it("fails the task when the workflow does not finish within the result timeout", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: requester.publicKey,
				options: { pollInterval: 1, resultTimeout: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/did not finish in time/);
		expect(emitted).toHaveLength(1);
	});

	it("does not run a task again after n8n restarts", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const staticData: IDataObject = {};
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const first = triggerContext({ credentials: n8nAgent.credentials, params, staticData });
		const firstResponse = await startTrigger(first.ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		const run = pumpUntil(result, [client]);
		const event = await waitFor(() => first.emitted[0]);
		event.done?.resolve(finishedRun([{ ok: 1 }]));
		await expect(run).resolves.toEqual({ ok: 1 });
		await firstResponse.closeFunction?.();

		// A new process: nothing in memory, only the static data the emit saved.
		__resetLiveClaimsForTests();
		const second = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			staticData: JSON.parse(JSON.stringify(staticData)),
			workflowId: first.workflowId,
		});
		await startTrigger(second.ctx);
		await sleep(3000);
		expect(second.emitted).toHaveLength(0);
	});

	it("leaves a task it was closed in the middle of to the trigger that replaces it", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const staticData: IDataObject = {};
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const old = triggerContext({ credentials: n8nAgent.credentials, params, staticData });
		const oldResponse = await startTrigger(old.ctx);
		// n8n closes the trigger (a save) while the delivery receipt is on its
		// way, after the request was authorized and before its handler runs.
		const publishReceipt = NostrTransport.prototype.publishReceipt;
		vi.spyOn(NostrTransport.prototype, "publishReceipt").mockImplementationOnce(
			async function (this: NostrTransport, ...args) {
				await oldResponse.closeFunction?.();
				return publishReceipt.apply(this, args);
			},
		);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		const run = pumpUntil(result, [client]);
		await waitFor(() => vi.mocked(NostrTransport.prototype.publishReceipt).mock.calls.length > 0);
		await sleep(1500);
		expect(old.emitted).toHaveLength(0);

		const replacement = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			staticData,
			workflowId: old.workflowId,
		});
		await startTrigger(replacement.ctx);
		const event = await waitFor(() => replacement.emitted[0]);
		event.done?.resolve(finishedRun([{ ranOnce: true }]));
		await expect(run).resolves.toEqual({ ranOnce: true });
		await sleep(1500);
		expect(old.emitted).toHaveLength(0);
		expect(replacement.emitted).toHaveLength(1);
	});

	it("runs a task once while the workflow is active and a test run listens too", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const staticData: IDataObject = {};
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const workflowId = "wf-active-and-test";
		const activeRun = triggerContext({ credentials: n8nAgent.credentials, params, staticData, workflowId });
		const testRun = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			staticData,
			workflowId,
			mode: "manual",
		});
		await startTrigger(activeRun.ctx);
		await startTrigger(testRun.ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		const run = pumpUntil(result, [client]);
		const event = await waitFor(() => activeRun.emitted[0] ?? testRun.emitted[0]);
		event.done?.resolve(finishedRun([{ once: true }]));
		await expect(run).resolves.toEqual({ once: true });
		await sleep(2000);
		expect(activeRun.emitted.length + testRun.emitted.length).toBe(1);
	});

	it("ignores a task request too old to run, with no reply", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const now = Math.floor(Date.now() / 1000);
		// A trigger that has been on for an hour, so the request is not simply
		// from before it started.
		const staticData: IDataObject = {
			"agx:trigger-node": {
				v: 1,
				pubkey: n8nAgent.publicKey,
				since: now - 3600,
				cursor: now,
				claimed: {},
			},
		};
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: requester.publicKey,
				options: { pollInterval: 1, maxTaskAge: 10 },
			},
			staticData,
		});
		await startTrigger(ctx);
		const receipts = vi.fn();
		const client = await peerClient(relay, requester, { onReceipt: receipts });
		// Signed eleven minutes ago, by the requester's clock: `request` signs
		// before its first await.
		const realNow = Date.now;
		vi.spyOn(Date, "now").mockImplementation(() => realNow() - 11 * 60 * 1000);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 5000 });
		vi.mocked(Date.now).mockRestore();
		await expect(pumpUntil(result, [client])).rejects.toThrow(/timed out/);
		expect(emitted).toHaveLength(0);
		expect(receipts).not.toHaveBeenCalled();
	});

	it("handles one task per manual test run, and leaves the next for the next run", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const client = await peerClient(relay, requester);
		const a = client.request(n8nAgent.publicKey, "invoice.review", { n: 1 }, { timeoutMs: 30_000 });
		const b = client.request(n8nAgent.publicKey, "invoice.review", { n: 2 }, { timeoutMs: 30_000 });
		const both = pumpUntil(Promise.allSettled([a, b]), [client]);
		// Both requests in the inbox before the first run polls it, so they
		// arrive in one batch.
		await waitFor(
			() =>
				relay
					.events()
					.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === n8nAgent.publicKey))
					.length >= 2,
		);

		const workflowId = "wf-manual-tasks";
		const firstRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual", workflowId });
		const firstResponse = await startTrigger(firstRun.ctx);
		const first = await waitFor(() => firstRun.emitted[0]);
		await sleep(2500);
		expect(firstRun.emitted).toHaveLength(1);
		// n8n closes a manual trigger as soon as it emits, and only then finishes
		// the execution: the result must still go out after the close.
		await firstResponse.closeFunction?.();
		first.done?.resolve(finishedRun([{ run: 1 }]));

		const secondRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual", workflowId });
		await startTrigger(secondRun.ctx);
		const second = await waitFor(() => secondRun.emitted[0]);
		expect((second.json.payload as IDataObject).n).not.toBe((first.json.payload as IDataObject).n);
		second.done?.resolve(finishedRun([{ run: 2 }]));

		const settled = await both;
		expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(
			settled.map((s) => (s.status === "fulfilled" ? s.value : null)).sort((x, y) =>
				JSON.stringify(x).localeCompare(JSON.stringify(y)),
			),
		).toEqual([{ run: 1 }, { run: 2 }]);
	});
});

describe("AGX Trigger: messages", () => {
	async function send(
		from: { secretKey: Uint8Array },
		to: string,
		text: string,
		autoDepth?: number,
		sentSecondsAgo = 0,
	) {
		const transport = await NostrTransport.create({
			signer: localSigner(from.secretKey),
			relays: [relayUrl(relay)],
		});
		// The sender's clock, read when the message is signed (before the first
		// await of `publishMessage`).
		const realNow = Date.now;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() - sentSecondsAgo * 1000);
		const sent = transport.publishMessage(to, {
			text,
			contextId: "thread-7",
			contentType: DEFAULT_CONTENT_TYPE,
			autoDepth,
		});
		clock.mockRestore();
		expect((await sent).ok).toBe(true);
	}

	it("starts the workflow for an allowed agent's message, with the depth a reply declares", async () => {
		const n8nAgent = newAgent(relay);
		const sender = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: sender.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		await send(stranger, n8nAgent.publicKey, "let me in");
		await send(sender, n8nAgent.publicKey, "Invoice 1234 is ready.", 2);
		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({
			event: "message",
			from: toNpub(sender.publicKey),
			allowed: true,
			text: "Invoice 1234 is ready.",
			contextId: "thread-7",
			autoDepth: 2,
			replyAutoDepth: 3,
		});
		await sleep(1500);
		expect(emitted).toHaveLength(1);
	});

	it("leaves task requests to the workflow that serves them, with no reply", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: requester.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 3000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/timed out/);
		await send(requester, n8nAgent.publicKey, "a plain one");
		const event = await waitFor(() => emitted[0]);
		expect(event.json.text).toBe("a plain one");
		expect(emitted).toHaveLength(1);
	});

	it("emits one message per manual test run, though a batch holds several", async () => {
		const n8nAgent = newAgent(relay);
		const sender = newAgent(relay);
		const params = {
			events: ["message"],
			allowedPeers: sender.publicKey,
			options: { pollInterval: 1 },
		};
		await send(sender, n8nAgent.publicKey, "first");
		await send(sender, n8nAgent.publicKey, "second");

		// Unlike a task's, a message's emit does not wait for the execution, so
		// both would go out in the same pump — and n8n would run the test with
		// the first and drop the second.
		const workflowId = "wf-manual-messages";
		const firstRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual", workflowId });
		const firstResponse = await startTrigger(firstRun.ctx);
		await waitFor(() => firstRun.emitted[0]);
		await sleep(1500);
		expect(firstRun.emitted).toHaveLength(1);
		await firstResponse.closeFunction?.();

		const secondRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual", workflowId });
		await startTrigger(secondRun.ctx);
		await waitFor(() => secondRun.emitted[0]);
		expect(
			[firstRun.emitted[0].json.text, secondRun.emitted[0].json.text].sort(),
		).toEqual(["first", "second"]);
	});

	it("starts from the inbox as it is when the workflow is turned on, but catches up after a restart", async () => {
		const n8nAgent = newAgent(relay);
		const sender = newAgent(relay);
		const params = {
			events: ["message"],
			allowedPeers: sender.publicKey,
			options: { pollInterval: 1 },
		};
		const staticData: IDataObject = {};
		const first = triggerContext({ credentials: n8nAgent.credentials, params, staticData });
		const firstResponse = await startTrigger(first.ctx);
		await firstResponse.closeFunction?.();
		// Rewind the saved start, as if the trigger had been off for an hour.
		const saved = staticData["agx:trigger-node"] as { since: number; cursor: number };
		saved.since -= 3600;
		saved.cursor -= 3600;
		await send(sender, n8nAgent.publicKey, "while it was off", undefined, 10 * 60);
		// A deliberate activation starts fresh...
		const reactivated = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			activationMode: "activate",
			staticData: JSON.parse(JSON.stringify(staticData)),
		});
		const reactivatedResponse = await startTrigger(reactivated.ctx);
		await sleep(2500);
		expect(reactivated.emitted).toHaveLength(0);
		await reactivatedResponse.closeFunction?.();
		// ...a restart resumes where it left off.
		const restarted = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			activationMode: "init",
			staticData: JSON.parse(JSON.stringify(staticData)),
		});
		await startTrigger(restarted.ctx);
		const event = await waitFor(() => restarted.emitted[0]);
		expect(event.json.text).toBe("while it was off");
	});

	it("starts the workflow for delivery receipts from allowed agents only", async () => {
		const n8nAgent = newAgent(relay);
		const allowedAgent = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["receipt"],
				allowedPeers: allowedAgent.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		for (const from of [stranger, allowedAgent]) {
			const transport = await NostrTransport.create({
				signer: localSigner(from.secretKey),
				relays: [relayUrl(relay)],
			});
			await transport.publishReceipt(n8nAgent.publicKey, {
				refEventId: "a".repeat(64),
				contextId: "thread-9",
				status: "delivered",
			});
		}
		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({
			event: "receipt",
			from: toNpub(allowedAgent.publicKey),
			allowed: true,
			status: "delivered",
		});
		await sleep(1500);
		expect(emitted).toHaveLength(1);
	});

	it("includes unlisted senders, marked as such, only when asked to", async () => {
		const n8nAgent = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: "",
				options: { pollInterval: 1, includeUnlisted: true },
			},
		});
		await startTrigger(ctx);
		await send(stranger, n8nAgent.publicKey, "hello?");
		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({ allowed: false, text: "hello?", autoDepth: 0, replyAutoDepth: 1 });
	});
});

describe("AGX Trigger: configuration", () => {
	it("refuses to start when nobody could ever reach it", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["task"], capabilities: "invoice.review", allowedPeers: "" },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/No agent is allowed/);
	});

	it("refuses a wildcard capability, which it could advertise but never serve", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["task"], capabilities: "invoice.*", acceptAll: true },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/invoice\.\* cannot be served/);
	});

	it("refuses options an expression could set out of range", async () => {
		const n8nAgent = newAgent(relay);
		for (const options of [{ pollInterval: 0 }, { resultTimeout: Number.NaN }, { maxTaskAge: -1 }]) {
			const { ctx } = triggerContext({
				credentials: n8nAgent.credentials,
				params: { events: ["task"], capabilities: "invoice.review", acceptAll: true, options },
			});
			await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/must be a number/);
		}
	});

	it("refuses to start for receipts nobody is allowed to send", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["receipt"], allowedPeers: "" },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/No agent is allowed/);
	});

	it("names a malformed allowlist entry", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["task"], capabilities: "invoice.review", allowedPeers: "alice" },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/alice/);
	});
});
