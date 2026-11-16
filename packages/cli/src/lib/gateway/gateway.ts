import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgxClient,
	type AgxIncomingMessage,
	type AgxIncomingReceipt,
	type AgxLogger,
	AgxPublicError,
	AgxTaskDeclined,
	AutoReplyGuard,
	DEFAULT_CONTENT_TYPE,
	parseTaskEnvelope,
	type Task,
	TASK_CONTENT_TYPE,
} from "@nostr-agx/core";
import { toNpub } from "@nostr-agx/nostr";
import { effectiveProfile } from "../config.js";
import { loadIdentity } from "../identity.js";
import { createCollector } from "../inbox.js";
import { acquireLock } from "../lock.js";
import { profileDir } from "../paths.js";
import { toHexPubkey } from "../peer.js";
import { FileSeenStore, loadState, updateState } from "../state.js";
import { MessageStore } from "../store/message-store.js";
import { createTransport } from "../transport.js";
import { AGX_CLI_VERSION } from "../version.js";
import { DeliveryQueue, deliver } from "./delivery.js";
import { messageEvent, receiptEvent, taskEvent } from "./events.js";
import { ApiError, readJson, sendError, sendJson } from "./http.js";
import { parseIdempotencyKey, TaskOperationStore } from "./idempotency.js";
import { verifyGatewayKey } from "./keys.js";
import { type OperationDeps, parseTaskRequest, readCard, runTaskRequest, sendMessage } from "./operations.js";
import { Requester } from "./requester.js";
import { KeyedSlots } from "./slots.js";
import { TaskEventStreams } from "./task-events.js";
import { serveTaskEvents, TASK_STREAM_REVALIDATE_MS, TaskStreamSlots } from "./task-events-http.js";
import {
	assertWebhookHost,
	parseSubscriptionInput,
	SubscriptionError,
	SubscriptionStore,
	viewOf,
} from "./subscriptions.js";

/**
 * `agx gateway`: this profile's agent behind an HTTP API, for tools that can
 * make HTTP calls but cannot speak Nostr themselves — n8n Cloud's verified
 * nodes, Make, Zapier.
 *
 * Outbound, an API client requests tasks, sends messages and reads Agent Cards.
 * Inbound, it subscribes a webhook, and the gateway delivers what arrives for
 * this agent to it: messages and receipts in the background, and task requests
 * synchronously — the webhook's answer is the task's result.
 *
 * The gateway holds the profile's secret key and lock, as `agx serve` does,
 * and keeps the same durable state: the cursor, the replay store, and the
 * message store `agx inbox` reads.
 */

export interface GatewayOptions {
	profile: string;
	/** Interface to listen on. Default 127.0.0.1: put a TLS proxy in front. */
	host?: string;
	/** Port to listen on; 0 picks a free one. Default 8787. */
	port?: number;
	/** Inbox poll interval, ms. Default 3000. */
	pollIntervalMs?: number;
	logger?: AgxLogger;
	/** One line per thing the gateway did, for its console. */
	log?: (line: string) => void;
	/** For tests: waits before each retry of a background delivery. */
	deliveryRetryDelaysMs?: number[];
	/** Tasks one webhook runs at once; the rest wait their turn. Default 8. */
	maxTasksPerWebhook?: number;
	/** Tasks that wait for one webhook at once; past it, a task is answered
	 * that the workflow is busy. Default 24. */
	maxTasksWaitingPerWebhook?: number;
	/** Tasks the gateway runs or holds at once; past it, a task is answered
	 * that the gateway is busy. Default 64. */
	maxTasksInFlight?: number;
	/** For tests: API task requests waiting for results. Default 256. */
	maxTaskRequestsWaiting?: number;
	/** For tests: keyed task operations still running after callers disconnect. Default 256. */
	maxTaskOperationsInFlight?: number;
	/** For tests: background task operations running at once. Default 64. */
	maxBackgroundTasksInFlight?: number;
	/** SSE comment heartbeat interval. Default 15000. */
	taskSseHeartbeatMs?: number;
	/** For tests: how often an open SSE stream rechecks its task. Default 5000. */
	taskSseRevalidateMs?: number;
	/** For tests: open SSE task streams per API key. Default 64. */
	maxTaskStreamsPerCredential?: number;
	/** For tests: open SSE task streams across the gateway. Default 256. */
	maxTaskStreams?: number;
}

export interface RunningGateway {
	url: string;
	port: number;
	npub: string;
	/** Resolves once background deliveries are done (tests). */
	idle(): Promise<void>;
	close(): Promise<void>;
}

export const DEFAULT_GATEWAY_PORT = 8787;
/** How long the card waits for subscription changes to settle before it is
 * republished: over a second, so two cards never carry the same timestamp. */
const CARD_SETTLE_MS = 1_100;
/** How long before a card no relay accepted is published again. */
const CARD_RETRY_MS = 30_000;
/** Tasks the gateway runs or holds at once; past it, a task is refused as busy
 * instead of holding up the inbox. */
const MAX_TASKS_IN_FLIGHT = 64;
const DEFAULT_TASKS_PER_WEBHOOK = 8;
const DEFAULT_TASKS_WAITING_PER_WEBHOOK = 24;
/** /v1/health reports unhealthy once no poll has finished for this long, or
 * for ten poll intervals if that is longer. */
const HEALTH_STALE_MIN_MS = 60_000;
/** A relay silent this long is logged, and again every hour while it stays so. */
const RELAY_WARN_AFTER_MS = 10 * 60_000;
const RELAY_WARN_EVERY_MS = 60 * 60_000;
/** Messages the gateway keeps in the profile's history, newest first. */
const MAX_HISTORY_MESSAGES = 20_000;
/** Task requests through the API waiting for their results at once. */
const MAX_TASK_REQUESTS_WAITING = 256;
/** Open connections to the API at once. */
const MAX_CONNECTIONS = 1_024;
/** How long stopping waits for the poll, running tasks and the card. */
const SHUTDOWN_WAIT_MS = 8_000;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function bearer(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
	const name = options.profile;
	const log = options.log ?? (() => undefined);
	const profile = effectiveProfile(name);
	const identity = loadIdentity(name);
	const releaseLock = acquireLock(name);
	let closed = false;
	let stopGateway: (() => Promise<void>) | undefined;
	try {
		const state = loadState(name);
		const transport = await createTransport(profile, identity, options.logger);
		const seen = new FileSeenStore(name);
		// The newest messages only: the gateway runs for months.
		const store = new MessageStore(profileDir(name), undefined, { claimSpool: true, maxMessages: MAX_HISTORY_MESSAGES });
		const allowed = new Set<string>();
		const refreshAllowed = () => {
			try {
				const current = effectiveProfile(name).allow.map((entry) => toHexPubkey(entry, "allowlist entry"));
				allowed.clear();
				for (const entry of current) {
					allowed.add(entry);
				}
			} catch {
				// Keep the last good list; the next poll tries again.
			}
		};
		refreshAllowed();
		const collector = createCollector({
			store,
			allowed,
			onError: (error) =>
				log(`A message could not be stored and will be retried: ${error instanceof Error ? error.message : String(error)}`),
		});
		const subscriptions = new SubscriptionStore(name);
		const taskOperations = new TaskOperationStore(name, {
			log,
			maxInFlight: options.maxTaskOperationsInFlight ?? MAX_TASK_REQUESTS_WAITING,
			maxBackgroundInFlight: options.maxBackgroundTasksInFlight,
		});
		const taskEvents = new TaskEventStreams();
		const taskStreamSlots = new TaskStreamSlots({
			perCredential: options.maxTaskStreamsPerCredential,
			total: options.maxTaskStreams,
		});
		const queue = new DeliveryQueue({
			retryDelaysMs: options.deliveryRetryDelaysMs,
			onFailure: (subscription, eventId, detail) =>
				log(`DROP  delivery of ${eventId.slice(0, 8)} to ${subscription.id} failed: ${detail}`),
		});
		const requester = new Requester(transport, options.logger);
		const deps: OperationDeps = {
			npub: identity.npub,
			publicKey: identity.publicKey,
			relays: profile.relays,
			signer: identity.signer,
			transport,
			requester,
			guard: new AutoReplyGuard(),
			recordSent: (message) => {
				try {
					store.addOutbound(message);
				} catch (error) {
					log(`A sent message could not be recorded in the history: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		};

		// Tasks run side by side, each webhook in its own slots: a slow workflow
		// holds up neither the inbox nor the other webhooks. Both queues are
		// bounded and refuse what does not fit, so a pile-up never reaches the
		// limit `AgxClient` holds the inbox at.
		const webhookSlots = new KeyedSlots(options.maxTasksPerWebhook ?? DEFAULT_TASKS_PER_WEBHOOK);
		const maxWaitingPerWebhook = options.maxTasksWaitingPerWebhook ?? DEFAULT_TASKS_WAITING_PER_WEBHOOK;
		const maxInFlight = options.maxTasksInFlight ?? MAX_TASKS_IN_FLIGHT;
		let inFlight = 0;
		// When the current poll started: a task's age is measured from when it
		// was fetched, not from when its turn came.
		let polledAt = nowSec();

		const runTask = async (task: Task): Promise<unknown> => {
			if (inFlight >= maxInFlight) {
				log(`BUSY  ${task.capability} from ${toNpub(task.from)}: ${inFlight} tasks in flight`);
				throw new AgxPublicError("the gateway is busy");
			}
			inFlight++;
			try {
				return await deliverTask(task);
			} finally {
				inFlight--;
			}
		};

		const deliverTask = async (task: Task): Promise<unknown> => {
			const targets = subscriptions.forTask(task.capability, task.from, task.sentAt ?? polledAt, polledAt);
			if (targets.length === 0) {
				// The subscription went away between authorization and now.
				throw new AgxTaskDeclined("no webhook serves it any more");
			}
			// Recorded as handled, on disk, before any webhook sees it: a crash or
			// restart while the workflow runs then costs the requester its result
			// (its timeout covers that) instead of running the workflow twice.
			for (const id of [task.eventId, task.transportId]) {
				if (id) {
					seen.add(id);
				}
			}
			seen.flush();
			log(`TASK  ${task.capability} from ${toNpub(task.from)}`);
			for (const subscription of targets) {
				if (webhookSlots.waiting(subscription.id) >= maxWaitingPerWebhook) {
					log(`BUSY  ${task.capability} from ${toNpub(task.from)}: ${subscription.id} has a full queue`);
					throw new AgxPublicError("the workflow is busy");
				}
				const release = await webhookSlots.acquire(subscription.id);
				let outcome: Awaited<ReturnType<typeof deliver>>;
				try {
					if (closed) {
						throw new AgxPublicError("the gateway is stopping");
					}
					// It waited for the webhook to be free: past the age the webhook
					// accepts, the requester has almost certainly stopped waiting.
					const sentAt = task.sentAt ?? polledAt;
					if (subscription.maxTaskAgeSec > 0 && nowSec() - sentAt > subscription.maxTaskAgeSec) {
						log(`LATE  ${task.capability} from ${toNpub(task.from)}: ${subscription.id} was busy past the task's age limit`);
						throw new AgxPublicError("the workflow was busy for too long");
					}
					outcome = await deliver(
						subscription,
						taskEvent(task),
						task.eventId ?? task.taskId,
						subscription.resultTimeoutSec * 1000,
					);
				} finally {
					release();
				}
				if (outcome.kind === "timeout") {
					throw new AgxPublicError("the workflow did not finish in time");
				}
				if (outcome.kind === "oversized") {
					throw new AgxPublicError("result too large");
				}
				if (outcome.kind === "unreachable") {
					if (outcome.sent) {
						// The webhook may have the task and be running it: trying another
						// could run it twice.
						throw new Error(`the webhook connection failed: ${outcome.error}`);
					}
					// Down: an older subscription for the same capability may answer.
					log(`SKIP  ${subscription.id}: ${outcome.error}`);
					continue;
				}
				if (outcome.status === 404 || outcome.status === 410) {
					// Gone (a test webhook n8n dropped, say): an older one may answer.
					log(`SKIP  ${subscription.id}: HTTP ${outcome.status}`);
					continue;
				}
				if (outcome.status >= 200 && outcome.status < 300) {
					return outcome.body;
				}
				// n8n answers a failed execution with a bare 500; whatever went wrong
				// stays on this side, and the requester hears `handler failed`.
				throw new Error(`the webhook answered HTTP ${outcome.status}`);
			}
			throw new Error("no webhook for this capability could be reached");
		};

		const client = new AgxClient({
			transport,
			seen,
			logger: options.logger,
			identity: { org: profile.org ?? undefined, nip05: profile.nip05 },
			// First run: from now. The poll still reaches back the full lookback,
			// and what is too old for a webhook is filtered below.
			startCursor: state.cursor > 0 ? state.cursor : nowSec(),
			// Above the gateway's own limit: tasks it refuses as busy still take a
			// moment to answer, and must not hold up the inbox meanwhile.
			maxConcurrentTasks: maxInFlight * 2,
			// A task request every webhook serving it considers too old: dropped
			// before authorization, with no receipt and no reply.
			ignore: (event) => {
				if ("receipt" in event || event.contentType !== TASK_CONTENT_TYPE) {
					return false;
				}
				const env = parseTaskEnvelope(event.text);
				if (env?.t !== "req" || subscriptions.forTask(env.capability, event.from).length === 0) {
					return false;
				}
				const sentAt = event.sentAt ?? event.createdAt;
				if (subscriptions.forTask(env.capability, event.from, sentAt, polledAt).length > 0) {
					return false;
				}
				log(`OLD   ${env.capability} from ${toNpub(event.from)}: too old for every webhook serving it, ignored`);
				return true;
			},
			// Default-deny, per subscription: a task runs only for a webhook that
			// serves its capability and allows its sender.
			authorize: ({ from, capability }) => subscriptions.forTask(capability, from).length > 0,
			onMessage: (msg: AgxIncomingMessage) => {
				// Task traffic no webhook took — a denied or unserved request, a result
				// for the requesting client — is not a message for anyone.
				if (msg.contentType === TASK_CONTENT_TYPE) {
					return;
				}
				collector.onMessage(msg);
				for (const { subscription, allowed: ok } of subscriptions.forEvent("message", msg.from, msg.sentAt ?? msg.createdAt)) {
					queue.enqueue(subscription, messageEvent(msg, ok), msg.eventId);
				}
			},
			onReceipt: (receipt: AgxIncomingReceipt) => {
				collector.onReceipt(receipt);
				for (const { subscription, allowed: ok } of subscriptions.forEvent("receipt", receipt.from, receipt.sentAt ?? receipt.createdAt)) {
					queue.enqueue(subscription, receiptEvent(receipt, ok), receipt.eventId);
				}
			},
		});

		const registered = new Set<string>();
		const registerHandlers = () => {
			for (const capability of subscriptions.capabilities()) {
				if (!registered.has(capability)) {
					client.handle(capability, runTask);
					registered.add(capability);
				}
			}
		};
		registerHandlers();

		// The card lists what subscriptions that advertise serve, and is
		// republished when that changes: one publish at a time, once changes
		// settle. n8n replaces a subscription with a DELETE and a POST in quick
		// succession, and of two cards published in the same second a relay may
		// keep either.
		let advertised: string | null = null;
		let publishing: Promise<void> = Promise.resolve();
		let cardTimer: ReturnType<typeof setTimeout> | null = null;
		const publishCard = async () => {
			// Again until the card matches the subscriptions: they may have changed
			// while it was being published.
			while (!closed && transport.advertise) {
				const capabilities = subscriptions.advertised();
				const key = capabilities.join("\n");
				if (key === advertised || (advertised === null && capabilities.length === 0)) {
					return;
				}
				try {
					const { ok } = await transport.advertise(capabilities, {
						org: profile.org ?? undefined,
						nip05: profile.nip05,
						payloadTypes: [DEFAULT_CONTENT_TYPE, TASK_CONTENT_TYPE],
					});
					if (!ok) {
						throw new Error("no relay accepted it");
					}
					advertised = key;
					log(`CARD  advertised ${capabilities.length ? capabilities.join(", ") : "no capabilities"}`);
				} catch (error) {
					log(`CARD  could not be published, will retry: ${error instanceof Error ? error.message : String(error)}`);
					advertise(CARD_RETRY_MS);
					return;
				}
			}
		};
		const advertise = (delayMs = CARD_SETTLE_MS) => {
			if (cardTimer) {
				clearTimeout(cardTimer);
			}
			cardTimer = setTimeout(() => {
				cardTimer = null;
				publishing = publishing.then(publishCard);
			}, delayMs);
		};

		let cursor = state.cursor;
		const persist = () => {
			store.absorbSpool();
			store.flush();
			seen.flush();
			updateState(name, { cursor, lastPumpAt: new Date().toISOString() });
		};
		let wake: (() => void) | null = null;
		const interval = options.pollIntervalMs ?? 3000;
		// For /v1/health: when a poll last finished, and when every relay last
		// answered one. A poll that throws (a disk that cannot be written, say)
		// does not count.
		let lastPollAt: number | null = null;
		let lastCompletePollAt: number | null = null;
		// Since when some relay has not answered, and when that was last logged.
		let incompleteSince: number | null = null;
		let relayWarnedAt: number | null = null;
		const runPump = async () => {
			while (!closed) {
				try {
					refreshAllowed();
					store.absorbSpool();
					polledAt = nowSec();
					const result = await client.pump();
					if (result.complete) {
						cursor = result.cursor;
					}
					seen.holdFor(cursor);
					persist();
					lastPollAt = Date.now();
					if (result.complete) {
						if (relayWarnedAt !== null) {
							log("POLL  every relay answers again");
						}
						lastCompletePollAt = lastPollAt;
						incompleteSince = null;
						relayWarnedAt = null;
					} else {
						incompleteSince ??= lastPollAt;
						if (
							lastPollAt - incompleteSince >= RELAY_WARN_AFTER_MS &&
							(relayWarnedAt === null || lastPollAt - relayWarnedAt >= RELAY_WARN_EVERY_MS)
						) {
							log(
								`POLL  a relay has not answered since ${new Date(incompleteSince).toISOString()}: the inbox position stays where it was until every relay answers. Check the relays (AGX_RELAY, or agx config set relays).`,
							);
							relayWarnedAt = lastPollAt;
						}
					}
				} catch (error) {
					log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (!closed) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, interval);
						wake = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					wake = null;
				}
			}
		};

		let tasksWaiting = 0;
		const maxTaskRequestsWaiting = options.maxTaskRequestsWaiting ?? MAX_TASK_REQUESTS_WAITING;
		const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
			const url = new URL(req.url ?? "/", "http://gateway");
			const method = req.method ?? "GET";
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (method === "GET" && path === "/v1/health") {
				// 503 while no poll has finished lately (starting up, or wedged), for a
				// container health check or an uptime monitor. A relay that does not
				// answer only degrades it: the others still carry traffic.
				const staleAfterMs = Math.max(HEALTH_STALE_MIN_MS, 10 * interval);
				const recent = (at: number | null) => at !== null && Date.now() - at <= staleAfterMs;
				const ok = recent(lastPollAt);
				sendJson(res, ok ? 200 : 503, {
					ok,
					allRelaysAnswering: recent(lastCompletePollAt),
					lastPollAt: lastPollAt === null ? null : new Date(lastPollAt).toISOString(),
					version: AGX_CLI_VERSION,
				});
				return;
			}
			if (!path.startsWith("/v1/")) {
				throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
			}
			const keyId = verifyGatewayKey(name, bearer(req));
			if (keyId === null) {
				res.setHeader("www-authenticate", 'Bearer realm="agx-gateway"');
				throw new ApiError(401, "unauthorized", "A valid gateway API key is required", "Create one with `agx gateway key new`, and send it as `Authorization: Bearer <key>`.");
			}
			if (method === "GET" && path === "/v1/identity") {
				sendJson(res, 200, {
					npub: identity.npub,
					pubkey: identity.publicKey,
					relays: profile.relays,
					org: profile.org,
					nip05: profile.nip05,
					gatewayVersion: AGX_CLI_VERSION,
				});
				return;
			}
			const eventRoute = /^\/v1\/tasks\/([^/]+)\/events$/.exec(path);
			if (method === "GET" && eventRoute) {
				const credential = bearer(req);
				const taskId = decodeURIComponent(eventRoute[1]);
				serveTaskEvents(req, res, {
					id: taskId,
					credential,
					getView: () => taskOperations.get(credential, taskId),
					stillAuthorized: () => verifyGatewayKey(name, credential) !== null,
					streams: taskEvents,
					slots: taskStreamSlots,
					heartbeatMs: Math.max(10, options.taskSseHeartbeatMs ?? 15_000),
					revalidateMs: Math.max(10, options.taskSseRevalidateMs ?? TASK_STREAM_REVALIDATE_MS),
				});
				return;
			}
			const task = /^\/v1\/tasks\/([^/]+)$/.exec(path);
			if (method === "GET" && task) {
				const output = taskOperations.get(bearer(req), decodeURIComponent(task[1]));
				if (output === null) {
					throw new ApiError(404, "not_found", "No background task with that ID for this credential");
				}
				sendJson(res, 200, output);
				return;
			}
			if (method === "POST" && path === "/v1/tasks") {
				const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);
				// Each one holds a connection; synchronous requests also hold a result poll.
				if (tasksWaiting >= maxTaskRequestsWaiting) {
					throw new ApiError(
						503,
						"busy",
						`${maxTaskRequestsWaiting} task requests are already waiting for results`,
						"Try again shortly.",
					);
				}
				tasksWaiting += 1;
				let released = false;
				const releaseWaiting = () => {
					if (!released) {
						released = true;
						tasksWaiting -= 1;
					}
				};
				const gone = new AbortController();
				res.on("close", () => {
					if (!res.writableFinished) {
						// Only synchronous work without a key uses this abort signal. Every
						// disconnected caller stops consuming a waiting slot immediately.
						if (idempotencyKey === null) {
							gone.abort();
						}
						releaseWaiting();
					}
				});
				try {
					const body = await readJson(req);
					const taskRequest = parseTaskRequest(body);
					const operation = () => runTaskRequest(deps, taskRequest);
					if (taskRequest.background) {
						const pendingEvents = taskEvents.create();
						const backgroundOperation = () => runTaskRequest(
							deps,
							taskRequest,
							undefined,
							(update) => pendingEvents.push(update),
						);
						const submitted = taskOperations.submit(
							bearer(req),
							idempotencyKey,
							body,
							backgroundOperation,
							(publicId) => taskEvents.get(publicId)?.markTerminal(),
						);
						if (typeof submitted.id !== "string") {
							throw new Error("Background task store returned no public task ID");
						}
						taskEvents.ensure(submitted.id, pendingEvents);
						sendJson(res, 202, submitted);
						return;
					}
					const output = idempotencyKey === null
						? await runTaskRequest(deps, taskRequest, gone.signal)
						: await taskOperations.execute(bearer(req), idempotencyKey, body, operation);
					sendJson(res, 200, output);
				} finally {
					releaseWaiting();
				}
				return;
			}
			if (method === "POST" && path === "/v1/messages") {
				sendJson(res, 200, await sendMessage(deps, await readJson(req)));
				return;
			}
			const agent = /^\/v1\/agents\/([^/]+)$/.exec(path);
			if (method === "GET" && agent) {
				sendJson(res, 200, await readCard(deps, decodeURIComponent(agent[1]), url.searchParams));
				return;
			}
			if (path === "/v1/subscriptions") {
				if (method === "GET") {
					sendJson(res, 200, { subscriptions: subscriptions.list().map(viewOf) });
					return;
				}
				if (method === "POST") {
					let input: ReturnType<typeof parseSubscriptionInput>;
					try {
						input = parseSubscriptionInput(await readJson(req));
						await assertWebhookHost(input.url);
					} catch (error) {
						if (error instanceof SubscriptionError) {
							throw new ApiError(400, "invalid_subscription", error.message);
						}
						throw error;
					}
					const subscription = subscriptions.create(input);
					registerHandlers();
					advertise();
					log(`SUB   ${subscription.id} → ${subscription.url} (${subscription.events.join(", ")})`);
					// The secret is shown once, here: the webhook verifies deliveries with it.
					sendJson(res, 201, { ...viewOf(subscription), secret: subscription.secret });
					return;
				}
			}
			const one = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
			if (one) {
				const id = decodeURIComponent(one[1]);
				if (method === "GET") {
					const subscription = subscriptions.get(id);
					if (!subscription) {
						throw new ApiError(404, "not_found", `No subscription ${id}`);
					}
					sendJson(res, 200, viewOf(subscription));
					return;
				}
				if (method === "DELETE") {
					if (!subscriptions.delete(id)) {
						throw new ApiError(404, "not_found", `No subscription ${id}`);
					}
					advertise();
					log(`UNSUB ${id}`);
					res.writeHead(204);
					res.end();
					return;
				}
			}
			throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
		};

		const server: Server = createServer((req, res) => {
			route(req, res).catch((error: unknown) => {
				if (res.headersSent) {
					res.end();
					return;
				}
				if (error instanceof ApiError) {
					sendError(res, error);
					return;
				}
				log(`API error on ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
				sendError(res, new ApiError(500, "internal_error", "The gateway could not complete the request"));
			});
		});
		// The time to RECEIVE a request: a task request then waits for its
		// result, up to an hour, which this does not limit.
		server.requestTimeout = 120_000;
		server.headersTimeout = 60_000;
		server.maxConnections = MAX_CONNECTIONS;
		let pumpLoop: Promise<void> = Promise.resolve();
		stopGateway = async () => {
			closed = true;
			// Tasks waiting for a busy webhook are told the gateway is stopping.
			webhookSlots.close();
			if (cardTimer) {
				clearTimeout(cardTimer);
			}
			(wake as (() => void) | null)?.();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			try {
				taskOperations.close();
			} catch (error) {
				log(`task outcomes could not be saved: ${error instanceof Error ? error.message : String(error)}`);
			}
			requester.stop();
			// One budget for the whole stop, under the 10 s a container runtime
			// gives before it kills the process.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
			});
			await Promise.race([pumpLoop, deadline]);
			// On disk before waiting for running tasks: a kill from here on loses
			// nothing (a running task is already recorded as handled).
			try {
				persist();
			} catch (error) {
				log(`state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
			}
			await Promise.race([Promise.all([publishing, client.tasksSettled(), queue.idle()]), deadline]);
			clearTimeout(timer);
			if (queue.pending() > 0) {
				log(`DROP  ${queue.pending()} message and receipt deliveries not made before stopping (they are in agx inbox)`);
			}
			await client.stop().catch(() => undefined);
		};

		const host = options.host ?? "127.0.0.1";
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? DEFAULT_GATEWAY_PORT, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		// Inbound traffic only once the API is up: a gateway that cannot listen
		// delivers nothing.
		await client.start({
			pollIntervalMs: 0,
			advertise: false,
			liveDispatch: false,
		});
		// A card this profile published before (`agx serve --advertise`, say) may
		// list capabilities no webhook serves: start from it, so the first publish
		// replaces it. A profile that has no card gets none until a subscription
		// advertises: a card is public.
		try {
			const { card } = await transport.resolvePeer(identity.publicKey);
			if (card) {
				advertised = [...card.capabilities].sort().join("\n");
			}
		} catch {
			// Not known: the next change to the subscriptions publishes it anyway.
		}
		publishing = publishing.then(publishCard);
		await publishing;
		pumpLoop = runPump();

		const port = (server.address() as AddressInfo).port;
		const shownHost = host.includes(":") ? `[${host}]` : host;

		return {
			url: `http://${shownHost === "0.0.0.0" ? "127.0.0.1" : shownHost}:${port}`,
			port,
			npub: identity.npub,
			idle: () => queue.idle(),
			close: async () => {
				if (closed) {
					return;
				}
				await stopGateway?.();
				persist();
				releaseLock();
			},
		};
	} catch (error) {
		await stopGateway?.().catch(() => undefined);
		releaseLock();
		throw error;
	}
}
