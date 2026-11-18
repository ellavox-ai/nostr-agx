import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Filesystem layout and the two rules that matter for a directory holding a
 * secp256k1 secret key and a bearer API key:
 *
 *   - `0700` on the directory, `0600` on every file. `writeFileSync`'s `mode` is
 *     ignored when the file already exists, so every write chmods explicitly.
 *   - Writes are atomic (tmp + rename; tmp + link for a write that must not
 *     replace a file). `agx serve` rewrites its cursor after every poll; a torn
 *     write there would strand the inbox.
 *
 *   ~/.agx/
 *     config.json                         profiles: API base, org, relays, allowlist
 *                                         (never a key since 0.4; a 0.3 key is
 *                                         migrated out on the next write)
 *     credentials.json                    API keys, one per profile, each bound
 *                                         to the one origin it may be sent to
 *     profiles/<name>/identity.json       the secret key
 *     profiles/<name>/state.json          cursor + listing id
 *     profiles/<name>/seen.json           replay-protection ids
 *     profiles/<name>/pending-login.json  an `agx login` waiting for approval
 *     profiles/<name>/pending-login.lock  held by the one process polling it
 *     profiles/<name>/gateway-keys.json   `agx gateway` API keys (SHA-256 hashes)
 *     profiles/<name>/gateway-subscriptions.json
 *                                         webhooks `agx gateway` delivers to,
 *                                         with their signing secrets
 *     profiles/<name>/gateway-task-operations.json
 *                                         idempotent and background task operations and outcomes
 */

export function agxHome(): string {
	return process.env.AGX_HOME ?? join(homedir(), ".agx");
}

export function configPath(): string {
	return join(agxHome(), "config.json");
}

export function credentialsPath(): string {
	return join(agxHome(), "credentials.json");
}

export function profileDir(profile: string): string {
	return join(agxHome(), "profiles", profile);
}

export function identityPath(profile: string): string {
	return join(profileDir(profile), "identity.json");
}

export function statePath(profile: string): string {
	return join(profileDir(profile), "state.json");
}

export function seenPath(profile: string): string {
	return join(profileDir(profile), "seen.json");
}

export function lockPath(profile: string): string {
	return join(profileDir(profile), "serve.lock");
}

export function pendingLoginPath(profile: string): string {
	return join(profileDir(profile), "pending-login.json");
}

export function pendingLoginLockPath(profile: string): string {
	return join(profileDir(profile), "pending-login.lock");
}

/** `agx gateway`'s API keys, hashed. */
export function gatewayKeysPath(profile: string): string {
	return join(profileDir(profile), "gateway-keys.json");
}

/** `agx gateway`'s webhook subscriptions, with their signing secrets. */
export function gatewaySubscriptionsPath(profile: string): string {
	return join(profileDir(profile), "gateway-subscriptions.json");
}

/** Idempotent task submissions and their retained outcomes. */
export function gatewayTaskOperationsPath(profile: string): string {
	return join(profileDir(profile), "gateway-task-operations.json");
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// A pre-existing directory we do not own; the permission check surfaces it.
	}
}

/** Atomic, private write. Used for every file under `~/.agx`. */
export function writePrivateJson(
	path: string,
	value: unknown,
	options?: PrivateWriteOptions,
): void {
	writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export interface PrivateWriteOptions {
	/**
	 * Flush to disk before the rename (default true). Only a file that means
	 * nothing after a power loss, such as a lock heartbeat whose holder died
	 * with the machine, turns this off.
	 */
	sync?: boolean;
	/**
	 * Create the file only if nothing is there at the moment it is written
	 * (default false: replace what is there). Throws `PrivateFileExistsError`
	 * when something is. For a file whose old content must not be lost to a
	 * writer that checked for it a moment too early, such as a secret key.
	 */
	exclusive?: boolean;
}

/** An exclusive write found the file already there. Holds the path, never the content. */
export class PrivateFileExistsError extends Error {
	constructor(readonly path: string) {
		super(`${path} already exists.`);
		this.name = "PrivateFileExistsError";
	}
}

/**
 * An exclusive write could not be made because the file system under the target
 * cannot make hard links (EPERM on Linux vfat, ENOTSUP on macOS FAT, EOPNOTSUPP,
 * ENOSYS). Nothing was written. Holds the path, never the content.
 */
export class HardLinksUnavailableError extends Error {
	constructor(readonly path: string) {
		super(`${dirname(path)} is on a file system that cannot make hard links.`);
		this.name = "HardLinksUnavailableError";
	}
}

/** The codes `link()` gives when the file system cannot make hard links at all. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Atomic, private write of text (JSON-lines files use this directly).
 *
 * The temp name is unique per write, so two processes writing the same file
 * (two `agx login` runs finishing together) never share, and tear, one temp
 * file. A failed write removes its temp file rather than leaving it behind.
 */
export function writePrivateText(
	path: string,
	text: string,
	{ sync = true, exclusive = false }: PrivateWriteOptions = {},
): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		// On disk before the rename, so a power loss never leaves an empty file where data was.
		if (sync) {
			const fd = openSync(tmp, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		if (exclusive) {
			// link() creates `path` complete, with the temp file's content and mode, or
			// fails with EEXIST when something is already there. rename() would replace it.
			try {
				linkSync(tmp, path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (code === "EEXIST") {
					throw new PrivateFileExistsError(path);
				}
				if (NO_HARD_LINKS.has(code)) {
					throw new HardLinksUnavailableError(path);
				}
				throw error;
			}
			try {
				unlinkSync(tmp);
			} catch {
				// `path` is in place and whole. A temp name that stays behind must not turn a finished write into a failure.
			}
		} else {
			renameSync(tmp, path);
		}
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Delete a private file if it exists. Returns whether it was there. */
export function removePrivateFile(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

/** Returns the octal permission bits, or null when the file does not exist. */
export function fileMode(path: string): number | null {
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return null;
	}
}

export function isTooPermissive(path: string): boolean {
	const mode = fileMode(path);
	return mode !== null && (mode & 0o077) !== 0;
}
