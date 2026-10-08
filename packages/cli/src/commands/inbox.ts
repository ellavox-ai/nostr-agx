import { AgxClient } from "@nostr-agx/core";
import { effectiveProfile, resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import {
	createCollector,
	heldList,
	INBOX_SCHEMA,
	type InboxReport,
	renderInboxLines,
	summarize,
	summaryLine,
} from "../lib/inbox.js";
import { acquireLock } from "../lib/lock.js";
import { json, say, warn } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toHexPubkey } from "../lib/peer.js";
import { probeRelay } from "../lib/relay-probe.js";
import { FileSeenStore, loadState, updateState } from "../lib/state.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";

export interface InboxOptions {
	profile?: string;
	wait?: string;
	unread?: boolean;
	thread?: string;
	fullIds?: boolean;
	summary?: boolean;
	verbose?: boolean;
}

const DEFAULT_WAIT_SEC = 10;
const PROBE_TIMEOUT_MS = 3000;

function parseWait(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_WAIT_SEC;
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
		throw new AgxCliError(`--wait must be a number of seconds from 1 to 600, got "${value}".`, {
			exitCode: EXIT.usage,
		});
	}
	return seconds;
}

/**
 * One pull of the inbox, then exit. It applies the trust rules of
 * `agx serve --allowed-only --no-reply --no-tasks`: it publishes nothing,
 * answers nothing and runs no task. Allowed senders go into the history; anyone
 * else is held with their text for `agx held`.
 */
export async function inboxCommand(options: InboxOptions): Promise<void> {
	const waitSec = parseWait(options.wait);
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const logger = makeLogger(options.verbose ?? false);
	const releaseLock = acquireLock(profileName, EXIT.generic);

	try {
		const allowed = new Set(profile.allow.map((entry) => toHexPubkey(entry, "allowlist entry")));
		const state = loadState(profileName);
		const store = new MessageStore(profileDir(profileName), undefined, { claimSpool: true });
		const seen = new FileSeenStore(profileName);
		const collector = createCollector({
			store,
			allowed,
			onError: (error) => warn(`A message could not be stored and will be retried: ${error instanceof Error ? error.message : String(error)}`),
		});

		const transport = await createTransport(profile, identity, logger);
		const client = new AgxClient({
			transport,
			seen,
			logger,
			identity: { org: profile.org ?? undefined, nip05: profile.nip05 },
			startCursor: state.cursor,
			// No capability is served, so nothing is authorized to run.
			authorize: () => false,
			onMessage: (msg) => collector.onMessage(msg),
			onReceipt: (receipt) => collector.onReceipt(receipt),
		});
		await client.start({ pollIntervalMs: 0, advertise: false });

		let truncated = false;
		let cursor = state.cursor;
		try {
			const outcome = await Promise.race([
				client.pump().then((result) => ({ result })),
				new Promise<{ result: null }>((done) => setTimeout(() => done({ result: null }), waitSec * 1000)),
			]);
			if (outcome.result?.complete) {
				cursor = outcome.result.cursor;
			} else {
				truncated = true;
			}
		} finally {
			await client.stop().catch(() => undefined);
		}

		// History first: a crash before the cursor moves re-delivers, and the store dedupes by event id.
		store.flush();
		seen.flush();
		updateState(profileName, { cursor, lastPumpAt: new Date().toISOString() });

		const relays = await Promise.all(
			profile.relays.map(async (url) => ({
				url,
				status: (await probeRelay(url, PROBE_TIMEOUT_MS)) ? ("ok" as const) : ("unreachable" as const),
			})),
		);

		let messages = collector.messages;
		if (options.thread) {
			messages = store.getThread(options.thread);
		} else if (options.unread) {
			messages = store.listMessages({ direction: "in", unreadOnly: true });
		}
		const report: InboxReport = {
			schema: INBOX_SCHEMA,
			fetchedAt: new Date().toISOString(),
			npub: identity.npub,
			relays,
			messages,
			held: heldList(store),
			receipts: collector.receipts,
			truncated,
		};
		const unreadCount = store.listMessages({ direction: "in", unreadOnly: true }).length;
		const summary = summarize(report, collector.messages.length, unreadCount);

		if (options.summary) {
			json(summary);
			say(summaryLine(summary));
		} else {
			json(report);
			for (const line of renderInboxLines(report, {
				fullIds: options.fullIds === true,
				heldNow: collector.heldNow,
				newCount: collector.messages.length,
				unreadCount,
			})) {
				say(line);
			}
		}

		if (summary.relays.ok === 0) {
			process.exitCode = EXIT.network;
		}
	} finally {
		releaseLock();
	}
}
