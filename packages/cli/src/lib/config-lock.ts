import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { configError } from "./errors.js";
import { configPath, ensureDir } from "./paths.js";

/**
 * A short lock around `config.json`'s read-modify-write.
 *
 * `config.json` is shared by every profile and every command. Without a lock, two
 * `agx` commands that overlap each read the same old file and the later write
 * drops the earlier one, with both exiting 0 — and a `deny` can be undone by an
 * `allow`. This is NOT the profile lock in `lock.ts`: that one is held for the whole
 * life of `serve`, `inbox`, `gateway` and `ui`, and `identity allow` must still work
 * while one of them runs. This one is held for the milliseconds a write takes.
 *
 * The same lock can guard any one file that is read, changed and written back (`withFileLock`): it is
 * made next to that file, so the lock of one file never holds up a write of another. `config.json` is
 * the case that has a name (`withConfigLock`).
 */

/** How long a writer waits for another one before it gives up. A holder normally lets go within milliseconds. */
export const CONFIG_LOCK_WAIT_MS = 5_000;
/** A lock file older than this is abandoned, whatever its pid says: the section it guards takes milliseconds. The age counts from when its owner started waiting for it, not from when it got it. */
export const CONFIG_LOCK_STALE_MS = 30_000;
/** A record that cannot be read is only judged abandoned once the file is this old. A lock is linked in whole, so a live holder's is never unreadable. */
export const CONFIG_LOCK_UNREADABLE_MS = 1_000;
const POLL_MS = 10;

interface LockRecord {
	pid: number;
	host: string;
	token: string;
}

/** The lock of a file sits beside it. */
function lockPathOf(file: string): string {
	return `${file}.lock`;
}

export function configLockPath(): string {
	return lockPathOf(configPath());
}

function parseRecord(text: string): LockRecord | null {
	try {
		const parsed: unknown = JSON.parse(text);
		const { pid, host, token } = parsed as Partial<LockRecord>;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return null;
		}
		return { pid, host: typeof host === "string" ? host : "", token: typeof token === "string" ? token : "" };
	} catch {
		return null;
	}
}

function readRecord(path: string): LockRecord | null {
	try {
		return parseRecord(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** What is at the lock path right now: nothing, or a file whose record may be unreadable. Not the same thing. */
function look(path: string): { exists: boolean; record: LockRecord | null } {
	try {
		return { exists: true, record: parseRecord(readFileSync(path, "utf8")) };
	} catch {
		return { exists: false, record: null };
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
 * True when nobody is holding the lock: a holder that has exited, one nobody refreshed for too long,
 * or a file that has stayed unreadable. Only meaningful for a file that exists. A file that has just
 * vanished was released, not abandoned, so it is never judged abandoned (that mistake let two
 * writers hold the lock at once).
 */
function abandoned(path: string, record: LockRecord | null): boolean {
	let age: number;
	try {
		age = Date.now() - statSync(path).mtimeMs;
	} catch {
		return false;
	}
	if (record === null) {
		return age > CONFIG_LOCK_UNREADABLE_MS;
	}
	if (age > CONFIG_LOCK_STALE_MS) {
		return true;
	}
	if (record.host === "" || record.host === hostname()) {
		// Our own pid in a file we do not hold is an earlier life of this pid.
		return record.pid === process.pid || !isAlive(record.pid);
	}
	// Another host: a pid means nothing there, so only its age counts (above).
	return false;
}

function sameRecord(a: LockRecord | null, b: LockRecord | null): boolean {
	return a === null || b === null ? a === b : a.token === b.token && a.pid === b.pid;
}

/**
 * Remove a lock judged abandoned, so that only one process at a time can do it and nobody removes a
 * lock that is not the one judged. A rename-and-put-back (as the profile lock does) leaves the path
 * empty for a moment; a third writer could link in there and two would hold the lock.
 *
 * The breaker file is itself a lock: it carries its owner's pid and a token. It is taken away only by
 * the same judgement as a lock (owner gone, or not refreshed for the stale age), never because it is
 * old: an owner that is only paused would otherwise wake up and remove a lock it has no right to. It
 * is removed afterwards only if it is still ours.
 *
 * Exported so a test can hand it a judgement that has gone out of date, which a race cannot be made to do.
 */
export function clearUnderBreaker(path: string, judged: LockRecord | null): void {
	const breaker = `${path}.break`;
	const token = randomUUID();
	try {
		writeFileSync(breaker, `${JSON.stringify({ pid: process.pid, host: hostname(), token })}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
		// Someone else is clearing. Take their breaker away only if its owner is gone.
		const other = look(breaker);
		if (other.exists && abandoned(breaker, other.record)) {
			const again = look(breaker);
			if (again.exists && sameRecord(again.record, other.record)) {
				rmSync(breaker, { force: true });
			}
		}
		return;
	}
	try {
		const now = look(path);
		if (!now.exists) {
			return;
		}
		if (sameRecord(now.record, judged) && abandoned(path, now.record)) {
			rmSync(path, { force: true });
		}
	} finally {
		if (readRecord(breaker)?.token === token) {
			rmSync(breaker, { force: true });
		}
	}
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms`. `updateProfile` and its callers are synchronous, so the wait must be too. */
function pause(ms: number): void {
	Atomics.wait(sleeper, 0, 0, ms);
}

/** Take the lock of `file`. `label` names the lock for a person: "config" in "the config lock". */
function acquire(file: string, label: string, waitMs: number): { token: string; release: () => void } {
	const path = lockPathOf(file);
	ensureDir(dirname(path));
	const token = randomUUID();
	const mine = `${path}.${process.pid}.${token.slice(0, 8)}`;
	writeFileSync(mine, `${JSON.stringify({ pid: process.pid, host: hostname(), token })}\n`, { mode: 0o600 });
	const deadline = Date.now() + waitMs;
	try {
		for (;;) {
			try {
				// A hard link is created whole or not at all, so no one ever sees a half-written lock.
				linkSync(mine, path);
				// Only our own record means we hold it.
				if (readRecord(path)?.token === token) {
					return {
						token,
						release: () => {
							if (readRecord(path)?.token === token) {
								rmSync(path, { force: true });
							}
						},
					};
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
			}
			const seen = look(path);
			if (seen.exists && abandoned(path, seen.record) && Date.now() < deadline) {
				clearUnderBreaker(path, seen.record);
				pause(1);
				continue;
			}
			if (Date.now() >= deadline) {
				throw configError(
					`Could not take the ${label} lock: another agx command has been writing ${file} for more than ${Math.round(waitMs / 1000)} seconds.`,
					`If no other agx command is running, remove the lock and try again:\n    rm ${path}`,
				);
			}
			// The lock was released between our link attempt and our look: try again at once.
			pause(seen.exists ? POLL_MS : 1);
		}
	} finally {
		rmSync(mine, { force: true });
	}
}

/** For each file whose lock this process holds: the token in the lock record this process wrote. */
const held = new Map<string, string>();

/** A function that returns a promise is refused: the lock is let go when `fn` returns, before the promise settles. */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

/** The type refuses a promise, but a function typed `any` or a hand-made thenable gets past it, so it is refused here too. */
function runSynchronously<T>(fn: () => NotAPromise<T>, label: string): T {
	const result = fn();
	if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
		const caller = label === "config" ? "withConfigLock" : `withFileLock (${label})`;
		throw new Error(
			`${caller}: the function must be synchronous. The lock is let go when it returns, so whatever a promise does later would run without the lock.`,
		);
	}
	return result;
}

/**
 * Run `fn` while holding the lock of `file`. Re-entrant within one process, so a caller that already
 * holds it can call again without waiting for itself. `label` names the lock in what a person reads:
 * "Tailscale secrets" gives "Could not take the Tailscale secrets lock".
 *
 * Nothing holds the locks of two files at once today. If something ever does, every place must take
 * them in the same order, or two commands can each wait for the other until the wait runs out.
 */
export function withFileLock<T>(
	file: string,
	label: string,
	fn: () => NotAPromise<T>,
	options: { waitMs?: number } = {},
): T {
	if (held.has(file)) {
		return runSynchronously(fn, label);
	}
	const { token, release } = acquire(file, label, options.waitMs ?? CONFIG_LOCK_WAIT_MS);
	held.set(file, token);
	try {
		return runSynchronously(fn, label);
	} finally {
		held.delete(file);
		release();
	}
}

/**
 * Run `fn` while holding the config lock. Re-entrant within one process, so a
 * caller that already holds it can call `updateProfile` without waiting for itself.
 */
export function withConfigLock<T>(fn: () => NotAPromise<T>, options: { waitMs?: number } = {}): T {
	return withFileLock<T>(configPath(), "config", fn, options);
}

/**
 * Called right before `file` is renamed into place. A command that is stopped for longer than
 * the stale age (a debugger, a laptop asleep) has its lock taken by the next one, and would then
 * publish its out-of-date copy over what that command saved. So the holder checks, one step before
 * the rename, that the lock file still carries its own token; if it does not, this raises and nothing
 * is written. That narrows the window to the time between this check and the rename. It does not
 * close it: that would need the file system to refuse a write from a holder that was displaced.
 * A save made outside the lock holds nothing to lose, so it is never refused.
 */
export function assertFileLockHeld(file: string, label: string): void {
	const token = held.get(file);
	if (token === undefined || readRecord(lockPathOf(file))?.token === token) {
		return;
	}
	throw configError(
		`This change was not saved: another agx command took over the ${label} lock on ${file} while this one was stopped for more than ${CONFIG_LOCK_STALE_MS / 1000} seconds. ${basename(file)} is as that command left it.`,
		"Run the command again.",
	);
}

/** `assertFileLockHeld` for config.json. */
export function assertConfigLockHeld(): void {
	assertFileLockHeld(configPath(), "config");
}
