import kleur from "kleur";
import { effectiveProfile, getProfile, resolveProfileName, updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { acquireLock } from "../lib/lock.js";
import { info, json, ok, say, shortNpub, table } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";
import { MessageStore } from "../lib/store/message-store.js";
import { HELD_SCHEMA } from "../lib/threads.js";

export interface HeldOptions {
	profile?: string;
	fullIds?: boolean;
}

/** Senders waiting for a decision: address, count and first seen. Never their text. */
export function heldListCommand(options: HeldOptions): void {
	const profileName = resolveProfileName(options.profile);
	const store = new MessageStore(profileDir(profileName));
	const held = store.listHeld().map((h) => ({ from: h.npub, count: h.count, firstSeenAt: h.firstSeenAt }));
	json({ schema: HELD_SCHEMA, held });
	table(
		held.map((h) => [options.fullIds ? h.from : shortNpub(h.from), String(h.count), h.firstSeenAt]),
		["sender", "messages", "first seen"],
	);
	if (held.length > 0) {
		say(kleur.dim("\n  decide: agx held allow <npub>  |  agx held ignore <npub>  |  agx held block <npub>"));
	}
}

export type HeldDecision = "allow" | "ignore" | "block";

/**
 * allow: add the sender to the allowlist and release their kept text into the
 * history. ignore: drop the text and keep later messages out. block: the same,
 * and take the sender off the allowlist if they were on it.
 */
export function heldDecideCommand(decision: HeldDecision, peer: string, options: HeldOptions): void {
	const profileName = resolveProfileName(options.profile);
	effectiveProfile(profileName);
	const hex = toHexPubkey(peer, "sender");
	const npub = toDisplayNpub(hex);
	const releaseLock = acquireLock(profileName, EXIT.generic);
	try {
		const store = new MessageStore(profileDir(profileName), undefined, { claimSpool: true });
		let released = 0;
		if (decision === "allow") {
			// The allowlist first: if this stops early, running it again releases the text.
			const profile = getProfile(profileName);
			updateProfile(profileName, { allow: [...new Set([...profile.allow, hex])] });
			released = store.releaseHeld(npub);
		} else {
			if (decision === "block") {
				const profile = getProfile(profileName);
				updateProfile(profileName, { allow: profile.allow.filter((entry) => entry !== hex) });
			}
			store.setSenderStatus(npub, decision === "ignore" ? "ignored" : "blocked");
		}
		store.flush();
		json({ ok: true, action: decision, npub, released });
		if (decision === "allow") {
			ok(`Allowed ${npub}`);
			if (released > 0) {
				info(`${released} message${released === 1 ? "" : "s"} moved into your inbox. Read them with: agx inbox --unread`);
			} else {
				info("They had no kept messages; new ones will arrive in your inbox.");
			}
		} else if (decision === "ignore") {
			ok(`Ignored ${npub}: their kept text was dropped and later messages are not kept.`);
		} else {
			ok(`Blocked ${npub}: their kept text was dropped, they are off the allowlist and later messages are not kept.`);
		}
	} finally {
		releaseLock();
	}
}
