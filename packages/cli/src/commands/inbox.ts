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
import { runtime } from "../lib/runtime.js";
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

export type InboxRunControl =
	| { activity: false }
	| { activity: true; timeoutSec: number; signal?: AbortSignal };

const WAIT_POLL_INTERVAL_MS = 1000;

async function pumpWithin(client: AgxClient, timeoutMs: number, signal?: AbortSignal) {
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			client.pump().then((result) => ({ result, interrupted: false })),
			new Promise<{ result: null; interrupted: boolean }>((done) => {
				timer = setTimeout(() => done({ result: null, interrupted: false }), Math.max(1, timeoutMs));
				if (signal) {
					onAbort = () => done({ result: null, interrupted: true });
					if (signal.aborted) {
						onAbort();
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (signal && onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Pull the inbox without replying or running tasks. `activity` changes only the
 * loop: persist every poll and stop after activity, timeout or interruption.
 */
export async function runInboxCommand(options: InboxOptions, control: InboxRunControl = { activity: false }): Promise<void> {
	const waitSec = control.activity ? control.timeoutSec : parseWait(options.wait);
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const logger = makeLogger(options.verbose ?? false);
	const releaseLock = acquireLock(profileName, EXIT.generic);

	try {
		const allowed = new Set(profile.allow.map((entry) => toHexPubkey(entry, "allowlist entry")));
		let warnedAllowlist = false;
		function refreshAllowed(): void {
			let current: string[];
			try {
				current = effectiveProfile(profileName).allow.map((entry) => toHexPubkey(entry, "allowlist entry"));
			} catch (error) {
				if (!warnedAllowlist) {
					warnedAllowlist = true;
					warn(`The allowlist could not be re-read, so the last good one stays in use: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}
			warnedAllowlist = false;
			allowed.clear();
			for (const entry of current) {
				allowed.add(entry);
			}
		}
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
		});

		let truncated = false;
		let cursor = state.cursor;
		let timedOut: boolean | undefined = control.activity ? false : undefined;
		let interrupted = false;
		let everRelayAnswered = false;
		let relays: InboxReport["relays"] = [];
		const probe = async () => Promise.all(
			profile.relays.map(async (url) => ({
				url,
				status: (await probeRelay(url, PROBE_TIMEOUT_MS)) ? ("ok" as const) : ("unreachable" as const),
			})),
		);

		try {
			if (control.activity) {
				const deadline = Date.now() + waitSec * 1000;
				while (true) {
					const remaining = deadline - Date.now();
					if (remaining <= 0) {
						timedOut = true;
						break;
					}
					store.absorbSpool();
					refreshAllowed();
					try {
						const outcome = await pumpWithin(client, remaining, control.signal);
						if (outcome.interrupted) {
							interrupted = true;
							break;
						}
						if (outcome.result === null) {
							truncated = true;
							timedOut = true;
							break;
						}
						if (outcome.result.complete) {
							everRelayAnswered = true;
							cursor = outcome.result.cursor;
							truncated = false;
						} else {
							truncated = true;
						}
					} catch (error) {
						if (control.signal?.aborted) {
							interrupted = true;
							break;
						}
						truncated = true;
						warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
					}

					seen.holdFor(cursor);
					store.flush();
					seen.flush();
					updateState(profileName, { cursor, lastPumpAt: new Date().toISOString() });
					relays = await probe();
					everRelayAnswered ||= relays.some((relay) => relay.status === "ok");
					const unread = store.listMessages({ direction: "in", unreadOnly: true }).length;
					if (unread > 0 || collector.messages.length > 0 || collector.heldNow.size > 0 || collector.receipts.length > 0) {
						break;
					}
					if (Date.now() >= deadline) {
						timedOut = true;
						break;
					}
					try {
						await runtime().sleep(Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()), control.signal);
					} catch (error) {
						if (control.signal?.aborted) {
							interrupted = true;
							break;
						}
						throw error;
					}
				}
			} else {
				const outcome = await pumpWithin(client, waitSec * 1000);
				if (outcome.result?.complete) {
					cursor = outcome.result.cursor;
				} else {
					truncated = true;
				}
			}
		} finally {
			await client.stop().catch(() => undefined);
		}

		if (!interrupted) {
			if (control.activity) {
				seen.holdFor(cursor);
			}
			store.flush();
			seen.flush();
			updateState(profileName, { cursor, lastPumpAt: new Date().toISOString() });
		}
		if (!control.activity) {
			relays = await probe();
		}

		if (interrupted) {
			process.exitCode = EXIT.interrupted;
			return;
		}

		const unreadCount = store.listMessages({ direction: "in", unreadOnly: true }).length;
		let messages = collector.messages;
		if (options.thread) {
			messages = store.getThread(options.thread);
		} else if (options.unread || (control.activity && unreadCount > 0)) {
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
			...(timedOut === undefined ? {} : { timedOut }),
		};
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

		if (control.activity ? !everRelayAnswered : summary.relays.ok === 0) {
			process.exitCode = EXIT.network;
		}
	} finally {
		releaseLock();
	}
}

export async function inboxCommand(options: InboxOptions): Promise<void> {
	return runInboxCommand(options);
}
