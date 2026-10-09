import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
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
 *     config.json                    profiles: API base, key, org, relays, allowlist
 *     profiles/<name>/identity.json  the secret key
 *     profiles/<name>/state.json     cursor + listing id
 *     profiles/<name>/seen.json      replay-protection ids
 */

export function agxHome(): string {
	return process.env.AGX_HOME ?? join(homedir(), ".agx");
}

export function configPath(): string {
	return join(agxHome(), "config.json");
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

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// A pre-existing directory we do not own; the permission check surfaces it.
	}
}

/** Atomic, private write. Used for every file under `~/.agx`. */
export function writePrivateJson(path: string, value: unknown): void {
	writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Atomic, private write of text (JSON-lines files use this directly). */
export function writePrivateText(path: string, text: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	// On disk before the rename, so a power loss never leaves an empty file where data was.
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
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
