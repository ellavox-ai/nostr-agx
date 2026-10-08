import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isSafeId, neutralizeBodyControls, neutralizeControls } from "../inbound-lines.js";
import { writePrivateText } from "../paths.js";
import type {
	HeldMessage,
	HeldSender,
	HoldResult,
	MessageFilter,
	NewMessage,
	NewOutboundMessage,
	StoredMessage,
	ThreadSummary,
} from "./types.js";

/** Most messages kept per held sender; the count keeps going past it. */
export const MAX_HELD_PER_SENDER = 50;
/** Most new unknown senders recorded in any one hour. */
export const MAX_NEW_SENDERS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

const messageSchema = z.object({
	id: z.string(),
	direction: z.enum(["in", "out"]),
	peer: z.string(),
	subject: z.string().nullable(),
	contextId: z.string().nullable(),
	contextIdWithheld: z.boolean(),
	text: z.string(),
	at: z.string(),
	deliveryStatus: z.string().nullable(),
	readAt: z.string().nullable(),
});

const heldSchema = z.object({
	npub: z.string(),
	status: z.enum(["held", "ignored", "blocked"]),
	firstSeenAt: z.string(),
	count: z.number(),
	messages: z.array(
		z.object({
			id: z.string(),
			at: z.string(),
			subject: z.string().nullable(),
			contextId: z.string().nullable(),
			contextIdWithheld: z.boolean(),
			text: z.string(),
		}),
	),
});

export const MESSAGES_FILE = "messages.jsonl";
export const HELD_FILE = "held.jsonl";

/** Parse JSON-lines, dropping lines that are not valid records. */
function readLines<T>(path: string, schema: z.ZodType<T>): T[] {
	if (!existsSync(path)) {
		return [];
	}
	const records: T[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			const parsed = schema.safeParse(JSON.parse(line));
			if (parsed.success) {
				records.push(parsed.data);
			}
		} catch {
			// A torn or hand-edited line is skipped; the next flush rewrites the file clean.
		}
	}
	return records;
}

function writeLines(path: string, records: unknown[]): void {
	writePrivateText(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

function safeContext(contextId: string | null): { contextId: string | null; contextIdWithheld: boolean } {
	if (contextId === null || contextId === "") {
		return { contextId: null, contextIdWithheld: false };
	}
	return isSafeId(contextId) ? { contextId, contextIdWithheld: false } : { contextId: null, contextIdWithheld: true };
}

/**
 * Local history of messages and held first contacts, one JSON record per line.
 * Single-writer: the caller holds the profile lock. Changes stay in memory until
 * `flush()`, which rewrites each changed file atomically with mode 0600.
 */
export class MessageStore {
	private readonly messagesPath: string;
	private readonly heldPath: string;
	private messages: StoredMessage[];
	private held: HeldSender[];
	private messagesDirty = false;
	private heldDirty = false;

	constructor(
		dir: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.messagesPath = join(dir, MESSAGES_FILE);
		this.heldPath = join(dir, HELD_FILE);
		this.messages = readLines(this.messagesPath, messageSchema);
		this.held = readLines(this.heldPath, heldSchema);
	}

	private has(id: string): boolean {
		return this.messages.some((m) => m.id === id);
	}

	private insert(message: StoredMessage): void {
		this.messages.push(message);
		this.messages.sort((a, b) => a.at.localeCompare(b.at));
		this.messagesDirty = true;
	}

	/** Record an allowed sender's message. Returns false when it is already stored. */
	addInbound(input: NewMessage): boolean {
		if (this.has(input.id)) {
			return false;
		}
		this.insert({
			id: input.id,
			direction: "in",
			peer: input.peer,
			subject: input.subject === null ? null : neutralizeControls(input.subject),
			...safeContext(input.contextId),
			text: neutralizeBodyControls(input.text),
			at: input.at,
			deliveryStatus: null,
			readAt: null,
		});
		return true;
	}

	/** Record a message this profile sent. Outbound is read by definition. */
	addOutbound(input: NewOutboundMessage): boolean {
		if (this.has(input.id)) {
			return false;
		}
		this.insert({
			id: input.id,
			direction: "out",
			peer: input.peer,
			subject: input.subject,
			...safeContext(input.contextId),
			text: input.text,
			at: input.at,
			deliveryStatus: input.deliveryStatus,
			readAt: input.at,
		});
		return true;
	}

	/** Keep a message from a sender who is not on the allowlist. */
	hold(npub: string, input: NewMessage): HoldResult {
		const existing = this.held.find((h) => h.npub === npub);
		if (existing && existing.status !== "held") {
			return "suppressed";
		}
		if (existing?.messages.some((m) => m.id === input.id)) {
			return "duplicate";
		}
		if (!existing) {
			const since = this.now().getTime() - HOUR_MS;
			const recent = this.held.filter((h) => Date.parse(h.firstSeenAt) > since).length;
			if (recent >= MAX_NEW_SENDERS_PER_HOUR) {
				return "rate-limited";
			}
		}
		const sender =
			existing ??
			({ npub, status: "held", firstSeenAt: this.now().toISOString(), count: 0, messages: [] } satisfies HeldSender);
		if (!existing) {
			this.held.push(sender);
		}
		sender.count += 1;
		this.heldDirty = true;
		if (sender.messages.length >= MAX_HELD_PER_SENDER) {
			return "capped";
		}
		sender.messages.push({
			id: input.id,
			at: input.at,
			subject: input.subject === null ? null : neutralizeControls(input.subject),
			...safeContext(input.contextId),
			text: neutralizeBodyControls(input.text),
		});
		return "kept";
	}

	listMessages(filter: MessageFilter = {}): StoredMessage[] {
		return this.messages.filter(
			(m) =>
				(!filter.direction || m.direction === filter.direction) &&
				(!filter.unreadOnly || m.readAt === null) &&
				(filter.contextId === undefined || m.contextId === filter.contextId) &&
				(!filter.peer || m.peer === filter.peer),
		);
	}

	/** One thread per contextId; messages without one are grouped by peer. */
	listThreads(): ThreadSummary[] {
		const groups = new Map<string, StoredMessage[]>();
		for (const m of this.messages) {
			const key = m.contextId === null ? `peer:${m.peer}` : `ctx:${m.contextId}`;
			groups.set(key, [...(groups.get(key) ?? []), m]);
		}
		return Array.from(groups.values())
			.map((group) => {
				const first = group[0] as StoredMessage;
				const last = group[group.length - 1] as StoredMessage;
				return {
					contextId: first.contextId,
					contextIdWithheld: group.some((m) => m.contextIdWithheld),
					peer: first.peer,
					subject: group.find((m) => m.subject !== null)?.subject ?? null,
					messages: group.length,
					unread: group.filter((m) => m.readAt === null).length,
					lastMessageAt: last.at,
				};
			})
			.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
	}

	getThread(contextId: string): StoredMessage[] {
		return this.listMessages({ contextId });
	}

	/** Mark messages read, by id or by thread. Returns how many changed. */
	markRead(target: { ids: string[] } | { contextId: string }): number {
		const stamp = this.now().toISOString();
		let changed = 0;
		for (const m of this.messages) {
			const hit = "ids" in target ? target.ids.includes(m.id) : m.contextId === target.contextId;
			if (hit && m.readAt === null) {
				m.readAt = stamp;
				changed += 1;
			}
		}
		if (changed > 0) {
			this.messagesDirty = true;
		}
		return changed;
	}

	/** Record a delivery receipt on the outbound message it refers to. */
	setDeliveryStatus(id: string, status: string): boolean {
		const m = this.messages.find((x) => x.id === id && x.direction === "out");
		if (!m || m.deliveryStatus === status) {
			return false;
		}
		m.deliveryStatus = status;
		this.messagesDirty = true;
		return true;
	}

	/** Senders waiting for a decision. */
	listHeld(): HeldSender[] {
		return this.held.filter((h) => h.status === "held");
	}

	heldStatus(npub: string): HeldSender["status"] | null {
		return this.held.find((h) => h.npub === npub)?.status ?? null;
	}

	/** Move a held sender's text into the history. Returns how many messages. */
	releaseHeld(npub: string): number {
		const sender = this.held.find((h) => h.npub === npub && h.status === "held");
		if (!sender) {
			return 0;
		}
		let released = 0;
		for (const m of sender.messages as HeldMessage[]) {
			if (this.has(m.id)) {
				continue;
			}
			this.insert({
				id: m.id,
				direction: "in",
				peer: npub,
				subject: m.subject,
				contextId: m.contextId,
				contextIdWithheld: m.contextIdWithheld,
				text: m.text,
				at: m.at,
				deliveryStatus: null,
				readAt: null,
			});
			released += 1;
		}
		this.held = this.held.filter((h) => h !== sender);
		this.heldDirty = true;
		return released;
	}

	/** Drop the held text and remember the decision so later messages are not kept. */
	dismissHeld(npub: string, status: "ignored" | "blocked"): boolean {
		const sender = this.held.find((h) => h.npub === npub);
		if (!sender) {
			return false;
		}
		sender.status = status;
		sender.messages = [];
		this.heldDirty = true;
		return true;
	}

	/** Record a decision about a sender who has no held messages (a block, for example). */
	setSenderStatus(npub: string, status: "ignored" | "blocked"): void {
		if (this.dismissHeld(npub, status)) {
			return;
		}
		this.held.push({ npub, status, firstSeenAt: this.now().toISOString(), count: 0, messages: [] });
		this.heldDirty = true;
	}

	/** Write what changed. A quiet run writes nothing. */
	flush(): void {
		if (this.messagesDirty) {
			writeLines(this.messagesPath, this.messages);
			this.messagesDirty = false;
		}
		if (this.heldDirty) {
			writeLines(this.heldPath, this.held);
			this.heldDirty = false;
		}
	}
}
