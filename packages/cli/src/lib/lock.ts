import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { AgxCliError, EXIT, type ExitCode } from "./errors.js";
import { ensureDir, lockPath, profileDir } from "./paths.js";

/** The holder refreshes the lock file's mtime this often... */
export const LOCK_HEARTBEAT_MS = 10_000;
/** ...and a lock from another host counts as abandoned after this long without a refresh. */
export const LOCK_STALE_MS = 60_000;

interface LockRecord {
	pid: number;
	host: string;
	token: string;
}

function readRecord(path: string): LockRecord | null {
	try {
		const text = readFileSync(path, "utf8").trim();
		const parsed: unknown = text.startsWith("{") ? JSON.parse(text) : { pid: Number(text) };
		const { pid, host, token } = parsed as Partial<LockRecord>;
		// An empty or torn file reads as pid 0 or NaN; `kill(0, 0)` would call that "alive".
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return null;
		}
		return { pid, host: typeof host === "string" ? host : "", token: typeof token === "string" ? token : "" };
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether the file names a live holder. On this host the pid decides: another live
 * process holds it, and our own pid in an old file is a previous life of this process
 * (pids repeat after a restart, notably pid 1 in containers). From another host,
 * where a pid means nothing, only a recent heartbeat counts: that is what keeps two
 * containers sharing one AGX_HOME from both writing.
 */
function heldByLiveOwner(path: string, record: LockRecord | null): boolean {
	if (record === null) {
		return false;
	}
	if (record.host === "" || record.host === hostname()) {
		return record.pid !== process.pid && isAlive(record.pid);
	}
	try {
		return Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
	} catch {
		return false;
	}
}

/** Per-profile single-writer lock shared by `agx serve`, `agx inbox` and `agx ui`. */
export function acquireLock(
	profile: string,
	exitCode: ExitCode = EXIT.config,
): () => void {
	const path = lockPath(profile);
	ensureDir(profileDir(profile));
	const token = randomUUID();
	const mine = `${path}.${process.pid}.${token.slice(0, 8)}`;
	const record: LockRecord = { pid: process.pid, host: hostname(), token };
	writeFileSync(mine, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				// A hard link is created whole or not at all, so no one ever sees a half-written lock.
				linkSync(mine, path);
				return startHeartbeat(path, token);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
			}
			const holder = existsSync(path) ? readRecord(path) : null;
			if (holder !== null && heldByLiveOwner(path, holder)) {
				throw new AgxCliError(
					`Another \`agx serve\`, \`agx inbox\` or \`agx ui\` is already running for profile "${profile}" (pid ${holder.pid}${holder.host && holder.host !== hostname() ? ` on ${holder.host}` : ""}).`,
					{
						exitCode,
						remediation:
							"The seen-store and message store are single-writer, so only one may run per profile. Stop the other one, or use a second profile:\n    agx serve --profile other",
					},
				);
			}
			// Abandoned: a crashed run, an empty file, or an old life of this pid.
			rmSync(path, { force: true });
		}
		throw new AgxCliError(`Could not take the lock for profile "${profile}".`, { exitCode });
	} finally {
		rmSync(mine, { force: true });
	}
}

/** Keep the lock fresh for hosts that cannot see our pid; the returned function releases it. */
function startHeartbeat(path: string, token: string): () => void {
	const ours = (): boolean => readRecord(path)?.token === token;
	const timer = setInterval(() => {
		if (!ours()) {
			clearInterval(timer);
			return;
		}
		try {
			const now = new Date();
			utimesSync(path, now, now);
		} catch {
			// The file is gone; the next tick sees that and stops.
		}
	}, LOCK_HEARTBEAT_MS);
	timer.unref();
	return () => {
		clearInterval(timer);
		// Only remove the lock if it is still ours.
		if (ours()) {
			rmSync(path, { force: true });
		}
	};
}
