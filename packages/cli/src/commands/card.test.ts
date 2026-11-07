import { AgxClient, InMemorySeenStore } from "@nostr-agx/core";
import {
	type AgentCard,
	type AgentSkill,
	buildCard,
	CARD_KIND,
	generateKeypair,
	localSigner,
	NostrTransport,
	publishToRelays,
	resolvePeerCard,
	signCardEvent,
	toNpub,
} from "@nostr-agx/nostr";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProfile } from "../lib/config.js";
import { FileSuspensionStore } from "../lib/gateway/suspensions.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

let relay: RunningRelay;
let box: ReturnType<typeof sandbox>;
let relayUrl: string;

const typedSkill: AgentSkill = {
	id: "invoice.review",
	description: "Review an invoice against approval policy",
	tags: ["finance", "invoice"],
	inputModes: ["application/json"],
	outputModes: ["application/json"],
	inputSchema: {
		type: "object",
		required: ["amount"],
		properties: { amount: { type: "number", minimum: 0 } },
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		required: ["approved"],
		properties: { approved: { type: "boolean" } },
		additionalProperties: false,
	},
	features: ["working"],
};

beforeAll(async () => {
	relay = await startRelay({ port: 0 });
	relayUrl = `ws://127.0.0.1:${relay.port}`;
}, 30_000);

beforeEach(() => {
	box = sandbox();
	relay.clear();
	updateProfile("default", { relays: [relayUrl] });
});

afterEach(() => {
	box.restore();
});

afterAll(async () => {
	await relay.close();
});

async function publishCard(card: AgentCard, secretKey: Uint8Array): Promise<void> {
	const event = await signCardEvent(
		localSigner(secretKey),
		card,
		Math.floor(Date.now() / 1000),
	);
	expect((await publishToRelays([relayUrl], event)).ok).toBe(true);
}

function lastJson(stdout: string): Record<string, any> {
	return jsonDocuments(stdout).at(-1) as Record<string, any>;
}

describe("agx card typed skills over a real local relay", () => {
	it("publishes, resolves, and inspects one complete typed skill", async () => {
		const publisher = generateKeypair();
		const requester = generateKeypair();
		const transport = await NostrTransport.create({
			signer: localSigner(publisher.secretKey),
			relays: [relayUrl],
			ws: WebSocket,
		});
		expect(
			(
				await transport.publishDiscovery({
					org: "Acme Finance",
					capabilities: ["invoice.review"],
					payloadTypes: ["application/json"],
					skills: [typedSkill],
					extensions: [{ uri: "agx.task-status.v1", required: false }],
				})
			).ok,
		).toBe(true);

		const resolved = await resolvePeerCard(
			publisher.publicKey,
			[relayUrl],
			localSigner(requester.secretKey),
		);
		expect(resolved).toMatchObject({
			capabilities: ["invoice.review"],
			skills: [typedSkill],
			extensions: [{ uri: "agx.task-status.v1", required: false }],
		});

		const run = await agx(
			"card",
			toNpub(publisher.publicKey),
			"--skill",
			"invoice.review",
			"--json",
		);
		expect(run.code, run.stderr).toBe(0);
		const output = lastJson(run.stdout);
		expect(output.signatureValid).toBe(true);
		expect(output.card.version).toBe("1.1.0");
		expect(output.selectedSkill).toEqual(typedSkill);
		expect(output.typedMetadata.warning).toBeUndefined();

		const human = await agx(
			"card",
			toNpub(publisher.publicKey),
			"--skill",
			"invoice.review",
		);
		expect(human.code, human.stderr).toBe(0);
		expect(human.stdout).toContain("Skill — invoice.review");
		expect(human.stdout).toContain("Input schema");
		expect(human.stdout).toContain('"amount"');
		expect(human.stdout).toContain("Output schema");
		expect(human.stdout).toContain("agx.task-status.v1 (optional)");
	}, 30_000);

	it("keeps a legacy-only card unchanged", async () => {
		const publisher = generateKeypair();
		const card = buildCard({
			org: "Legacy agent",
			pubkey: publisher.publicKey,
			relays: [relayUrl],
			capabilities: ["invoice.*"],
			payloadTypes: ["application/json"],
		});
		await publishCard(card, publisher.secretKey);
		const run = await agx("card", toNpub(publisher.publicKey), "--json");
		expect(run.code, run.stderr).toBe(0);
		const output = lastJson(run.stdout);
		expect(output.card.version).toBe("1.0.0");
		expect(output.card.capabilities).toEqual(["invoice.*"]);
		expect(output.card).not.toHaveProperty("skills");
		expect(output.typedMetadata).toEqual({});
	}, 30_000);

	it("shows a warning and preserves legacy capabilities for invalid typed metadata", async () => {
		const publisher = generateKeypair();
		const legacy = buildCard({
			org: "Fallback agent",
			pubkey: publisher.publicKey,
			relays: [relayUrl],
			capabilities: ["invoice.review"],
			payloadTypes: ["application/json"],
		});
		await publishCard(
			{
				...legacy,
				skills: [
					{ id: "invoice.review", description: "one" },
					{ id: "invoice.review", description: "duplicate" },
				],
			},
			publisher.secretKey,
		);
		const run = await agx("card", toNpub(publisher.publicKey), "--json");
		expect(run.code, run.stderr).toBe(0);
		const output = lastJson(run.stdout);
		expect(output.card.capabilities).toEqual(["invoice.review"]);
		expect(output.typedMetadata.warning.code).toBe("invalid_typed_metadata");
		expect(output.typedMetadata.skills).toBeUndefined();

		const selected = await agx(
			"card",
			toNpub(publisher.publicKey),
			"--skill",
			"invoice.review",
		);
		expect(selected.code).toBe(6);
		expect(selected.stderr).toContain("duplicate skill ID");
	}, 30_000);

	it("falls back to legacy capabilities for an unknown required extension", async () => {
		const publisher = generateKeypair();
		const card = buildCard({
			org: "Extension agent",
			pubkey: publisher.publicKey,
			relays: [relayUrl],
			capabilities: ["invoice.review"],
			payloadTypes: ["application/json"],
			skills: [typedSkill],
			extensions: [{ uri: "agx.unknown.v1", required: true }],
		});
		await publishCard(card, publisher.secretKey);
		const run = await agx("card", toNpub(publisher.publicKey), "--json");
		expect(run.code, run.stderr).toBe(0);
		const output = lastJson(run.stdout);
		expect(output.card.capabilities).toEqual(["invoice.review"]);
		expect(output.typedMetadata.warning.code).toBe(
			"unsupported_required_extension",
		);
		expect(output.typedMetadata.skills).toBeUndefined();
		expect(output.typedMetadata.extensions).toEqual([
			{ uri: "agx.unknown.v1", required: true },
		]);
	}, 30_000);
});

async function pumpUntil<T>(
	promise: Promise<T>,
	clients: AgxClient[],
): Promise<T> {
	let settled = false;
	const watched = promise.finally(() => {
		settled = true;
	});
	watched.catch(() => undefined);
	while (!settled) {
		await Promise.all(clients.map((client) => client.pump()));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return watched;
}

describe("agx typed task validation over a real local relay", () => {
	it("preflights input and enforces authorized input and output contracts", async () => {
		const responderKeys = generateKeypair();
		const requesterKeys = generateKeypair();
		const responderTransport = await NostrTransport.create({
			signer: localSigner(responderKeys.secretKey),
			relays: [relayUrl],
			ws: WebSocket,
		});
		const requesterTransport = await NostrTransport.create({
			signer: localSigner(requesterKeys.secretKey),
			relays: [relayUrl],
			ws: WebSocket,
		});
		let output: unknown = { approved: true };
		const handler = vi.fn(() => output);
		const { id: capability, ...contract } = typedSkill;
		const responder = new AgxClient({
			transport: responderTransport,
			authorize: "accept-all",
		});
		const requester = new AgxClient({ transport: requesterTransport });
		responder.handle(capability, handler, contract);

		try {
			await responder.start({ pollIntervalMs: 0 });
			await expect(
				requester.request(
					responderKeys.publicKey,
					capability,
					{ amount: "bad" },
					{ validate: true },
				),
			).rejects.toThrow(/invalid_input/);
			expect(handler).not.toHaveBeenCalled();

			const invalidInput = requester.request(
				responderKeys.publicKey,
				capability,
				{ amount: "bad" },
				{ timeoutMs: 10_000 },
			);
			await expect(
				pumpUntil(invalidInput, [responder, requester]),
			).rejects.toThrow("invalid_input");
			expect(handler).not.toHaveBeenCalled();

			const valid = requester.request(
				responderKeys.publicKey,
				capability,
				{ amount: 5 },
				{ validate: true, timeoutMs: 10_000 },
			);
			await expect(
				pumpUntil(valid, [responder, requester]),
			).resolves.toEqual({ approved: true });
			expect(handler).toHaveBeenCalledTimes(1);

			output = { approved: "yes" };
			const invalidOutput = requester.request(
				responderKeys.publicKey,
				capability,
				{ amount: 5 },
				{ timeoutMs: 10_000 },
			);
			await expect(
				pumpUntil(invalidOutput, [responder, requester]),
			).rejects.toThrow("invalid_output");
			expect(handler).toHaveBeenCalledTimes(2);
		} finally {
			await Promise.all([responder.stop(), requester.stop()]);
		}
	}, 30_000);
});


describe("agx durable resume over a real local relay", () => {
	it("restores a suspended task from disk and resumes only the resume handler", async () => {
		const responderKeys = generateKeypair();
		const requesterKeys = generateKeypair();
		const seen = new InMemorySeenStore();
		const resumeSchema = {
			type: "object",
			required: ["answer"],
			properties: { answer: { type: "string" } },
			additionalProperties: false,
		};
		const initial = vi.fn(async (task: {
			requireInput?: (options: {
				question: { kind: "text"; prompt: string };
				resumeSchema: typeof resumeSchema;
				state: { invoice: number };
			}) => Promise<unknown>;
		}) => task.requireInput?.({
			question: { kind: "text", prompt: "Approve invoice?" },
			resumeSchema,
			state: { invoice: 42 },
		}));
		const resume = vi.fn((task: { state?: unknown }, input: unknown) => ({
			answer: (input as { answer: string }).answer,
			state: task.state,
		}));
		const firstTransport = await NostrTransport.create({
			signer: localSigner(responderKeys.secretKey),
			relays: [relayUrl],
			ws: WebSocket,
		});
		const requesterTransport = await NostrTransport.create({
			signer: localSigner(requesterKeys.secretKey),
			relays: [relayUrl],
			ws: WebSocket,
		});
		const first = new AgxClient({
			transport: firstTransport,
			seen,
			suspensions: new FileSuspensionStore("restart"),
			authorize: "accept-all",
			maxConcurrentTasks: 2,
		});
		const requester = new AgxClient({ transport: requesterTransport });
		first.handle("invoice.approve", initial, undefined, resume);
		let second: AgxClient | undefined;

		try {
			await first.start({ pollIntervalMs: 0, advertise: false });
			let taskId = "";
			let questionArrived: () => void = () => undefined;
			const question = new Promise<void>((resolve) => {
				questionArrived = resolve;
			});
			const onTaskStatus = vi.fn((update: { taskId: string; status: string }) => {
				if (update.status === "input-required") {
					taskId = update.taskId;
					questionArrived();
				}
			});
			const pending = requester.request(
				responderKeys.publicKey,
				"invoice.approve",
				{},
				{ timeoutMs: 20_000, onTaskStatus },
			);
			await pumpUntil(question, [first, requester]);
			expect(taskId).not.toBe("");
			expect(await new FileSuspensionStore("restart").list()).toHaveLength(1);
			await first.stop();

			const secondTransport = await NostrTransport.create({
				signer: localSigner(responderKeys.secretKey),
				relays: [relayUrl],
				ws: WebSocket,
			});
			const restartedInitial = vi.fn(() => "must not run");
			second = new AgxClient({
				transport: secondTransport,
				seen,
				suspensions: new FileSuspensionStore("restart"),
				authorize: "accept-all",
				maxConcurrentTasks: 2,
			});
			second.handle("invoice.approve", restartedInitial, undefined, resume);
			await second.start({ pollIntervalMs: 0, advertise: false });
			await requester.resume(taskId, { answer: "yes" });
			await expect(pumpUntil(pending, [second, requester])).resolves.toEqual({
				answer: "yes",
				state: { invoice: 42 },
			});
			expect(initial).toHaveBeenCalledTimes(1);
			expect(restartedInitial).not.toHaveBeenCalled();
			expect(resume).toHaveBeenCalledTimes(1);
			expect(await new FileSuspensionStore("restart").list()).toEqual([]);
		} finally {
			await Promise.all([first.stop(), second?.stop(), requester.stop()]);
		}
	}, 30_000);
});
