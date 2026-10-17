import { AgxPublicError } from "./errors";
import { randomId } from "./id";
import { type AgxLogger, noopLogger } from "./logger";
import { InMemorySeenStore, type SeenStore } from "./seen-store";
import {
	encodeTaskEnvelope,
	parseTaskEnvelope,
	type Task,
	type TaskEnvelope,
	type TaskRequestEnvelope,
	type TaskResultEnvelope,
} from "./task";
import type {
	AgxIncomingMessage,
	AgxIncomingReceipt,
	AgxTransport,
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
 * `failed`. */
export type TaskHandler<Payload = unknown, Output = unknown> = (
	task: Task<Payload>,
) => Output | Promise<Output>;

/** Context for the trust/authorization hook, evaluated before a task runs. */
export interface AgxAuthorizeContext {
	from: string;
	capability: string;
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
}

interface Pending {
	resolve: (output: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	/** The peer this request was sent to (canonicalized). A result is settled only
	 * if its sender matches — correlation by `taskId` alone is forgeable, since the
	 * responder legitimately knows the `taskId`. */
	peer: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
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
	private readonly handlers = new Map<string, TaskHandler>();
	private readonly pending = new Map<string, Pending>();
	private cursor: number;
	private pollTimer?: ReturnType<typeof setTimeout>;
	/** True while a pump() is in flight — prevents overlapping pumps from
	 * double-running a handler (the seen-add happens only after dispatch). */
	private pumping = false;
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

	/** Register a capability handler. The set of registered keys is what `start()`
	 * advertises on the Agent Card (discovery + capability matching are automatic). */
	handle<Payload = unknown, Output = unknown>(
		capability: string,
		handler: TaskHandler<Payload, Output>,
	): this {
		this.handlers.set(capability, handler as TaskHandler);
		return this;
	}

	/** The capabilities this agent handles. */
	capabilities(): string[] {
		return [...this.handlers.keys()];
	}

	/** Send a task to a peer and await its correlated result. Rejects on a `failed`
	 * result, an unsupported capability, or timeout. */
	async request<Output = unknown>(
		peer: string,
		capability: string,
		payload: unknown,
		opts?: { timeoutMs?: number },
	): Promise<Output> {
		const taskId = randomId();
		const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
		const envelope: TaskRequestEnvelope = {
			t: "req",
			taskId,
			capability,
			payload,
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
		const result = new Promise<Output>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(taskId);
							reject(
								new Error(
									`AGX request timed out after ${timeoutMs}ms`,
								),
							);
						}, timeoutMs)
					: undefined;
			this.pending.set(taskId, {
				resolve: resolve as (o: unknown) => void,
				reject,
				timer,
				peer: this.normalizeId(peer),
			});
		});

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
		}
		return result;
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
		// An event's envelope id, when the binding has one distinct from its
		// event id; recorded alongside it so the next poll skips the envelope.
		const markSeen = async (event: {
			eventId: string;
			transportId?: string;
		}): Promise<void> => {
			await addAll(
				event.transportId && event.transportId !== event.eventId
					? [event.eventId, event.transportId]
					: [event.eventId],
			);
		};
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
			if (this.ignore?.(msg)) {
				await markSeen(msg);
				attempted.set(msg.eventId, "done");
				continue;
			}
			try {
				await this.dispatchMessage(msg);
			} catch (err) {
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
					await markSeen(msg);
					attempted.set(msg.eventId, "done");
				} else {
					attempted.set(msg.eventId, "pending");
					anyFailed = true;
				}
				continue;
			}
			// Record as processed only AFTER a successful dispatch.
			await markSeen(msg);
			attempted.set(msg.eventId, "done");
			dispatched += 1;
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
			if (this.ignore?.(receipt)) {
				await markSeen(receipt);
				attempted.set(receipt.eventId, "done");
				continue;
			}
			try {
				await this.onReceipt?.(receipt);
			} catch (err) {
				const deadLettered = await this.onDispatchFailure(
					"receipt",
					receipt.eventId,
					receipt.from,
					err,
				);
				if (deadLettered) {
					// Its envelope too, or the next poll re-opens it just to skip it.
					await markSeen(receipt);
					attempted.set(receipt.eventId, "done");
				} else {
					attempted.set(receipt.eventId, "pending");
					anyFailed = true;
				}
				continue;
			}
			await markSeen(receipt);
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
	 * (`pollIntervalMs: 0`) and drive `pump()` from their own scheduler. */
	async start(opts?: {
		pollIntervalMs?: number;
		advertise?: boolean;
	}): Promise<void> {
		await this.transport.start?.();
		if (opts?.advertise !== false && this.transport.advertise) {
			await this.transport
				.advertise(this.capabilities(), {
					org: this.identity?.org,
					nip05: this.identity?.nip05,
					payloadTypes: [DEFAULT_CONTENT_TYPE, TASK_CONTENT_TYPE],
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

	/** Stop the poll interval + release the transport. In-flight `request()` callers
	 * are rejected (their result can no longer arrive) rather than left hanging. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		for (const p of this.pending.values()) {
			if (p.timer) {
				clearTimeout(p.timer);
			}
			p.reject(new Error("AGX client stopped"));
		}
		this.pending.clear();
		await this.transport.stop?.();
	}

	private async dispatchMessage(msg: AgxIncomingMessage): Promise<void> {
		if (msg.contentType === TASK_CONTENT_TYPE) {
			// `contentType` is peer-supplied, so a task label can't be trusted to mean
			// "this is task traffic for me". Consume it as a task ONLY when we can
			// actually service it: a request for a capability WE registered, or a
			// result correlated to a pending request of OURS. Anything else — an
			// unknown capability, an unmatched/late result, a malformed envelope — is
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
				this.resolvePending(msg, env);
				return;
			}
			// fall through: not a task we service → treat as a plain message.
		}
		await this.onMessage?.(msg);
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
		const handler = this.handlers.get(env.capability);
		if (!handler) {
			// Unreachable — dispatchMessage only routes here when a handler exists.
			// Guard defensively and, crucially, do NOT auto-reply.
			return;
		}
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
			const output = await handler(task);
			await this.sendResult(msg.from, env.taskId, {
				status: "completed",
				output,
			});
		} catch (err) {
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
					? (err as AgxPublicError).message
					: "handler failed",
			});
		}
	}

	private async sendResult(
		to: string,
		taskId: string,
		result: {
			status: "completed" | "failed";
			output?: unknown;
			error?: string;
		},
	): Promise<void> {
		let env: TaskEnvelope = {
			t: "res",
			taskId,
			status: result.status,
			output: result.output,
			error: result.error,
		};
		let text = encodeTaskEnvelope(env);
		// A too-large result would be truncated into an unparseable envelope, so the
		// initiator would time out. Reply with a clean failure instead.
		if (!this.fitsWire(text)) {
			this.log.warn?.("AGX: task result too large; sending failure", {
				taskId,
			});
			env = {
				t: "res",
				taskId,
				status: "failed",
				error: "result too large",
			};
			text = encodeTaskEnvelope(env);
		}
		await this.transport
			.publishMessage(to, {
				text,
				contextId: taskId,
				contentType: TASK_CONTENT_TYPE,
			})
			.catch((e) =>
				this.log.error?.("AGX: failed to publish task result", {
					taskId,
					error: String(e),
				}),
			);
	}

	private resolvePending(
		msg: AgxIncomingMessage,
		env: TaskResultEnvelope,
	): void {
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
		this.pending.delete(env.taskId);
		if (p.timer) {
			clearTimeout(p.timer);
		}
		if (env.status === "completed") {
			p.resolve(env.output);
		} else {
			p.reject(new Error(env.error ?? "task failed"));
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
	}
}
