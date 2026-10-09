import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isSafeId, neutralizeBodyControls, neutralizeControls } from "../inbound-lines.js";
import { ensureDir, writePrivateText } from "../paths.js";
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
/** Longest held text kept; the rest is cut off. */
export const MAX_HELD_TEXT_CHARS = 8_000;
/** Most held text kept in all; the oldest is dropped first. */
export const MAX_HELD_TOTAL_BYTES = 8 * 1024 * 1024;
/** Held text older than this is dropped. */
export const HELD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Most new unknown senders recorded in any one hour. */
export const MAX_NEW_SENDERS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

const messageSchema = z.looseObject({
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

const heldSchema = z.looseObject({
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
/**
 * Changes made by commands that cannot take the profile lock because `serve` holds it
 * for hours: `send`, `held allow|ignore|block`, `thread --mark-read`. One small file
 * each, written under a temporary name and renamed into place; the lock holder applies
 * them and deletes the files only after its own write.
 */
export const SPOOL_DIR = "spool.d";

const outboundSchema = z.object({
	id: z.string(),
	peer: z.string(),
	subject: z.string().nullable(),
	contextId: z.string().nullable(),
	text: z.string(),
	at: z.string(),
	deliveryStatus: z.string(),
});

const spoolOpSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("outbound"), message: outboundSchema }),
	z.object({ kind: z.literal("decision"), action: z.enum(["allow", "ignore", "block"]), npub: z.string() }),
	z.object({ kind: z.literal("read"), contextId: z.string() }),
]);

export type SpoolOp = z.infer<typeof spoolOpSchema>;

interface ParsedLines<T> {
	records: T[];
	/** Valid JSON objects this version does not understand (a newer one wrote them); written back unchanged. */
	unknown: string[];
}

/** Parse JSON-lines. Torn lines are dropped; lines from a newer version are kept as they are. */
function readLines<T>(path: string, schema: z.ZodType<T>): ParsedLines<T> {
	const result: ParsedLines<T> = { records: [], unknown: [] };
	if (!existsSync(path)) {
		return result;
	}
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// A torn or hand-edited line is dropped; the next flush rewrites the file clean.
			continue;
		}
		const parsed = schema.safeParse(value);
		if (parsed.success) {
			result.records.push(parsed.data);
		} else if (typeof value === "object" && value !== null) {
			result.unknown.push(line);
		}
	}
	return result;
}

function writeLines(path: string, records: unknown[], unknown: string[]): void {
	writePrivateText(path, [...records.map((record) => JSON.stringify(record)), ...unknown].map((line) => `${line}\n`).join(""));
}

function heldText(text: string): string {
	return text.length > MAX_HELD_TEXT_CHARS ? `${text.slice(0, MAX_HELD_TEXT_CHARS)}\n[cut off]` : text;
}

function heldBytes(sender: HeldSender): number {
	return sender.messages.reduce((total, m) => total + Buffer.byteLength(m.text) + Buffer.byteLength(m.subject ?? ""), 0);
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
	/** Lines a newer version wrote that this one keeps but does not read. */
	private messagesUnknown: string[];
	private heldUnknown: string[];
	/** Spool files this store applied; removed once the result is written. */
	private claimed: string[] = [];

	/**
	 * `claimSpool` is for the process that holds the profile lock and will flush:
	 * it takes over what `agx send` spooled. Without it the spool is only read, so a
	 * reader sees sent messages without changing any file.
	 */
	constructor(
		private readonly dir: string,
		private readonly now: () => Date = () => new Date(),
		options: { claimSpool?: boolean } = {},
	) {
		this.messagesPath = join(dir, MESSAGES_FILE);
		this.heldPath = join(dir, HELD_FILE);
		const messages = readLines(this.messagesPath, messageSchema);
		const held = readLines(this.heldPath, heldSchema);
		this.messages = messages.records;
		this.messagesUnknown = messages.unknown;
		this.held = held.records;
		this.heldUnknown = held.unknown;
		this.enforceHeldLimits();
		if (options.claimSpool === true) {
			this.absorbSpool();
		} else {
			// A reader sees pending changes but writes nothing.
			const { messagesDirty, heldDirty } = this;
			this.absorbSpool();
			this.claimed = [];
			this.messagesDirty = messagesDirty;
			this.heldDirty = heldDirty;
		}
	}

	/** Queue a change for the next store writer; see `SPOOL_DIR`. */
	static spool(dir: string, op: SpoolOp): void {
		const spool = join(dir, SPOOL_DIR);
		ensureDir(spool);
		const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${randomUUID().slice(0, 8)}`;
		const tmp = join(spool, `${name}.tmp`);
		writePrivateText(tmp, `${JSON.stringify(op)}\n`);
		renameSync(tmp, join(spool, `${name}.json`));
	}

	/** `agx send` queues its record instead of taking the lock. */
	static spoolOutbound(dir: string, message: NewOutboundMessage): void {
		MessageStore.spool(dir, { kind: "outbound", message });
	}

	private spoolFiles(): string[] {
		const spool = join(this.dir, SPOOL_DIR);
		if (!existsSync(spool)) {
			return [];
		}
		return readdirSync(spool)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) => join(spool, name));
	}

	private applyOp(op: SpoolOp): void {
		if (op.kind === "outbound") {
			this.addOutbound(op.message);
		} else if (op.kind === "read") {
			this.markRead({ contextId: op.contextId });
		} else if (op.action === "allow") {
			this.releaseHeld(op.npub);
		} else {
			this.setSenderStatus(op.npub, op.action === "ignore" ? "ignored" : "blocked");
		}
	}

	/** Apply what other commands queued; `flush()` removes the files once the result is written. */
	absorbSpool(): void {
		for (const file of this.spoolFiles()) {
			if (this.claimed.includes(file)) {
				continue;
			}
			try {
				const op = spoolOpSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
				if (op.success) {
					this.applyOp(op.data);
				}
			} catch {
				// Unreadable: leave it for a newer version rather than delete it.
				continue;
			}
			this.claimed.push(file);
		}
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
			text: heldText(neutralizeBodyControls(input.text)),
		});
		this.enforceHeldLimits();
		return this.held.some((h) => h === sender && h.messages.some((m) => m.id === input.id)) ? "kept" : "capped";
	}

	/** Drop held text past its age limit, then the oldest until the total fits. */
	private enforceHeldLimits(): void {
		const cutoff = this.now().getTime() - HELD_TTL_MS;
		let changed = false;
		for (const sender of this.held) {
			const fresh = sender.messages.filter((m) => !(Date.parse(m.at) < cutoff));
			if (fresh.length !== sender.messages.length) {
				sender.messages = fresh;
				changed = true;
			}
		}
		let total = this.held.reduce((sum, h) => sum + heldBytes(h), 0);
		if (total > MAX_HELD_TOTAL_BYTES) {
			const all = this.held
				.flatMap((sender) => sender.messages.map((message) => ({ sender, message })))
				.sort((a, b) => a.message.at.localeCompare(b.message.at));
			for (const { sender, message } of all) {
				if (total <= MAX_HELD_TOTAL_BYTES) {
					break;
				}
				total -= Buffer.byteLength(message.text) + Buffer.byteLength(message.subject ?? "");
				sender.messages = sender.messages.filter((m) => m !== message);
				changed = true;
			}
		}
		if (changed) {
			this.heldDirty = true;
		}
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

	/**
	 * Record a delivery receipt on the outbound message it refers to, but only when it
	 * came from the peer that message was sent to. Returns whether the receipt matched.
	 */
	setDeliveryStatus(id: string, status: string, from: string): boolean {
		const m = this.messages.find((x) => x.id === id && x.direction === "out" && x.peer === from);
		if (!m) {
			return false;
		}
		if (m.deliveryStatus !== status) {
			m.deliveryStatus = status;
			this.messagesDirty = true;
		}
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
			writeLines(this.messagesPath, this.messages, this.messagesUnknown);
			this.messagesDirty = false;
		}
		if (this.heldDirty) {
			writeLines(this.heldPath, this.held, this.heldUnknown);
			this.heldDirty = false;
		}
		// Only after the history is on disk, so a crash re-reads the spool.
		for (const file of this.claimed) {
			rmSync(file, { force: true });
		}
		this.claimed = [];
	}
}
