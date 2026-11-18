import { normalizePubkey } from "@nostr-agx/nostr";
import { holdsSecretKey, refuseSecretCapability } from "./secrets";
import { asText } from "./text";

/** Lists in node parameters: entries separated by commas, spaces or new lines. */
function splitList(input: unknown): string[] {
	return asText(input)
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** An agent's identity as lowercase hex, from an `npub1…` key or 64 hex
 * characters. Throws with a message fit to show the user. */
export function parsePeer(input: unknown, label = "agent"): string {
	const text = asText(input).trim();
	const hex = normalizePubkey(text);
	if (!hex) {
		throw new Error(
			`The ${label} must be an npub1… key or a 64-character hex public key, not ${holdsSecretKey(text) ? "a secret key (nsec1…), which is not shown here" : `"${text}"`}.`,
		);
	}
	return hex;
}

/** A list of agents, as hex. Every unparseable entry is named in one error,
 * because an allowlist silently missing a peer looks exactly like that peer
 * being denied. */
export function parsePeerList(input: unknown): string[] {
	const out = new Set<string>();
	const invalid: string[] = [];
	for (const entry of splitList(input)) {
		const hex = normalizePubkey(entry);
		if (hex) {
			out.add(hex);
		} else {
			invalid.push(holdsSecretKey(entry) ? "(a secret key, not shown)" : entry);
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
export function parseCapabilities(input: unknown): string[] {
	const capabilities = [...new Set(splitList(input))];
	capabilities.forEach(refuseSecretCapability);
	return capabilities;
}
