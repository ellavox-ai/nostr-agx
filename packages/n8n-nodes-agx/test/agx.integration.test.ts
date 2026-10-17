import { AgxPublicError } from "@nostr-agx/core";
import { localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agx } from "../nodes/Agx/Agx.node";
import { testAgxCredential } from "../nodes/shared/credential-test";
import {
	executeContext,
	newAgent,
	peerClient,
	quietLogger,
	relayUrl,
	type RunningRelay,
	startTestRelay,
	waitFor,
} from "./helpers";

let relay: RunningRelay;
beforeAll(async () => {
	relay = await startTestRelay();
});
afterAll(async () => {
	await relay.close();
});

/** Run the AGX node's `execute` while `peer` serves on its own interval. */
async function execute(
	node: Agx,
	ctx: ReturnType<typeof executeContext>,
	running: { stop(): Promise<void> }[] = [],
) {
	try {
		return await node.execute.call(ctx);
	} finally {
		for (const r of running) {
			await r.stop();
		}
	}
}

describe("AGX node: Task → Request", () => {
	it("sends a task and returns the peer's result", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		const peer = await peerClient(relay, reviewer, {
			authorize: ({ from }) => from === n8nAgent.publicKey,
		});
		peer.handle<{ amount: number }>("invoice.review", (task) => ({
			approved: task.payload.amount < 10_000,
		}));
		await peer.start({ pollIntervalMs: 250, advertise: false });

		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			items: 2,
			params: (i) => ({
				resource: "task",
				operation: "request",
				peer: toNpub(reviewer.publicKey),
				capability: "invoice.review",
				payload: JSON.stringify({ amount: i === 0 ? 4200 : 42_000 }),
				options: { timeout: 20 },
			}),
		});
		const [out] = await execute(new Agx(), ctx, [peer]);
		expect(out.map((item) => item.json)).toEqual([
			{
				peer: toNpub(reviewer.publicKey),
				capability: "invoice.review",
				status: "completed",
				output: { approved: true },
			},
			{
				peer: toNpub(reviewer.publicKey),
				capability: "invoice.review",
				status: "completed",
				output: { approved: false },
			},
		]);
		expect(out.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it("reports the peer's public failure message", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		const peer = await peerClient(relay, reviewer, { authorize: "accept-all" });
		peer.handle("invoice.review", () => {
			throw new AgxPublicError("invoice not found");
		});
		await peer.start({ pollIntervalMs: 250, advertise: false });
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "task",
				operation: "request",
				peer: reviewer.publicKey,
				capability: "invoice.review",
				payload: "{}",
				options: { timeout: 20 },
			}),
		});
		await expect(execute(new Agx(), ctx, [peer])).rejects.toThrow(
			/reported that the task failed: invoice not found/,
		);
	});

	it("explains a timeout as the likely missing allowlist entry", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		// Default-deny: no authorize hook, so the request is dropped with no reply.
		const peer = await peerClient(relay, reviewer);
		peer.handle("invoice.review", () => ({ approved: true }));
		await peer.start({ pollIntervalMs: 250, advertise: false });
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			continueOnFail: true,
			params: () => ({
				resource: "task",
				operation: "request",
				peer: reviewer.publicKey,
				capability: "invoice.review",
				payload: "{}",
				options: { timeout: 2 },
			}),
		});
		const [out] = await execute(new Agx(), ctx, [peer]);
		expect(out[0].json.error).toMatch(/No result from npub1.* within 2 seconds/);
	});

	it("fails fast when Check Agent Card First finds the capability missing", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		const peer = await peerClient(relay, reviewer, {
			authorize: "accept-all",
			identity: { org: "Acme Finance" },
		});
		peer.handle("invoice.review", () => ({ approved: true }));
		await peer.start({ pollIntervalMs: 0 }); // advertises its card
		await peer.stop();
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "task",
				operation: "request",
				peer: reviewer.publicKey,
				capability: "payroll.run",
				payload: "{}",
				options: { checkCard: true, timeout: 20 },
			}),
		});
		await expect(execute(new Agx(), ctx)).rejects.toThrow(
			/Acme Finance does not advertise "payroll.run"/,
		);
	});
});

describe("AGX node: Task → Request, guarded", () => {
	it("refuses a timeout an expression set to 0, which would otherwise never time out", async () => {
		const n8nAgent = newAgent(relay);
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "task",
				operation: "request",
				peer: newAgent(relay).publicKey,
				capability: "invoice.review",
				payload: "{}",
				options: { timeout: 0 },
			}),
		});
		await expect(new Agx().execute.call(ctx)).rejects.toThrow(/Timeout \(Seconds\) must be a number/);
	});

	it("says no relay answered, not that there is no card, when the card cannot be read", async () => {
		const n8nAgent = newAgent(relay);
		const ctx = executeContext({
			credentials: { ...n8nAgent.credentials, relays: "ws://127.0.0.1:1" },
			params: () => ({
				resource: "task",
				operation: "request",
				peer: newAgent(relay).publicKey,
				capability: "invoice.review",
				payload: "{}",
				options: { checkCard: true },
			}),
		});
		await expect(new Agx().execute.call(ctx)).rejects.toThrow(/No relay answered/);
	});

	it("keeps concurrent executions' results apart on one identity", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		const peer = await peerClient(relay, reviewer, { authorize: "accept-all" });
		peer.handle<{ n: number }>("echo.n", (task) => ({ n: task.payload.n }));
		await peer.start({ pollIntervalMs: 250, advertise: false });
		const run = (n: number) =>
			new Agx().execute.call(
				executeContext({
					credentials: n8nAgent.credentials,
					params: () => ({
						resource: "task",
						operation: "request",
						peer: reviewer.publicKey,
						capability: "echo.n",
						payload: JSON.stringify({ n }),
						options: { timeout: 20 },
					}),
				}),
			);
		try {
			const [a, b] = await Promise.all([run(1), run(2)]);
			expect(a[0][0].json.output).toEqual({ n: 1 });
			expect(b[0][0].json.output).toEqual({ n: 2 });
		} finally {
			await peer.stop();
		}
	});
});

describe("AGX node: Message → Send", () => {
	it("delivers an encrypted message the peer can read, with its autoDepth", async () => {
		const n8nAgent = newAgent(relay);
		const reader = newAgent(relay);
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "message",
				operation: "send",
				peer: toNpub(reader.publicKey),
				text: "Invoice 1234 is approved.",
				options: { subject: "Invoice 1234", contextId: "thread-1", autoDepth: 2 },
			}),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out[0].json).toMatchObject({
			to: toNpub(reader.publicKey),
			contextId: "thread-1",
			autoDepth: 2,
			relaysAccepted: 1,
		});

		const transport = await NostrTransport.create({
			signer: localSigner(reader.secretKey),
			relays: [relayUrl(relay)],
		});
		const msg = await waitFor(async () => {
			const res = await transport.poll({ since: 0 });
			return res.messages.find((m) => m.eventId === out[0].json.eventId);
		});
		expect(msg).toMatchObject({
			from: n8nAgent.publicKey,
			text: "Invoice 1234 is approved.",
			subject: "Invoice 1234",
			contextId: "thread-1",
			autoDepth: 2,
		});
	});

	it("counts each new conversation on its own when no Conversation ID is given", async () => {
		const n8nAgent = newAgent(relay);
		const reader = newAgent(relay);
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			items: 3,
			params: () => ({
				resource: "message",
				operation: "send",
				peer: reader.publicKey,
				text: "automated",
				options: { autoDepth: 1, maxPerConversation: 1 },
			}),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out).toHaveLength(3);
		expect(new Set(out.map((item) => item.json.contextId)).size).toBe(3);
	});

	it("does not count an automated reply that was not delivered", async () => {
		const n8nAgent = newAgent(relay);
		const reader = newAgent(relay);
		const params = () => ({
			resource: "message",
			operation: "send",
			peer: reader.publicKey,
			text: "automated",
			options: { autoDepth: 1, contextId: "thread-3", maxPerConversation: 1 },
		});
		const unreachable = executeContext({
			credentials: { ...n8nAgent.credentials, relays: "ws://127.0.0.1:1" },
			params,
		});
		await expect(new Agx().execute.call(unreachable)).rejects.toThrow(/No relay accepted/);
		const [out] = await new Agx().execute.call(
			executeContext({ credentials: n8nAgent.credentials, params }),
		);
		expect(out[0].json.contextId).toBe("thread-3");
	});

	it("refuses an automated-reply depth an expression got wrong, rather than sending it as depth 0", async () => {
		const n8nAgent = newAgent(relay);
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "message",
				operation: "send",
				peer: newAgent(relay).publicKey,
				text: "automated",
				options: { autoDepth: Number.NaN },
			}),
		});
		await expect(new Agx().execute.call(ctx)).rejects.toThrow(/Automated Reply Depth must be/);
	});

	it("refuses an automated reply over the depth ceiling, before publishing", async () => {
		const n8nAgent = newAgent(relay);
		const reader = newAgent(relay);
		const before = relay.events().length;
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "message",
				operation: "send",
				peer: reader.publicKey,
				text: "and again",
				options: { autoDepth: 9 },
			}),
		});
		await expect(new Agx().execute.call(ctx)).rejects.toThrow(/loop protection/);
		expect(relay.events().length).toBe(before);
	});
});

describe("AGX node: Agent", () => {
	it("reads an advertised card and checks a capability against it", async () => {
		const n8nAgent = newAgent(relay);
		const reviewer = newAgent(relay);
		const peer = await peerClient(relay, reviewer, {
			authorize: "accept-all",
			identity: { org: "Acme Finance" },
		});
		peer.handle("invoice.*", () => ({}));
		await peer.start({ pollIntervalMs: 0 });
		await peer.stop();
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({
				resource: "agent",
				operation: "getCard",
				peer: toNpub(reviewer.publicKey),
				options: { capability: "invoice.review" },
			}),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out[0].json).toMatchObject({
			npub: toNpub(reviewer.publicKey),
			found: true,
			org: "Acme Finance",
			capabilities: ["invoice.*"],
			nip05: null,
			nip05Verified: null,
			capability: "invoice.review",
			supportsCapability: true,
		});
	});

	it("reports a NIP-05 claim it could not check as unconfirmed, not as false", async () => {
		const n8nAgent = newAgent(relay);
		const claimant = newAgent(relay);
		const peer = await peerClient(relay, claimant, {
			authorize: "accept-all",
			// The SSRF guard will not fetch from this host, so the claim cannot be
			// checked either way.
			identity: { org: "Acme", nip05: "agent@localhost" },
		});
		peer.handle("x.y", () => ({}));
		await peer.start({ pollIntervalMs: 0 });
		await peer.stop();
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({ resource: "agent", operation: "getCard", peer: claimant.publicKey }),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out[0].json).toMatchObject({ nip05: "agent@localhost", nip05Verified: null });
	});

	it("says when there is no card, rather than failing", async () => {
		const n8nAgent = newAgent(relay);
		const stranger = newAgent(relay);
		const ctx = executeContext({
			credentials: n8nAgent.credentials,
			params: () => ({ resource: "agent", operation: "getCard", peer: stranger.publicKey }),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out[0].json).toMatchObject({ found: false, capabilities: [] });
	});

	it("returns its own identity without contacting a relay", async () => {
		const n8nAgent = newAgent(relay);
		const ctx = executeContext({
			credentials: { ...n8nAgent.credentials, org: "Acme" },
			params: () => ({ resource: "agent", operation: "getIdentity" }),
		});
		const [out] = await new Agx().execute.call(ctx);
		expect(out[0].json).toEqual({
			npub: toNpub(n8nAgent.publicKey),
			pubkey: n8nAgent.publicKey,
			relays: [relayUrl(relay)],
			org: "Acme",
			nip05: null,
		});
	});
});

describe("credential test", () => {
	const call = (data: Record<string, string>) =>
		testAgxCredential.call(
			{ logger: quietLogger } as never,
			{ id: "1", name: "AGX", type: "agxApi", data },
		);

	it("passes when a relay answers", async () => {
		const agent = newAgent(relay);
		const res = await call(agent.credentials as Record<string, string>);
		expect(res.status).toBe("OK");
		expect(res.message).toContain(toNpub(agent.publicKey));
	});

	it("names a bad key or an unreachable relay", async () => {
		const agent = newAgent(relay);
		expect(await call({ ...(agent.credentials as Record<string, string>), secretKey: "x" })).toMatchObject({
			status: "Error",
		});
		const unreachable = await call({
			...(agent.credentials as Record<string, string>),
			relays: "ws://127.0.0.1:1",
		});
		expect(unreachable).toMatchObject({ status: "Error" });
		expect(unreachable.message).toMatch(/No relay answered/);
	});
});
