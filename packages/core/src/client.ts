import {
	AGX_AGENT_CARD_LIMITS,
	agxEncodedJsonBytes,
	parseAgxAgentSkill,
} from "./agent-card";
import {
	AgxInvalidInputError,
	AgxPublicError,
	AgxTaskDeclined,
	AgxTaskFailedError,
} from "./errors";
import { randomId } from "./id";
import {
	agxWireJson,
	validateAgxJsonPayload,
	validateAgxJsonSchema,
} from "./json-schema";
import { type AgxLogger, noopLogger } from "./logger";
import { InMemorySeenStore, type SeenStore } from "./seen-store";
import {
	encodeTaskEnvelope,
	parseTaskEnvelope,
	type Task,
	type TaskCancelEnvelope,
	type TaskInputEnvelope,
	type TaskRequestEnvelope,
	type TaskResultEnvelope,
	type InputRequirement,
	type InputRequiredUpdate,
	type TaskStatusUpdate,
	type TaskWorkingUpdate,
} from "./task";
import type {
	AgxAgentSkill,
	AgxIncomingMessage,
	AgxIncomingReceipt,
	AgxPeerCard,
	AgxTransportListenerOptions,
	AgxTransport,
	Unsubscribe,
} from "./transport";
import {
	DEFAULT_CONTENT_TYPE,
	MAX_BODY,
	MAX_BODY_BYTES,
	TASK_CONTENT_TYPE,
} from "./wire";

/**
 * `AgxClient` makes an exchange correct + interoperable by default. A runtime only
 * registers capability handlers ({@link AgxClient.handle}); the client owns
 * dispatch → task lifecycle → result → receipt → correlation, plus replay
 * protection. The Nostr transport binding is `@nostr-agx/nostr`, but any `AgxTransport`
 * works.
 */

/** A capability handler. Returns the task result (→ `completed`); throwing →
 * `failed`, except {@link AgxTaskDeclined}, which sends nothing back. */
export type TaskHandler<Payload = unknown, Output = unknown> = (
	task: Task<Payload>,
	ctx: HandlerContext,
) => Output | Promise<Output>;

export type AgxTaskContract = Omit<AgxAgentSkill, "id">;

const taskContractFields = new Set([
	"description",
	"tags",
	"inputModes",
	"outputModes",
	"inputSchema",
	"outputSchema",
	"features",
]);

interface RegisteredTaskHandler {
	handler: TaskHandler;
	contract?: AgxTaskContract;
}

export type HandlerContext = {
	/** The peer that sent the task request. */
	from: string;
	/** The capability requested. */
	capability: string;
	/** The AGX event ID of the request message. */
	eventId: string;
	/** Ask the task requester for input and resume when it replies. */
	requestInput(requirement: InputRequirement): Promise<unknown>;
	/** Publish a best-effort public `working` update (at most 2000 characters; never
	 * raw reasoning or internal error detail). Sends nothing unless the request
	 * opted in with `supportsWorking`, nothing from the moment an input request
	 * starts sending until the handler resumes with the answer, and nothing once the task has finished or been canceled. A
	 * failed or oversized publish is logged and dropped; it never fails the task. */
	report(message?: string): Promise<void>;
};

/** Context for the trust/authorization hook, evaluated before a task runs. */
export interface AgxAuthorizeContext {
	from: string;
	capability: string;
	/** The request's replay key, as {@link Task.eventId} — for a host that keeps
	 * its own record of handled tasks and can turn one down before its receipt. */
	eventId?: string;
	/** The transport envelope's id, when it differs from `eventId`. */
	transportId?: string;
}

export type AgxAuthorize = (
	ctx: AgxAuthorizeContext,
) => boolean | Promise<boolean>;

export interface AgxClientOptions {
	transport: AgxTransport;
	/** Replay-protection store (default in-memory, bounded). */
	seen?: SeenStore;
	/** Trust hook: return true to let an inbound task run, false to drop it (silently,
	 * with no reply). A registered capability handler is executable by ANY peer that
	 * can reach this agent, so authorization is DEFAULT-DENY: omitting this hook drops
	 * every task request (and logs a one-time warning). Pass an `authorize` function
	 * to gate per `{ from, capability }`, or the explicit sentinel `"accept-all"` to
	 * accept every peer deliberately. */
	authorize?: AgxAuthorize | "accept-all";
	logger?: AgxLogger;
	/** Discovery metadata advertised on `start()`. */
	identity?: { org?: string; nip05?: string | null };
	/** Handler for inbound plain (non-task) messages. */
	onMessage?: (msg: AgxIncomingMessage) => void | Promise<void>;
	/** Handler for inbound delivery receipts (a peer acking one of OUR outbound
	 * messages). Dispatched at-most-once per receipt via the SeenStore; throwing
	 * holds the cursor for a retry next poll. */
	onReceipt?: (receipt: AgxIncomingReceipt) => void | Promise<void>;
	/** Host filter, consulted before anything else is done with an inbound event:
	 * one it returns true for is recorded as seen and never dispatched — no
	 * authorization, no receipt, no handler, no `onMessage`/`onReceipt`. For
	 * events the host has decided never to act on, such as ones dated before it
	 * started listening. Tell a receipt from a message by its `receipt` field. */
	ignore?: (event: AgxIncomingMessage | AgxIncomingReceipt) => boolean;
	/** Default `request()` timeout in ms (default 30000; 0 disables). */
	requestTimeoutMs?: number;
	/** Poll-overlap in seconds (replay-safe redelivery of late events; default 120). */
	pollOverlapSec?: number;
	/** Initial cursor (unix seconds). Default 0 (drain everything). */
	startCursor?: number;
	/** Max failed dispatch attempts for one inbound event before it is DEAD-LETTERED
	 * (marked seen + logged at error) instead of holding the cursor indefinitely.
	 * Requires a {@link SeenStore} that implements `recordFailure`; with the default
	 * in-memory store it also bounds retries within a process. Default 10; 0 disables
	 * (unbounded at-least-once retries). Prevents a poison event from stalling the
	 * inbox and letting a held cursor outrun the SeenStore retention window. */
	maxDispatchAttempts?: number;
	/** Task handlers that may run at once. With the default, 1, `pump()` waits for
	 * a handler to finish unless it requests input; an input-waiting handler
	 * releases its task slot so another task can run while the continuation is
	 * outstanding.
	 * Above 1, handlers start in free slots and run independently; when all slots
	 * are busy, dispatch waits for a slot before marking the task handled. A task
	 * request is marked handled once its handler starts, so a restart while it runs
	 * does not run it again, and its requester's timeout covers a result it never
	 * gets. */
	maxConcurrentTasks?: number;
	/** Maximum concurrent input requirements retained in memory (default 32). */
	maxPendingTaskInputs?: number;
	/** Maximum duration of one input requirement (default 5 minutes). A task's
	 * overall request timeout, when nonzero, may impose a shorter deadline. */
	maxInputTimeoutMs?: number;
}

interface Pending {
	resolve: (output: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	/** The peer this request was sent to (canonicalized). A result is settled only
	 * if its sender matches — correlation by `taskId` alone is forgeable, since the
	 * responder legitimately knows the `taskId`. */
	peer: string;
	onTaskStatus?: (update: TaskStatusUpdate) => void | Promise<void>;
	lastStatusSeq: number;
	published?: boolean;
	cancelRequested?: boolean;
	onUpdate?: (update: TaskResultEnvelope) => void;
	onError?: (error: Error) => void;
}

interface PendingTaskInput {
	taskId: string;
	inputRequestId: string;
	peer: string;
	resolve: (input: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface SendRequestOptions {
	timeoutMs?: number;
	taskId?: string;
	supportsInput?: boolean;
	supportsWorking?: boolean;
	onTaskStatus?: (update: TaskStatusUpdate) => void | Promise<void>;
	onUpdate?: (update: TaskResultEnvelope) => void;
	onError?: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_WORKING_MESSAGE_CHARS = 2000;
const DEFAULT_MAX_PENDING_TASK_INPUTS = 32;
const DEFAULT_MAX_INPUT_TIMEOUT_MS = 5 * 60_000;
const MAX_QUEUED_TASK_RUNS = 100;
const INPUT_UNSUPPORTED_ERROR =
	"AGX task requires input; this request does not support interactive input";
const INPUT_CANCELLED_ERROR = "AGX task was canceled by its requester";
const STREAM_HANDLE_UPDATE = Symbol("stream update");
const STREAM_HANDLE_ERROR = Symbol("stream error");

class AgxTaskQueueFull extends Error {}

class AgxTaskCanceled extends Error {
	constructor() {
		super(INPUT_CANCELLED_ERROR);
	}
}
/** Default {@link AgxClientOptions.pollOverlapSec}. Exported for hosts that keep
 * their own replay records and must know how far back a poll reaches. */
export const DEFAULT_POLL_OVERLAP_SEC = 120;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Default cap on failed dispatch attempts before an event is dead-lettered. */
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 10;
/** Reject events dated further than this ahead of now — `createdAt` is
 * sender-declared, and a future-dated event must never advance the cursor (that
 * would freeze the inbox forever). Mirrors the host ingest guard. Exported, like
 * {@link DEFAULT_POLL_OVERLAP_SEC}, for hosts that keep their own replay records:
 * an event dispatched at time `t` is dated no later than `t` plus this. */
export const MAX_FUTURE_SKEW_SEC = 300;

/** The longest `error` a result may carry: the limit in `taskResultSchema`
 * (task.ts). A requester drops a result whose `error` is longer, so the task
 * would only end at its timeout. */
const MAX_RESULT_ERROR = 2000;

/** Cut a public error message to {@link MAX_RESULT_ERROR} UTF-16 units. If the
 * cut would split a surrogate pair (an emoji, say), keep one unit fewer so the
 * cut never separates the two halves of a pair. */
function fitPublicMessage(message: string): string {
	if (message.length <= MAX_RESULT_ERROR) {
		return message;
	}
	const last = message.charCodeAt(MAX_RESULT_ERROR - 1);
	const splitsPair = last >= 0xd800 && last <= 0xdbff;
	return message.slice(0, splitsPair ? MAX_RESULT_ERROR - 1 : MAX_RESULT_ERROR);
}

interface TransportLifecycle {
	clients: Set<object>;
	started: boolean;
	queue: Promise<void>;
}

const transportLifecycles = new WeakMap<AgxTransport, TransportLifecycle>();

async function retainTransport(
	transport: AgxTransport,
	client: object,
): Promise<void> {
	let lifecycle = transportLifecycles.get(transport);
	if (!lifecycle) {
		lifecycle = { clients: new Set(), started: false, queue: Promise.resolve() };
		transportLifecycles.set(transport, lifecycle);
	}
	lifecycle.clients.add(client);
	const operation = lifecycle.queue.then(async () => {
		if (!lifecycle.started) {
			await transport.start?.();
			lifecycle.started = true;
		}
	});
	lifecycle.queue = operation.catch(() => undefined);
	try {
		await operation;
	} catch (error) {
		lifecycle.clients.delete(client);
		if (lifecycle.clients.size === 0 && !lifecycle.started) {
			transportLifecycles.delete(transport);
		}
		throw error;
	}
}

async function releaseTransport(
	transport: AgxTransport,
	client: object,
): Promise<void> {
	const lifecycle = transportLifecycles.get(transport);
	if (!lifecycle || !lifecycle.clients.delete(client)) {
		return;
	}
	const operation = lifecycle.queue.then(async () => {
		if (lifecycle.clients.size > 0) {
			return;
		}
		if (lifecycle.started) {
			await transport.stop?.();
			lifecycle.started = false;
		}
		if (
			lifecycle.clients.size === 0 &&
			transportLifecycles.get(transport) === lifecycle
		) {
			transportLifecycles.delete(transport);
		}
	});
	lifecycle.queue = operation.catch(() => undefined);
	await operation;
}

export class AgxClient {
	private readonly transport: AgxTransport;
	private readonly seen: SeenStore;
	private readonly authorize?: AgxAuthorize | "accept-all";
	private readonly log: AgxLogger;
	/** One-time guard for the no-authorization warning (default-deny in effect). */
	private warnedNoAuth = false;
	private readonly identity?: { org?: string; nip05?: string | null };
	private readonly onMessage?: (
		msg: AgxIncomingMessage,
	) => void | Promise<void>;
	private readonly onReceipt?: (
		receipt: AgxIncomingReceipt,
	) => void | Promise<void>;
	private readonly ignore?: (
		event: AgxIncomingMessage | AgxIncomingReceipt,
	) => boolean;
	private readonly requestTimeoutMs: number;
	private readonly pollOverlapSec: number;
	private readonly maxDispatchAttempts: number;
	private readonly maxConcurrentTasks: number;
	private readonly maxPendingTaskInputs: number;
	private readonly maxInputTimeoutMs: number;
	/** Active and queued task handler runs. */
	private readonly runningTasks = new Set<Promise<void>>();
	private readonly queuedTaskRuns: Array<{
		start: () => void;
		cancel: () => void;
	}> = [];
	private activeTaskCount = 0;
	private readonly receiptListeners = new Set<
		(receipt: AgxIncomingReceipt) => void
	>();
	private readonly handlers = new Map<string, RegisteredTaskHandler>();
	private readonly pending = new Map<string, Pending>();
	private readonly pendingTaskInputs = new Map<string, PendingTaskInput>();
	private readonly activeInboundTasks = new Map<string, { canceled: boolean }>();
	private readonly cancellationSends = new Set<Promise<void>>();
	private cursor: number;
	private pollTimer?: ReturnType<typeof setTimeout>;
	private transportRetained = false;
	private stopping = false;
	private started = false;
	private startPromise?: Promise<void>;
	private listenerUnsubscribers: Unsubscribe[] = [];
	/** True while a pump() is in flight — prevents overlapping pumps from
	 * double-running a handler (the seen-add happens only after dispatch). */
	private pumping = false;
	/** Shared by live subscriptions and poll() so they cannot dispatch one event
	 * twice while either path is still processing it. */
	private readonly activeDispatches = new Map<string, Promise<boolean>>();
	/** True while the self-rescheduling poll loop should keep running. */
	private running = false;

	constructor(opts: AgxClientOptions) {
		this.transport = opts.transport;
		this.seen = opts.seen ?? new InMemorySeenStore();
		this.authorize = opts.authorize;
		this.log = opts.logger ?? noopLogger;
		this.identity = opts.identity;
		this.onMessage = opts.onMessage;
		this.onReceipt = opts.onReceipt;
		this.ignore = opts.ignore;
		this.requestTimeoutMs =
			opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.pollOverlapSec = opts.pollOverlapSec ?? DEFAULT_POLL_OVERLAP_SEC;
		this.maxDispatchAttempts =
			opts.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
		const concurrent = Math.floor(opts.maxConcurrentTasks ?? 1);
		this.maxConcurrentTasks =
			Number.isFinite(concurrent) && concurrent > 1 ? concurrent : 1;
		const maxPendingInputs = Math.floor(
			opts.maxPendingTaskInputs ?? DEFAULT_MAX_PENDING_TASK_INPUTS,
		);
		this.maxPendingTaskInputs =
			Number.isFinite(maxPendingInputs) && maxPendingInputs > 0
				? maxPendingInputs
				: DEFAULT_MAX_PENDING_TASK_INPUTS;
		const maxInputTimeout = Math.floor(
			opts.maxInputTimeoutMs ?? DEFAULT_MAX_INPUT_TIMEOUT_MS,
		);
		this.maxInputTimeoutMs =
			Number.isFinite(maxInputTimeout) && maxInputTimeout > 0
				? maxInputTimeout
				: DEFAULT_MAX_INPUT_TIMEOUT_MS;
		this.cursor = opts.startCursor ?? 0;
	}

	/** This agent's identity (from the transport). */
	whoami(): string {
		return this.transport.whoami();
	}

	/** Canonicalize a peer identity via the transport (e.g. npub → hex), so
	 * result-sender binding compares equal regardless of the caller's encoding.
	 * Bindings that need no canonicalization leave identities untouched. */
	private normalizeId(id: string): string {
		return this.transport.normalizeIdentity?.(id) ?? id;
	}

	/** True if `text` survives transmission intact — under the char cap the wire
	 * slices at, and under the byte cap the encrypted transport allows. The BYTE
	 * cap is a transport property (what NIP-44 encrypts is the serialized payload,
	 * where `text` sits JSON-escaped and can be 2–6x larger), so defer to the
	 * transport's own verdict when it exposes one; otherwise fall back to a
	 * conservative built-in ceiling. */
	private fitsWire(text: string): boolean {
		if (text.length > MAX_BODY) {
			return false;
		}
		if (this.transport.canCarry) {
			return this.transport.canCarry(text);
		}
		return new TextEncoder().encode(text).length <= MAX_BODY_BYTES;
	}

	/** Register a capability handler and, optionally, its public typed contract.
	 * The contract must pass the same rules the Agent Card applies to a typed
	 * skill, so a contract accepted here can always be published. The client
	 * keeps its own copy: changing `contract` afterwards has no effect. */
	handle<Payload = unknown, Output = unknown>(
		capability: string,
		handler: TaskHandler<Payload, Output>,
		contract?: AgxTaskContract,
	): this {
		let registered: AgxTaskContract | undefined;
		if (contract) {
			// Stricter than a card reader, which ignores unknown fields: here an
			// unknown field is most likely a typo such as `inputschema`.
			const unknownField = Object.keys(contract).find(
				(field) => !taskContractFields.has(field),
			);
			if (unknownField !== undefined) {
				throw new Error(
					`AGX handler ${capability} contract: unknown field ${unknownField.slice(0, 120)}`,
				);
			}
			const parsed = parseAgxAgentSkill({ ...contract, id: capability });
			if ("problem" in parsed) {
				throw new Error(
					`AGX handler ${capability} contract: ${parsed.problem}`,
				);
			}
			// The card carries every typed skill, so check the set this one
			// would join (replacing any earlier contract for the capability).
			const skills = [
				...this.typedSkills().filter((skill) => skill.id !== capability),
				parsed.skill,
			];
			if (skills.length > AGX_AGENT_CARD_LIMITS.skills) {
				throw new Error(
					`AGX handler ${capability} contract: more than ${AGX_AGENT_CARD_LIMITS.skills} typed skills`,
				);
			}
			const bytes = agxEncodedJsonBytes({ skills });
			if (bytes === null || bytes > AGX_AGENT_CARD_LIMITS.metadataBytes) {
				throw new Error(
					`AGX handler ${capability} contract: typed skills would exceed ${AGX_AGENT_CARD_LIMITS.metadataBytes} bytes as encoded in the Agent Card event`,
				);
			}
			const { id: _id, ...copy } = parsed.skill;
			registered = copy;
		}
		this.handlers.set(capability, {
			handler: handler as TaskHandler,
			contract: registered,
		});
		return this;
	}

	/** The capabilities this agent handles. */
	capabilities(): string[] {
		return [...this.handlers.keys()];
	}

	private typedSkills(): AgxAgentSkill[] {
		return [...this.handlers].flatMap(([id, registered]) => {
			if (!registered.contract) {
				return [];
			}
			// Features are the contract author's to declare; add none here.
			return [{ ...registered.contract, id }];
		});
	}

	/** Check the payload against the peer's typed skill before anything is
	 * published or registered, throwing {@link AgxInvalidInputError} on a
	 * failure. It checks only when the peer's card has a valid input schema
	 * for exactly this capability; with no card, no such skill or schema, an
	 * invalid schema, or a failed lookup, the payload is sent unchecked.
	 * Callers await this only when `validate` is set, so a plain request still
	 * publishes in the same tick. The peer lookup runs before the request's
	 * `timeoutMs` deadline starts, so that deadline does not cover it. */
	private async preflightInput(
		peer: string,
		capability: string,
		payload: unknown,
	): Promise<unknown> {
		let card: AgxPeerCard | null;
		try {
			card = (await this.transport.resolvePeer(peer)).card;
		} catch (error) {
			this.log.debug?.("AGX: peer card lookup failed; sending unchecked", {
				peer,
				capability,
				error: String(error),
			});
			return payload;
		}
		const schema = card?.skills?.find(
			(candidate) => candidate.id === capability,
		)?.inputSchema;
		// A transport need not run the card reader's checks, so make sure the
		// schema is one this client can apply before trusting its verdict.
		if (!schema || validateAgxJsonSchema(schema)) return payload;
		const wire = agxWireJson(payload);
		if (!wire.ok) {
			throw new AgxInvalidInputError(`$: ${wire.problem}`);
		}
		const problem = validateAgxJsonPayload(schema, wire.value);
		if (problem) {
			throw new AgxInvalidInputError(problem);
		}
		// Send the value that was checked, so a toJSON that answers differently
		// on a second call cannot put something else on the wire.
		return wire.value;
	}

	/** Send a task to a peer and await its correlated result. Rejects on a `failed`
	 * result, an unsupported capability, timeout, or opted-in schema preflight. */
	async request<Output = unknown>(
		peer: string,
		capability: string,
		payload: unknown,
		opts?: {
			timeoutMs?: number;
			validate?: boolean;
			/** Receives the responder's `working` updates, in `seq` order. It is
			 * called without being awaited and never delays dispatch; a thrown
			 * error or rejected promise is logged. */
			onTaskStatus?: (update: TaskStatusUpdate) => void | Promise<void>;
		},
	): Promise<Output> {
		const sent = opts?.validate
			? await this.preflightInput(peer, capability, payload)
			: payload;
		const { result } = await this.sendRequest<Output>(
			peer,
			capability,
			sent,
			{
				...opts,
				supportsInput: false,
				// Ask for working updates only when the caller can receive them.
				supportsWorking: typeof opts?.onTaskStatus === "function",
			},
		);
		return result;
	}

	/** Send a task to a peer and await its correlated result. Rejects on a `failed`
	 * result, an unsupported capability, timeout, or opted-in schema preflight. */
	async streamRequest<Output = unknown>(
		peer: string,
		capability: string,
		payload: unknown,
		opts?: { timeoutMs?: number; validate?: boolean },
	): Promise<StreamResponse<Output>> {
		const sent = opts?.validate
			? await this.preflightInput(peer, capability, payload)
			: payload;
		const taskId = randomId();
		let resolveResult!: (output: Output) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<Output>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		result.catch(() => undefined);
		const stream = new StreamResponse<Output>(
			taskId,
			result,
			(listener) => {
				this.receiptListeners.add(listener);
				return () => this.receiptListeners.delete(listener);
			},
			(inputRequestId, input) =>
				this.sendTaskInput(peer, taskId, inputRequestId, input),
			this.log,
		);
		try {
			const { result } = await this.sendRequest<Output>(peer, capability, sent, {
				...opts,
				taskId,
				supportsInput: true,
				supportsWorking: true,
				onUpdate: (update) => stream[STREAM_HANDLE_UPDATE](update),
				onError: (error) => stream[STREAM_HANDLE_ERROR](error),
			});
			void result.then(resolveResult, rejectResult);
		} catch (error) {
			const requestError =
				error instanceof Error ? error : new Error(String(error));
			stream[STREAM_HANDLE_ERROR](requestError);
			rejectResult(requestError);
			throw error;
		}

		return stream;
	}

	private async sendRequest<Output = unknown>(
		peer: string,
		capability: string,
		payload: unknown,
		opts?: SendRequestOptions,
	): Promise<{ taskId: string; result: Promise<Output> }> {
		const taskId = opts?.taskId ?? randomId();
		const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
		const envelope: TaskRequestEnvelope = {
			t: "req",
			taskId,
			capability,
			payload,
			supportsInput: opts?.supportsInput === true,
			// Omitted unless true, so a request that does not opt in is byte-for-byte
			// what a requester that predates `working` sends.
			...(opts?.supportsWorking === true ? { supportsWorking: true } : {}),
			timeoutMs: timeoutMs > 0 ? timeoutMs : 0,
		};
		const text = encodeTaskEnvelope(envelope);
		// Fail fast (before registering the pending) rather than silently truncate
		// the envelope into unparseable JSON — which the peer drops, leaving the
		// caller to hit a generic timeout for what is really a caller error.
		if (!this.fitsWire(text)) {
			throw new Error(
				`AGX request: encoded payload exceeds the transport size limit (over ${MAX_BODY} chars, or too large once serialized + encrypted)`,
			);
		}
		// Register the pending entry SYNCHRONOUSLY (before the await), so a stop()
		// or a publish failure while the send is in flight still settles the caller
		// instead of leaving it hanging.
		let pending!: Pending;
		const result = new Promise<Output>((resolve, reject) => {
			pending = {
				resolve: resolve as (o: unknown) => void,
				reject,
				peer: this.normalizeId(peer),
				onTaskStatus: opts?.onTaskStatus,
				lastStatusSeq: 0,
				onUpdate: opts?.onUpdate,
				onError: opts?.onError,
			};
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (this.pending.get(taskId) !== pending) return;
					this.pending.delete(taskId);
					const error = new Error(
						`AGX request timed out after ${timeoutMs}ms`,
					);
					pending.reject(error);
					pending.onError?.(error);
					pending.cancelRequested = true;
					if (pending.published) {
						void this.sendTaskCancel(pending.peer, taskId);
					}
				}, timeoutMs);
			}
			this.pending.set(taskId, pending);
		});
		// The timeout or a stop() can settle it while the publish below is still
		// in flight, before the caller holds it: handled here, it is not an
		// unhandled rejection (which would end the process). The caller still
		// gets the rejection from `return result`.
		result.catch(() => undefined);

		const sent = await this.transport
			.publishMessage(peer, {
				text,
				contextId: taskId,
				contentType: TASK_CONTENT_TYPE,
			})
			.catch(() => ({ ok: false, eventId: "", contextId: taskId }));
		if (!sent.ok) {
			this.settlePending(
				taskId,
				new Error(`AGX request: publish failed to ${peer}`),
			);
		} else {
			pending.published = true;
			if (pending.cancelRequested) {
				void this.sendTaskCancel(pending.peer, taskId);
			}
		}

		return { taskId, result };
	}

	/** One poll → dispatch cycle. Drains inbound messages, dispatches task requests
	 * to handlers, resolves pending requests on results, and dedupes via the
	 * SeenStore. The cursor advances only when the poll was complete (so an
	 * incomplete source can't skip unseen events). Serverless hosts call this on
	 * their own schedule; `start()` calls it on an interval. */
	async pump(): Promise<{
		cursor: number;
		dispatched: number;
		complete: boolean;
	}> {
		// Re-entrancy guard: overlapping pumps would both see `has(id) === false`
		// (add happens only after dispatch) and double-run the same handler. A
		// concurrent pump is a no-op — reported as incomplete so a host driving
		// cursor persistence off `complete` never advances on a skipped pump.
		if (this.pumping) {
			return { cursor: this.cursor, dispatched: 0, complete: false };
		}
		this.pumping = true;
		try {
			return await this.pumpOnce();
		} finally {
			this.pumping = false;
		}
	}

	/** Handle a failed dispatch. Records the attempt and decides retry vs give-up.
	 * Returns `true` when the event was DEAD-LETTERED (attempt cap hit): it has been
	 * marked seen, and the caller must advance past it so one poison event can't hold
	 * the cursor — and thus the SeenStore retention window — hostage forever. Returns
	 * `false` to hold the cursor and retry next poll (at-least-once). */
	private async onDispatchFailure(
		kind: "message" | "receipt",
		eventId: string,
		from: string,
		err: unknown,
	): Promise<boolean> {
		const attempts = this.seen.recordFailure
			? await this.seen.recordFailure(eventId)
			: 0;
		if (
			this.maxDispatchAttempts > 0 &&
			attempts >= this.maxDispatchAttempts
		) {
			this.log.error?.(
				"AGX: dead-lettering event after repeated dispatch failures",
				{ kind, eventId, from, attempts, error: String(err) },
			);
			await this.seen.add(eventId);
			return true;
		}
		this.log.error?.(`AGX: ${kind} dispatch failed; will retry`, {
			eventId,
			from,
			attempts,
			error: String(err),
		});
		return false;
	}

	private async markSeen(event: {
		eventId: string;
		transportId?: string;
	}): Promise<void> {
		const ids =
			event.transportId && event.transportId !== event.eventId
				? [event.eventId, event.transportId]
				: [event.eventId];
		if (this.seen.addMany) {
			await this.seen.addMany(ids);
			return;
		}
		for (const id of ids) {
			await this.seen.add(id);
		}
	}

	/** Dispatch an event through whichever receive path got it first. */
	private async dispatchOnce(
		event: { eventId: string; transportId?: string },
		dispatch: () => void | Promise<void>,
	): Promise<boolean> {
		const active = this.activeDispatches.get(event.eventId);
		if (active) {
			await active;
			return false;
		}

		const operation = (async () => {
			if (await this.seen.has(event.eventId)) {
				if (event.transportId && event.transportId !== event.eventId) {
					await this.seen.add(event.transportId);
				}
				return false;
			}
			await dispatch();
			await this.markSeen(event);
			return true;
		})();
		this.activeDispatches.set(event.eventId, operation);
		try {
			return await operation;
		} finally {
			if (this.activeDispatches.get(event.eventId) === operation) {
				this.activeDispatches.delete(event.eventId);
			}
		}
	}

	private async pumpOnce(): Promise<{
		cursor: number;
		dispatched: number;
		complete: boolean;
	}> {
		// One clock read for the whole pump, taken BEFORE the poll: it is both the
		// skew ceiling and, on a complete pump, the new cursor.
		const nowSec = Math.floor(Date.now() / 1000);
		const skewCeiling = nowSec + MAX_FUTURE_SKEW_SEC;
		// Look back the overlap (late-arriving events) PLUS however far the
		// transport may backdate a timestamp — otherwise a NIP-59 wrap stamped
		// two days ago, but sent after our last poll, sits below `since` forever.
		// The SeenStore makes the re-scanned window a no-op, which is why its
		// retention must exceed this total (measured from when an event was
		// processed — see the cursor advance at the end).
		const lookback =
			this.pollOverlapSec + (this.transport.pollLookbackSec ?? 0);
		const since = this.cursor > lookback ? this.cursor - lookback : 0;
		const res = await this.transport.poll({
			since,
			// Lets the binding skip envelopes we already handled BEFORE opening
			// them — the re-scanned window (overlap + lookback) is mostly those.
			isKnown: async (ids) =>
				this.seen.hasMany
					? await this.seen.hasMany(ids)
					: new Set(
						(
							await Promise.all(
								ids.map(async (id) =>
									(await this.seen.has(id)) ? id : null,
								),
							)
						).filter((id): id is string => id !== null),
					),
		});
		// One batched write when the store can take it (`addMany`), per-id `add`
		// otherwise.
		const addAll = async (ids: string[]): Promise<void> => {
			if (ids.length === 0) {
				return;
			}
			if (this.seen.addMany) {
				await this.seen.addMany(ids);
				return;
			}
			for (const id of ids) {
				await this.seen.add(id);
			}
		};
		// Record envelopes the binding could not open or trust, so they are
		// skipped via isKnown from now on instead of being re-opened every poll.
		// In ONE write: how many there are is decided by whoever addresses junk
		// to us, and one round-trip each would let that flood stall the pump
		// before any real message is dispatched.
		await addAll(res.discarded ?? []);
		// Prefetch the whole batch's seen-set in one round-trip when the store
		// supports it — a busy team can carry hundreds of events per poll, and a
		// serial `has()` per event would be that many sequential DB round-trips.
		// The snapshot is read ONCE and does not see adds made during this pump,
		// and an id is not guaranteed to appear once: message identity is the
		// rumor id, so a sender that re-wraps a message (a retry) can put the same
		// id in one batch twice. `attempted` below is what covers that.
		const prefetchedSeen = this.seen.hasMany
			? await this.seen.hasMany([
				...res.messages.map((m) => m.eventId),
				...res.receipts.map((r) => r.eventId),
			])
			: null;
		const alreadySeen = async (id: string): Promise<boolean> =>
			prefetchedSeen ? prefetchedSeen.has(id) : await this.seen.has(id);
		// Every event id this pump already tried, and how it ended: "done"
		// (processed or dead-lettered, so marked seen) or "pending" (failed; will
		// be retried next poll). A second copy of either is not dispatched again
		// in this pump — a "done" one just has its envelope recorded, and a
		// "pending" one is left for the retry, so a failure is not counted twice.
		const attempted = new Map<string, "done" | "pending">();
		/** Handle an event already attempted this pump or seen before. Returns
		 * true when the caller should skip it. */
		const skipDuplicate = async (event: {
			eventId: string;
			transportId?: string;
		}): Promise<boolean> => {
			const prior = attempted.get(event.eventId);
			if (prior === "pending") {
				return true;
			}
			if (prior === "done" || (await alreadySeen(event.eventId))) {
				// Same event, another envelope (a re-wrapped retry): remember the
				// envelope, so it is not re-opened next poll. Only the envelope —
				// the event id is already recorded, and writing it again is a
				// wasted store round-trip per duplicate.
				if (event.transportId && event.transportId !== event.eventId) {
					await addAll([event.transportId]);
				}
				return true;
			}
			return false;
		};
		let dispatched = 0;
		let anyFailed = false;
		for (const msg of res.messages) {
			// `createdAt` is sender-declared: a future-dated event is skipped
			// entirely without touching seen (the "seen only after dispatch"
			// invariant is preserved); it is re-polled once it is no longer ahead.
			if (msg.createdAt > skewCeiling) {
				continue;
			}
			if (await skipDuplicate(msg)) {
				continue;
			}
			let ignored = false;
			let processed: boolean;
			try {
				// Inside the try: a host filter that throws is a failed dispatch
				// (retried, then dead-lettered), not a pump that rejects at the same
				// event on every poll.
				processed = await this.dispatchOnce(msg, async () => {
					ignored = this.ignore?.(msg) === true;
					if (!ignored) {
						await this.dispatchMessage(msg);
					}
				});
			} catch (err) {
				if (err instanceof AgxTaskQueueFull) {
					attempted.set(msg.eventId, "pending");
					anyFailed = true;
					break;
				}
				// A transient host error (e.g. a throwing onMessage) must not lose the
				// message or block the rest of the batch: leave it UNSEEN, hold the
				// cursor, and retry next poll (at-least-once) — UNLESS it has failed
				// enough times to look poison, in which case dead-letter it (marked
				// seen + logged) and let the cursor advance past it.
				const deadLettered = await this.onDispatchFailure(
					"message",
					msg.eventId,
					msg.from,
					err,
				);
				if (deadLettered) {
					// Its envelope too, or the next poll re-opens it just to skip it.
					await this.markSeen(msg);
					attempted.set(msg.eventId, "done");
				} else {
					attempted.set(msg.eventId, "pending");
					anyFailed = true;
				}
				continue;
			}
			attempted.set(msg.eventId, "done");
			if (processed && !ignored) {
				dispatched += 1;
			}
		}
		// Receipts (a peer acking OUR outbound) share the same replay + cursor loop
		// as messages, so a receipt-only poll window still advances the cursor and a
		// redelivered receipt is dispatched at-most-once.
		for (const receipt of res.receipts) {
			if (receipt.createdAt > skewCeiling) {
				continue;
			}
			if (await skipDuplicate(receipt)) {
				continue;
			}
			try {
				await this.dispatchOnce(receipt, async () => {
					if (this.ignore?.(receipt) !== true) {
						await this.dispatchReceipt(receipt);
					}
				});
			} catch (err) {
				const deadLettered = await this.onDispatchFailure(
					"receipt",
					receipt.eventId,
					receipt.from,
					err,
				);
				if (deadLettered) {
					// Its envelope too, or the next poll re-opens it just to skip it.
					await this.markSeen(receipt);
					attempted.set(receipt.eventId, "done");
				} else {
					attempted.set(receipt.eventId, "pending");
					anyFailed = true;
				}
				continue;
			}
			attempted.set(receipt.eventId, "done");
		}
		// Advance the cursor only when the poll was complete AND nothing failed —
		// otherwise a held cursor + overlap re-polls the unseen/failed events.
		//
		// It advances to OUR clock at poll time, not to the newest event's
		// `createdAt`. A complete poll saw everything the relays held with
		// `created_at >= since`; anything published after `nowSec` carries
		// `created_at >= nowSec - pollLookbackSec`, which the next `since`
		// (`cursor - overlap - lookback`) still reaches, and relay propagation lag
		// is what the overlap covers. An event-time watermark was wrong on two
		// counts: a backdating transport (NIP-59) stamps events up to two days
		// early, so the cursor trailed real time by that much and the re-scanned
		// window grew to twice the backdate; and on a quiet inbox it never moved,
		// so its last event stayed in the window until the relay expired it —
		// outliving any SeenStore retention and re-delivering on every poll.
		const complete = res.complete && !anyFailed;
		if (complete && nowSec > this.cursor) {
			this.cursor = nowSec;
		}
		return { cursor: this.cursor, dispatched, complete };
	}

	/** Advertise capabilities (if the transport supports discovery) and begin
	 * polling on an interval. Serverless hosts should skip the interval
	 * (`pollIntervalMs: 0`) and drive `pump()` from their own scheduler.
	 * Hosts that drive `pump()` themselves can disable
	 * the interval and live dispatch while retaining advertising. */
	async start(opts?: {
		pollIntervalMs?: number;
		advertise?: boolean;
		/** Set false when the host drives `pump()` and does not want live delivery.
		 * Defaults to true. */
		liveDispatch?: boolean;
	}): Promise<void> {
		if (this.started) {
			return;
		}
		if (this.startPromise) {
			await this.startPromise;
			return;
		}

		this.stopping = false;
		const startPromise = this.startClient(opts);
		this.startPromise = startPromise;
		try {
			await startPromise;
			this.started = true;
		} catch (error) {
			this.unsubscribeTransportListeners();
			if (this.transportRetained) {
				this.transportRetained = false;
				await releaseTransport(this.transport, this);
			}
			throw error;
		} finally {
			if (this.startPromise === startPromise) {
				this.startPromise = undefined;
			}
		}
	}

	private async startClient(opts?: {
		pollIntervalMs?: number;
		advertise?: boolean;
		liveDispatch?: boolean;
	}): Promise<void> {
		if (opts?.liveDispatch !== false) {
			await this.startMessageListener();
			await retainTransport(this.transport, this);
			this.transportRetained = true;
		}
		if (opts?.advertise !== false && this.transport.advertise) {
			const skills = this.typedSkills();
			await this.transport
				.advertise(this.capabilities(), {
					org: this.identity?.org,
					nip05: this.identity?.nip05,
					payloadTypes: [DEFAULT_CONTENT_TYPE, TASK_CONTENT_TYPE],
					...(skills.length > 0 ? { skills } : {}),
				})
				.catch((e) =>
					this.log.warn?.("AGX: advertise failed", {
						error: String(e),
					}),
				);
		}
		const interval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		if (interval > 0) {
			this.running = true;
			this.scheduleNextPump(interval);
		}
	}

	/** Self-rescheduling poll loop: the next pump is scheduled only AFTER the
	 * current one settles, so a slow relay can never cause overlapping pumps (unlike
	 * a fixed setInterval). */
	private scheduleNextPump(interval: number): void {
		this.pollTimer = setTimeout(async () => {
			try {
				await this.pump();
			} catch (e) {
				this.log.error?.("AGX: pump failed", { error: String(e) });
			}
			if (this.running) {
				this.scheduleNextPump(interval);
			}
		}, interval);
	}

	/** Stop polling and this client's live listener. In-flight `request()` callers
	 * are rejected (their result can no longer arrive) rather than left hanging. */
	async stop(): Promise<void> {
		this.running = false;
		this.stopping = true;
		for (const queued of this.queuedTaskRuns.splice(0)) {
			queued.cancel();
		}
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		const startPromise = this.startPromise;
		if (startPromise) {
			try {
				await startPromise;
			} catch {
				// start() reports its own failure; still release its resources here.
			}
		}
		this.running = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.started = false;
		this.unsubscribeTransportListeners();
		this.receiptListeners.clear();
		for (const [taskId, p] of this.pending) {
			if (p.timer) {
				clearTimeout(p.timer);
			}
			const error = new Error("AGX client stopped");
			p.reject(error);
			p.onError?.(error);
			p.cancelRequested = true;
			if (p.published) {
				void this.sendTaskCancel(p.peer, taskId);
			}
		}
		this.pending.clear();
		for (const p of this.pendingTaskInputs.values()) {
			if (p.timer) {
				clearTimeout(p.timer);
			}
			p.reject(new Error("AGX client stopped"));
		}
		this.pendingTaskInputs.clear();
		while (this.cancellationSends.size > 0) {
			await Promise.all([...this.cancellationSends]);
		}
		if (this.transportRetained) {
			this.transportRetained = false;
			await releaseTransport(this.transport, this);
		}
	}

	private async dispatchMessage(msg: AgxIncomingMessage): Promise<void> {
		if (msg.contentType === TASK_CONTENT_TYPE) {
			// `contentType` is peer-supplied, so a task label can't be trusted to mean
			// "this is task traffic for me". Consume it as a task ONLY when we can
			// actually service it: a request for a capability WE registered, a result
			// or update correlated to a pending request of OURS, or an input
			// correlated to a handler waiting for it. Anything else — an unknown
			// capability, an unmatched/late result or update, a malformed envelope — is
			// deliberately NOT auto-replied to (a reply would let any peer coax a
			// signed event out of this identity) and NOT silently dropped; it falls
			// through to `onMessage` so the host's own trust flow triages it exactly
			// like a plain message. This is what keeps a task-labelled message from
			// bypassing a host that gates all inbound traffic in `onMessage`.
			const env = parseTaskEnvelope(msg.text);
			if (env?.t === "req" && this.handlers.has(env.capability)) {
				await this.handleTaskRequest(msg, env);
				return;
			}
			if (env?.t === "res" && this.pending.has(env.taskId)) {
				await this.resolvePending(msg, env);
				return;
			}
			if (env?.t === "input") {
				const key = this.taskInputKey(env.taskId, env.inputRequestId);
				if (this.pendingTaskInputs.has(key)) {
					this.resolveTaskInput(msg, env);
					return;
				}
			}
			if (env?.t === "cancel") {
				this.cancelInboundTask(msg, env);
				return;
			}
			if (!env) {
				const pending = this.pending.get(msg.contextId);
				if (pending && this.normalizeId(msg.from) === pending.peer) {
					pending.onError?.(new Error("TaskNotFoundError"));
				}
			}
			// fall through: not a task we service → treat as a plain message.
		}
		await this.onMessage?.(msg);
	}

	private async dispatchReceipt(receipt: AgxIncomingReceipt): Promise<void> {
		this.receiptListeners.forEach((listener) => listener(receipt));
		await this.onReceipt?.(receipt);
	}

	private async dispatchLiveEvent(
		kind: "message" | "receipt",
		event: AgxIncomingMessage | AgxIncomingReceipt,
	): Promise<void> {
		if (event.createdAt > Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SEC) {
			return;
		}
		try {
			await this.dispatchOnce(event, async () => {
				if (this.ignore?.(event) === true) {
					return;
				}
				if ("receipt" in event) {
					await this.dispatchReceipt(event);
				} else {
					await this.dispatchMessage(event);
				}
			});
		} catch (err) {
			this.log.error?.(`AGX: live ${kind} dispatch failed; poll will retry`, {
				eventId: event.eventId,
				from: event.from,
				error: String(err),
			});
		}
	}

	private async handleTaskRequest(
		msg: AgxIncomingMessage,
		env: TaskRequestEnvelope,
	): Promise<void> {
		let denied = false;
		if (typeof this.authorize === "function") {
			denied = !(await this.authorize({
				from: msg.from,
				capability: env.capability,
				eventId: msg.eventId,
				transportId: msg.transportId,
			}));
			if (denied) {
				this.log.info?.("AGX: task rejected by authorize", {
					from: msg.from,
					capability: env.capability,
				});
			}
		} else if (this.authorize !== "accept-all") {
			// DEFAULT-DENY (fail closed): a registered capability is executable by any
			// peer that can reach us, so opening it must be a deliberate opt-in — pass
			// an `authorize` function, or `authorize: "accept-all"`. Warn once so the
			// misconfiguration is visible rather than silently swallowing traffic.
			denied = true;
			if (!this.warnedNoAuth) {
				this.warnedNoAuth = true;
				this.log.warn?.(
					'AGX: task requests are DENIED — no `authorize` hook configured. Pass an authorize function, or `authorize: "accept-all"` to accept every peer.',
				);
			}
			this.log.info?.("AGX: task denied (no authorize configured)", {
				from: msg.from,
				capability: env.capability,
			});
		}
		if (denied) {
			// A denied task is NOT silently swallowed and is NOT auto-replied to: fall
			// through to onMessage so a host that gates all inbound traffic there (peer
			// registration, audit trail, counters) still sees it.
			// Consistent with how an unserviceable task falls through in dispatchMessage.
			await this.onMessage?.(msg);
			return;
		}
		const registered = this.handlers.get(env.capability);
		if (!registered) {
			// Unreachable — dispatchMessage only routes here when a handler exists.
			// Guard defensively and, crucially, do NOT auto-reply.
			return;
		}
		// Refuse a reused active task id before validating its payload, so a
		// duplicate never answers for (or terminates) the task already running.
		const peer = this.normalizeId(msg.from);
		const activeTaskKey = this.activeInboundTaskKey(peer, env.taskId);
		if (this.activeInboundTasks.has(activeTaskKey)) {
			this.log.warn?.("AGX: duplicate active task ID; dropping", {
				taskId: env.taskId,
				from: msg.from,
			});
			return;
		}
		if (registered.contract?.inputSchema) {
			const problem = validateAgxJsonPayload(
				registered.contract.inputSchema,
				env.payload,
			);
			if (problem) {
				this.log.info?.("AGX: task input failed schema validation", {
					taskId: env.taskId,
					capability: env.capability,
					from: msg.from,
					error: problem,
				});
				await this.sendResult(msg.from, env.taskId, {
					status: "failed",
					error: "invalid_input",
				});
				return;
			}
		}
		this.activeInboundTasks.set(activeTaskKey, {
			canceled: false,
		});
		// Best-effort delivery receipt (the task was accepted for processing).
		await this.transport
			.publishReceipt(msg.from, {
				refEventId: msg.eventId,
				contextId: msg.contextId,
				status: "delivered",
			})
			.catch(() => undefined);

		const task: Task = {
			taskId: env.taskId,
			capability: env.capability,
			payload: env.payload,
			from: msg.from,
			contextId: msg.contextId,
			eventId: msg.eventId,
			transportId: msg.transportId,
			sentAt: msg.sentAt,
		};
		try {
			const scheduled = this.scheduleTask(
				(onInputRequired, releaseSlot, acquireSlot) =>
					this.runTask(
						msg,
						env,
						registered,
						task,
						onInputRequired,
						releaseSlot,
						acquireSlot,
					),
				env.taskId,
			);
			if (!(await scheduled.started)) {
				throw new Error("AGX client stopped before the task handler started");
			}
			if (this.maxConcurrentTasks === 1) {
				await Promise.race([scheduled.completion, scheduled.inputRequired]);
			}
		} catch (error) {
			this.activeInboundTasks.delete(activeTaskKey);
			throw error;
		}
	}

	/** Resolves once no task handler is running outside `pump()`. */
	async tasksSettled(): Promise<void> {
		while (this.runningTasks.size > 0) {
			await Promise.allSettled([...this.runningTasks]);
		}
	}

	private scheduleTask(
		run: (
			onInputRequired: () => void,
			releaseSlot: () => void,
			acquireSlot: () => Promise<void>,
		) => Promise<void>,
		taskId: string,
	): {
		completion: Promise<void>;
		inputRequired: Promise<void>;
		started: Promise<boolean>;
	} {
		let resolveCompletion!: () => void;
		let resolveInputRequired!: () => void;
		let resolveStarted!: (started: boolean) => void;
		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		const inputRequired = new Promise<void>((resolve) => {
			resolveInputRequired = resolve;
		});
		const started = new Promise<boolean>((resolve) => {
			resolveStarted = resolve;
		});
		const scheduled = { completion, inputRequired, started };
		this.runningTasks.add(completion);

		let holdingSlot = false;
		const releaseSlot = () => {
			if (!holdingSlot) return;
			holdingSlot = false;
			this.activeTaskCount -= 1;
			this.queuedTaskRuns.shift()?.start();
		};
		const acquireSlot = (): Promise<void> => {
			if (this.stopping) {
				// NOT AgxTaskCanceled: that error suppresses the task's result
				// (runTask treats it as a requester cancel). A stop that breaks a
				// mid-task slot wait must FAIL the task — a published `failed`
				// result — or the requester is left to time out in the dark.
				return Promise.reject(
					new Error("AGX client stopped while waiting for a task slot"),
				);
			}
			if (holdingSlot) return Promise.resolve();
			if (this.activeTaskCount < this.maxConcurrentTasks) {
				holdingSlot = true;
				this.activeTaskCount += 1;
				return Promise.resolve();
			}
			return new Promise<void>((resolve, reject) => {
				if (this.queuedTaskRuns.length >= MAX_QUEUED_TASK_RUNS) {
					reject(new AgxTaskQueueFull("AGX task queue is full"));
					return;
				}
				this.queuedTaskRuns.push({
					start: () => {
						holdingSlot = true;
						this.activeTaskCount += 1;
						resolve();
					},
					// Same rule as the check above: a stop that breaks this wait
					// fails the task with a result, never silently.
					cancel: () =>
						reject(
							new Error("AGX client stopped while waiting for a task slot"),
						),
				});
			});
		};
		const start = () => {
			resolveStarted(true);
			holdingSlot = true;
			this.activeTaskCount += 1;
			void run(() => {
				releaseSlot();
				resolveInputRequired();
			}, releaseSlot, acquireSlot)
				.catch((err) =>
					this.log.error?.("AGX: task failed outside its handler", {
						taskId,
						error: String(err),
					}),
				)
				.finally(() => {
					releaseSlot();
					this.runningTasks.delete(completion);
					resolveCompletion();
				});
		};
		const cancel = () => {
			resolveStarted(false);
			this.runningTasks.delete(completion);
			resolveCompletion();
		};

		if (this.stopping) {
			cancel();
		} else if (this.activeTaskCount < this.maxConcurrentTasks) {
			start();
		} else {
			if (this.queuedTaskRuns.length >= MAX_QUEUED_TASK_RUNS) {
				this.runningTasks.delete(completion);
				resolveCompletion();
				throw new AgxTaskQueueFull("AGX task queue is full");
			}
			this.queuedTaskRuns.push({ start, cancel });
		}
		return scheduled;
	}

	/** Run a task's handler and send its result. */
	private async runTask(
		msg: AgxIncomingMessage,
		env: TaskRequestEnvelope,
		registered: RegisteredTaskHandler,
		task: Task,
		onInputRequired: () => void,
		releaseSlot: () => void,
		acquireSlot: () => Promise<void>,
	): Promise<void> {
		const active = this.activeInboundTasks.get(
			this.activeInboundTaskKey(this.normalizeId(msg.from), env.taskId),
		);
		const deadline =
			env.timeoutMs && env.timeoutMs > 0
				? Date.now() + env.timeoutMs
				: undefined;
		let waitingForInput = false;
		let statusSeq = 0;
		// `working` stops the moment the handler returns or throws; publishes
		// already started are awaited before any terminal result is sent, so no
		// update ever follows it on the wire.
		let reportsClosed = false;
		let reportsInFlight: Promise<void> = Promise.resolve();
		const closeReports = () => {
			reportsClosed = true;
			return reportsInFlight;
		};
		try {
			if (active?.canceled) return;
			const output = await registered.handler(task, {
				from: msg.from,
				capability: env.capability,
				eventId: msg.eventId,
				report: async (message) => {
					// A requester that did not opt in may predate `working` and would
					// misread it, so send nothing at all.
					if (env.supportsWorking !== true) return;
					// Only while the handler runs: not after a cancel, not once it has
					// returned or thrown.
					if (reportsClosed || active?.canceled) {
						return;
					}
					// Nothing while an input request is outstanding, from the moment it
					// starts sending until the answer arrives. Dropped, not queued, and
					// it uses no seq number.
					if (waitingForInput) return;
					statusSeq += 1;
					const sending = this.sendTaskStatus(msg.from, env.taskId, statusSeq, message);
					reportsInFlight = Promise.all([
						reportsInFlight,
						sending.catch(() => undefined),
					]).then(() => undefined);
					await sending;
				},
				requestInput: async (requirement) => {
					if (env.supportsInput !== true) {
						throw new AgxPublicError(INPUT_UNSUPPORTED_ERROR);
					}
					if (active?.canceled) {
						throw new AgxTaskCanceled();
					}
					if (waitingForInput) {
						throw new AgxPublicError(
							"Only one input requirement may be pending per task",
						);
					}
					waitingForInput = true;
					const inputRequestId = randomId();
					if (this.pendingTaskInputs.size >= this.maxPendingTaskInputs) {
						waitingForInput = false;
						throw new AgxPublicError(
							"Agent has reached its limit for pending input requirements",
						);
					}
					const remainingTaskMs =
						deadline === undefined ? undefined : deadline - Date.now();
					if (remainingTaskMs !== undefined && remainingTaskMs <= 0) {
						waitingForInput = false;
						throw new Error("AGX task timed out while waiting for input");
					}
					const requestedTimeout =
						requirement.timeoutMs && requirement.timeoutMs > 0
							? requirement.timeoutMs
							: this.requestTimeoutMs > 0
								? this.requestTimeoutMs
								: this.maxInputTimeoutMs;
					const timeoutMs = Math.max(
						1,
						Math.min(
							requestedTimeout,
							this.maxInputTimeoutMs,
							remainingTaskMs ?? Number.POSITIVE_INFINITY,
						),
					);
					const inputPromise = this.waitForTaskInput(
						env.taskId,
						inputRequestId,
						msg.from,
						timeoutMs,
					);
					releaseSlot();
					const effectiveRequirement = {
						...requirement,
						timeoutMs,
					};
					// A `working` publish still in flight must land first, or a requester
					// would see `working` after `input-required`.
					await reportsInFlight;
					// A requirement that cannot be encoded fails like one that could
					// not be published, so the wait below ends and resets the state.
					const sent = await this.sendResult(msg.from, env.taskId, {
						status: "input-required",
						inputRequestId,
						requirement: effectiveRequirement,
					}).catch((error) => {
						this.log.error?.("AGX: failed to encode the input requirement", {
							taskId: env.taskId,
							error: String(error),
						});
						return false;
					});
					if (!sent) {
						this.rejectTaskInput(
							env.taskId,
							inputRequestId,
							new Error("AGX failed to send the input requirement"),
						);
					}
					onInputRequired();
					try {
						const input = await inputPromise;
						await acquireSlot();
						if (active?.canceled) {
							throw new AgxTaskCanceled();
						}
						return input;
					} finally {
						waitingForInput = false;
					}
				},
			});
			await closeReports();
			if (active?.canceled) return;
			let resultOutput: unknown = output;
			if (registered.contract?.outputSchema) {
				const wire = agxWireJson(output);
				const problem = wire.ok
					? validateAgxJsonPayload(
							registered.contract.outputSchema,
							wire.value,
						)
					: `$: ${wire.problem}`;
				if (!wire.ok || problem) {
					this.log.warn?.("AGX: task output failed schema validation", {
						taskId: env.taskId,
						capability: env.capability,
						error: problem,
					});
					await this.sendResult(msg.from, env.taskId, {
						status: "failed",
						error: "invalid_output",
					});
					return;
				}
				// Send the value that was checked, not a second encoding of it.
				resultOutput = wire.value;
			}
			await this.sendResult(msg.from, env.taskId, {
				status: "completed",
				output: resultOutput,
			});
		} catch (err) {
			await closeReports();
			if (err instanceof AgxTaskCanceled || active?.canceled) {
				return;
			}
			if (err instanceof AgxTaskDeclined) {
				// The host left this task to something else that will answer it: no
				// result from here, and the pump records it as handled.
				this.log.debug?.("AGX: task declined by its handler", {
					taskId: env.taskId,
					capability: env.capability,
					reason: err.message,
				});
				return;
			}
			// Don't leak internal error detail across the trust boundary: a handler
			// error is arbitrary code that may carry hostnames / table names / creds.
			// Only an explicitly-public AgxPublicError message is forwarded; anything
			// else is reported generically and logged locally.
			const isPublic = err instanceof AgxPublicError;
			if (!isPublic) {
				this.log.error?.("AGX: task handler threw", {
					taskId: env.taskId,
					capability: env.capability,
					from: msg.from,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			await this.sendResult(msg.from, env.taskId, {
				status: "failed",
				error: isPublic
					? fitPublicMessage((err as AgxPublicError).message)
					: "handler failed",
			});
		} finally {
			this.activeInboundTasks.delete(
				this.activeInboundTaskKey(this.normalizeId(msg.from), env.taskId),
			);
		}
	}

	/** Best-effort `working` update: an oversized or unpublishable update is logged
	 * and dropped, never turned into a failed task. */
	private async sendTaskStatus(
		to: string,
		taskId: string,
		seq: number,
		message?: string,
	): Promise<void> {
		const env: TaskResultEnvelope = {
			t: "res",
			taskId,
			status: "working",
			seq,
			...(message === undefined ? {} : { message }),
		};
		const text = encodeTaskEnvelope(env);
		if ((message?.length ?? 0) > MAX_WORKING_MESSAGE_CHARS || !this.fitsWire(text)) {
			this.log.warn?.("AGX: task status too large; dropping update", {
				taskId,
				seq,
			});
			return;
		}
		await this.transport
			.publishMessage(to, {
				text,
				contextId: taskId,
				contentType: TASK_CONTENT_TYPE,
			})
			.catch((error) =>
				this.log.warn?.("AGX: failed to publish task status", {
					taskId,
					seq,
					error: String(error),
				}),
			);
	}

	private async sendResult(
		to: string,
		taskId: string,
		result: {
			status: "input-required";
			inputRequestId: string;
			requirement: InputRequirement;
		} | {
			status: "completed";
			output?: unknown;
		} | {
			status: "failed";
			error?: string;
		},
	): Promise<boolean> {
		let env: TaskResultEnvelope = {
			t: "res",
			taskId,
			...result,
		};
		let text = encodeTaskEnvelope(env);
		// Never truncate an envelope. Terminal results fall back to a compact
		// failure; an oversized input requirement is reported to the waiting handler.
		if (!this.fitsWire(text)) {
			this.log.warn?.("AGX: task result exceeds the transport size limit", {
				taskId,
			});
			if (result.status === "input-required") {
				return false;
			}
			env = {
				t: "res",
				taskId,
				status: "failed",
				error: "result too large",
			};
			text = encodeTaskEnvelope(env);
		}
		const sent = await this.transport
			.publishMessage(to, {
				text,
				contextId: taskId,
				contentType: TASK_CONTENT_TYPE,
			})
			.catch((e) => {
				this.log.error?.("AGX: failed to publish task result", {
					taskId,
					error: String(e),
				});
				return { ok: false };
			});
		return sent.ok;
	}

	private async resolvePending(
		msg: AgxIncomingMessage,
		env: TaskResultEnvelope,
	): Promise<void> {
		const p = this.pending.get(env.taskId);
		if (!p) {
			return; // unknown or already-settled result
		}
		// Bind the result to the peer the request was sent to. A result whose sender
		// is not that peer is a forgery/misroute (the responder legitimately knows
		// the taskId and could hand it to a third party) — drop it and LEAVE the
		// pending open so the real peer's result, or the timeout, still settles it.
		if (this.normalizeId(msg.from) !== p.peer) {
			this.log.warn?.("AGX: task result from unexpected peer; dropping", {
				taskId: env.taskId,
				from: msg.from,
				expected: p.peer,
			});
			return;
		}

		if (msg.contextId !== env.taskId) {
			this.log.warn?.("AGX: task result context mismatch; dropping", {
				taskId: env.taskId,
				contextId: msg.contextId,
			});
			return;
		}

		if (env.status === "working") {
			// Non-terminal progress: never settles the request, never touches its
			// timer, and cannot cancel it (unlike input-required, which a plain
			// request() cannot answer).
			this.receiveWorkingUpdate(p, env);
			return;
		}

		p.onUpdate?.(env);
		if (env.status === "input-required") {
			if (!p.onUpdate) {
				await this.sendTaskCancel(p.peer, env.taskId);
				this.settlePending(env.taskId, new Error(INPUT_UNSUPPORTED_ERROR));
				return;
			}
			return; // don't delete or settle the task
		}

		this.pending.delete(env.taskId);
		if (p.timer) {
			clearTimeout(p.timer);
		}
		if (env.status === "completed") {
			p.resolve(env.output);
		} else {
			p.reject(new AgxTaskFailedError(env.error ?? "task failed"));
		}
	}

	private receiveWorkingUpdate(p: Pending, env: TaskWorkingUpdate): void {
		if (env.seq <= p.lastStatusSeq) {
			this.log.debug?.("AGX: dropping duplicate or older task status", {
				taskId: env.taskId,
				seq: env.seq,
				lastStatusSeq: p.lastStatusSeq,
			});
			return;
		}
		// Record the sequence number first so a failing listener cannot make the
		// same update replay, and never lets the listener break the inbox.
		p.lastStatusSeq = env.seq;
		p.onUpdate?.(env);
		const failed = (error: unknown) =>
			this.log.error?.("AGX: task status listener failed", {
				taskId: env.taskId,
				seq: env.seq,
				error: String(error),
			});
		// Called in seq order but never awaited, so a slow listener cannot hold
		// up dispatch of this or any other request's messages.
		try {
			const settled = p.onTaskStatus?.({
				taskId: env.taskId,
				status: env.status,
				seq: env.seq,
				...(env.message === undefined ? {} : { message: env.message }),
			});
			if (settled && typeof settled.then === "function") {
				settled.then(undefined, failed);
			}
		} catch (error) {
			failed(error);
		}
	}

	private waitForTaskInput(
		taskId: string,
		inputRequestId: string,
		peer: string,
		timeoutMs: number,
	): Promise<unknown> {
		const key = this.taskInputKey(taskId, inputRequestId);
		if (this.pendingTaskInputs.has(key)) {
			throw new Error("AGX input request is already pending");
		}
		let pending!: PendingTaskInput;
		const answer = new Promise<unknown>((resolve, reject) => {
			pending = {
				taskId,
				inputRequestId,
				peer: this.normalizeId(peer),
				resolve,
				reject,
			};
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (this.pendingTaskInputs.get(key) !== pending) return;
					this.pendingTaskInputs.delete(key);
					pending.reject(
						new Error(`AGX input request timed out after ${timeoutMs}ms`),
					);
				}, timeoutMs);
			}
			this.pendingTaskInputs.set(key, pending);
		});
		answer.catch(() => undefined);
		return answer;
	}

	private taskInputKey(taskId: string, inputRequestId: string): string {
		return JSON.stringify([taskId, inputRequestId]);
	}

	private activeInboundTaskKey(peer: string, taskId: string): string {
		return JSON.stringify([peer, taskId]);
	}

	private resolveTaskInput(
		msg: AgxIncomingMessage,
		env: TaskInputEnvelope,
	): void {
		const key = this.taskInputKey(env.taskId, env.inputRequestId);
		const pending = this.pendingTaskInputs.get(key);
		if (!pending) return;
		if (msg.contextId !== env.taskId) {
			this.log.warn?.("AGX: task input context mismatch; dropping", {
				taskId: env.taskId,
				contextId: msg.contextId,
			});
			return;
		}
		if (this.normalizeId(msg.from) !== pending.peer) {
			this.log.warn?.("AGX: task input from unexpected peer; dropping", {
				taskId: env.taskId,
				inputRequestId: env.inputRequestId,
				from: msg.from,
			});
			return;
		}
		this.pendingTaskInputs.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(env.input);
	}

	private cancelInboundTask(
		msg: AgxIncomingMessage,
		env: TaskCancelEnvelope,
	): void {
		const peer = this.normalizeId(msg.from);
		const active = this.activeInboundTasks.get(
			this.activeInboundTaskKey(peer, env.taskId),
		);
		if (!active) {
			// Expected in the common timeout race: the task already completed
			// (its entry was cleaned up) or never started here. Ignore it —
			// consumed, never replied to, never surfaced as a plain message.
			this.log.debug?.(
				"AGX: cancellation for unknown or finished task; ignoring",
				{ taskId: env.taskId, from: msg.from },
			);
			return;
		}
		if (msg.contextId !== env.taskId) {
			this.log.warn?.("AGX: task cancellation context mismatch; dropping", {
				taskId: env.taskId,
				from: msg.from,
			});
			return;
		}
		active.canceled = true;
		for (const pending of this.pendingTaskInputs.values()) {
			if (pending.taskId === env.taskId && pending.peer === peer) {
				this.rejectTaskInput(
					env.taskId,
					pending.inputRequestId,
					new AgxTaskCanceled(),
				);
			}
		}
	}

	private sendTaskCancel(to: string, taskId: string): Promise<void> {
		const env: TaskCancelEnvelope = { t: "cancel", taskId };
		const text = encodeTaskEnvelope(env);
		const operation = (async () => {
			try {
				const sent = await this.transport.publishMessage(to, {
					text,
					contextId: taskId,
					contentType: TASK_CONTENT_TYPE,
				});
				if (!sent.ok) {
					this.log.warn?.("AGX: task cancellation could not be sent", { taskId });
				}
			} catch (error) {
				this.log.warn?.("AGX: task cancellation could not be sent", {
					taskId,
					error: String(error),
				});
			}
		})();
		this.cancellationSends.add(operation);
		void operation.finally(() => this.cancellationSends.delete(operation));
		return operation;
	}

	private rejectTaskInput(
		taskId: string,
		inputRequestId: string,
		error: Error,
	): void {
		const key = this.taskInputKey(taskId, inputRequestId);
		const pending = this.pendingTaskInputs.get(key);
		if (!pending) return;
		this.pendingTaskInputs.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		pending.reject(error);
	}

	private async sendTaskInput(
		to: string,
		taskId: string,
		inputRequestId: string,
		input: unknown,
	): Promise<void> {
		const env: TaskInputEnvelope = {
			t: "input",
			taskId,
			inputRequestId,
			input,
		};
		const text = encodeTaskEnvelope(env);
		if (!this.fitsWire(text)) {
			throw new Error("AGX task input exceeds the transport size limit");
		}
		const sent = await this.transport.publishMessage(to, {
			text,
			contextId: taskId,
			contentType: TASK_CONTENT_TYPE,
		});
		if (!sent.ok) {
			throw new Error(`AGX task input could not be sent to ${to}`);
		}
	}

	/** Reject + remove a pending request (publish failure / shutdown). */
	private settlePending(taskId: string, error: Error): void {
		const p = this.pending.get(taskId);
		if (!p) {
			return;
		}
		this.pending.delete(taskId);
		if (p.timer) {
			clearTimeout(p.timer);
		}
		p.reject(error);
		p.onError?.(error);
	}

	private async startMessageListener(): Promise<void> {
		const unsubscribers: Unsubscribe[] = [];
		const listenerOptions: AgxTransportListenerOptions = {
			isKnown: async (transportIds) => {
				if (this.seen.hasMany) {
					return this.seen.hasMany(transportIds);
				}
				const known = new Set<string>();
				for (const id of transportIds) {
					if (await this.seen.has(id)) {
						known.add(id);
					}
				}
				return known;
			},
			onDiscarded: async (transportIds) => {
				if (this.seen.addMany) {
					await this.seen.addMany(transportIds);
					return;
				}
				for (const id of transportIds) {
					await this.seen.add(id);
				}
			},
		};
		try {
			const unsubscribeMessage = await this.transport.onMessage?.(
				async (msg: AgxIncomingMessage) => {
					await this.dispatchLiveEvent("message", msg);
				},
				listenerOptions,
			);
			if (typeof unsubscribeMessage === "function") {
				unsubscribers.push(unsubscribeMessage);
			}
			const unsubscribeReceipt = await this.transport.onReceipt?.(
				async (receipt: AgxIncomingReceipt) => {
					await this.dispatchLiveEvent("receipt", receipt);
				},
				listenerOptions,
			);
			if (typeof unsubscribeReceipt === "function") {
				unsubscribers.push(unsubscribeReceipt);
			}
			this.listenerUnsubscribers = unsubscribers;
		} catch (error) {
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
			throw error;
		}
	}

	private unsubscribeTransportListeners(): void {
		const unsubscribers = this.listenerUnsubscribers;
		this.listenerUnsubscribers = [];
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	}
}

type StreamEventData<Output> = {
	completed: Output;
	statusUpdate:
		| "delivered"
		| "working"
		| "input-required"
		| "completed"
		| "failed";
	/** Ordered public `working` updates; duplicates and older ones are dropped
	 * before they get here. */
	progress: { seq: number; message?: string };
	inputRequired: InputRequiredUpdate;
	error: string;
};


/** Progress events and the final result of a streaming task request. */
export class StreamResponse<Output> {
	private events = new Map<
		keyof StreamEventData<Output>,
		Array<(data: unknown) => unknown>
	>();
	private earlyEvents = new Map<
		keyof StreamEventData<Output>,
		unknown[]
	>();
	private readonly pendingInputs = new Set<string>();

	constructor(
		taskId: string,
		/** Resolves with the final output; rejects on failure, timeout, or client stop. */
		readonly result: Promise<Output>,
		subscribeToReceipts: (
			listener: (receipt: AgxIncomingReceipt) => void,
		) => () => void,
		private readonly sendInput: (
			inputRequestId: string,
			input: unknown,
		) => Promise<void>,
		private readonly log: AgxLogger,
	) {
		this.result.catch(() => undefined);
		this.unsubscribeReceipt = subscribeToReceipts((receipt) => {
			if (
				receipt.receipt.contextId === taskId &&
				receipt.receipt.status === "delivered"
			) {
				this.emit('statusUpdate', 'delivered');
			}
		});
	}
	private readonly unsubscribeReceipt: () => void;

	on<Event extends keyof StreamEventData<Output>>(
		event: Event,
		listener: (data: StreamEventData<Output>[Event]) => void,
	): StreamResponse<Output> {
		const listeners = this.events.get(event) ?? [];
		listeners.push((data) =>
			listener(data as StreamEventData<Output>[Event]),
		);
		this.events.set(event, listeners);
		const early = this.earlyEvents.get(event);
		if (early) {
			early.forEach((data) =>
				this.invoke(
					(value) => listener(value as StreamEventData<Output>[Event]),
					data,
					event,
				),
			);
			this.earlyEvents.delete(event);
		}
		return this;
	}

	private emit(
		event: "completed",
		data: Output,
	): void;
	private emit(
		event: "statusUpdate",
		data: StreamEventData<Output>["statusUpdate"],
	): void;
	private emit(
		event: "inputRequired",
		data: InputRequiredUpdate,
	): void;
	private emit(
		event: "progress",
		data: StreamEventData<Output>["progress"],
	): void;
	private emit(event: "error", data: string): void;
	private emit(
		event: keyof StreamEventData<Output>,
		data: StreamEventData<Output>[keyof StreamEventData<Output>],
	): void {
		const listeners = this.events.get(event);
		if (!listeners?.length) {
			const early = this.earlyEvents.get(event) ?? [];
			early.push(data);
			this.earlyEvents.set(event, early);
			return;
		}
		listeners.forEach((listener) => this.invoke(listener, data, event));
	}

	private invoke(
		listener: (data: unknown) => unknown,
		data: unknown,
		event: keyof StreamEventData<Output>,
	): void {
		try {
			const result = listener(data);
			if (result instanceof Promise) {
				void result.catch((error: unknown) =>
					this.log.error?.("AGX: stream listener failed", {
						event,
						error: String(error),
					}),
				);
			}
		} catch (error) {
			this.log.error?.("AGX: stream listener failed", {
				event,
				error: String(error),
			});
		}
	}

	[STREAM_HANDLE_UPDATE](update: TaskResultEnvelope): void {
		this.emit("statusUpdate", update.status);
		switch (update.status) {
			case "working":
				this.emit("progress", {
					seq: update.seq,
					...(update.message === undefined ? {} : { message: update.message }),
				});
				break;
			case "input-required":
				this.pendingInputs.add(update.inputRequestId);
				this.emit("inputRequired", {
					inputRequestId: update.inputRequestId,
					requirement: update.requirement,
				});
				break;
			case "completed":
				this.pendingInputs.clear();
				this.emit("completed", update.output as Output);
				this.unsubscribeReceipt();
				break;
			case "failed":
				this.pendingInputs.clear();
				this.emit("error", update.error ?? "task failed");
				this.unsubscribeReceipt();
				break;
		}
	}

	[STREAM_HANDLE_ERROR](error: Error): void {
		this.pendingInputs.clear();
		this.emit("error", error.message);
		this.unsubscribeReceipt();
	}

	/** Send an answer for an input requirement reported by this task. */
	async provideInput(inputRequestId: string, input: unknown): Promise<void> {
		if (!this.pendingInputs.has(inputRequestId)) {
			throw new Error("AGX input request is not pending");
		}
		await this.sendInput(inputRequestId, input);
		this.pendingInputs.delete(inputRequestId);
	}
}