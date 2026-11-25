/** A secret key always starts `nsec1`, and a password-protected one (NIP-49)
 * `ncryptsec1`. Matched anywhere and in any case, so also behind `nostr:` or
 * with a typo in the rest of it. The same rule as the CLI's `holdsSecretKey`. */
const SECRET_KEY_IN_TEXT = /n(crypt)?sec1/i;

/** True when `text` holds something that looks like a secret key. */
export function holdsSecretKey(text: string): boolean {
	return SECRET_KEY_IN_TEXT.test(text);
}

/** `text` as it may be quoted in an error: never one that holds a secret key.
 * An n8n error lands in the execution log and in the editor. */
export function shown(text: string): string {
	return holdsSecretKey(text) ? "(a value with a secret key, not shown)" : text;
}

/**
 * A capability is a name such as `invoice.review`. It goes to the other agent
 * inside the request and onto the Agent Card, so a pasted secret key is refused
 * before anything is sent, and is never repeated.
 */
export function refuseSecretCapability(capability: string): void {
	if (holdsSecretKey(capability)) {
		throw new Error(
			"The capability must be a name such as invoice.review, not a secret key (nsec1…), which is not shown here.",
		);
	}
}
