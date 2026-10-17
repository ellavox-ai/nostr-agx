import { normalizePubkey } from "@nostr-agx/nostr";

/** Lists in node parameters: entries separated by commas, spaces or new lines. */
function splitList(input: string): string[] {
	return input
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** An agent's identity as lowercase hex, from an `npub1…` key or 64 hex
 * characters. Throws with a message fit to show the user. */
export function parsePeer(input: string, label = "agent"): string {
	const hex = normalizePubkey(input);
	if (!hex) {
		throw new Error(
			`The ${label} must be an npub1… key or a 64-character hex public key, not "${input.trim()}".`,
		);
	}
	return hex;
}

/** A list of agents, as hex. Every unparseable entry is named in one error,
 * because an allowlist silently missing a peer looks exactly like that peer
 * being denied. */
export function parsePeerList(input: string): string[] {
	const out = new Set<string>();
	const invalid: string[] = [];
	for (const entry of splitList(input)) {
		const hex = normalizePubkey(entry);
		if (hex) {
			out.add(hex);
		} else {
			invalid.push(entry);
		}
	}
	if (invalid.length > 0) {
		throw new Error(
			`These are not npub1… keys or 64-character hex public keys: ${invalid.join(", ")}`,
		);
	}
	return [...out];
}

/** Dot-namespaced capability keys (`invoice.review`), as the Agent Card
 * advertises them. */
export function parseCapabilities(input: string): string[] {
	return [...new Set(splitList(input))];
}
