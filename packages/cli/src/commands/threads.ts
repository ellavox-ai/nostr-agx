import { AgxCliError, EXIT } from "../lib/errors.js";
import { tryAcquireLock } from "../lib/lock.js";
import { json, say, table } from "../lib/output.js";
import { resolveProfileName } from "../lib/config.js";
import { profileDir } from "../lib/paths.js";
import { MessageStore } from "../lib/store/message-store.js";
import { buildThreadReport, renderThreadLines, THREADS_SCHEMA, threadRows } from "../lib/threads.js";

export interface ThreadsOptions {
	profile?: string;
	fullIds?: boolean;
	markRead?: boolean;
}

export function threadsCommand(options: ThreadsOptions): void {
	const profileName = resolveProfileName(options.profile);
	const threads = new MessageStore(profileDir(profileName)).listThreads();
	json({ schema: THREADS_SCHEMA, threads });
	table(threadRows(threads, options.fullIds === true), ["peer", "subject", "msgs", "unread", "last", "thread"]);
}

export function threadCommand(contextId: string, options: ThreadsOptions): void {
	const profileName = resolveProfileName(options.profile);
	const dir = profileDir(profileName);
	const store = new MessageStore(dir);
	const messages = store.getThread(contextId);
	if (messages.length === 0) {
		throw new AgxCliError(`No thread "${contextId}".`, {
			exitCode: EXIT.generic,
			remediation: "List threads with: agx threads",
		});
	}
	const report = buildThreadReport(contextId, messages);
	json(report);
	for (const line of renderThreadLines(report, options.fullIds === true)) {
		say(line);
	}
	if (!options.markRead) {
		return;
	}
	// Marking read writes: do it now if no one holds the lock, else queue it for the holder.
	const releaseLock = tryAcquireLock(profileName);
	if (releaseLock === null) {
		MessageStore.spool(dir, { kind: "read", contextId });
		return;
	}
	try {
		const writer = new MessageStore(dir, undefined, { claimSpool: true });
		writer.markRead({ contextId });
		writer.flush();
	} finally {
		releaseLock();
	}
}
