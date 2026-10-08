import type { AgxIncomingMessage, AgxIncomingReceipt } from "@nostr-agx/core";
import kleur from "kleur";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import { neutralizeControls } from "./inbound-lines.js";
import { shortNpub } from "./output.js";
import { toDisplayNpub } from "./peer.js";
import type { MessageStore } from "./store/message-store.js";
import type { StoredMessage } from "./store/types.js";
import { renderMessageLines } from "./threads.js";

export const INBOX_SCHEMA = "agx.inbox/1";
export const INBOX_SUMMARY_SCHEMA = "agx.inbox.summary/1";

export interface InboxRelay {
	url: string;
	status: "ok" | "unreachable";
}

export interface InboxReceipt {
	from: string;
	ref: string;
	status: string;
	at: string;
}

export interface InboxHeld {
	from: string;
	count: number;
	firstSeenAt: string;
}

export interface InboxReport {
	schema: typeof INBOX_SCHEMA;
	fetchedAt: string;
	npub: string;
	relays: InboxRelay[];
	messages: StoredMessage[];
	held: InboxHeld[];
	receipts: InboxReceipt[];
	truncated: boolean;
}

export interface InboxSummary {
	schema: typeof INBOX_SUMMARY_SCHEMA;
	/** Arrived in this pull. */
	new: number;
	/** Inbound messages not yet marked read, whenever they arrived. */
	unread: number;
	held: number;
	relays: { ok: number; unreachable: number };
}

/** ISO time for a unix-seconds value, or `fallback` when the value is not a time `Date` can hold. */
function isoFromSeconds(seconds: number, fallback: Date): string {
	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/** Slack for clock differences between sender and receiver. */
const CLOCK_SKEW_SEC = 120;

/**
 * The time to show. The sender's own claim is used only when it is a plausible
 * send time: the wrap is backdated by at most `MAX_WRAP_BACKDATE_SEC`, so the real
 * time lies shortly after the wrap's time and never in the future. Anything else
 * (a far-past or far-future claim) would reorder history or break the date, so the
 * transport time is used.
 */
function messageTime(msg: AgxIncomingMessage, now: Date): string {
	const claimed = msg.sentAt;
	const nowSec = Math.floor(now.getTime() / 1000);
	const plausible =
		claimed !== undefined &&
		Number.isInteger(claimed) &&
		claimed >= msg.createdAt - CLOCK_SKEW_SEC &&
		claimed <= Math.min(nowSec + CLOCK_SKEW_SEC, msg.createdAt + MAX_WRAP_BACKDATE_SEC + CLOCK_SKEW_SEC);
	return isoFromSeconds(plausible ? claimed : msg.createdAt, now);
}

/**
 * Sorts what a poll delivers into the store. Nothing here replies or runs a
 * task: a sender on the allowlist is stored, anyone else is held with their text.
 */
export function createCollector(options: {
	store: MessageStore;
	/** Hex pubkeys on the profile allowlist. */
	allowed: ReadonlySet<string>;
	now?: () => Date;
	/** Called when a message could not be stored; the error is then rethrown so the core retries it. */
	onError?: (error: unknown, msg: AgxIncomingMessage) => void;
}) {
	const now = options.now ?? (() => new Date());
	const stored: StoredMessage[] = [];
	const heldNow = new Set<string>();
	const receipts: InboxReceipt[] = [];

	function sort(msg: AgxIncomingMessage): void {
		const peer = toDisplayNpub(msg.from);
		const input = {
			id: msg.eventId,
			peer,
			subject: msg.subject ?? null,
			contextId: msg.contextId ?? null,
			text: msg.text,
			at: messageTime(msg, now()),
		};
		if (options.allowed.has(msg.from)) {
			if (options.store.addInbound(input)) {
				const saved = options.store.listMessages().find((m) => m.id === msg.eventId);
				if (saved) {
					stored.push(saved);
				}
			}
			return;
		}
		const result = options.store.hold(peer, input);
		if (result === "kept" || result === "capped") {
			heldNow.add(peer);
		}
	}

	return {
		onMessage(msg: AgxIncomingMessage): void {
			try {
				sort(msg);
			} catch (error) {
				options.onError?.(error, msg);
				throw error;
			}
		},
		/**
		 * A receipt counts only from the peer the message was sent to (anyone who knows an
		 * event id could otherwise mark it delivered), or from an allowed sender.
		 */
		onReceipt(receipt: AgxIncomingReceipt): void {
			const from = toDisplayNpub(receipt.from);
			const ref = receipt.receipt.refEventId;
			const matched = options.store.setDeliveryStatus(ref, receipt.receipt.status, from);
			if (!matched && !options.allowed.has(receipt.from)) {
				return;
			}
			receipts.push({
				from,
				ref,
				status: receipt.receipt.status,
				at: isoFromSeconds(receipt.createdAt, now()),
			});
		},
		/** Messages stored by this run, oldest first. */
		get messages(): StoredMessage[] {
			return stored;
		},
		/** Senders that were held (or counted past the cap) by this run. */
		get heldNow(): ReadonlySet<string> {
			return heldNow;
		},
		get receipts(): InboxReceipt[] {
			return receipts;
		},
	};
}

export function heldList(store: MessageStore): InboxHeld[] {
	return store.listHeld().map((h) => ({ from: h.npub, count: h.count, firstSeenAt: h.firstSeenAt }));
}

export function summarize(report: InboxReport, newCount: number, unreadCount: number): InboxSummary {
	return {
		schema: INBOX_SUMMARY_SCHEMA,
		new: newCount,
		unread: unreadCount,
		held: report.held.length,
		relays: {
			ok: report.relays.filter((r) => r.status === "ok").length,
			unreachable: report.relays.filter((r) => r.status === "unreachable").length,
		},
	};
}

/** `3 new · 5 unread · 1 held`, with `· 1 relay unreachable` when some relays failed. */
export function summaryLine(summary: InboxSummary): string {
	const parts = [`${summary.new} new`, `${summary.unread} unread`, `${summary.held} held`];
	const down = summary.relays.unreachable;
	if (down > 0) {
		parts.push(`${down} ${down === 1 ? "relay" : "relays"} unreachable`);
	}
	return parts.join(" · ");
}

/** Human output: the `serve` line formats, then the summary. */
export function renderInboxLines(
	report: InboxReport,
	options: { fullIds: boolean; heldNow: ReadonlySet<string>; newCount: number; unreadCount: number },
): string[] {
	const lines: string[] = [];
	for (const m of report.messages) {
		lines.push("");
		lines.push(...renderMessageLines(m, options.fullIds));
	}
	for (const h of report.held) {
		if (!options.heldNow.has(h.from)) {
			continue;
		}
		lines.push("");
		lines.push(
			`${kleur.yellow("HOLD ")} from ${options.fullIds ? h.from : shortNpub(h.from)} — not on the allowlist; ${h.count} message${h.count === 1 ? "" : "s"} kept for your decision (text not shown here)`,
		);
		lines.push(kleur.dim(`       decide: agx held allow ${h.from}  |  agx held ignore ${h.from}  |  agx held block ${h.from}`));
	}
	for (const r of report.receipts) {
		lines.push(
			`${kleur.green("ACK  ")} from ${options.fullIds ? r.from : shortNpub(r.from)}  ${kleur.dim(`ref ${neutralizeControls(r.ref.slice(0, 8))}  ${neutralizeControls(r.status)}`)}`,
		);
	}
	lines.push("");
	lines.push(summaryLine(summarize(report, options.newCount, options.unreadCount)));
	return lines;
}
