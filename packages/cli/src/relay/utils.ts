import { type Event } from "@nostr-relay/common";

/** NIP-40: a relay must not serve an event past its `expiration`. Every AGX
 * gift wrap carries one, so without this a local run would keep delivering
 * what production has already purged. */
export function isExpired(ev: Event): boolean {
	const tag = ev.tags.find((t) => t[0] === "expiration");
	const at = tag ? Number(tag[1]) : Number.NaN;
	return Number.isFinite(at) && at <= Math.floor(Date.now() / 1000);
}