export type Direction = "in" | "out";

/** A message in the local history, shaped as the `agx.inbox/1` Message. */
export interface StoredMessage {
	/** Nostr event id. */
	id: string;
	direction: Direction;
	/** The other side's npub. */
	peer: string;
	subject: string | null;
	/** Null when absent or withheld as unsafe. */
	contextId: string | null;
	contextIdWithheld: boolean;
	/** Untrusted for `in`; control characters are already neutralized. */
	text: string;
	/** ISO 8601. */
	at: string;
	/** For `out` messages, for example "sent"; null for `in`. */
	deliveryStatus: string | null;
	readAt: string | null;
}

export interface NewMessage {
	id: string;
	peer: string;
	subject: string | null;
	contextId: string | null;
	text: string;
	/** ISO 8601. */
	at: string;
}

export interface NewOutboundMessage extends NewMessage {
	deliveryStatus: string;
}

export type HeldStatus = "held" | "ignored" | "blocked";

export interface HeldMessage {
	id: string;
	at: string;
	subject: string | null;
	contextId: string | null;
	contextIdWithheld: boolean;
	text: string;
}

/** A sender that is not on the allowlist. Text is kept only while `held`. */
export interface HeldSender {
	npub: string;
	status: HeldStatus;
	firstSeenAt: string;
	/** Every message seen, including those past the per-sender cap. */
	count: number;
	messages: HeldMessage[];
}

export type HoldResult = "kept" | "duplicate" | "capped" | "rate-limited" | "suppressed";

export interface ThreadSummary {
	contextId: string | null;
	contextIdWithheld: boolean;
	peer: string;
	subject: string | null;
	messages: number;
	unread: number;
	lastMessageAt: string;
}

export interface MessageFilter {
	direction?: Direction;
	unreadOnly?: boolean;
	contextId?: string;
	peer?: string;
}
