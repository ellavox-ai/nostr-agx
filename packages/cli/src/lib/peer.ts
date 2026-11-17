import { normalizePubkey, toNpub } from "@nostr-agx/nostr";
import { usageError } from "./errors.js";
import { holdsSecretKey } from "./secrets.js";

/** True when a value looks like a pasted secret key, which must never be shown back to anyone.
 * Matching `nsec1` or `ncryptsec1` anywhere in the value, in any case, also covers a `nostr:` scheme and a typo. */
export function isPastedSecretKey(input: string): boolean {
	return holdsSecretKey(input);
}

/** Refuse a pasted secret key without showing it. Anything else passes. */
export function refuseSecretKey(input: string, label = "identity"): void {
	if (isPastedSecretKey(input)) {
		throw usageError(
			`The ${label} you gave is a secret key (nsec1…), not a public one, so it is not shown here. Expected an npub1… or a 64-character hex pubkey.`,
		);
	}
}

/** Peer identity input is always accepted as npub or hex and normalized to hex
 * immediately — `authorize`'s `from` is raw hex, so comparing anything else
 * silently never matches, which is the worst possible failure for an allowlist. */
export function toHexPubkey(input: string, label = "identity"): string {
	const hex = normalizePubkey(input.trim());
	if (!hex) {
		// A secret key pasted where a peer belongs must not come back in the error: stderr
		// lives on in terminal scrollback, logs and an agent's context.
		refuseSecretKey(input, label);
		throw usageError(
			`"${input}" is not a valid ${label} — expected an npub1… or a 64-character hex pubkey.`,
		);
	}
	return hex;
}

export function toDisplayNpub(hexOrNpub: string): string {
	const hex = normalizePubkey(hexOrNpub);
	return hex ? toNpub(hex) : hexOrNpub;
}
