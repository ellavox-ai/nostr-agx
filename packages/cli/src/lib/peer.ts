import { normalizePubkey, toNpub } from "@nostr-agx/nostr";
import { usageError } from "./errors.js";
import { loadIdentityFile } from "./identity.js";
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

/**
 * True when `input` is the secret key of this profile, as 64 hex characters in any case or as the npub that
 * carries the same bytes. A profile with no identity file, or one that cannot be read, has no key to compare
 * with, so it is false there.
 */
export function isOwnSecretKey(input: string, profileName: string): boolean {
	const hex = normalizePubkey(input);
	if (hex === null) {
		return false;
	}
	try {
		// The key is only compared here, never used, so loose file permissions do not matter.
		return hex === loadIdentityFile(profileName, { allowInsecurePerms: true }).secretKeyHex.toLowerCase();
	} catch {
		return false;
	}
}

/**
 * Refuse this profile's own secret key given as a peer, without showing it. A secret key is also 64 hex
 * characters, or an npub that carries the same bytes, so by its shape it passes for a public key and would be
 * stored, printed back as an npub or sent to a relay. Only the key in the identity file of the profile named
 * here is compared. The secret key of another profile, or of another agent, is not recognised and passes
 * like a public key.
 */
export function refuseOwnSecretKey(input: string, profileName: string, label = "peer"): void {
	if (isOwnSecretKey(input, profileName)) {
		throw usageError(
			`The ${label} you gave is this profile's own secret key, not a public one, so it is not shown here. Expected the npub1… or 64-character hex pubkey of another agent.`,
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

/** What the UI's `toNpub` dependency does: any recipient or peer a request names, as a strict npub. Throws when it is not one. */
export function uiToNpub(input: string): string {
	return toDisplayNpub(toHexPubkey(input.trim(), "recipient"));
}
