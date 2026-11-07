import {
	type AgxLogger,
	type AgxPollResult,
	type AgxResolvedPeer,
	type AgxTransport,
	type ExchangeEvidence,
	exchangeEvidenceProblem,
	MAX_BODY,
	MAX_EVIDENCE_FIELDS,
	MAX_EVIDENCE_RECORDS,
	MAX_EVIDENCE_VALUE,
	type ReceiptStatus,
} from "@nostr-agx/core";
import type { Event } from "nostr-tools";
import { normalizePubkey } from "./address";
import {
	type AgentCard,
	buildCard,
	resolveNip05,
	resolvePeerCard,
	resolvePeerRelays,
	signCardEvent,
	signRelayListEvent,
} from "./discovery";
import type { AgentCardExtension, AgentSkill } from "./typed-card";
import {
	AgxPayloadTooLargeError,
	exchangeMessagePlaintextBytes,
	INTEROP_MAX_EVENT_BYTES,
	INTEROP_MAX_PLAINTEXT_BYTES,
	isIgnorableReceiptRumor,
	openMessageRumor,
	openReceiptRumor,
	signMessageEvent,
	signReceiptEvent,
	worstCaseEventBytes,
} from "./events";
import {
	eventExpiration,
	MAX_WRAP_BACKDATE_SEC,
	type UnwrappedRumor,
	unwrapRumor,
} from "./giftwrap";
import {
	pollInbox,
	publishToRelays,
	type RelayFailureKind,
} from "./relay-pool";
import {
	type AgxSigner,
	type AgxSignerUnavailableError,
	isSignerUnavailable,
} from "./signer";
import { configureWebSocket, type WebSocketImpl } from "./ws";

export interface NostrTransportConfig {
	/** Signs, encrypts and decrypts for this agent. Use `localSigner(secretKey)`
	 * when the host holds the key; any NIP-07/NIP-46-shaped signer works too. */
	signer: AgxSigner;
	/** Relays this agent publishes to / reads from. */
	relays: string[];
	/** WebSocket implementation (Node: `ws`; browser/edge: omit to use the global). */
	ws?: WebSocketImpl;
	/** Optional logger (default no-op). */
	logger?: AgxLogger;
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/** TTL for the per-transport peer-discovery caches. A NIP-65 relay list and an
 * Agent Card are replaceable events that change rarely, but `publishMessage`
 * resolves the recipient's relays on EVERY send — one fresh WebSocket dial per
 * configured relay (plus a DNS lookup per candidate). A short TTL collapses the
 * repeated resolutions within a poll batch (many messages/receipts to the same
 * peer) into one, without risking a long-stale routing table. */
const PEER_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
	value: T;
	expires: number;
}

/** Module-scoped so it survives a fresh `NostrTransport` per tick
 * (ingest.ts's `pollOneTeam`). Keyed on transport identity + relay set, not
 * just peer pubkey — different teams query different relays, so pubkey-only
 * keying would leak one team's resolution to another. */
const peerRelayCache = new Map<string, CacheEntry<string[]>>();

/** Sweeps expired entries on write; nothing else bounds this map's size. */
function evictExpired(cache: Map<string, CacheEntry<unknown>>): void {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.expires <= now) {
			cache.delete(key);
		}
	}
}

/** Test-only: clears the module-scoped cache between test cases. */
export function __resetPeerRelayCacheForTests(): void {
	peerRelayCache.clear();
}

/**
 * The Nostr binding of {@link AgxTransport}. Maps AGX messages and receipts onto
 * NIP-59 gift wraps (NIP-44 twice, NIP-40 expiry, NIP-13 proof-of-work) and
 * discovery onto signed, public events, over a relay pool with NIP-65 routing
 * and NIP-42 auth. Connections are short-lived (poll/publish),
 * fitting serverless + tick models.
 */
export class NostrTransport implements AgxTransport {
	/** Wraps are backdated up to this far (NIP-59), so an inbox poll has to
	 * reach this far behind its cursor. `AgxClient` widens `since` by it. */
	readonly pollLookbackSec = MAX_WRAP_BACKDATE_SEC;
	private readonly signer: AgxSigner;
	private readonly publicKey: string;
	private readonly relays: string[];
	private readonly logger?: AgxLogger;
	/** Per-peer Agent Card cache (keyed by hex pubkey). Instance-scoped,
	 * unlike `peerRelayCache` above (see its comment for why that one isn't). */
	private readonly peerCardCache = new Map<
		string,
		CacheEntry<AgxResolvedPeer["card"]>
	>();

	/** Resolves the signer's public key once, up front, so `whoami()` stays
	 * synchronous (the `AgxTransport` contract) even for a remote signer. */
	static async create(config: NostrTransportConfig): Promise<NostrTransport> {
		const publicKey = await config.signer.getPublicKey();
		return new NostrTransport(config, publicKey);
	}

	private constructor(config: NostrTransportConfig, publicKey: string) {
		configureWebSocket(config.ws);
		this.signer = config.signer;
		this.publicKey = publicKey;
		this.relays = config.relays;
		this.logger = config.logger;
	}

	whoami(): string {
		return this.publicKey;
	}

	/** Relays sorted so `[a,b]` and `[b,a]` share a cache entry. */
	private peerRelayCacheKey(pubkey: string): string {
		return `${this.publicKey}|${[...this.relays].sort().join(",")}|${pubkey}`;
	}

	/** Resolve a peer's NIP-65 relays, memoized for {@link PEER_CACHE_TTL_MS}.
	 * Best-effort: a resolution failure caches an empty list so a peer with no (or
	 * an unreachable) relay list isn't re-dialed on every send within the TTL. */
	private async cachedPeerRelays(pubkey: string): Promise<string[]> {
		const key = this.peerRelayCacheKey(pubkey);
		const hit = peerRelayCache.get(key);
		if (hit && hit.expires > Date.now()) {
			return hit.value;
		}
		const relays = await resolvePeerRelays(
			pubkey,
			this.relays,
			this.signer,
		).catch(() => [] as string[]);
		evictExpired(peerRelayCache);
		peerRelayCache.set(key, {
			value: relays,
			expires: Date.now() + PEER_CACHE_TTL_MS,
		});
		return relays;
	}

	/** Resolve a peer's Agent Card, memoized for {@link PEER_CACHE_TTL_MS}. */
	private async cachedPeerCard(
		pubkey: string,
	): Promise<AgxResolvedPeer["card"]> {
		const hit = this.peerCardCache.get(pubkey);
		if (hit && hit.expires > Date.now()) {
			return hit.value;
		}
		const card = await resolvePeerCard(
			pubkey,
			this.relays,
			this.signer,
		).catch(() => null);
		this.peerCardCache.set(pubkey, {
			value: card,
			expires: Date.now() + PEER_CACHE_TTL_MS,
		});
		return card;
	}

	/** Canonicalize `npub…` / hex to lowercase hex; unparseable ids pass through so
	 * the caller (not this hook) decides how to handle them. */
	normalizeIdentity(id: string): string {
		return normalizePubkey(id) ?? id;
	}

	async publishMessage(
		to: string,
		message: {
			text: string;
			subject?: string | null;
			contextId?: string | null;
			contentType?: string;
			autoDepth?: number;
			evidence?: ExchangeEvidence;
		},
	): Promise<{
		ok: boolean;
		eventId: string;
		contextId: string;
		accepted: number;
		total: number;
		errors: string[];
		/** Which relays did not take it, why, and WHICH KIND of failure it was —
		 * index-preserved, unlike a flat error list, because "which relay, and
		 * did it answer" is the whole question here.
		 *
		 * `kind` is NON-optional on this concrete type (the interface's is
		 * optional, for bindings that cannot classify): `publishToRelays` always
		 * classifies, and callers such as `egress.ts` branch on it to avoid
		 * reporting an unreachable relay as having refused. Widening the
		 * interface alone left this annotation narrow, `implements AgxTransport`
		 * still satisfied, and every caller reading the old shape — which is how
		 * that reached a red build rather than a red editor. */
		rejected: { relay: string; error: string; kind: RelayFailureKind }[];
		/** Whether at least one relay the RECIPIENT advertises accepted the event.
		 * `undefined` when they advertise none we could resolve — unknown, which
		 * is not the same as false. This is the field that answers "will they
		 * actually see it", as opposed to "did anything store it". */
		deliveredToPeer?: boolean;
	}> {
		const recipient = normalizePubkey(to);
		if (!recipient) {
			throw new Error(`Invalid recipient identity: "${to}"`);
		}
		// Refuse UNDELIVERABLE before refusing UNENCRYPTABLE. signMessageEvent
		// guards NIP-44's 65535-byte plaintext, which is a much weaker bound than
		// what a peer's relay will store — so a body between the two encrypted
		// fine, published fine to OUR relay, and was rejected by the recipient's.
		// AgxClient.fitsWire consults canCarry, but direct transport callers
		// (`agx send` in @nostr-agx/cli) bypass the core entirely, so the
		// check belongs here as well.
		// Measured with the ACTUAL contentType and subject rather than
		// canCarry's placeholders, because signMessageEvent below signs the real
		// values. canCarry takes only `text` (that is all the AgxTransport
		// interface gives it) and substitutes a default contentType
		// and a 200-BYTE subject placeholder — while a real subject is 200
		// CHARACTERS, up to ~1200 bytes once UTF-8-encoded and JSON-escaped.
		//
		// That gap is ~400 bytes, which would not matter except that the ceiling
		// sits exactly on a NIP-44 chunk boundary: a 28,672-byte rumor wraps to
		// ~55,200 bytes and one a byte larger pads both layers up a step, to
		// ~66,100 — over. So a body near the limit with a CJK subject passed the
		// check, got signed, got published, and was refused by every
		// default-configured peer relay. (Found at the single-layer ceiling of
		// the time; the same arithmetic holds now: a 27,400-char body measures a
		// 28,601-byte rumor through canCarry and 29,001 as actually signed.)
		//
		// `autoDepth` is NOT measured on either path, and that is safe rather
		// than overlooked: it adds at most ~16 bytes, while this measurement
		// substitutes 200-character placeholders for messageId/contextId against
		// a real `randomId()` of 32 — ~168 bytes of slack in the other
		// direction. Stated because the next reader would otherwise either trust
		// a claim the code does not make, or re-derive the slack from scratch.
		// `evidence` IS measured: it can run to many kilobytes, more than the
		// whole budget at its caps.

		// CHARACTERS FIRST, and the ordering is the whole point. Every byte
		// measurement below runs through `buildExchangePayload`, which used to
		// `.slice(0, MAX_BODY)` — so an over-long body was measured AFTER being
		// shortened, sailed through the byte check, and went out with its tail
		// missing under a reported `ok: true`. `AgxClient.fitsWire` already tested
		// characters before bytes for exactly this reason; the transport did not,
		// and `agx send` calls the transport directly.
		//
		// `buildExchangePayload` now throws instead of truncating, so without this
		// the same body would surface as an unhandled AgxBodyTooLongError from
		// inside a measurement call. Check here and report it properly.
		if (message.text.length > MAX_BODY) {
			const msg =
				`Message body is too long (${message.text.length} characters; limit ${MAX_BODY}). ` +
				"Shorten it and resend — anything longer cannot be sent whole.";
			this.logger?.warn?.("AGX: message body over the character cap", {
				chars: message.text.length,
				limit: MAX_BODY,
			});
			return {
				ok: false,
				eventId: "",
				contextId: message.contextId ?? "",
				accepted: 0,
				total: 0,
				errors: [msg],
				rejected: [],
			};
		}
		// Before measuring, for the same reason as the character check: the
		// measurement builds the payload, and the builder throws on evidence a
		// receiver would drop.
		const evidenceProblem = exchangeEvidenceProblem(message.evidence);
		if (evidenceProblem) {
			const msg =
				`Message evidence is invalid (${evidenceProblem}). ` +
				`It allows ${MAX_EVIDENCE_RECORDS} records of 1 to ${MAX_EVIDENCE_FIELDS} fields, ` +
				`values up to ${MAX_EVIDENCE_VALUE} characters and an ISO 8601 observedAt.`;
			this.logger?.warn?.("AGX: message evidence is invalid", {
				problem: evidenceProblem,
			});
			return {
				ok: false,
				eventId: "",
				contextId: message.contextId ?? "",
				accepted: 0,
				total: 0,
				errors: [msg],
				rejected: [],
			};
		}
		const plaintextBytes = exchangeMessagePlaintextBytes(message.text, {
			contentType: message.contentType,
			subject: message.subject ?? null,
			evidence: message.evidence,
		});
		if (worstCaseEventBytes(plaintextBytes) > INTEROP_MAX_EVENT_BYTES) {
			// The SAME measurement the guard rejected on, so the explanation and
			// the decision cannot disagree.
			const bytes = plaintextBytes;
			// What the evidence costs, so the target below is a target for the
			// TEXT: scaling the whole size by the text's length would ask for a
			// cut the evidence alone can make impossible.
			const evidenceBytes = message.evidence
				? bytes -
					exchangeMessagePlaintextBytes(message.text, {
						contentType: message.contentType,
						subject: message.subject ?? null,
					})
				: 0;
			// NAME A CHARACTER TARGET, because bytes are not actionable by the
			// caller. `MAX_BODY` is advertised verbatim in the tool schema the
			// model reads (intrinsic-skills/skills/external-messaging.ts), but
			// it is only reachable for pure ASCII: a 27,400-character body
			// serializes to a ~28,600-byte rumor against a 28,672 ceiling — about
			// 70 bytes of headroom, so a couple of dozen newlines or quotes are
			// enough to fail. Each of those escapes TWICE (payload, then rumor),
			// so an all-escaped body fits about a quarter of the advertised
			// number. Told only "29,240 bytes; limit 28,672", a model cannot work
			// out how much to cut. Serialization is near-linear in the escape ratio, so scaling
			// the length by how far over we are gives a usable target.
			const suggestedChars = Math.floor(
				message.text.length *
					((INTEROP_MAX_PLAINTEXT_BYTES - evidenceBytes) /
						(bytes - evidenceBytes)),
			);
			let advice = `Shorten the body to roughly ${suggestedChars} characters or fewer`;
			if (evidenceBytes > 0) {
				advice =
					suggestedChars > 0
						? `${advice}, or cite fewer evidence records (they take ${evidenceBytes} bytes)`
						: `The evidence alone takes ${evidenceBytes} bytes of the ${INTEROP_MAX_PLAINTEXT_BYTES}-byte budget: cite fewer evidence records or fields`;
			}
			const msg =
				`Message is too large to be deliverable: it serializes to ${bytes} bytes, ` +
				`producing a ~${worstCaseEventBytes(bytes)}-byte event, over the ` +
				`${INTEROP_MAX_EVENT_BYTES}-byte limit a default-configured relay accepts. ` +
				`${advice} — a relay that rejects it will not tell the sender.`;
			this.logger?.warn?.("AGX: message too large to be deliverable", {
				bytes,
				evidenceBytes,
				limit: INTEROP_MAX_EVENT_BYTES,
			});
			return {
				ok: false,
				eventId: "",
				contextId: message.contextId ?? "",
				accepted: 0,
				total: 0,
				errors: [msg],
				rejected: [],
			};
		}
		let event: Event;
		let rumorId: string;
		let payload: { contextId: string };
		try {
			const signed = await signMessageEvent({
				signer: this.signer,
				recipientPubkey: recipient,
				text: message.text,
				subject: message.subject ?? null,
				contextId: message.contextId ?? null,
				contentType: message.contentType,
				autoDepth: message.autoDepth,
				evidence: message.evidence,
				nowSec: nowSec(),
			});
			event = signed.event;
			rumorId = signed.rumorId;
			payload = signed.payload;
		} catch (err) {
			// An oversize payload (serialized past NIP-44's cap) must fail cleanly,
			// not surface encrypt's throw as a 500 / a misleading "publish failed".
			if (err instanceof AgxPayloadTooLargeError) {
				this.logger?.warn?.(
					"AGX: message too large to encrypt; not publishing",
					{ error: err.message },
				);
				return {
					ok: false,
					eventId: "",
					contextId: message.contextId ?? "",
					accepted: 0,
					total: 0,
					errors: [err.message],
					rejected: [],
				};
			}
			throw err;
		}
		// NIP-65: route to the recipient's relays ∪ ours (best-effort, cached).
		const peerRelays = await this.cachedPeerRelays(recipient);
		const targets = Array.from(new Set([...this.relays, ...peerRelays]));
		const published = await publishToRelays(targets, event, this.signer);

		// "Some relay took it" is not the same as "the recipient can read it".
		// The recipient polls THEIR relays, so if we know that set and every one
		// of them refused, the message is undelivered no matter how many of ours
		// accepted — which is exactly how an oversize event used to report
		// success: our relay stored it, the peer's rejected it, accepted > 0.
		// Attribution is BY STRING. `publishToRelays` echoes back the exact URL it
		// was handed, and it was handed `targets` — which is built from these same
		// `peerRelays` strings — so the lookup holds by construction. It is the
		// one thing here that would break silently: if a normalization step ever
		// sits between `cachedPeerRelays` and what comes back in `rejected[]`,
		// every refusal misses this set and a refused send reports as delivered.
		// Keep the two ends reading from the same strings.
		//
		// Split by KIND, because only one of the two is a verdict. `rejected[]`
		// used to bucket a connect timeout, a DNS failure and an `OK false`
		// identically, so a peer relay bouncing during THEIR deploy came back as
		// "every relay they advertise refused it" -> ok:false. Per `claude.md`,
		// ok:false feeds `escalatePersistentToolBlockers` and pages a human — so a
		// routine restart on someone else's infrastructure woke someone up on
		// ours, and the agent then resent onto a contextId that already had a row.
		const refused = new Set(
			published.rejected
				.filter((r) => r.kind === "refused")
				.map((r) => r.relay),
		);

		// Deduped, not filtered against `targets`: every element of `peerRelays`
		// is in `targets` by construction (it is one of the two sets `targets` is
		// built from), so filtering was a no-op that read like a guard. What
		// actually needed handling is a peer advertising the same relay twice,
		// which would otherwise count twice below.
		const peerTargets = Array.from(new Set(peerRelays));
		// NOT ACCEPTED IS NOT ACCEPTED, whatever the kind. Membership in
		// `rejected[]` is the complete answer to "did this relay take it", and
		// `kind` is optional on the AgxTransport interface — so subtracting only
		// the two CLASSIFIED buckets counted an unclassified rejection as an
		// acceptance, yielding `deliveredToPeer: true` for a relay that
		// demonstrably did not take the event. `kind` is consulted below, where
		// the `false` verdict genuinely needs it.
		const notAccepted = new Set(published.rejected.map((r) => r.relay));
		const peerAccepted = peerTargets.filter(
			(url) => !notAccepted.has(url),
		).length;
		// THREE outcomes. `undefined` means unknown and is not the same as false:
		//
		//  - any peer relay took it              -> true
		//  - every peer relay ANSWERED and said no -> false, a real delivery failure
		//  - anything else                        -> undefined
		//
		// The last branch covers both "they advertise no relays" (no NIP-65, so we
		// published to ours and cannot know) and "at least one was unreachable" (a
		// relay we could not reach might well have accepted it). Claiming failure
		// in either case asserts something we did not observe — and under the
		// NIP-65 outbox model the peer may still read the event from one of OUR
		// write relays, which is the same argument the recordOutbound comment in
		// egress.ts makes for filing the audit row.
		//
		// The oversize-event bug this mechanism exists for is unaffected: an event
		// over the peer's maxEventSize is answered `OK false` by every one of
		// their relays, so it still lands on `false`.
		const deliveredToPeer =
			peerTargets.length === 0
				? undefined
				: peerAccepted > 0
					? true
					: peerTargets.every((url) => refused.has(url))
						? false
						: undefined;

		if (deliveredToPeer === false) {
			this.logger?.warn?.(
				"AGX: published, but every relay the recipient advertises refused it",
				{
					recipient,
					peerRelays: peerTargets,
					rejected: published.rejected,
				},
			);
		}

		return {
			// A publish that reached none of the recipient's relays is not a
			// success, even though ours stored it. Deliberate behaviour change:
			// this previously returned ok:true and the sender was told the message
			// was delivered.
			ok: published.ok && deliveredToPeer !== false,
			// The RUMOR id, not the wrap's: it is what the peer's receipt will name
			// in `refEventId`, and what they dedupe on if this is ever re-wrapped.
			eventId: rumorId,
			contextId: payload.contextId,
			accepted: published.accepted,
			total: targets.length,
			errors: published.errors,
			rejected: published.rejected,
			deliveredToPeer,
		};
	}

	/** Whether a message body of `text` is DELIVERABLE — measured after
	 * serialization (the JSON-escaped payload, not the raw text) and bounded by
	 * what an arbitrary peer's relay will store, not by what NIP-44 can encrypt.
	 *
	 * Those are different numbers and the gap was a silent bug. NIP-44 accepts up
	 * to 65535 bytes of plaintext, which produces an ~87892-byte event —
	 * comfortably over strfry's DEFAULT maxEventSize of 65536. Since
	 * `publishMessage` routes to the recipient's NIP-65 relays as well as ours, a
	 * peer on defaults rejected anything above ~32KB while `publishToRelays`
	 * still reported success on the strength of OUR relay accepting it.
	 *
	 * So the ceiling here is the interop one. A recipient's own inbox relay may be
	 * deliberately more generous (to accept inbound events up to NIP-44 max); that
	 * generosity does not help what we SEND. */
	canCarry(text: string): boolean {
		// Characters first, same ordering and same reason as publishMessage: the
		// byte measurement is taken through `buildExchangePayload`, so before it
		// threw, this returned TRUE for text it would silently truncate — a
		// public `AgxTransport` method answering "yes, deliverable" about a body
		// that could not be delivered whole. Now it would throw instead, which is
		// worse for a predicate. Answer the question.
		if (text.length > MAX_BODY) {
			return false;
		}
		return (
			worstCaseEventBytes(exchangeMessagePlaintextBytes(text)) <=
			INTEROP_MAX_EVENT_BYTES
		);
	}

	async publishReceipt(
		to: string,
		receipt: {
			refEventId: string;
			contextId: string;
			status: ReceiptStatus;
			readAt?: string;
		},
	): Promise<{ ok: boolean }> {
		const recipient = normalizePubkey(to);
		if (!recipient) {
			throw new Error(`Invalid recipient identity: "${to}"`);
		}
		const { event } = await signReceiptEvent({
			signer: this.signer,
			recipientPubkey: recipient,
			refEventId: receipt.refEventId,
			contextId: receipt.contextId,
			status: receipt.status,
			readAt: receipt.readAt,
			nowSec: nowSec(),
		});
		// Mirrors publishMessage's routing: a peer polling only their own
		// relays would otherwise never see this receipt. Still returns
		// `{ ok: published.ok }`, not publishMessage's tri-state
		// `deliveredToPeer` — deliberate, both callers discard the result.
		// A cache MISS here costs one resolution (RELAY_OP_TIMEOUT_MS +
		// up to MAX_PEER_CANDIDATES DNS checks) — worth knowing when sizing
		// ingest.ts's poll lease / cron maxDuration.
		const peerRelays = await this.cachedPeerRelays(recipient);
		const targets = Array.from(new Set([...this.relays, ...peerRelays]));
		const published = await publishToRelays(targets, event, this.signer);
		return { ok: published.ok };
	}

	async poll(opts: {
		since: number;
		limit?: number;
		isKnown?: (transportIds: string[]) => Promise<Set<string>>;
	}): Promise<AgxPollResult> {
		const { events, complete } = await pollInbox({
			relays: this.relays,
			pubkey: this.publicKey,
			since: opts.since,
			limit: opts.limit,
			signer: this.signer,
			logger: this.logger,
		});
		// Opening a wrap is two ECDHs, the outer one against a one-time key that
		// can never be cached — and the poll window re-covers two days of wraps
		// every time (the NIP-59 backdate). So ask the host which wraps it has
		// already handled, and skip those before any decryption.
		const known = opts.isKnown
			? await opts.isKnown(events.map((event) => event.id))
			: new Set<string>();
		const messages: AgxPollResult["messages"] = [];
		const receipts: AgxPollResult["receipts"] = [];
		// Wraps we fetched but will never accept. Reported so the host records
		// them and `isKnown` skips them next time: otherwise anyone who can
		// address a wrap to us makes us re-open it on every poll until it expires.
		const discarded: string[] = [];
		let unopenable = 0;
		let malformed = 0;
		let signerUnavailable: AgxSignerUnavailableError | undefined;
		const now = nowSec();
		for (const event of events) {
			if (known.has(event.id)) {
				continue;
			}
			// NIP-40: a relay that has not purged an expired wrap yet may still
			// serve it, and its sender meant it to be gone. Dropped before any
			// decryption work.
			const expiration = eventExpiration(event);
			if (expiration !== null && expiration <= now) {
				discarded.push(event.id);
				continue;
			}
			let unwrapped: UnwrappedRumor | null;
			try {
				unwrapped = await unwrapRumor({ signer: this.signer, event });
			} catch (err) {
				if (!isSignerUnavailable(err)) {
					throw err;
				}
				// The signer is down, not the wraps bad: stop opening, discard
				// none of the rest, and report the poll incomplete so the host holds
				// its cursor and the next poll sees them again. What was opened
				// before this point is still returned — safe, the cursor holds.
				signerUnavailable = err;
				break;
			}
			if (!unwrapped) {
				unopenable += 1;
				discarded.push(event.id);
				continue;
			}
			// A receipt with a status a newer peer added: ignored, by the spec,
			// rather than counted and warned about as malformed. Recorded as seen
			// so it is not reopened on the next poll.
			if (isIgnorableReceiptRumor(unwrapped)) {
				discarded.push(event.id);
				continue;
			}
			const receipt = openReceiptRumor(unwrapped);
			if (receipt) {
				receipts.push({
					from: receipt.senderPubkey,
					eventId: receipt.eventId,
					transportId: event.id,
					createdAt: receipt.createdAt,
					sentAt: receipt.sentAt,
					receipt: receipt.receipt,
				});
				continue;
			}
			const opened = openMessageRumor(unwrapped);
			if (opened) {
				messages.push({
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
			} else {
				malformed += 1;
				discarded.push(event.id);
			}
		}
		// One line per poll, not per event: a systemic failure (wrong key,
		// corrupt relay data, forged seals) stays visible, and a junk flood
		// cannot turn into a log flood — each wrap is counted once, on first
		// sight, because the host records `discarded` and skips it after that.
		if (unopenable > 0 || malformed > 0) {
			this.logger?.warn?.("AGX: skipped gift wraps we cannot accept", {
				undecryptableOrUnverifiable: unopenable,
				malformedRumor: malformed,
			});
		}
		if (signerUnavailable) {
			this.logger?.warn?.(
				"AGX: signer unavailable; left the rest of the inbox for the next poll",
				{ error: signerUnavailable.message },
			);
		}
		return {
			messages,
			receipts,
			complete: complete && !signerUnavailable,
			discarded,
		};
	}

	async resolvePeer(id: string): Promise<AgxResolvedPeer> {
		const pk = normalizePubkey(id);
		if (!pk) {
			return { relays: [], card: null };
		}
		const [relays, card] = await Promise.all([
			this.cachedPeerRelays(pk),
			this.cachedPeerCard(pk),
		]);
		return { relays, card };
	}

	async verifyIdentity(
		id: string,
	): Promise<{ id: string; domain: string; verified: true } | null> {
		const pk = normalizePubkey(id);
		if (!pk) {
			return null;
		}
		const r = await resolveNip05({
			pubkey: pk,
			relays: this.relays,
			signer: this.signer,
		}).catch(() => null);
		return r
			? { id: r.nip05, domain: r.nip05Domain, verified: true }
			: null;
	}

	/** Advertise capabilities and optional typed skills via the Agent Card. */
	async advertise(
		capabilities: string[],
		meta?: {
			org?: string;
			nip05?: string | null;
			payloadTypes?: string[];
			skills?: AgentSkill[];
		},
	): Promise<{ ok: boolean }> {
		return this.publishDiscovery({
			org: meta?.org ?? "agent",
			capabilities,
			payloadTypes: meta?.payloadTypes ?? ["application/a2a+json"],
			nip05: meta?.nip05 ?? null,
			skills: meta?.skills,
		});
	}

	/** Publish (or refresh) this agent's Agent Card + NIP-65 relay list so peers
	 * can discover it. UNENCRYPTED public metadata — call only when discoverable. */
	async publishDiscovery(params: {
		org: string;
		capabilities: string[];
		payloadTypes: string[];
		nip05?: string | null;
		encryption?: string[];
		skills?: AgentSkill[];
		extensions?: AgentCardExtension[];
	}): Promise<{ ok: boolean }> {
		const card: AgentCard = buildCard({
			org: params.org,
			pubkey: this.publicKey,
			nip05: params.nip05 ?? null,
			relays: this.relays,
			capabilities: params.capabilities,
			payloadTypes: params.payloadTypes,
			encryption: params.encryption,
			skills: params.skills,
			extensions: params.extensions,
		});
		const now = nowSec();
		const a = await publishToRelays(
			this.relays,
			await signCardEvent(this.signer, card, now),
			this.signer,
		);
		const b = await publishToRelays(
			this.relays,
			await signRelayListEvent(this.signer, this.relays, now),
			this.signer,
		);
		return { ok: a.ok && b.ok };
	}
}
