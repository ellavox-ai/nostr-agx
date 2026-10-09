import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../paths.js";
import { toDisplayNpub, toHexPubkey } from "../peer.js";
import type { MessageStore } from "../store/message-store.js";
import type {
	HeldDecision,
	HeldSender,
	MessageFilter,
	PeerRecord,
	PeerStatus,
	StoredMessage,
	SyncResult,
	ThreadSummary,
	UiStore,
} from "./store.js";

const PEERS_FILE = "ui-peers.json";

const metaSchema = z.record(
	z.string(),
	z.object({ label: z.string().nullable(), handle: z.string().nullable(), verified: z.boolean() }),
);

export interface AgxStoreOptions {
	/** The profile directory, where `ui-peers.json` lives. */
	dir: string;
	store: MessageStore;
	/** Hex pubkeys on the profile allowlist; shared with whatever sorts incoming mail. */
	allowed: Set<string>;
	/** The allowlist as saved in the profile now (`agx identity allow|deny` can change it while the UI runs). */
	loadAllow: () => string[];
	/** Add or remove one entry in the saved profile, leaving the rest as it is on disk. */
	changeAllow: (hex: string, on: boolean) => void;
	sync?: () => Promise<SyncResult>;
}

/** The `UiStore` the UI runs on: the real message store plus the profile allowlist. */
export function createAgxStore(options: AgxStoreOptions): UiStore {
	const { store, allowed } = options;
	const metaPath = join(options.dir, PEERS_FILE);
	const meta: z.infer<typeof metaSchema> = loadMeta(metaPath);

	function loadMeta(path: string): z.infer<typeof metaSchema> {
		if (!existsSync(path)) {
			return {};
		}
		try {
			const parsed = metaSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
			return parsed.success ? parsed.data : {};
		} catch {
			return {};
		}
	}

	function commit(): void {
		store.flush();
	}

	/** Bring the in-memory allowlist in line with the profile on disk. */
	function refresh(): void {
		const saved = options.loadAllow();
		allowed.clear();
		for (const hex of saved) {
			allowed.add(hex);
		}
	}

	function setAllowed(npub: string, on: boolean): void {
		const hex = toHexPubkey(npub, "peer");
		refresh();
		if (on !== allowed.has(hex)) {
			options.changeAllow(hex, on);
			refresh();
		}
	}

	function lastDirection(thread: { contextId: string | null; peer: string }): "in" | "out" {
		const rows =
			thread.contextId === null
				? store.listMessages({ peer: thread.peer }).filter((m) => m.contextId === null)
				: store.getThread(thread.contextId);
		return rows.at(-1)?.direction ?? "in";
	}

	const result: UiStore = {
		listMessages(filter: MessageFilter): StoredMessage[] {
			const needle = filter.query?.toLowerCase();
			const rows = store
				.listMessages({ direction: filter.direction, unreadOnly: filter.unreadOnly, peer: filter.peer })
				.filter((m) => !needle || `${m.subject ?? ""} ${m.text} ${m.peer}`.toLowerCase().includes(needle))
				.sort((a, b) => b.at.localeCompare(a.at));
			return filter.limit ? rows.slice(0, filter.limit) : rows;
		},
		listThreads(): ThreadSummary[] {
			return store.listThreads().map((t) => ({ ...t, lastDirection: lastDirection(t) }));
		},
		getThread(contextId: string): StoredMessage[] {
			return store.getThread(contextId);
		},
		markThreadRead(contextId: string): void {
			if (store.markRead({ contextId }) > 0) {
				commit();
			}
		},
		listHeld(): HeldSender[] {
			return store.listHeld().map((h) => ({
				npub: h.npub,
				nip05: null,
				nip05Check: { status: "unchecked", detail: null },
				firstSeenAt: h.firstSeenAt,
				count: h.count,
				messages: h.messages.map((m) => ({ at: m.at, text: m.text, subject: m.subject })),
			}));
		},
		decideHeld(npub: string, decision: HeldDecision): void {
			if (!store.listHeld().some((h) => h.npub === npub)) {
				throw new Error("No held sender with that address.");
			}
			if (decision === "allow") {
				setAllowed(npub, true);
				store.releaseHeld(npub);
			} else {
				if (decision === "block") {
					setAllowed(npub, false);
				}
				store.setSenderStatus(npub, decision === "ignore" ? "ignored" : "blocked");
			}
			commit();
		},
		listPeers(): PeerRecord[] {
			refresh();
			const record = (npub: string, status: PeerStatus): PeerRecord => ({
				npub,
				status,
				label: meta[npub]?.label ?? null,
				handle: meta[npub]?.handle ?? null,
				verified: meta[npub]?.verified ?? false,
			});
			return [
				...[...allowed].map((hex) => record(toDisplayNpub(hex), "allowed")),
				...store.listSenderDecisions().map((d) => record(d.npub, d.status)),
			];
		},
		setPeer(peer: PeerRecord): void {
			store.forgetSender(peer.npub);
			if (peer.status === "allowed") {
				setAllowed(peer.npub, true);
			} else {
				setAllowed(peer.npub, false);
				store.setSenderStatus(peer.npub, peer.status);
			}
			meta[peer.npub] = { label: peer.label, handle: peer.handle, verified: peer.verified };
			writePrivateJson(metaPath, meta);
			commit();
		},
		removePeer(npub: string): void {
			setAllowed(npub, false);
			store.forgetSender(npub);
			delete meta[npub];
			writePrivateJson(metaPath, meta);
			commit();
		},
		peerStatus(npub: string): PeerStatus | null {
			refresh();
			if (allowed.has(toHexPubkey(npub, "peer"))) {
				return "allowed";
			}
			const status = store.heldStatus(npub);
			return status === "ignored" || status === "blocked" ? status : null;
		},
		recordOutbound(message): StoredMessage {
			const id = message.id ?? randomUUID();
			store.addOutbound({
				id,
				peer: message.peer,
				subject: message.subject,
				contextId: message.contextId,
				text: message.text,
				at: message.at,
				deliveryStatus: message.deliveryStatus ?? "sent",
			});
			commit();
			const saved = store.listMessages().find((m) => m.id === id);
			if (!saved) {
				throw new Error("The sent message could not be recorded.");
			}
			return saved;
		},
	};
	if (options.sync) {
		result.sync = options.sync;
	}
	return result;
}
