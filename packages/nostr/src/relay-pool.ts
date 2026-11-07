import { type AgxIncomingMessage, type AgxIncomingReceipt, type AgxLogger, noopLogger } from "@nostr-agx/core";
import { type Event, type Filter, getEventHash, verifyEvent } from "nostr-tools";
import { Relay, Subscription } from "nostr-tools/relay";
import { GIFT_WRAP_KIND } from "./kinds";
import { isSignerUnavailable, type AgxSigner } from "./signer";
import { isIgnorableReceiptRumor, openMessageRumor, openReceiptRumor } from "./events";
import { unwrapRumor, type UnwrappedRumor } from "./giftwrap";

/**
 * Ids whose signature has already checked out in this process, oldest first.
 * An inbox poll re-reads two days of gift wraps every time (NIP-59 backdates
 * them up to two days), and a Schnorr check costs milliseconds: a busy agent
 * would spend most of its CPU re-checking signatures it has checked before.
 *
 * A cached id still has to match the event's own hash, which binds its content
 * and `created_at`: a relay that replays a known id with anything changed is
 * caught as before. Only the signature, made over that id, is not re-checked.
 */
const verifiedIds = new Set<string>();
const MAX_VERIFIED_IDS = 100_000;

/** `verifyEvent`, without repeating the signature check for an id it passed. */
function verifiedOnce(event: Event): boolean {
	if (verifiedIds.has(event.id)) {
		return getEventHash(event) === event.id;
	}
	if (!verifyEvent(event)) {
		return false;
	}
	verifiedIds.add(event.id);
	if (verifiedIds.size > MAX_VERIFIED_IDS) {
		const oldest = verifiedIds.values().next().value;
		if (oldest !== undefined) {
			verifiedIds.delete(oldest);
		}
	}
	return true;
}

/**
 * Relay pool: short-lived connections for poll/publish/discovery. WebSocket is
 * configured once by the transport via `configureWebSocket`. A logger is injected
 * (default no-op). NIP-42 AUTH is auto-answered when a signer is supplied.
 */

/** Per-op timeout budget — applied to the connect, to each REQ page (in
 * {@link reqPage}), and to each publish (in {@link publishToRelays}). It is NOT a
 * single deadline over a whole `withRelay` call, because a paged poll legitimately
 * runs up to MAX_POLL_PAGES sequential REQ pages; each page carries its own budget. */
const RELAY_OP_TIMEOUT_MS = 8000;
/** Max backward pages per relay per poll (bounds work on a flooded relay). Note:
 * worst case is MAX_POLL_PAGES × `limit` signed events per relay per poll, each
 * Schnorr-verified — keep `limit` modest on a shared serverless tick. */
const MAX_POLL_PAGES = 20;

/**
 * Events requested per backward page in {@link pollInbox}.
 *
 * Exported, and named rather than inlined, because it is half of a cross-system
 * invariant: a relay that clamps a filter's `limit` BELOW this value makes every
 * page come back short, which the paging loop reads as "window drained" — so it
 * stops early, reports `complete: true`, and the caller advances its cursor past
 * events it never saw. Silent, permanent loss with no alarm.
 *
 * A relay serving agx traffic must allow a filter `limit` of at least this
 * value (for strfry, `maxFilterLimit`).
 */
export const DEFAULT_POLL_LIMIT = 500;

/** Reject if `p` doesn't settle within `ms` — bounds an op that would otherwise
 * hang on a relay that accepts the socket then stalls (e.g. never returns the
 * publish OK). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/** Why a relay did not take an event. See `rejected` on {@link publishToRelays};
 * the distinction is the difference between a delivery failure and a blip. */
export type RelayFailureKind = "refused" | "unreachable";

/**
 * Marks a failure where the relay ANSWERED AND REFUSED — an `OK false` from
 * `relay.publish()`. Everything else (connect refused, DNS failure, either
 * timeout) leaves us unable to say what the relay would have done.
 *
 * Tagged in this direction on purpose. Only the refusal is positively
 * identifiable, so an unclassifiable failure falls through to "unreachable",
 * which callers must treat as UNKNOWN rather than as a delivery failure. The
 * opposite default would turn every network blip into a reported failure — and
 * per `claude.md`, a reported failure pages a human.
 */
class RelayRefusedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "RelayRefusedError";
	}
}

async function withRelay<T>(
	url: string,
	fn: (relay: Relay) => Promise<T>,
	signer?: AgxSigner,
): Promise<T> {
	// Bound the connect too: a relay can accept the TCP socket then stall the WS
	// upgrade, which would otherwise hang here past any per-op budget.
	const relay = await withTimeout(
		Relay.connect(url),
		RELAY_OP_TIMEOUT_MS,
		// No URL in the label. A connect timeout surfaces as
		// `rejected[].error` too, and every caller already renders the relay
		// alongside it — pollInbox logs `{ relay: url }`, publishToRelays keeps
		// it in its own field. Naming it here made the message say it twice.
		"relay connect",
	);
	if (signer) {
		// Verified before it is sent: a remote signer's answer is not trusted
		// blindly, and verifyEvent is also what brands it a VerifiedEvent.
		relay.onauth = async (evt) => {
			const signed = await signer.signEvent(evt);
			if (!verifyEvent(signed)) {
				throw new Error("signer returned an invalid AUTH event");
			}
			return signed;
		};
	}
	try {
		return await fn(relay);
	} finally {
		relay.close();
	}
}

/** One REQ→EOSE round on an open relay; resolves the events (unverified), whether
 * EOSE was reached (`complete`; a timeout or a refusal resolves false), and the
 * relay's stated reason when it REFUSED the subscription. */
function reqPage(
	relay: Relay,
	filter: Filter,
): Promise<{ events: Event[]; complete: boolean; closedReason?: string }> {
	return new Promise((resolve) => {
		const events: Event[] = [];
		let settled = false;
		let sub: { close(): void } | null = null;
		const finish = (complete: boolean, closedReason?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			sub?.close();
			resolve({ events, complete, closedReason });
		};
		const timer = setTimeout(() => finish(false), RELAY_OP_TIMEOUT_MS);
		sub = relay.subscribe([filter], {
			onevent: (ev: Event) => events.push(ev),
			oneose: () => finish(true),
			// Settle on close instead of waiting out the 8s timeout. Without this
			// handler the frame was dropped and the promise settled only on the
			// timer, so a PERMANENT refusal was indistinguishable from a slow
			// relay: the caller holds its cursor (correctly) and meets the
			// identical refusal next tick, forever, reported as a transient
			// timeout.
			//
			// `reason` is NOT necessarily a refusal. nostr-tools routes two
			// different things here: a relay-sent CLOSED frame (carrying the
			// relay's own reason) AND any hard socket close, via
			// handleHardClose → closeAllSubscriptions, which supplies its own
			// strings ("relay connection closed" / "failed" / "timed out" /
			// "closed by us"). Only the caller can tell those apart, so pass the
			// reason through verbatim rather than labelling it here — see
			// `isStandingRefusal` at the pollInbox warning.
			//
			// `complete: false` is the right verdict either way, so this changes no
			// caller's behaviour — only how fast it is reached and whether anyone
			// can tell why. The `settled` guard above makes the callback our own
			// sub.close() triggers a no-op.
			onclose: (reason: string) => finish(false, reason),
		});
		// A handler can fire SYNCHRONOUSLY inside subscribe() — an already-closed
		// socket closes its new subscriptions immediately. `sub` is still null at
		// that point, so finish()'s `sub?.close()` silently no-ops and the
		// subscription leaks for the life of the connection. Close it here, where
		// the reference finally exists.
		if (settled) {
			sub.close();
		}
	});
}

/** NIP-01 machine-readable CLOSED prefixes. A reason carrying one came from the
 * RELAY and describes a standing condition — the same REQ gets the same answer
 * next tick, so it is something to fix (filter rules, auth, a rate limit), not a
 * blip to wait out. Anything else may equally be a dropped socket, which
 * nostr-tools reports through the very same callback: on a single-machine relay
 * every deploy is a few seconds of exactly that, and calling those a standing
 * refusal would cry wolf on every release. */
const CLOSED_REFUSAL_PREFIXES = [
	// NIP-01's standardized set, minus `duplicate:` — the spec pairs that one
	// with OK *true*, so it never reaches a rejection path.
	"blocked:",
	"error:",
	"invalid:",
	"mute:",
	"pow:",
	"rate-limited:",
	"restricted:",
	// Not in NIP-01's list but real here: `auth-required:` is NIP-42, and strfry
	// emits `bad req:` and `unsupported:` on CLOSED.
	"auth-required:",
	"bad req:",
	"unsupported:",
];

function isStandingRefusal(reason: string): boolean {
	const normalized = reason.trim().toLowerCase();
	return CLOSED_REFUSAL_PREFIXES.some((p) => normalized.startsWith(p));
}

/** nostr-tools' own name for "the socket was gone when we tried to send".
 *
 * Matched on `name`, NOT on the message: that message is built as
 * `Tried to send message '${message} on a closed connection to ${relay}.` where
 * `message` is the ENTIRE serialized event, so a text test here would be a test
 * against a payload. The class is exported, but `name` is what survives a
 * bundler and a version bump of the export surface alike. */
const CLOSED_CONNECTION_ERROR = "SendingOnClosedConnection";

/** Reasons nostr-tools generates ITSELF when a publish cannot get an answer,
 * plus the one {@link withTimeout} generates. Everything matching means we never
 * got an answer — as opposed to getting one we did not like.
 *
 * Read off nostr-tools 2.25.0, which `package.json` pins EXACTLY for this
 * reason: these are its internal strings, not protocol, so a minor bump could
 * reword them and silently swap this classification's default. The tests below
 * assert each one; the pin is what makes a reword arrive as a lockfile change
 * someone reviews rather than as a `pnpm update`.
 *
 * - `handleHardClose` supplies `relay connection closed` / `failed` / `timed out`
 *   / `closed by us`, all sharing one prefix, and `closeAllSubscriptions`
 *   rejects every pending publish with them.
 * - `publish timed out` comes from nostr-tools' OWN `publishTimeout`, which is
 *   4400ms — SHORTER than {@link RELAY_OP_TIMEOUT_MS}. So for a relay that
 *   connects and then stalls, this is the reason that actually arrives. Before
 *   this line existed it fell through to RelayRefusedError, which made a
 *   stalled relay report as a REFUSAL: deliveredToPeer false, ok false, and a
 *   human paged for a blip.
 *
 * DELIBERATELY ABSENT: `auth timed out`, from `auth()`'s timer on the same
 * budget. It looks like the same shape and is not. `auth()` registers its
 * handlers in `openEventPublishes` keyed on the AUTH EVENT's own id, and the
 * `reject` it stores is the authPromise's — so it settles the auth promise,
 * never the publish one, whose event carries a different id. Adding it would
 * widen a set whose whole value is being closed, to catch a string that cannot
 * arrive. Re-check on any bump. */
function isLocalTransportFailure(reason: string): boolean {
	const normalized = reason.trim().toLowerCase();
	return (
		normalized.startsWith("relay connection") ||
		normalized === "publish timed out" ||
		// UNREACHABLE from this predicate's only caller today, and kept as a
		// marker rather than a guard. `withTimeout` rejects the promise it
		// WRAPS, so `relay publish timed out after 8000ms` is raised outside the
		// `.catch` that runs this — it lands unreachable on its own, by being a
		// plain Error rather than a RelayRefusedError. Nothing reaching `.catch`
		// ends in this shape.
		//
		// Its real remaining value is upstream churn, not ours: nostr-tools
		// rewording `publish timed out` into `publish timed out after 4400ms`
		// would land here and stay classified correctly. A restructuring of the
		// call site to `withTimeout(...).catch(classify)` is the other case, and
		// the less likely one.
		/timed out after \d+ms$/.test(normalized)
	);
}

/** Cap a rejection reason before it is STORED. Classification runs on the full
 * string first — `isLocalTransportFailure` anchors one test at the end — so this
 * only bounds what gets rendered.
 *
 * Worth bounding because `rejected[].error` is rendered three ways: `errors` as
 * `${relay}: ${error}`, egress as `${relay} (${error})` inside advice a model
 * reads, and the CLI straight to a terminal. {@link CLOSED_CONNECTION_ERROR}
 * carries a whole serialized event, so without this one rejection puts an
 * encrypted payload through all three. */
const MAX_REJECTION_REASON_CHARS = 200;

function boundReason(reason: string): string {
	const trimmed = reason.trim();
	return trimmed.length > MAX_REJECTION_REASON_CHARS
		? `${trimmed.slice(0, MAX_REJECTION_REASON_CHARS)}…`
		: trimmed;
}

/** {@link fetchByAuthorWithStatus}'s result. */
export interface FetchByAuthorResult {
	/** Verified, deduped, newest-first. */
	events: Event[];
	/** How many relays completed the query (reached EOSE). Zero means NO relay
	 * could be read — a connect timeout, a stalled or refused REQ — which is
	 * NOT the same as "the author has no such event". */
	answered: number;
}

/**
 * Fetch the latest events of given kinds authored by a pubkey across relays
 * (Agent Card / NIP-65). Verified, deduped, newest-first. Best-effort.
 */
export async function fetchByAuthor(params: {
	relays: string[];
	author: string;
	kinds: number[];
	limit?: number;
	signer?: AgxSigner;
}): Promise<Event[]> {
	return (await fetchByAuthorWithStatus(params)).events;
}

/**
 * {@link fetchByAuthor}, plus whether any relay actually answered. A caller
 * that makes an irreversible decision on "no event found" needs to tell that
 * apart from "no relay could be read": every per-relay failure is swallowed
 * here, so without the count both look like an empty result.
 */
export async function fetchByAuthorWithStatus(params: {
	relays: string[];
	author: string;
	kinds: number[];
	limit?: number;
	signer?: AgxSigner;
}): Promise<FetchByAuthorResult> {
	const byId = new Map<string, Event>();
	let answered = 0;
	await Promise.allSettled(
		params.relays.map((url) =>
			withRelay(
				url,
				async (relay) => {
					const { events, complete } = await reqPage(relay, {
						kinds: params.kinds,
						authors: [params.author],
						limit: params.limit ?? 4,
					});
					if (complete) {
						answered += 1;
					}
					for (const ev of events) {
						// The relay is untrusted (peer-advertised): it can answer a
						// {authors,kinds} REQ with ANY validly-signed event. Enforce
						// the filter ourselves — otherwise a card/relay-list lookup
						// could return an attacker-chosen (but signed) event, spoofing
						// the display name / capabilities / relays a human approves on.
						if (ev.pubkey !== params.author) {
							continue;
						}
						if (!params.kinds.includes(ev.kind)) {
							continue;
						}
						if (!byId.has(ev.id) && verifyEvent(ev)) {
							byId.set(ev.id, ev);
						}
					}
				},
				params.signer,
			),
		),
	);
	return {
		events: Array.from(byId.values()).sort(
			(a, b) => b.created_at - a.created_at,
		),
		answered,
	};
}

/** Publish an event to relays. ok:true if ≥1 relay accepted. */
export async function publishToRelays(
	relays: string[],
	event: Event,
	signer?: AgxSigner,
): Promise<{
	ok: boolean;
	accepted: number;
	total: number;
	/** Which relays did not take it, why, and WHICH KIND of failure it was.
	 * `ok` can be true with entries here — that is a PARTIAL publish, and for a
	 * recipient's relay it means the message was not delivered even though the
	 * call succeeded. Callers that report success must consult this.
	 *
	 * `kind` is the part that must not be collapsed. "refused" is a verdict: the
	 * relay answered and said no, and it will say no again. "unreachable" is an
	 * absence of information — a restart, a deploy, a DNS blip — and treating it
	 * as a verdict reports a transient outage as a delivery failure. */
	rejected: { relay: string; error: string; kind: RelayFailureKind }[];
	/** Flattened `rejected`, kept for callers that only render a string. */
	errors: string[];
}> {
	if (relays.length === 0) {
		return {
			ok: false,
			accepted: 0,
			total: 0,
			rejected: [],
			errors: ["no relays configured"],
		};
	}
	const results = await Promise.allSettled(
		relays.map((url) =>
			withRelay(
				url,
				async (relay) => {
					// Bound the publish. NOT because nostr-tools would otherwise wait
					// forever — its own `publishTimeout` is 4400ms, SHORTER than
					// RELAY_OP_TIMEOUT_MS, so on a stall its timer fires first and
					// this wrapper never does. This is the backstop for the case its
					// timer does not cover, and the reason `publish timed out` has to
					// be classified below rather than left to fall through.
					await withTimeout(
						// `publish()` rejects for two disjoint reasons, and only one is
						// a verdict: the relay answered `OK false`, or the socket died
						// with the publish pending (nostr-tools' closeAllSubscriptions
						// rejects everything in openEventPublishes).
						//
						// Identify the LOCAL failures — a closed set we control — and
						// treat everything else as the `OK false` it must be. Not a
						// prefix test on the reason: NIP-01 only says relays SHOULD
						// prefix, so a bare "not accepted" would classify unreachable,
						// leaving deliveredToPeer undefined and the send reporting
						// ok:true for a message the relay refused. The poll path uses
						// the opposite default, and must: see reqPage's onclose.
						//
						// `e.message`, not `String(e)` — the latter prepends "Error: ",
						// which defeats any test applied to it.
						relay.publish(event).catch((e: unknown) => {
							const reason =
								e instanceof Error ? e.message : String(e);
							// By NAME, before any text test — see
							// CLOSED_CONNECTION_ERROR. The socket was already gone,
							// so the relay never saw the event and cannot have
							// refused it.
							//
							// The library's message is DROPPED, not rethrown or
							// bounded. Everything diagnostic in it sits AFTER the
							// whole serialized event, so a front-anchored bound
							// keeps the payload and cuts `on a closed connection
							// to <relay>` — measured, the cause was ALWAYS the part
							// that went. Whether any ciphertext also survived came
							// down to two characters of key order, which is not a
							// property to rest on. Dropping it costs nothing the
							// call site does not already hold: `rejected[].relay`
							// carries the URL, which is also why the comment below
							// says NEITHER branch names the relay.
							if (
								e instanceof Error &&
								e.name === CLOSED_CONNECTION_ERROR
							) {
								throw new Error("send on a closed connection");
							}
							// NEITHER branch names the relay. `rejected[]` keeps
							// `relay` in its own field and every renderer prefixes
							// it — `errors` as `${relay}: ${error}`, egress and the
							// CLI as `${relay} (${error})`. Naming it here too gave
							// the unreachable path, the one an operator sees most,
							// "wss://x: relay publish wss://x: relay connection
							// closed". Only refusals read cleanly, because
							// RelayRefusedError carries the bare reason.
							throw isLocalTransportFailure(reason)
								? new Error(reason)
								: new RelayRefusedError(reason);
						}),
						RELAY_OP_TIMEOUT_MS,
						// Label without the URL, for the same reason: it becomes
						// `rejected[].error` on a timeout.
						"relay publish",
					);
				},
				signer,
			),
		),
	);
	// Index-preserving, like pollInbox's per-relay logging below: a bare
	// `.filter(rejected).map(reason)` decouples each error from the relay that
	// produced it, and "which relay refused" is the whole question when some
	// accept and others do not.
	const rejected: {
		relay: string;
		error: string;
		kind: RelayFailureKind;
	}[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status === "rejected") {
			rejected.push({
				relay: relays[i] ?? "unknown",
				// Unwrapped, so a stored reason reads "invalid: event too large"
				// rather than "Error: invalid: event too large" — this text is
				// rendered to operators and to the model reading a tool result.
				error: boundReason(
					r.reason instanceof Error
						? r.reason.message
						: String(r.reason),
				),
				kind:
					r.reason instanceof RelayRefusedError
						? "refused"
						: "unreachable",
			});
		}
	}
	const accepted = results.length - rejected.length;
	return {
		ok: accepted > 0,
		accepted,
		total: results.length,
		rejected,
		errors: rejected.map((r) => `${r.relay}: ${r.error}`),
	};
}

/**
 * Poll an inbox across relays for MESSAGE/RECEIPT events tagged to `pubkey`
 * `since` a cursor. Each relay is PAGED BACKWARD with `until` until a page brings
 * back nothing that relay has not already returned (window drained) so a dense
 * window can't silently drop its oldest events — and so a relay that clamps
 * `limit` below ours cannot pass a truncated page off as a drained one. `complete` is false if any relay failed/timed out/was truncated —
 * the caller must then not advance its cursor past unseen events.
 */
export async function pollInbox(params: {
	relays: string[];
	pubkey: string;
	since: number;
	limit?: number;
	signer?: AgxSigner;
	logger?: AgxLogger;
}): Promise<{ events: Event[]; complete: boolean }> {
	const log = params.logger ?? noopLogger;
	// CLAMPED, not just defaulted: `limit` arrives from
	// NostrTransport.poll({ limit }), which is public API, and a relay sized for
	// agx pins maxFilterLimit to DEFAULT_POLL_LIMIT. Asking for less is fine; asking for
	// more only earns a server-side clamp. It is not the load-bearing guard —
	// termination no longer consults a relay-supplied count (see the break
	// below) — it just keeps every REQ within what the relay will honour.
	const limit = Math.min(
		params.limit ?? DEFAULT_POLL_LIMIT,
		DEFAULT_POLL_LIMIT,
	);
	const byId = new Map<string, Event>();
	const results = await Promise.allSettled(
		params.relays.map((url) =>
			withRelay(
				url,
				async (relay): Promise<boolean> => {
					let relayComplete = true;
					let until: number | undefined;
					// Per-RELAY, deliberately not the shared `byId`. Paging
					// progress is a property of this relay's answers; `byId` is
					// written by every relay concurrently under Promise.allSettled,
					// so testing it would let relay B's inserts make relay A
					// conclude "drained" and advance the cursor past events relay A
					// never returned — the same silent-advance bug this loop is
					// being fixed to avoid, reintroduced by the fix.
					//
					// Raw batch ids, before the client-side filter re-enforcement
					// below: what matters here is whether the relay is still
					// handing us new events, not whether they survive our filter.
					const seenFromRelay = new Set<string>();
					for (let page = 0; page < MAX_POLL_PAGES; page++) {
						const filter: Filter = {
							kinds: [GIFT_WRAP_KIND],
							"#p": [params.pubkey],
							since: params.since,
							limit,
						};
						if (until !== undefined) {
							filter.until = until;
						}
						const {
							events: batch,
							complete,
							closedReason,
						} = await reqPage(relay, filter);
						let oldest = Number.POSITIVE_INFINITY;
						let newFromRelay = 0;
						for (const ev of batch) {
							if (!seenFromRelay.has(ev.id)) {
								seenFromRelay.add(ev.id);
								newFromRelay++;
							}
							// The relay is untrusted: it can answer our REQ with ANY
							// validly-signed event. Re-enforce the filter client-side
							// (mirrors fetchByAuthor) — NIP-44 already limits which events
							// decrypt to us, but a relay could still return an out-of-window
							// event, which the 24h SeenStore prune would turn into a replay
							// path for a third-party runtime on an InMemorySeenStore.
							if (ev.kind !== GIFT_WRAP_KIND) {
								continue;
							}
							if (
								!ev.tags.some(
									(t) =>
										t[0] === "p" && t[1] === params.pubkey,
								)
							) {
								continue;
							}
							if (ev.created_at < params.since) {
								continue;
							}
							// An id another relay already supplied was verified then;
							// don't pay for it twice. Keep the stored copy, because
							// the cursor is read off it below.
							const known = byId.get(ev.id);
							if (!known && !verifiedOnce(ev)) {
								continue;
							}
							if (!known) {
								byId.set(ev.id, ev);
							}
							// ONLY AN EVENT WE ACCEPTED MAY MOVE THE CURSOR.
							//
							// `oldest` becomes the next page's `until`, so whatever
							// lowers it decides what the following REQ can still
							// reach. Read off the raw batch — anywhere above these
							// checks — a single event we go on to DISCARD sets that
							// bound: one `{ kind: 1, created_at: since, tags: [] }`
							// frame from a single relay walks `until` down to
							// `since`, the next REQ is a range the relay answers
							// nothing for, and the loop exits with relayComplete
							// still true. Measured: 1 of 1500 events read, reported
							// complete. Gating on `>= since` alone closed only the
							// below-window half of that.
							//
							// A page that yields nothing acceptable leaves `oldest`
							// at Infinity, which the guard below turns into
							// `complete: false` and a held cursor — the right answer,
							// since such a page taught us nothing about the window.
							//
							// The timestamp comes from the VERIFIED copy, not from
							// whichever relay echoed the id back: `created_at` is
							// part of what the id hashes, so a relay replaying a
							// known id with a mutated timestamp cannot move the
							// cursor with it.
							const createdAt = (known ?? ev).created_at;
							if (createdAt < oldest) {
								oldest = createdAt;
							}
						}
						if (!complete) {
							relayComplete = false;
							// THREE outcomes, not two. A relay-sent CLOSED with a NIP-01
							// prefix is a standing condition — the same REQ gets the same
							// answer next tick, so it is something to fix. But the same
							// callback also fires when the SOCKET drops, and claiming a
							// standing refusal there would raise a false alarm on every
							// relay restart (on a single-machine relay, every deploy).
							// So: name a refusal only when the relay said so in the
							// protocol's own vocabulary, report any other early close
							// neutrally with the reason verbatim, and keep the timeout
							// wording for an actual timeout.
							if (closedReason === undefined) {
								log.warn?.(
									"pollInbox: relay timed out mid-poll; treating as incomplete",
									{ relay: url, since: params.since },
								);
							} else if (isStandingRefusal(closedReason)) {
								log.warn?.(
									"pollInbox: relay REFUSED the subscription; it will refuse again until this is addressed",
									{
										relay: url,
										reason: closedReason,
										since: params.since,
									},
								);
							} else {
								log.warn?.(
									"pollInbox: subscription closed early; treating as incomplete",
									{
										relay: url,
										reason: closedReason,
										since: params.since,
									},
								);
							}
							break;
						}
						// ── WHEN TO STOP PAGING ────────────────────────────────
						//
						// Two questions, in order.
						//
						// (1) CAN THE CURSOR MOVE? Paging backward lowers `until` to
						//     `oldest`. It cannot when the page brought no id this
						//     relay had not already returned, or brought none older
						//     than the cursor — either way the next REQ repeats this
						//     one. (Only the first half is load-bearing; the second
						//     saves a round trip, since a stuck cursor yields no new
						//     ids on the following page anyway.)
						//
						// (2) IF NOT, IS THAT DRAINAGE OR TRUNCATION? A FULL page is
						//     evidence the relay had more and cut it off, so events may
						//     sit at `until` that lowering the cursor can never reach
						//     -> incomplete, hold. A SHORT page is the relay saying it
						//     handed over everything matching the filter -> complete.
						//
						// `batch.length` appears in (2) and only there. It is safe in
						// that role and unsafe as a drain test: a full page is evidence
						// of truncation, never of drainage, so a lying relay can only
						// make us hold a cursor we could have advanced.
						//
						// Two cases are settled first, because neither question applies:
						// an EMPTY page is unambiguous drainage, and a page with no
						// in-window event leaves `oldest` at Infinity, which
						// JSON.stringify writes as `null` — the next REQ would ship a
						// filter with no upper bound.
						if (batch.length === 0) {
							break;
						}
						if (!Number.isFinite(oldest)) {
							relayComplete = false;
							log.warn?.(
								"pollInbox: page carried nothing we could accept; treating as incomplete",
								{ relay: url, since: params.since, until },
							);
							break;
						}
						const cursorStuck =
							newFromRelay === 0 ||
							(until !== undefined && oldest >= until);
						if (cursorStuck) {
							if (batch.length >= limit) {
								relayComplete = false;
								log.warn?.(
									"pollInbox: dense timestamp cluster exceeds page limit; some events may be unreachable",
									{ relay: url, since: params.since, until },
								);
							}
							break;
						}
						until = oldest;
						if (page === MAX_POLL_PAGES - 1) {
							relayComplete = false;
							log.warn?.(
								"pollInbox: hit page cap; window may be truncated this poll. Sustained, this is the inbox capacity ceiling (~10k wraps per relay per 2-day window) — see 'Inbox capacity ceiling' in docs/agent-exchange.md",
								{ relay: url, pages: MAX_POLL_PAGES, limit },
							);
						}
					}
					return relayComplete;
				},
				params.signer,
			),
		),
	);
	let complete = true;
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status === "rejected") {
			complete = false;
			log.warn?.("pollInbox: relay dial failed", {
				relay: params.relays[i],
				error: String(r.reason),
			});
		} else if (r.value === false) {
			complete = false;
		}
	}
	return {
		events: Array.from(byId.values()).sort(
			(a, b) => a.created_at - b.created_at,
		),
		complete,
	};
}

/**
 * Subscribe to relays for MESSAGE/RECEIPT events tagged to `pubkey`. 
 * Each relay is subscribed to once, and the callback is called for each event received. 
 * The subscription is not automatically closed; the caller must manage the lifecycle of the subscriptions.
 */
export async function listenEvents(signer: AgxSigner, relays: string[], params: { pubkey: string }, callback: (data: AgxIncomingMessage | AgxIncomingReceipt) => void) {
	if (relays.length === 0) {
		return []
	}

	const results = await Promise.allSettled(
		relays.map(async (url) => {
			// Bound the connect too: a relay can accept the TCP socket then stall the WS
			// upgrade, which would otherwise hang here past any per-op budget.
			const relay = await withTimeout(
				Relay.connect(url),
				RELAY_OP_TIMEOUT_MS,
				// No URL in the label. A connect timeout surfaces as
				// `rejected[].error` too, and every caller already renders the relay
				// alongside it — pollInbox logs `{ relay: url }`, publishToRelays keeps
				// it in its own field. Naming it here made the message say it twice.
				"relay connect",
			);
			if (signer) {
				// Verified before it is sent: a remote signer's answer is not trusted
				// blindly, and verifyEvent is also what brands it a VerifiedEvent.
				relay.onauth = async (evt) => {
					const signed = await signer.signEvent(evt);
					if (!verifyEvent(signed)) {
						throw new Error("signer returned an invalid AUTH event");
					}
					return signed;
				};
			}

			let sub: Subscription | null = null;

			const filter: Filter = {
				kinds: [GIFT_WRAP_KIND],
				"#p": [params.pubkey]
			};

			sub = relay.subscribe([filter], {
				async onevent(event: Event) {
					// console.log(`Event received from relay ${url}:`, event);
					let unwrapped: UnwrappedRumor | null = null;
					try {
						unwrapped = await unwrapRumor({ signer, event });
					} catch (err) {
						if (!isSignerUnavailable(err)) {
							throw err;
						}
						// The signer is down, not the wraps bad: stop opening, discard
						// none of the rest, and report the poll incomplete so the host holds
						// its cursor and the next poll sees them again. What was opened
						// before this point is still returned — safe, the cursor holds.
					}
					if (!unwrapped) {
						return
					}

					// A receipt with a status a newer peer added: ignored, by the spec,
					// rather than counted and warned about as malformed. Recorded as seen
					// so it is not reopened on the next poll.
					if (isIgnorableReceiptRumor(unwrapped)) {
						return;
					}
					const receipt = openReceiptRumor(unwrapped);
					if (receipt) {
						callback({
							from: receipt.senderPubkey,
							eventId: receipt.eventId,
							transportId: event.id,
							createdAt: receipt.createdAt,
							sentAt: receipt.sentAt,
							receipt: receipt.receipt,
						});
						return;
					}
					const opened = openMessageRumor(unwrapped);
					if (opened) {
						callback({
							from: opened.senderPubkey,
							eventId: opened.eventId,
							transportId: event.id,
							createdAt: opened.createdAt,
							sentAt: opened.sentAt,
							text: opened.text,
							contextId: opened.contextId,
							messageId: opened.messageId,
							subject: opened.subject,
							// Forwarded, not derived. What the peer declared is what the host's
							// loop guard reasons about; deciding here would hide the signal.
							autoDepth: opened.autoDepth,
							contentType: opened.contentType,
							// Forwarded as the sender declared it; trusting it is the host's call.
							...(opened.evidence ? { evidence: opened.evidence } : {}),
						});
					}
				}
			})

			return sub
		})
	)

	// Index-preserving, like pollInbox's per-relay logging below: a bare
	// `.filter(rejected).map(reason)` decouples each error from the relay that
	// produced it, and "which relay refused" is the whole question when some
	// accept and others do not.
	const subscriptions: Subscription[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status === "fulfilled") {
			subscriptions.push(r.value);
		} else {
			console.error(`Failed to subscribe to relay ${relays[i] ?? "unknown"}:`, r.reason);
		}
	}

	return subscriptions
}