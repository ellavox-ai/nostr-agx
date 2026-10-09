import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
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
 *   - Writes are atomic (tmp + rename). `agx serve` rewrites its cursor after
 *     every poll; a torn write there would strand the inbox.
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

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// A pre-existing directory we do not own; the permission check surfaces it.
	}
}

/**
 * Atomic, private write. Used for every file under `~/.agx`.
 *
 * The temp name is unique per write, so two processes writing the same file
 * (two `agx login` runs finishing together) never share, and tear, one temp
 * file. A failed write removes its temp file rather than leaving it behind.
 */
export function writePrivateJson(path: string, value: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
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
