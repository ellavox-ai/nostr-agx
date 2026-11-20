import type { Event } from "nostr-tools";
import { z } from "zod";
import { toNpub } from "./address";
import { CARD_KIND, RELAY_LIST_KIND } from "./kinds";
import { fetchByAuthor, fetchByAuthorWithStatus } from "./relay-pool";
import type { AgxSigner } from "./signer";
import { assertPublicUrl } from "./ssrf";
import type { WebSocketImpl } from "./ws";

/**
 * NIP-AGX discovery: publish/resolve a signed, UNENCRYPTED Agent Card + NIP-65
 * relay list, and verify a peer's NIP-05 domain identity. Peer-controlled URLs
 * (relay lists, NIP-05 hosts) are SSRF-guarded before any dial/fetch.
 */

export const CARD_VERSION = "1.0.0";
/** Cap peer-advertised relays we'll accept (SSRF blast-radius + fan-out). */
const MAX_PEER_RELAYS = 10;
/** Cap DISTINCT peer-advertised relay candidates we'll even DNS-check, so a card
 * with thousands of failing `r` tags can't fan out into thousands of lookups. */
const MAX_PEER_CANDIDATES = 20;
/** Ceiling on a `.well-known/nostr.json` body we'll read. */
const MAX_NIP05_BYTES = 100_000;

/** Attacker-controlled Agent Card content — validated, bounded, string-typed
 * before use (feeds capability matching + SSRF-guarded relay dials). */
const peerCardContentSchema = z.object({
	org: z.string().max(200).nullish(),
	nip05: z.string().max(253).nullish(),
	capabilities: z.array(z.string().max(200)).max(64).nullish(),
	relays: z.array(z.string().max(512)).max(MAX_PEER_RELAYS).nullish(),
});

export interface AgentCard {
	v: 1;
	org: string;
	npub: string;
	/** Claimed NIP-05 (`name@domain`); UNVERIFIED as published. */
	nip05: string | null;
	relays: string[];
	capabilities: string[];
	payloadTypes: string[];
	encryption: string[];
	version: string;
}

/** Build an Agent Card object for the given identity/metadata. */
export function buildCard(params: {
	org: string;
	pubkey: string;
	nip05?: string | null;
	relays: string[];
	capabilities: string[];
	payloadTypes: string[];
	encryption?: string[];
}): AgentCard {
	return {
		v: 1,
		org: params.org,
		npub: toNpub(params.pubkey),
		nip05: params.nip05 ?? null,
		relays: params.relays,
		capabilities: params.capabilities,
		payloadTypes: params.payloadTypes,
		encryption: params.encryption ?? ["nip44"],
		version: CARD_VERSION,
	};
}

/** Sign a replaceable Agent Card event (kind 11337, UNENCRYPTED). */
export function signCardEvent(
	signer: AgxSigner,
	card: AgentCard,
	nowSec: number,
): Promise<Event> {
	return signer.signEvent({
		kind: CARD_KIND,
		created_at: nowSec,
		tags: card.nip05 ? [["nip05", card.nip05]] : [],
		content: JSON.stringify(card),
	});
}

/** Sign a NIP-65 relay-list event (kind 10002). */
export function signRelayListEvent(
	signer: AgxSigner,
	relays: string[],
	nowSec: number,
): Promise<Event> {
	return signer.signEvent({
		kind: RELAY_LIST_KIND,
		created_at: nowSec,
		tags: relays.map((r) => ["r", r]),
		content: "",
	});
}

/** Peer relays plus the public addresses they were vetted against. */
export interface ResolvedPeerRelays {
	relays: string[];
	/** hostname → public addresses from the SSRF guard. A caller dialing through
	 * a remote-DNS SOCKS proxy must pin these; otherwise the proxy can resolve
	 * the hostname again to a tailnet/private address (DNS rebinding). */
	pins: Map<string, string[]>;
}

/** Resolve a peer's advertised relays (NIP-65). SSRF-guarded (public `wss://`)
 * and capped, since each becomes an outbound dial. Also returns the addresses
 * the guard approved, so a proxied transport can avoid a second DNS lookup. */
export async function resolvePeerRelaysWithPins(
	pubkey: string,
	relays: string[],
	signer?: AgxSigner,
	ws?: WebSocketImpl,
): Promise<ResolvedPeerRelays> {
	const empty = { relays: [] as string[], pins: new Map<string, string[]>() };
	if (relays.length === 0) {
		return empty;
	}
	const events = await fetchByAuthor({
		relays,
		author: pubkey,
		kinds: [RELAY_LIST_KIND],
		limit: 1,
		signer,
		ws,
	});
	const latest = events[0];
	if (!latest) {
		return empty;
	}
	// Dedupe + CAP the candidate set BEFORE the guard, so a card advertising
	// thousands of failing `r` tags can't fan out into thousands of DNS lookups.
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const t of latest.tags) {
		if (t[0] !== "r" || typeof t[1] !== "string" || seen.has(t[1])) {
			continue;
		}
		seen.add(t[1]);
		candidates.push(t[1]);
		if (candidates.length >= MAX_PEER_CANDIDATES) {
			break;
		}
	}
	const safe: string[] = [];
	const pins = new Map<string, string[]>();
	for (const url of candidates) {
		if (safe.length >= MAX_PEER_RELAYS) {
			break;
		}
		const check = await assertPublicUrl(url, { protocols: ["wss:"] });
		if (!check.ok || !check.addresses?.length) {
			continue;
		}
		safe.push(url);
		let host: string;
		try {
			host = new URL(url).hostname.toLowerCase();
		} catch {
			// assertPublicUrl already parsed it; this is only a defensive guard.
			continue;
		}
		const existing = pins.get(host);
		pins.set(host, existing ? [...existing, ...check.addresses] : check.addresses);
	}
	return { relays: safe, pins };
}

/** Resolve only the URLs. Kept for callers that do not dial through a proxy. */
export async function resolvePeerRelays(
	pubkey: string,
	relays: string[],
	signer?: AgxSigner,
	ws?: WebSocketImpl,
): Promise<string[]> {
	return (await resolvePeerRelaysWithPins(pubkey, relays, signer, ws)).relays;
}

/** A peer's Agent Card, as {@link resolvePeerCard} returns it. */
export interface PeerCard {
	displayName: string | null;
	capabilities: string[];
	nip05: string | null;
}

/** Resolve a peer's Agent Card. Best-effort; null when none/malformed. */
export async function resolvePeerCard(
	pubkey: string,
	relays: string[],
	signer?: AgxSigner,
	ws?: WebSocketImpl,
): Promise<PeerCard | null> {
	if (relays.length === 0) {
		return null;
	}
	const events = await fetchByAuthor({
		relays,
		author: pubkey,
		kinds: [CARD_KIND],
		limit: 1,
		signer,
		ws,
	});
	return parsePeerCard(events[0]);
}

/**
 * {@link resolvePeerCard}, plus whether any relay could be read at all.
 * `reachable: false` means "unknown", not "no card": a caller that would act
 * irreversibly on a missing card (drop a first contact) must not treat a relay
 * outage as the sender having none.
 */
export async function resolvePeerCardWithStatus(
	pubkey: string,
	relays: string[],
	signer?: AgxSigner,
	ws?: WebSocketImpl,
): Promise<{ card: PeerCard | null; reachable: boolean }> {
	if (relays.length === 0) {
		return { card: null, reachable: false };
	}
	const { events, answered } = await fetchByAuthorWithStatus({
		relays,
		author: pubkey,
		kinds: [CARD_KIND],
		limit: 1,
		signer,
		ws,
	});
	return { card: parsePeerCard(events[0]), reachable: answered > 0 };
}

function parsePeerCard(latest: Event | undefined): PeerCard | null {
	if (!latest) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(latest.content);
	} catch {
		return null;
	}
	// The card is attacker-controlled JSON — validate before use. A malformed or
	// oversize card (e.g. non-string capability elements that would crash the
	// capability matcher) is ignored rather than trusted.
	const parsed = peerCardContentSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const c = parsed.data;
	return {
		displayName: c.org ? c.org.slice(0, 120) : null,
		capabilities: c.capabilities ?? [],
		nip05: c.nip05 ?? null,
	};
}

/**
 * Resolve + VERIFY a peer's NIP-05 identity: the peer's card claims `name@domain`;
 * trust it only if `https://domain/.well-known/nostr.json?name=<name>` maps that
 * name back to the peer's pubkey. SSRF-guarded, timeout + size-capped, best-effort.
 */
export async function resolveNip05(params: {
	pubkey: string;
	relays: string[];
	signer?: AgxSigner;
	ws?: WebSocketImpl;
}): Promise<{
	nip05: string;
	nip05Domain: string;
	nip05Verified: true;
} | null> {
	const card = await resolvePeerCard(
		params.pubkey,
		params.relays,
		params.signer,
		params.ws,
	);
	const claimed = card?.nip05;
	if (!claimed) {
		return null;
	}
	const at = claimed.indexOf("@");
	if (at <= 0) {
		return null;
	}
	const parsed = parseNip05(claimed);
	if (!parsed) {
		return null;
	}
	const verified = await fetchNip05Pubkey(parsed.name, parsed.domain);
	if (verified !== params.pubkey) {
		return null;
	}
	return {
		nip05: claimed,
		nip05Domain: parsed.domain,
		nip05Verified: true,
	};
}

/** Split + validate a `name@domain` NIP-05 identifier. Null when malformed. The
 * domain is lowercased; the name keeps its case (NIP-05 `names` keys are
 * case-sensitive). */
export function parseNip05(
	identifier: string,
): { name: string; domain: string } | null {
	const at = identifier.indexOf("@");
	if (at <= 0) {
		return null;
	}
	const name = identifier.slice(0, at);
	const domain = identifier.slice(at + 1).toLowerCase();
	if (!/^[a-z0-9._-]+$/i.test(name) || !/^[a-z0-9.-]+$/.test(domain)) {
		return null;
	}
	return { name, domain };
}

/**
 * Resolve `https://<domain>/.well-known/nostr.json?name=<name>` to the pubkey the
 * domain publishes for that name — the NIP-05 primitive. Returns lowercase hex, or
 * null when the host is unsafe/unreachable, the response is malformed, or the name
 * is absent.
 *
 * This is the portable half of domain identity: a caller proves "domain X vouches
 * for pubkey P" by comparing this result to P, and ANY party can re-run the same
 * check independently. Peer-controlled URL, so it is SSRF-guarded, redirect-refusing,
 * timeout-bounded and size-capped.
 */
export async function fetchNip05Pubkey(
	name: string,
	domain: string,
): Promise<string | null> {
	const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
	const guard = await assertPublicUrl(url, { protocols: ["https:"] });
	if (!guard.ok) {
		return null;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch(url, {
			redirect: "error",
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!res.ok) {
			return null;
		}
		const lengthHeader = res.headers.get("content-length");
		if (lengthHeader && Number(lengthHeader) > MAX_NIP05_BYTES) {
			return null;
		}
		// Read with a RUNNING byte cap and abort — a chunked response omits
		// content-length, and `res.text()` would buffer the whole (peer-controlled)
		// body before any length check.
		const text = await readBodyCapped(res, MAX_NIP05_BYTES);
		if (text === null) {
			return null;
		}
		const json = JSON.parse(text) as { names?: Record<string, string> };
		const mapped = json.names?.[name];
		return typeof mapped === "string" ? mapped.toLowerCase() : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** Read a response body as text, aborting once `maxBytes` is exceeded. Returns
 * null if the cap is hit or the body can't be read. */
async function readBodyCapped(
	res: Response,
	maxBytes: number,
): Promise<string | null> {
	const reader = res.body?.getReader();
	if (!reader) {
		return null;
	}
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
		}
	} catch {
		return null;
	}
	const total = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		total.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(total);
}
