import { nip19 } from "nostr-tools";

/**
 * Nostr identity addressing helpers. Pure (no WebSockets/crypto side effects).
 */

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Normalize an `npub1…` or 64-char hex pubkey to lowercase hex; null if neither.
 * An npub must carry exactly 32 bytes: nostr-tools decodes one of any length.
 */
export function normalizePubkey(input: string): string | null {
	const s = input.trim();
	if (HEX64.test(s)) {
		return s.toLowerCase();
	}
	if (s.startsWith("npub1")) {
		try {
			const decoded = nip19.decode(s);
			if (decoded.type === "npub" && typeof decoded.data === "string" && HEX64.test(decoded.data)) {
				return decoded.data;
			}
		} catch {
			return null;
		}
	}
	return null;
}

/** Encode a hex pubkey as an `npub1…` bech32 identity (for display). */
export function toNpub(pubkeyHex: string): string {
	return nip19.npubEncode(pubkeyHex);
}

/** Short, human-friendly identity label: NIP-05 if present, else `npub1abc…xyz`. */
export function shortIdentity(
	pubkeyHex: string,
	nip05?: string | null,
): string {
	if (nip05) {
		return nip05;
	}
	try {
		const npub = toNpub(pubkeyHex);
		return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
	} catch {
		return `${pubkeyHex.slice(0, 12)}…`;
	}
}
