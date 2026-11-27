import { AgxClient } from "@nostr-agx/core";
import type { NostrTransport } from "@nostr-agx/nostr";
import type WebSocket from "ws";
import type { Identity } from "../identity.js";
import { createCollector } from "../inbox.js";
import { probeRelay } from "../relay-probe.js";
import { FileSeenStore, loadState, updateState } from "../state.js";
import type { MessageStore } from "../store/message-store.js";
import { createTransport, makeLogger } from "../transport.js";
import type { Profile } from "../config.js";
import type { SyncResult } from "./store.js";

const PROBE_TIMEOUT_MS = 3000;

export interface AgxSync {
	sync(): Promise<SyncResult>;
	close(): Promise<void>;
}

/**
 * Pulls mail for the UI the way `agx inbox` does: it never replies and never runs a task.
 * Allowed senders go into the history, everyone else is held with their text.
 */
export async function createAgxSync(options: {
	profileName: string;
	profile: Profile;
	identity: Identity;
	store: MessageStore;
	allowed: ReadonlySet<string>;
	/** Run before each pull, to refresh `allowed` from the profile. */
	beforePull?: () => void;
	/**
	 * A transport to pull through. The caller owns it and stops it; `close()`
	 * leaves it running. When omitted, one is made here and stopped on `close()`.
	 */
	transport?: NostrTransport;
	verbose: boolean;
}): Promise<AgxSync> {
	const logger = makeLogger(options.verbose);
	const collector = createCollector({ store: options.store, allowed: options.allowed });
	const seen = new FileSeenStore(options.profileName);
	const state = loadState(options.profileName);
	const owned = options.transport === undefined;
	const transport =
		options.transport ??
		(await createTransport(options.profile, options.identity, logger, {
			profileName: options.profileName,
		}));
	const stopOwned = async (): Promise<void> => {
		if (owned) {
			await transport.stop().catch(() => undefined);
		}
	};
	const client = new AgxClient({
		transport,
		seen,
		logger,
		identity: { org: options.profile.org ?? undefined, nip05: options.profile.nip05 },
		startCursor: state.cursor,
		// No capability is served, so nothing is authorized to run.
		authorize: () => false,
		onMessage: (msg) => {
			collector.onMessage(msg);
		},
		onReceipt: (receipt) => {
			collector.onReceipt(receipt);
		},
	});
	await client.start({
		pollIntervalMs: 0,
		advertise: false,
		liveDispatch: false,
	}).catch(async (error: unknown) => {
		// `liveDispatch: false` means client.stop() would not own the transport:
		// a failed start must not orphan the Tailscale launcher.
		await stopOwned();
		throw error;
	});
	let cursor = state.cursor;
	let pulling = false;

	return {
		async sync(): Promise<SyncResult> {
			const before = collector.messages.length + collector.heldNow.size;
			if (!pulling) {
				pulling = true;
				try {
					options.beforePull?.();
					options.store.absorbSpool();
					const result = await client.pump();
					if (result.complete) {
						cursor = result.cursor;
					}
					seen.holdFor(cursor);
					options.store.absorbSpool();
					// History first, then the seen-store and cursor: a crash in between re-delivers and the store dedupes.
					options.store.flush();
					seen.flush();
					updateState(options.profileName, { cursor, lastPumpAt: new Date().toISOString() });
				} finally {
					pulling = false;
				}
			}
			// The transport's own class: with a relay proxy it dials through it, like the pull above.
			const dial = transport.webSocket as typeof WebSocket | undefined;
			const reachable = await Promise.all(
				options.profile.relays.map((url) => probeRelay(url, PROBE_TIMEOUT_MS, dial)),
			);
			return {
				fetched: collector.messages.length + collector.heldNow.size - before,
				relaysOk: reachable.filter(Boolean).length,
				relaysUnreachable: reachable.filter((ok) => !ok).length,
			};
		},
		async close(): Promise<void> {
			await client.stop().catch(() => undefined);
			// `liveDispatch: false` means client.stop() does NOT own the
			// transport: only this explicit stop ends the Tailscale launcher and
			// removes its per-run state directory.
			await stopOwned();
			options.store.flush();
			seen.flush();
		},
	};
}
