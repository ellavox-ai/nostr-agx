import kleur from "kleur";
import { effectiveProfile, getProfile, resolveProfileName, updateProfile } from "../lib/config.js";
import { tryAcquireLock } from "../lib/lock.js";
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
 *
 * The allowlist is config, so it changes at once. The history belongs to whoever
 * holds the profile lock: if a running `agx serve` has it, the change is queued
 * and that process applies it within a poll.
 */
export function heldDecideCommand(decision: HeldDecision, peer: string, options: HeldOptions): void {
	const profileName = resolveProfileName(options.profile);
	effectiveProfile(profileName);
	const hex = toHexPubkey(peer, "sender");
	const npub = toDisplayNpub(hex);
	const dir = profileDir(profileName);
	// The allowlist first: if this stops early, running it again finishes the job.
	if (decision === "allow") {
		const profile = getProfile(profileName);
		updateProfile(profileName, { allow: [...new Set([...profile.allow, hex])] });
	} else if (decision === "block") {
		const profile = getProfile(profileName);
		updateProfile(profileName, { allow: profile.allow.filter((entry) => entry !== hex) });
	}
	let released = 0;
	let queued = false;
	const releaseLock = tryAcquireLock(profileName);
	if (releaseLock === null) {
		MessageStore.spool(dir, { kind: "decision", action: decision, npub });
		queued = true;
	} else {
		try {
			const store = new MessageStore(dir, undefined, { claimSpool: true });
			if (decision === "allow") {
				released = store.releaseHeld(npub);
			} else {
				store.setSenderStatus(npub, decision === "ignore" ? "ignored" : "blocked");
			}
			store.flush();
		} finally {
			releaseLock();
		}
	}
	json({ ok: true, action: decision, npub, released, queued });
	if (decision === "allow") {
		ok(`Allowed ${npub}`);
		if (queued) {
			info("Another agx process holds the message store; their kept messages move into your inbox when it next saves (a running agx serve does within a few seconds).");
		} else if (released > 0) {
			info(`${released} message${released === 1 ? "" : "s"} moved into your inbox. Read them with: agx inbox --unread`);
		} else {
			info("They had no kept messages; new ones will arrive in your inbox.");
		}
	} else if (decision === "ignore") {
		ok(`Ignored ${npub}: their kept text is dropped and later messages are not kept.${queued ? " (applied when the process holding the message store next saves; agx serve does within a few seconds)" : ""}`);
	} else {
		ok(`Blocked ${npub}: their kept text is dropped, they are off the allowlist and later messages are not kept.${queued ? " (applied when the process holding the message store next saves; agx serve does within a few seconds)" : ""}`);
	}
}
