import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AgxClient, DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { generateKeypair, localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../../relay/server.js";
import { agx, sandbox } from "../../test/helpers.js";
import { resolveProfileName } from "../config.js";
import { loadIdentity } from "../identity.js";
import { profileDir, seenPath } from "../paths.js";
import { MESSAGES_FILE } from "../store/message-store.js";
import { AGX_CLI_VERSION } from "../version.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { createGatewayKey } from "./keys.js";

/**
 * `agx gateway` end to end: a real gateway on a sandboxed profile, the CLI's
 * in-process relay, a real AGX peer, and a webhook receiver standing in for
 * n8n.
 */

let relay: RunningRelay;
let box: ReturnType<typeof sandbox>;
let gateway: RunningGateway;
let key: string;
let profile: string;

interface Received {
	headers: IncomingMessage["headers"];
	body: string;
	json: Record<string, unknown>;
}

/** A webhook: records each POST and answers with `answer`. */
async function webhook(
	answer: (event: Record<string, unknown>) => { status: number; body?: unknown } = () => ({ status: 200, body: {} }),
) {
	const received: Received[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const json = JSON.parse(body) as Record<string, unknown>;
			received.push({ headers: req.headers, body, json });
			const { status, body: out } = answer(json);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(out === undefined ? "" : JSON.stringify(out));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
	servers.push(server);
	return { url, received };
}
const servers: Server[] = [];

/** A webhook that holds every request until the test answers it. */
async function heldWebhook() {
	const held: ServerResponse[] = [];
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on("end", () => held.push(res));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`,
		held,
		answer(index: number, body: unknown) {
			held[index].writeHead(200, { "content-type": "application/json" });
			held[index].end(JSON.stringify(body));
		},
	};
}

/** An AGX agent on the test relay. */
async function peer(options: ConstructorParameters<typeof AgxClient>[0] extends infer O ? Partial<O> : never = {}) {
	const { secretKey, publicKey } = generateKeypair();
	const transport = await NostrTransport.create({
		signer: localSigner(secretKey),
		relays: [`ws://127.0.0.1:${relay.port}`],
		ws: WebSocket,
	});
	const client = new AgxClient({ transport, startCursor: Math.floor(Date.now() / 1000) - 60, ...options });
	clients.push(client);
	return { client, transport, publicKey, npub: toNpub(publicKey) };
}
const clients: AgxClient[] = [];

function api(path: string, init: RequestInit & { key?: string | null } = {}) {
	const { key: given, ...rest } = init;
	const auth = given === undefined ? key : given;
	return fetch(`${gateway.url}${path}`, {
		...rest,
		headers: {
			"content-type": "application/json",
			...(auth ? { authorization: `Bearer ${auth}` } : {}),
			...rest.headers,
		},
	});
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** Pump `client` until `promise` settles. */
async function pumping<T>(promise: Promise<T>, client: AgxClient): Promise<T> {
	let settled = false;
	const watched = promise.finally(() => {
		settled = true;
	});
	watched.catch(() => undefined);
	while (!settled) {
		await client.pump();
		await new Promise((r) => setTimeout(r, 150));
	}
	return watched;
}

async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error("waitFor: condition not met in time");
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function waitForPeer<T>(check: () => T | undefined | false, client: AgxClient, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error("waitForPeer: condition not met in time");
		}
		await client.pump();
		await new Promise((r) => setTimeout(r, 100));
	}
}

function verify(received: Received, secret: string): boolean {
	const timestamp = String(received.headers["x-agx-timestamp"]);
	const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${received.body}`).digest("hex")}`;
	return received.headers["x-agx-signature"] === expected;
}

async function subscribe(body: Record<string, unknown>) {
	const res = await api("/v1/subscriptions", { method: "POST", body: JSON.stringify(body) });
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; secret: string };
}

/** One task per webhook at a time, so a test can make one wait its turn. */
function gatewayOptions() {
	return { profile, port: 0, pollIntervalMs: 200, deliveryRetryDelaysMs: [100], maxTasksPerWebhook: 1 };
}

async function backgroundTask(id: string) {
	const res = await api(`/v1/tasks/${id}`);
	expect(res.status).toBe(200);
	return json(res);
}

async function settledBackgroundTask(id: string, client: AgxClient) {
	return pumping((async () => {
		for (let attempt = 0; attempt < 100; attempt++) {
			const view = await backgroundTask(id);
			if (view.status === "completed" || view.status === "failed") {
				return view;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`Background task ${id} did not settle`);
	})(), client);
}

beforeAll(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	expect((await agx("identity", "new")).code).toBe(0);
	expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	profile = resolveProfileName();
	key = createGatewayKey(profile, "test").key;
	gateway = await startGateway(gatewayOptions());
}, 30_000);

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.stop();
	}
});

afterAll(async () => {
	await gateway?.close();
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	await relay?.close();
	box?.restore();
});

describe("agx gateway: authentication", () => {
	it("answers health without a key, and nothing else", async () => {
		// Healthy once a poll has finished.
		let health: Response | undefined;
		for (let i = 0; i < 50 && health?.status !== 200; i++) {
			health = await api("/v1/health", { key: null });
			if (health.status !== 200) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		expect(health?.status).toBe(200);
		expect(await json(health as Response)).toMatchObject({ ok: true, allRelaysAnswering: true, version: AGX_CLI_VERSION });
		const missing = await api("/v1/identity", { key: null });
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Bearer");
		expect((await api("/v1/identity", { key: "agxg_wrong" })).status).toBe(401);
		const ok = await api("/v1/identity");
		expect(ok.status).toBe(200);
		expect(await json(ok)).toMatchObject({ npub: gateway.npub, relays: [`ws://127.0.0.1:${relay.port}`] });
	});

	it("refuses a key once it is revoked, while running", async () => {
		const created = await agx("gateway", "key", "new", "--label", "short-lived", "--json");
		expect(created.code).toBe(0);
		const { id, key: shortLived } = JSON.parse(created.stdout.slice(created.stdout.indexOf("{"))) as { id: string; key: string };
		expect((await api("/v1/identity", { key: shortLived })).status).toBe(200);
		const listed = await agx("gateway", "key", "list", "--json");
		expect(listed.stdout).toContain(id);
		expect(listed.stdout).not.toContain(shortLived);
		expect((await agx("gateway", "key", "revoke", id)).code).toBe(0);
		expect((await api("/v1/identity", { key: shortLived })).status).toBe(401);
	});
});

describe("agx gateway: outbound", () => {
	it("requests a task from another agent and returns its result", async () => {
		const reviewer = await peer({ authorize: "accept-all" });
		reviewer.client.handle("invoice.review", (task) => ({ approved: (task.payload as { amount: number }).amount < 100 }));
		const call = api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.review", payload: { amount: 42 }, timeoutSec: 20 }),
		});
		const res = await pumping(call, reviewer.client);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({
			peer: reviewer.npub,
			capability: "invoice.review",
			status: "completed",
			output: { approved: true },
		});
	}, 30_000);

	it("explains a timeout as the probable missing allowlist entry", async () => {
		const stranger = await peer();
		const res = await api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: stranger.publicKey, capability: "x.y", timeoutSec: 2 }),
		});
		expect(res.status).toBe(504);
		const body = await json(res);
		expect(body.error).toMatchObject({ code: "timeout" });
		expect(String((body.error as { description: string }).description)).toContain("allowed this one");
	}, 15_000);

	it("sends a message the peer can read, and bounds automated replies", async () => {
		const reader = await peer();
		const res = await api("/v1/messages", {
			method: "POST",
			body: JSON.stringify({ peer: reader.npub, text: "Invoice 1234 is approved.", contextId: 1234, autoDepth: 2 }),
		});
		expect(res.status).toBe(200);
		const sent = await json(res);
		expect(sent).toMatchObject({ contextId: "1234", autoDepth: 2, relaysAccepted: 1 });
		let msg: unknown;
		for (let i = 0; i < 40 && !msg; i++) {
			const { messages } = await reader.transport.poll({ since: 0 });
			msg = messages.find((m) => m.eventId === sent.eventId);
			if (!msg) {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		expect(msg).toMatchObject({ text: "Invoice 1234 is approved.", contextId: "1234", autoDepth: 2 });
		// Kept in the profile's history, as `agx send` keeps what it sends.
		const history = join(profileDir(profile), MESSAGES_FILE);
		await waitFor(() => existsSync(history) && readFileSync(history, "utf8").includes(String(sent.eventId)));

		const empty = await api("/v1/messages", {
			method: "POST",
			body: JSON.stringify({ peer: reader.npub, text: "automated", autoDepth: null }),
		});
		expect(empty.status).toBe(400);
		expect((await json(empty)).error).toMatchObject({ message: "Automated Reply Depth is empty" });
		const deep = await api("/v1/messages", {
			method: "POST",
			body: JSON.stringify({ peer: reader.npub, text: "automated", autoDepth: 9 }),
		});
		expect(deep.status).toBe(429);
		expect((await json(deep)).error).toMatchObject({ code: "loop_protection" });
	}, 30_000);

	it("reads an advertised card and checks a capability against it", async () => {
		const reviewer = await peer({ authorize: "accept-all", identity: { org: "Acme Finance" } });
		reviewer.client.handle("invoice.review", () => ({}));
		await reviewer.client.start({ pollIntervalMs: 0 });
		const res = await api(`/v1/agents/${reviewer.npub}?capability=invoice.review`);
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({
			npub: reviewer.npub,
			found: true,
			org: "Acme Finance",
			capabilities: ["invoice.review"],
			supportsCapability: true,
		});
	}, 30_000);

	it("runs one task for concurrent and completed idempotent retries", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 4 });
		let runs = 0;
		let releaseFirst: () => void = () => undefined;
		reviewer.client.handle("invoice.idempotent", async () => {
			runs += 1;
			if (runs === 1) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return { run: runs };
		});
		const body = { peer: reviewer.npub, capability: "invoice.idempotent", payload: { amount: 42 }, timeoutSec: 20 };
		const call = () => api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "invoice-42" },
			body: JSON.stringify(body),
		});
		const first = call();
		const concurrent = call();
		await waitForPeer(() => runs === 1, reviewer.client);
		releaseFirst();
		const responses = await pumping(Promise.all([first, concurrent]), reviewer.client);
		expect(responses.map((res) => res.status)).toEqual([200, 200]);
		const outputs = await Promise.all(responses.map(json));
		expect(outputs[0]).toMatchObject({ status: "completed", output: { run: 1 } });
		expect(outputs[1]).toEqual(outputs[0]);

		const reordered = { timeoutSec: 20, payload: { amount: 42 }, capability: "invoice.idempotent", peer: reviewer.npub };
		const replay = await api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "invoice-42" },
			body: JSON.stringify(reordered),
		});
		expect(replay.status).toBe(200);
		expect(await json(replay)).toEqual(outputs[0]);
		const conflict = await api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "invoice-42" },
			body: JSON.stringify({ ...body, payload: { amount: 43 } }),
		});
		expect(conflict.status).toBe(409);
		expect(await json(conflict)).toMatchObject({ error: { code: "idempotency_key_reused" } });
		expect(runs).toBe(1);

		const otherKey = createGatewayKey(profile, "other-credential").key;
		const otherCredential = await pumping(api("/v1/tasks", {
			method: "POST",
			key: otherKey,
			headers: { "idempotency-key": "invoice-42" },
			body: JSON.stringify(body),
		}), reviewer.client);
		expect(otherCredential.status).toBe(200);
		expect(await json(otherCredential)).toMatchObject({ output: { run: 2 } });
		expect(runs).toBe(2);
	}, 30_000);

	it("keeps an idempotent task alive when its first caller disconnects", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 2 });
		let runs = 0;
		let release: () => void = () => undefined;
		reviewer.client.handle("invoice.disconnect", async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		});
		const body = JSON.stringify({ peer: reviewer.npub, capability: "invoice.disconnect", timeoutSec: 20 });
		const gone = new AbortController();
		const first = api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "disconnect-1" },
			body,
			signal: gone.signal,
		});
		await waitForPeer(() => runs === 1, reviewer.client);
		gone.abort();
		await expect(first).rejects.toThrow();
		const retry = api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "disconnect-1" },
			body,
		});
		release();
		const res = await pumping(retry, reviewer.client);
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({ status: "completed", output: { run: 1 } });
		expect(runs).toBe(1);
	}, 30_000);

	it("does not leak waiting slots when idempotency keys are invalid", async () => {
		const reviewer = await peer({ authorize: "accept-all" });
		reviewer.client.handle("invoice.invalid-key", () => ({ ok: true }));
		await gateway.close();
		gateway = await startGateway({ ...gatewayOptions(), maxTaskRequestsWaiting: 1 });
		try {
			for (const value of ["", "has space", "x".repeat(256)]) {
				const invalid = await api("/v1/tasks", {
					method: "POST",
					headers: { "idempotency-key": value },
					body: "{}",
				});
				expect(invalid.status).toBe(400);
				expect(await json(invalid)).toMatchObject({ error: { code: "invalid_idempotency_key" } });
			}
			const valid = await pumping(api("/v1/tasks", {
				method: "POST",
				body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.invalid-key", timeoutSec: 20 }),
			}), reviewer.client);
			expect(valid.status).toBe(200);
		} finally {
			await gateway.close();
			gateway = await startGateway(gatewayOptions());
		}
	}, 30_000);

	it("releases a disconnected joiner's slot while the shared task keeps running", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 2 });
		let runs = 0;
		let release: () => void = () => undefined;
		reviewer.client.handle("invoice.joiner-disconnect", async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		});
		await gateway.close();
		gateway = await startGateway({ ...gatewayOptions(), maxTaskRequestsWaiting: 2 });
		const call = (signal?: AbortSignal) => api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "joiner-disconnect" },
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.joiner-disconnect", timeoutSec: 20 }),
			signal,
		});
		try {
			const first = call();
			first.catch(() => undefined);
			await waitForPeer(() => runs === 1, reviewer.client);
			const gone = new AbortController();
			const joiner = call(gone.signal);
			await new Promise((resolve) => setTimeout(resolve, 250));
			gone.abort();
			await expect(joiner).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const rejoined = call();
			rejoined.catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 250));
			release();
			const responses = await pumping(Promise.all([first, rejoined]), reviewer.client);
			expect(responses.map((res) => res.status)).toEqual([200, 200]);
			const outputs = await Promise.all(responses.map(json));
			expect(outputs[0]).toMatchObject({ status: "completed", output: { run: 1 } });
			expect(outputs[1]).toEqual(outputs[0]);
			expect(runs).toBe(1);
		} finally {
			release();
			await gateway.close();
			gateway = await startGateway(gatewayOptions());
		}
	}, 30_000);

	it("restores completed idempotent results and reports unresolved work after restart", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 4 });
		let completedRuns = 0;
		reviewer.client.handle("invoice.saved", () => ({ run: ++completedRuns }));
		const body = { peer: reviewer.npub, capability: "invoice.saved", timeoutSec: 20 };
		const call = () => api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "restart-complete" },
			body: JSON.stringify(body),
		});
		const first = await pumping(call(), reviewer.client);
		expect(first.status).toBe(200);
		expect(await json(first)).toMatchObject({ output: { run: 1 } });
		await gateway.close();
		gateway = await startGateway(gatewayOptions());
		const restored = await call();
		expect(restored.status).toBe(200);
		expect(await json(restored)).toMatchObject({ output: { run: 1 } });
		expect(completedRuns).toBe(1);

		let pendingRuns = 0;
		let release: () => void = () => undefined;
		reviewer.client.handle("invoice.unknown", async () => {
			pendingRuns += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: pendingRuns };
		});
		const pendingBody = JSON.stringify({ peer: reviewer.npub, capability: "invoice.unknown", timeoutSec: 1 });
		const pending = api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "restart-pending" },
			body: pendingBody,
		});
		pending.catch(() => undefined);
		await waitForPeer(() => pendingRuns === 1, reviewer.client);
		await gateway.close();
		await expect(pending).rejects.toThrow();
		gateway = await startGateway(gatewayOptions());
		const unknown = await api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "restart-pending" },
			body: pendingBody,
		});
		expect(unknown.status).toBe(409);
		expect(await json(unknown)).toMatchObject({ error: { code: "result_unknown" } });
		release();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const stillUnknown = await api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "restart-pending" },
			body: pendingBody,
		});
		expect(stillUnknown.status).toBe(409);
		expect(pendingRuns).toBe(1);
	}, 45_000);

	it("returns a background handle before completion and its stored result after reconnect", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 4 });
		let runs = 0;
		let release: () => void = () => undefined;
		reviewer.client.handle("invoice.background", async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		});
		const invalid = await api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.background", background: "yes" }),
		});
		expect(invalid.status).toBe(400);
		expect(await json(invalid)).toMatchObject({ error: { code: "invalid_request" } });
		expect(runs).toBe(0);

		const body = { peer: reviewer.npub, capability: "invoice.background", background: true, timeoutSec: 20 };
		const call = () => api("/v1/tasks", {
			method: "POST",
			headers: { "idempotency-key": "background-invoice-1" },
			body: JSON.stringify(body),
		});
		const acceptedResponse = await call();
		expect(acceptedResponse.status).toBe(202);
		const accepted = await json(acceptedResponse);
		const id = accepted.id as string;
		expect(accepted).toMatchObject({ id, status: "running" });
		expect(id).toMatch(/^task_[0-9a-f-]{36}$/);
		expect(await backgroundTask(id)).toMatchObject({ id, status: "running" });
		const otherKey = createGatewayKey(profile, "background-other-credential").key;
		expect((await api(`/v1/tasks/${id}`, { key: otherKey })).status).toBe(404);
		expect((await api("/v1/tasks/task_00000000-0000-0000-0000-000000000000")).status).toBe(404);

		await waitForPeer(() => runs === 1, reviewer.client);
		const duplicate = await call();
		expect(duplicate.status).toBe(202);
		expect(await json(duplicate)).toMatchObject({ id, status: "running" });
		expect(runs).toBe(1);
		release();
		const completed = await settledBackgroundTask(id, reviewer.client);
		expect(completed).toMatchObject({
			id,
			status: "completed",
			result: {
				peer: reviewer.npub,
				capability: "invoice.background",
				status: "completed",
				output: { run: 1 },
			},
		});
		expect(await backgroundTask(id)).toEqual(completed);
		const replay = await call();
		expect(replay.status).toBe(202);
		expect(await json(replay)).toEqual(completed);
		expect(runs).toBe(1);
	}, 30_000);

	it("restores completed and failed background outcomes after restart", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 4 });
		let completedRuns = 0;
		reviewer.client.handle("invoice.background.saved", () => ({ run: ++completedRuns }));
		const completedResponse = await api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.background.saved", background: true, timeoutSec: 20 }),
		});
		expect(completedResponse.status).toBe(202);
		const completedId = (await json(completedResponse)).id as string;
		const completed = await settledBackgroundTask(completedId, reviewer.client);
		expect(completed).toMatchObject({ status: "completed", result: { output: { run: 1 } } });
		await gateway.close();
		gateway = await startGateway(gatewayOptions());
		expect(await backgroundTask(completedId)).toEqual(completed);
		expect(completedRuns).toBe(1);

		reviewer.client.handle("invoice.background.failed", () => {
			throw new Error("private failure detail");
		});
		const failedResponse = await api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.background.failed", background: true, timeoutSec: 20 }),
		});
		expect(failedResponse.status).toBe(202);
		const failedId = (await json(failedResponse)).id as string;
		const failed = await settledBackgroundTask(failedId, reviewer.client);
		expect(failed).toMatchObject({ status: "failed", error: { code: "task_failed" } });
		expect(JSON.stringify(failed)).not.toContain("private failure detail");
		await gateway.close();
		gateway = await startGateway(gatewayOptions());
		expect(await backgroundTask(failedId)).toEqual(failed);
	}, 45_000);

	it("reports interrupted background work as unknown without rerunning it", async () => {
		const reviewer = await peer({ authorize: "accept-all", maxConcurrentTasks: 2 });
		let runs = 0;
		let release: () => void = () => undefined;
		reviewer.client.handle("invoice.background.unknown", async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		});
		const acceptedResponse = await api("/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ peer: reviewer.npub, capability: "invoice.background.unknown", background: true, timeoutSec: 20 }),
		});
		expect(acceptedResponse.status).toBe(202);
		const id = (await json(acceptedResponse)).id as string;
		await waitForPeer(() => runs === 1, reviewer.client);
		await gateway.close();
		gateway = await startGateway(gatewayOptions());
		const unknown = await backgroundTask(id);
		expect(unknown).toMatchObject({ id, status: "failed", error: { code: "result_unknown" } });
		release();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(await backgroundTask(id)).toEqual(unknown);
		expect(runs).toBe(1);
	}, 45_000);
});

describe("agx gateway: subscriptions", () => {
	it("creates, shows, lists and deletes a subscription; the secret is shown once", async () => {
		const hook = await webhook();
		const created = await subscribe({
			url: hook.url,
			events: ["message"],
			allowedPeers: [toNpub(generateKeypair().publicKey)],
		});
		expect(created.secret).toBeTruthy();
		const shown = await json(await api(`/v1/subscriptions/${created.id}`));
		expect(shown).toMatchObject({ id: created.id, url: hook.url, events: ["message"] });
		expect(shown.secret).toBeUndefined();
		const list = await json(await api("/v1/subscriptions"));
		expect(JSON.stringify(list)).toContain(created.id);
		expect(JSON.stringify(list)).not.toContain(created.secret);
		expect((await api(`/v1/subscriptions/${created.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await api(`/v1/subscriptions/${created.id}`)).status).toBe(404);
	});

	it("refuses a subscription nobody could reach, or a capability it could never serve", async () => {
		const hook = await webhook();
		for (const body of [
			{ url: hook.url, events: ["task"], capabilities: ["invoice.review"] },
			{ url: hook.url, events: ["task"], capabilities: ["invoice.*"], acceptAll: true },
			{ url: "ftp://example.com/x", events: ["message"], acceptAll: true },
			{ url: hook.url, events: ["task"], acceptAll: true },
			// Cloud metadata, link-local, multicast: never a webhook.
			{ url: "http://169.254.169.254/latest/meta-data/", events: ["message"], acceptAll: true },
			{ url: "http://[fe80::1]/hook", events: ["message"], acceptAll: true },
			{ url: "http://224.0.0.1/hook", events: ["message"], acceptAll: true },
		]) {
			const res = await api("/v1/subscriptions", { method: "POST", body: JSON.stringify(body) });
			expect(res.status).toBe(400);
			expect((await json(res)).error).toMatchObject({ code: "invalid_subscription" });
		}
	});
});

describe("agx gateway: Agent Card", () => {
	it("keeps a capability on the card when its subscription is replaced", async () => {
		const reader = await peer();
		const card = async () => {
			const res = await api(`/v1/agents/${gateway.npub}?capability=invoice.card&verifyNip05=false`);
			return (await json(res)).supportsCapability;
		};
		const hook = await webhook();
		const body = { url: hook.url, events: ["task"], capabilities: ["invoice.card"], allowedPeers: [reader.npub], advertise: true };
		const first = await subscribe(body);
		await new Promise((r) => setTimeout(r, 2500));
		expect(await card()).toBe(true);
		// What n8n does on a republish: DELETE, then POST the same at once.
		expect((await api(`/v1/subscriptions/${first.id}`, { method: "DELETE" })).status).toBe(204);
		const second = await subscribe(body);
		await new Promise((r) => setTimeout(r, 2500));
		expect(await card()).toBe(true);
		await api(`/v1/subscriptions/${second.id}`, { method: "DELETE" });
	}, 30_000);
	it("replaces a card the profile published before with what its webhooks serve", async () => {
		await gateway.close();
		// What `agx serve --advertise` left on the relays.
		const before = await NostrTransport.create({
			signer: loadIdentity(profile).signer,
			relays: [`ws://127.0.0.1:${relay.port}`],
			ws: WebSocket,
		});
		await before.advertise(["old.capability"], { payloadTypes: [DEFAULT_CONTENT_TYPE] });
		await new Promise((r) => setTimeout(r, 1100));
		gateway = await startGateway(gatewayOptions());
		const res = await api(`/v1/agents/${gateway.npub}?capability=old.capability&verifyNip05=false`);
		expect(await json(res)).toMatchObject({ found: true, capabilities: [], supportsCapability: false });
	}, 30_000);
});

describe("agx gateway: inbound", () => {
	it("runs an allowed agent's task through the webhook and sends its answer back, signed", async () => {
		const requester = await peer();
		let seenOnDisk = "";
		const hook = await webhook((event) => {
			seenOnDisk = readFileSync(seenPath(profile), "utf8");
			return { status: 200, body: { reviewed: (event.payload as { id: number }).id } };
		});
		const sub = await subscribe({
			url: hook.url,
			events: ["task"],
			capabilities: ["invoice.check"],
			allowedPeers: [requester.npub],
		});
		const result = requester.client.request(gateway.npub, "invoice.check", { id: 7 }, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).resolves.toEqual({ reviewed: 7 });
		expect(hook.received).toHaveLength(1);
		const [delivery] = hook.received;
		expect(verify(delivery, sub.secret)).toBe(true);
		expect(delivery.json).toMatchObject({
			event: "task",
			capability: "invoice.check",
			payload: { id: 7 },
			from: requester.npub,
			fromPubkey: requester.publicKey,
		});
		expect(delivery.headers["x-agx-subscription"]).toBe(sub.id);
		// On disk before the webhook had it: a crash while the workflow runs
		// cannot run it again.
		expect(seenOnDisk).toContain(String(delivery.headers["x-agx-delivery"]));
	}, 30_000);

	it("never reaches the webhook for an agent the subscription does not allow, and sends no reply", async () => {
		const receipts: unknown[] = [];
		const stranger = await peer({ onReceipt: (receipt) => void receipts.push(receipt) });
		const hook = await webhook(() => ({ status: 200, body: { ran: true } }));
		await subscribe({
			url: hook.url,
			events: ["task"],
			capabilities: ["invoice.deny"],
			allowedPeers: [toNpub(generateKeypair().publicKey)],
		});
		const result = stranger.client.request(gateway.npub, "invoice.deny", {}, { timeoutMs: 3_000 });
		await expect(pumping(result, stranger.client)).rejects.toThrow(/timed out/);
		expect(hook.received).toHaveLength(0);
		// Not even a delivery receipt: that would confirm the capability to a stranger.
		expect(receipts).toHaveLength(0);
	}, 15_000);

	it("reports a failed workflow as `handler failed`, keeping its details on this side", async () => {
		const requester = await peer();
		const hook = await webhook(() => ({ status: 500, body: { message: "Error in workflow: db.internal:5432 refused" } }));
		await subscribe({ url: hook.url, events: ["task"], capabilities: ["invoice.fail"], allowedPeers: [requester.npub] });
		const result = requester.client.request(gateway.npub, "invoice.fail", {}, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).rejects.toThrow("handler failed");
	}, 30_000);

	it("tries the newest webhook first, and an older one when the newest cannot be reached", async () => {
		const requester = await peer();
		const older = await webhook(() => ({ status: 200, body: { from: "older" } }));
		await subscribe({ url: older.url, events: ["task"], capabilities: ["invoice.route"], allowedPeers: [requester.npub] });
		await new Promise((r) => setTimeout(r, 1100));
		await subscribe({
			url: "http://127.0.0.1:9/gone",
			events: ["task"],
			capabilities: ["invoice.route"],
			allowedPeers: [requester.npub],
		});
		const result = requester.client.request(gateway.npub, "invoice.route", {}, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).resolves.toEqual({ from: "older" });
	}, 30_000);

	it("keeps answering other webhooks' tasks while one workflow is slow", async () => {
		const requester = await peer();
		const slow = await heldWebhook();
		await subscribe({ url: slow.url, events: ["task"], capabilities: ["invoice.slow"], allowedPeers: [requester.npub] });
		const fast = await webhook(() => ({ status: 200, body: { fast: true } }));
		await subscribe({ url: fast.url, events: ["task"], capabilities: ["invoice.fast"], allowedPeers: [requester.npub] });

		const slowResult = requester.client.request(gateway.npub, "invoice.slow", {}, { timeoutMs: 25_000 });
		await waitFor(() => slow.held.length === 1);
		const fastResult = requester.client.request(gateway.npub, "invoice.fast", {}, { timeoutMs: 10_000 });
		await expect(pumping(fastResult, requester.client)).resolves.toEqual({ fast: true });

		slow.answer(0, { slow: true });
		await expect(pumping(slowResult, requester.client)).resolves.toEqual({ slow: true });
	}, 30_000);

	it("tells the requester when a task waited for its webhook past the task's age limit", async () => {
		const requester = await peer();
		const busy = await heldWebhook();
		await subscribe({
			url: busy.url,
			events: ["task"],
			capabilities: ["invoice.queue"],
			allowedPeers: [requester.npub],
			maxTaskAgeSec: 2,
		});
		const first = requester.client.request(gateway.npub, "invoice.queue", { n: 1 }, { timeoutMs: 25_000 });
		await waitFor(() => busy.held.length === 1);
		// One task per webhook in these tests: the second waits its turn.
		const second = requester.client.request(gateway.npub, "invoice.queue", { n: 2 }, { timeoutMs: 25_000 });
		second.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 3500));
		busy.answer(0, { n: 1 });
		await expect(pumping(first, requester.client)).resolves.toEqual({ n: 1 });
		await expect(pumping(second, requester.client)).rejects.toThrow("the workflow was busy for too long");
		expect(busy.held).toHaveLength(1);
	}, 30_000);

	it("refuses tasks past a webhook's queue or the gateway's limit as busy, and keeps reading the inbox", async () => {
		// One running and one waiting per webhook, three tasks in all.
		await gateway.close();
		gateway = await startGateway({ ...gatewayOptions(), maxTasksWaitingPerWebhook: 1, maxTasksInFlight: 3 });
		try {
			const requester = await peer();
			const slow = await heldWebhook();
			await subscribe({ url: slow.url, events: ["task"], capabilities: ["invoice.pile"], allowedPeers: [requester.npub] });
			const other = await heldWebhook();
			await subscribe({ url: other.url, events: ["task"], capabilities: ["invoice.other"], allowedPeers: [requester.npub] });
			const fast = await webhook(() => ({ status: 200, body: { fast: true } }));
			await subscribe({ url: fast.url, events: ["task"], capabilities: ["invoice.quick"], allowedPeers: [requester.npub] });
			const ask = (capability: string, n: number) => {
				const result = requester.client.request(gateway.npub, capability, { n }, { timeoutMs: 25_000 });
				result.catch(() => undefined);
				return result;
			};

			const running = ask("invoice.pile", 1);
			await waitFor(() => slow.held.length === 1);
			const waiting = ask("invoice.pile", 2);
			await new Promise((r) => setTimeout(r, 1000));
			// The slow webhook's queue is full: refused at once, not held.
			await expect(pumping(ask("invoice.pile", 3), requester.client)).rejects.toThrow("the workflow is busy");
			// The inbox is still read: another webhook's task runs.
			await expect(pumping(ask("invoice.quick", 4), requester.client)).resolves.toEqual({ fast: true });

			const otherRunning = ask("invoice.other", 5);
			await waitFor(() => other.held.length === 1);
			// Three tasks in flight: the gateway refuses the next, wherever it goes.
			await expect(pumping(ask("invoice.quick", 6), requester.client)).rejects.toThrow("the gateway is busy");

			slow.answer(0, { n: 1 });
			await expect(pumping(running, requester.client)).resolves.toEqual({ n: 1 });
			await waitFor(() => slow.held.length === 2);
			slow.answer(1, { n: 2 });
			await expect(pumping(waiting, requester.client)).resolves.toEqual({ n: 2 });
			other.answer(0, { n: 5 });
			await expect(pumping(otherRunning, requester.client)).resolves.toEqual({ n: 5 });
			expect(slow.held).toHaveLength(2);
			expect(fast.received).toHaveLength(1);
		} finally {
			await gateway.close();
			gateway = await startGateway(gatewayOptions());
		}
	}, 60_000);

	it("answers `result too large` for a workflow answer it could never send on", async () => {
		const requester = await peer();
		const hook = await webhook(() => ({ status: 200, body: "x".repeat(1_100_000) }));
		await subscribe({ url: hook.url, events: ["task"], capabilities: ["invoice.huge"], allowedPeers: [requester.npub] });
		const result = requester.client.request(gateway.npub, "invoice.huge", {}, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).rejects.toThrow("result too large");
	}, 30_000);

	it("tells a task still waiting for its webhook that the gateway is stopping", async () => {
		const requester = await peer();
		const busy = await heldWebhook();
		await subscribe({ url: busy.url, events: ["task"], capabilities: ["invoice.stop"], allowedPeers: [requester.npub] });
		// The first task's workflow never finishes; the second waits for it.
		const first = requester.client.request(gateway.npub, "invoice.stop", { n: 1 }, { timeoutMs: 3_000 });
		first.catch(() => undefined);
		await waitFor(() => busy.held.length === 1);
		// One task per webhook in these tests: the second waits its turn.
		const second = requester.client.request(gateway.npub, "invoice.stop", { n: 2 }, { timeoutMs: 25_000 });
		second.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 1500));
		const closing = gateway.close();
		await expect(pumping(second, requester.client)).rejects.toThrow("the gateway is stopping");
		await closing;
		expect(busy.held).toHaveLength(1);
		busy.answer(0, {});
		gateway = await startGateway(gatewayOptions());
	}, 40_000);

	it("delivers an allowed agent's message in the background, with the depth a reply declares", async () => {
		const sender = await peer();
		const hook = await webhook();
		const sub = await subscribe({ url: hook.url, events: ["message"], allowedPeers: [sender.npub] });
		const sent = await sender.transport.publishMessage(gateway.npub, {
			text: "hello gateway",
			contextId: "thread-9",
			contentType: DEFAULT_CONTENT_TYPE,
			autoDepth: 2,
		});
		expect(sent.ok).toBe(true);
		const delivery = await waitFor(() => hook.received.find((r) => r.json.text === "hello gateway"));
		expect(verify(delivery, sub.secret)).toBe(true);
		expect(delivery.json).toMatchObject({
			event: "message",
			from: sender.npub,
			allowed: true,
			contextId: "thread-9",
			autoDepth: 2,
			replyAutoDepth: 3,
		});
	}, 30_000);

	it("keeps its subscriptions across a restart, and does not run a task again", async () => {
		const requester = await peer();
		let runs = 0;
		const hook = await webhook(() => {
			runs += 1;
			return { status: 200, body: { run: runs } };
		});
		await subscribe({ url: hook.url, events: ["task"], capabilities: ["invoice.restart"], allowedPeers: [requester.npub] });
		const first = requester.client.request(gateway.npub, "invoice.restart", {}, { timeoutMs: 20_000 });
		await expect(pumping(first, requester.client)).resolves.toEqual({ run: 1 });

		await gateway.close();
		gateway = await startGateway(gatewayOptions());
		// The same inbox, read again from the saved cursor: the first task is
		// in the poll window but already handled.
		await new Promise((r) => setTimeout(r, 1500));
		expect(runs).toBe(1);
		const second = requester.client.request(gateway.npub, "invoice.restart", {}, { timeoutMs: 20_000 });
		await expect(pumping(second, requester.client)).resolves.toEqual({ run: 2 });
	}, 45_000);
});
