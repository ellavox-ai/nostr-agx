/**
 * @nostr-agx/nostr — the Nostr transport binding for `@nostr-agx/core`.
 *
 * Implements `AgxTransport` over Nostr: messages and receipts as NIP-59 gift
 * wraps (kind 1059, carrying 3838/3839 rumors) with NIP-40 expiration and NIP-13
 * proof-of-work; an `AgxSigner` seam (NIP-07/NIP-46-shaped) for every key
 * operation; a relay pool (paged poll, publish with retries), NIP-65 routing,
 * NIP-42 auth, and Agent Card + NIP-05 discovery. The WebSocket implementation
 * is injected (Node passes `ws`; browser/edge use the global).
 */

export const AGX_NOSTR_VERSION = "0.4.0";

// Re-exported so hosts can verify a peer-supplied signed event (e.g. a key
// possession proof) without taking their own `nostr-tools` dependency — this
// package stays the single place the Nostr primitives are pinned.
export type { Event as NostrEvent } from "nostr-tools";
export { verifyEvent } from "nostr-tools";

export * from "./address";
export * from "./discovery";
export * from "./events";
// Explicit, not `export *`: giftwrap.ts also holds a test-only miner seam that
// must not become public API. Tests import it from "./giftwrap" directly.
export {
	AGX_POW_BITS,
	createRumor,
	eventExpiration,
	MAX_EXPIRATION_SEC,
	MAX_WRAP_BACKDATE_SEC,
	type Rumor,
	type UnwrappedRumor,
	unwrapRumor,
	WRAP_TTL_SEC,
	wrapRumor,
} from "./giftwrap";
export * from "./ids";
export * from "./keys";
export * from "./kinds";
export type { NostrTransportConfig } from "./nostr-transport";
export { NostrTransport } from "./nostr-transport";
export type { FetchByAuthorResult, RelayFailureKind } from "./relay-pool";
export {
	DEFAULT_POLL_LIMIT,
	fetchByAuthor,
	fetchByAuthorWithStatus,
	pollInbox,
	publishToRelays,
} from "./relay-pool";
export * from "./signer";
export {
	assertPublicHttpsUrl,
	assertPublicUrl,
	type UrlSafetyResult,
} from "./ssrf";
export { configureWebSocket } from "./ws";
