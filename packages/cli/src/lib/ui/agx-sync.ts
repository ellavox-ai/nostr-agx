import { AgxClient } from "@nostr-agx/core";
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
	verbose: boolean;
}): Promise<AgxSync> {
	const logger = makeLogger(options.verbose);
	const collector = createCollector({ store: options.store, allowed: options.allowed });
	const seen = new FileSeenStore(options.profileName);
	const state = loadState(options.profileName);
	const transport = await createTransport(options.profile, options.identity, logger);
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
		onReceipt: (receipt) => collector.onReceipt(receipt),
	});
	await client.start({ pollIntervalMs: 0, advertise: false });
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
					options.store.absorbSpool();
					// History first, then the seen-store and cursor: a crash in between re-delivers and the store dedupes.
					options.store.flush();
					seen.flush();
					updateState(options.profileName, { cursor, lastPumpAt: new Date().toISOString() });
				} finally {
					pulling = false;
				}
			}
			const reachable = await Promise.all(options.profile.relays.map((url) => probeRelay(url, PROBE_TIMEOUT_MS)));
			return {
				fetched: collector.messages.length + collector.heldNow.size - before,
				relaysOk: reachable.filter(Boolean).length,
				relaysUnreachable: reachable.filter((ok) => !ok).length,
			};
		},
		async close(): Promise<void> {
			await client.stop().catch(() => undefined);
			options.store.flush();
			seen.flush();
		},
	};
}
