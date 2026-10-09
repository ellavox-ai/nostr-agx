import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
	HeldDecision,
	HeldSender,
	MessageFilter,
	PeerRecord,
	PeerStatus,
	StoredMessage,
	ThreadSummary,
	UiStore,
} from "./store.js";

/**
 * A small JSON file behind `UiStore`, for tests and `agx ui --dev-store <file>`.
 * Not the production store: it rewrites the whole file on every change.
 */
interface DevData {
	messages: StoredMessage[];
	held: HeldSender[];
	peers: PeerRecord[];
}

export function createDevStore(path: string | null): UiStore & {
	data: DevData;
	addInbound(message: Omit<StoredMessage, "id" | "readAt" | "direction">): StoredMessage;
	addHeld(sender: HeldSender): void;
} {
	const data: DevData =
		path && existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as DevData)
			: { messages: [], held: [], peers: [] };

	function save(): void {
		if (!path) {
			return;
		}
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		renameSync(tmp, path);
	}

	function matches(message: StoredMessage, filter: MessageFilter): boolean {
		if (filter.direction && message.direction !== filter.direction) {
			return false;
		}
		if (filter.unreadOnly && message.readAt !== null) {
			return false;
		}
		if (filter.peer && message.peer !== filter.peer) {
			return false;
		}
		if (filter.query) {
			const needle = filter.query.toLowerCase();
			const hay = `${message.subject ?? ""} ${message.text} ${message.peer}`.toLowerCase();
			return hay.includes(needle);
		}
		return true;
	}

	const store = {
		data,
		listMessages(filter: MessageFilter): StoredMessage[] {
			const rows = data.messages
				.filter((m) => matches(m, filter))
				.sort((a, b) => b.at.localeCompare(a.at));
			return filter.limit ? rows.slice(0, filter.limit) : rows;
		},
		listThreads(): ThreadSummary[] {
			const groups = new Map<string, StoredMessage[]>();
			for (const message of data.messages) {
				const key = message.contextId ?? `none:${message.peer}`;
				groups.set(key, [...(groups.get(key) ?? []), message]);
			}
			return [...groups.values()]
				.map((rows) => {
					const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
					const last = sorted[sorted.length - 1] as StoredMessage;
					return {
						contextId: last.contextId,
						contextIdWithheld: last.contextIdWithheld,
						peer: last.peer,
						subject: sorted.find((m) => m.subject)?.subject ?? null,
						messages: sorted.length,
						unread: sorted.filter((m) => m.direction === "in" && !m.readAt).length,
						lastMessageAt: last.at,
						lastDirection: last.direction,
					};
				})
				.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
		},
		getThread(contextId: string): StoredMessage[] {
			return data.messages
				.filter((m) => m.contextId === contextId)
				.sort((a, b) => a.at.localeCompare(b.at));
		},
		markThreadRead(contextId: string): void {
			const at = new Date().toISOString();
			for (const message of data.messages) {
				if (message.contextId === contextId && !message.readAt) {
					message.readAt = at;
				}
			}
			save();
		},
		listHeld(): HeldSender[] {
			return data.held;
		},
		decideHeld(npub: string, decision: HeldDecision): void {
			const index = data.held.findIndex((h) => h.npub === npub);
			if (index < 0) {
				throw new Error("No held sender with that address.");
			}
			const [sender] = data.held.splice(index, 1) as [HeldSender];
			const status: PeerStatus =
				decision === "allow" ? "allowed" : decision === "ignore" ? "ignored" : "blocked";
			store.setPeer({
				npub,
				status,
				label: null,
				handle: sender.nip05,
				verified: sender.nip05Check.status === "verified",
			});
			if (decision === "allow") {
				for (const held of sender.messages) {
					data.messages.push({
						id: randomUUID(),
						direction: "in",
						peer: npub,
						subject: held.subject,
						contextId: null,
						contextIdWithheld: false,
						text: held.text,
						at: held.at,
						deliveryStatus: null,
						readAt: null,
					});
				}
			}
			save();
		},
		listPeers(): PeerRecord[] {
			return data.peers;
		},
		setPeer(record: PeerRecord): void {
			const index = data.peers.findIndex((p) => p.npub === record.npub);
			if (index >= 0) {
				data.peers[index] = record;
			} else {
				data.peers.push(record);
			}
			save();
		},
		removePeer(npub: string): void {
			data.peers = data.peers.filter((p) => p.npub !== npub);
			save();
		},
		peerStatus(npub: string): PeerStatus | null {
			return data.peers.find((p) => p.npub === npub)?.status ?? null;
		},
		recordOutbound(message: Omit<StoredMessage, "id" | "readAt"> & { id?: string }): StoredMessage {
			const stored: StoredMessage = { ...message, id: message.id ?? randomUUID(), readAt: null };
			data.messages.push(stored);
			save();
			return stored;
		},
		addInbound(message: Omit<StoredMessage, "id" | "readAt" | "direction">): StoredMessage {
			const stored: StoredMessage = {
				...message,
				id: randomUUID(),
				direction: "in",
				readAt: null,
			};
			data.messages.push(stored);
			save();
			return stored;
		},
		addHeld(sender: HeldSender): void {
			data.held.push(sender);
			save();
		},
	};
	return store;
}
