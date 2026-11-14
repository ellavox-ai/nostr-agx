import { normalizePubkey, toNpub } from "@nostr-agx/nostr";
import { usageError } from "./errors.js";

const PASTED_SECRET_KEY = /nsec1/i;

/** Peer identity input is always accepted as npub or hex and normalized to hex
 * immediately — `authorize`'s `from` is raw hex, so comparing anything else
 * silently never matches, which is the worst possible failure for an allowlist. */
export function toHexPubkey(input: string, label = "identity"): string {
	const hex = normalizePubkey(input.trim());
	if (!hex) {
		// A secret key pasted where a peer belongs must not come back in the error: stderr
		// lives on in terminal scrollback, logs and an agent's context. Matching `nsec1`
		// anywhere in the value, in any case, also covers a `nostr:` scheme and a typo.
		if (PASTED_SECRET_KEY.test(input)) {
			throw usageError(
				`The ${label} you gave is a secret key (nsec1…), not a public one, so it is not shown here. Expected an npub1… or a 64-character hex pubkey.`,
			);
		}
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
