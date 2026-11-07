import type { AgxJsonSchema } from "./json-schema";
import type {
	ExchangeEvidence,
	ParsedExchangeMessage,
	ReceiptPayload,
	ReceiptStatus,
} from "./wire";

/**
 * The transport seam. A binding (e.g. `@nostr-agx/nostr`) implements confidential,
 * authenticated delivery between agent identities; `@nostr-agx/core` layers task
 * lifecycle, correlation, receipts, replay protection, and capability matching on
 * top. Identities are opaque strings the binding understands (hex pubkey / npub
 * for Nostr).
 *
 * Draft v0.2 — the surface is finalized alongside the `AgxClient` in the core
 * protocol layer.
 */
export interface AgxTransport {
	/** This agent's own identity (e.g. hex pubkey). */
	whoami(): string;

	/** How far BEFORE the true send time this transport may stamp an event's
	 * `createdAt` (seconds). A binding that deliberately obscures timing — the
	 * Nostr one backdates gift wraps up to two days (NIP-59) — declares it here,
	 * and `AgxClient` polls that much further behind its cursor so a backdated
	 * event is never skipped. Omit (or 0) when timestamps are honest. */
	readonly pollLookbackSec?: number;

	/** Canonicalize a peer identity to the transport's stable form (e.g. `npub…` →
	 * hex pubkey) so identity comparisons (result-sender binding) hold regardless of
	 * the caller's encoding. Bindings that need no canonicalization may omit it. */
	normalizeIdentity?(id: string): string;

	/** Publish a message to a peer. Returns the transport message id (for receipt
	 * correlation + replay) and the contextId actually used. `accepted`/`total`/
	 * `errors`/`rejected` are optional per-relay fan-out detail for hosts that
	 * surface it.
	 *
	 * `ok` means DELIVERABLE, not merely "something stored it". A transport that
	 * fans out to both its own and the recipient's endpoints must not report
	 * success when only its own accepted — the recipient reads from theirs, so
	 * that is a delivery failure wearing a success. Where the distinction is
	 * knowable, report it in `deliveredToPeer`. */
	publishMessage(
		to: string,
		message: {
			text: string;
			subject?: string | null;
			contextId?: string | null;
			contentType?: string;
			/** Automated-reply depth to declare on this message. Set it to
			 * `(inbound.autoDepth ?? 0) + 1` on an automated reply; leave it unset
			 * for anything a human authored, approved or asked for. See
			 * "Automated-reply depth" in SPEC.md. */
			autoDepth?: number;
			/** Records quoted in support of `text`. Sender-declared; see
			 * "Evidence" in SPEC.md. Counted in the size check, and refused
			 * (`ok: false`) when it does not fit the wire schema. */
			evidence?: ExchangeEvidence;
		},
	): Promise<{
		ok: boolean;
		eventId: string;
		contextId: string;
		accepted?: number;
		total?: number;
		errors?: string[];
		/** Which endpoints did not take it, why, and which KIND of failure it was.
		 * Attributed rather than flattened, so a host can tell "the recipient's
		 * relay rejected this" from "one of ours was briefly down" — outcomes that
		 * look identical in a count.
		 *
		 * `kind` separates a verdict from an absence of one: "refused" means the
		 * endpoint answered and said no, "unreachable" means we never got an
		 * answer. Only the first is evidence of anything. Optional so a transport
		 * that cannot tell them apart may omit it rather than guess. */
		rejected?: {
			relay: string;
			error: string;
			kind?: "refused" | "unreachable";
		}[];
		/** Whether at least one endpoint the RECIPIENT advertises accepted it.
		 * `undefined` means the transport could not determine the recipient's
		 * endpoints — unknown, which is not the same as false. */
		deliveredToPeer?: boolean;
	}>;

	/** Whether a message body of `text` survives this transport's wire limit AFTER
	 * the binding serializes/encrypts it. The byte cap is a transport property (e.g.
	 * NIP-44's 65535-byte plaintext limit applies to the JSON-escaped payload, which
	 * can be 2–6x the raw text), so the core defers to this when present and falls
	 * back to a conservative built-in byte cap when it is absent. */
	canCarry?(text: string): boolean;

	/** Publish a delivery-ack receipt back to a message's sender. `readAt` is
	 * carried only with `status: "read"`. */
	publishReceipt(
		to: string,
		receipt: {
			refEventId: string;
			contextId: string;
			status: ReceiptStatus;
			readAt?: string;
		},
	): Promise<{ ok: boolean }>;

	/** Drain messages + receipts addressed to us since a cursor. `complete` is
	 * false when a source may hold events we didn't see (so the caller should not
	 * advance its cursor past them). */
	poll(opts: {
		since: number;
		limit?: number;
		/** Which of these transport ids the host has already handled. A binding
		 * whose per-event work is expensive (the Nostr one does two ECDHs per gift
		 * wrap) calls this BEFORE that work and skips the known ones, so re-scanning
		 * an overlapping window costs one batched lookup instead of re-opening
		 * every event. `AgxClient` wires it to its SeenStore. Optional both ways: a
		 * binding may ignore it, and a caller may omit it. */
		isKnown?: (transportIds: string[]) => Promise<Set<string>>;
	}): Promise<AgxPollResult>;

	/** Resolve a peer's routing relays + advertised capability card. */
	resolvePeer(id: string): Promise<AgxResolvedPeer>;

	/** Verify a peer's domain identity (e.g. NIP-05), if the binding supports it. */
	verifyIdentity?(
		id: string,
	): Promise<{ id: string; domain: string; verified: true } | null>;

	/** Advertise this agent's capabilities (+ optional discovery metadata) so peers
	 * can find + capability-match it. Bindings that don't support discovery omit it. */
	advertise?(
		capabilities: string[],
		meta?: {
			org?: string;
			nip05?: string | null;
			payloadTypes?: string[];
			skills?: AgxAgentSkill[];
		},
	): Promise<{ ok: boolean }>;

	/** Optional lifecycle hooks for bindings that hold connections. */
	start?(): Promise<void>;
	stop?(): Promise<void>;
}

export interface AgxIncomingMessage extends ParsedExchangeMessage {
	/** Sender identity. */
	from: string;
	/** Durable message id (receipt ref + replay key). Stable across re-sends of
	 * the same message, so a retry is recognized as a duplicate. */
	eventId: string;
	/** Transport timestamp: what the poll cursor advances on. May be earlier
	 * than the real send time by up to the transport's `pollLookbackSec`. */
	createdAt: number;
	/** When the sender says it sent this, if the transport carries that
	 * separately from `createdAt`. Sender-declared; display only. */
	sentAt?: number;
	/** The id of the transport envelope this arrived in, when it differs from
	 * `eventId` (a Nostr gift wrap's id vs. its rumor's). What `isKnown` is asked
	 * about; recorded as seen alongside `eventId`. */
	transportId?: string;
}

export interface AgxIncomingReceipt {
	from: string;
	/** Durable id of the receipt itself (replay key). */
	eventId: string;
	/** Transport timestamp (see {@link AgxIncomingMessage.createdAt}). */
	createdAt: number;
	/** Sender-declared send time (see {@link AgxIncomingMessage.sentAt}). */
	sentAt?: number;
	/** Envelope id (see {@link AgxIncomingMessage.transportId}). */
	transportId?: string;
	receipt: ReceiptPayload;
}

export interface AgxPollResult {
	messages: AgxIncomingMessage[];
	receipts: AgxIncomingReceipt[];
	complete: boolean;
	/** Transport ids the binding fetched but could not open or trust (bad
	 * encryption, forged seal, malformed payload, expired). The caller records
	 * them as seen so they are skipped via `isKnown` from then on — otherwise a
	 * junk event addressed to us is re-opened on every poll for as long as the
	 * relay keeps it. */
	discarded?: string[];
}

export interface AgxAgentSkill {
	id: string;
	description: string;
	tags?: string[];
	inputModes?: string[];
	outputModes?: string[];
	inputSchema?: AgxJsonSchema;
	outputSchema?: AgxJsonSchema;
	features?: string[];
}

export interface AgxAgentCardExtension {
	uri: string;
	required?: boolean;
}

export interface AgxAgentCardMetadataWarning {
	code: "invalid_typed_metadata" | "unsupported_required_extension";
	message: string;
}

export interface AgxPeerCard {
	displayName: string | null;
	capabilities: string[];
	/** Claimed (unverified) domain identity, e.g. NIP-05 `name@domain`. */
	nip05: string | null;
	skills?: AgxAgentSkill[];
	extensions?: AgxAgentCardExtension[];
	typedMetadataWarning?: AgxAgentCardMetadataWarning;
}

export interface AgxResolvedPeer {
	relays: string[];
	card: AgxPeerCard | null;
}
