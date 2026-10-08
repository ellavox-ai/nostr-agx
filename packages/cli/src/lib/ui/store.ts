/**
 * What `agx ui` needs from local storage.
 *
 * The real store ships with `agx inbox` (EL-361, `$AGX_HOME/profiles/<p>/`).
 * The UI depends on this interface only, so that store plugs in without a UI
 * change. `dev-store.ts` is a JSON-lines implementation for tests and
 * `agx ui --dev-store`.
 */

export type Direction = "in" | "out";
export type PeerStatus = "allowed" | "ignored" | "blocked";
export type HeldDecision = "allow" | "ignore" | "block";

export interface StoredMessage {
	id: string;
	direction: Direction;
	/** The other side's npub. */
	peer: string;
	subject: string | null;
	/** Null when absent or withheld as unsafe. */
	contextId: string | null;
	contextIdWithheld: boolean;
	/** Peer-controlled for `in`: untrusted. */
	text: string;
	/** ISO 8601. */
	at: string;
	/** For `out` messages, for example `"sent"`; null for `in`. */
	deliveryStatus: string | null;
	readAt: string | null;
}

export interface Nip05Check {
	status: "verified" | "failed" | "unchecked";
	detail: string | null;
}

export interface HeldSender {
	npub: string;
	nip05: string | null;
	nip05Check: Nip05Check;
	firstSeenAt: string;
	count: number;
	/** Kept until the user decides. Shown to the user only, never to an assistant. */
	messages: { at: string; text: string; subject: string | null }[];
}

export interface PeerRecord {
	npub: string;
	status: PeerStatus;
	label: string | null;
	/** NIP-05 handle when known. */
	handle: string | null;
	verified: boolean;
}

export interface ThreadSummary {
	contextId: string | null;
	contextIdWithheld: boolean;
	peer: string;
	subject: string | null;
	messages: number;
	unread: number;
	lastMessageAt: string;
	/** Direction of the newest message, for the follow-up guard. */
	lastDirection: Direction;
}

export interface MessageFilter {
	direction?: Direction;
	query?: string;
	unreadOnly?: boolean;
	peer?: string;
	limit?: number;
}

export interface SyncResult {
	fetched: number;
	relaysOk: number;
	relaysUnreachable: number;
}

export interface UiStore {
	listMessages(filter: MessageFilter): StoredMessage[];
	listThreads(): ThreadSummary[];
	getThread(contextId: string): StoredMessage[];
	markThreadRead(contextId: string): void;
	listHeld(): HeldSender[];
	/** Release (allow), dismiss (ignore) or block a held sender. */
	decideHeld(npub: string, decision: HeldDecision): void;
	listPeers(): PeerRecord[];
	setPeer(record: PeerRecord): void;
	removePeer(npub: string): void;
	peerStatus(npub: string): PeerStatus | null;
	/** `id` is the Nostr event id when the message was published; a store mints one otherwise. */
	recordOutbound(message: Omit<StoredMessage, "id" | "readAt"> & { id?: string }): StoredMessage;
	/** Pull new messages. Optional: a store without relays can omit it. */
	sync?(): Promise<SyncResult>;
}
