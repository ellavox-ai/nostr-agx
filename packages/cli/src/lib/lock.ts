import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AgxCliError, EXIT, type ExitCode } from "./errors.js";
import { ensureDir, lockPath, profileDir } from "./paths.js";

/** Per-profile single-writer lock shared by `agx serve` and `agx inbox`. */
export function acquireLock(
	profile: string,
	exitCode: ExitCode = EXIT.config,
): () => void {
	const path = lockPath(profile);
	ensureDir(profileDir(profile));
	if (existsSync(path)) {
		const pid = Number(readFileSync(path, "utf8").trim());
		// A stale lock from a crashed run must not block a restart forever, so the
		// pid is probed rather than trusted.
		let alive = false;
		try {
			process.kill(pid, 0);
			alive = true;
		} catch {
			alive = false;
		}
		if (alive) {
			throw new AgxCliError(
				`Another \`agx serve\` or \`agx inbox\` is already running for profile "${profile}" (pid ${pid}).`,
				{
					exitCode,
					remediation:
						"The seen-store and message store are single-writer, so only one may run per profile. Stop the other one, or use a second profile:\n    agx serve --profile other",
				},
			);
		}
		rmSync(path, { force: true });
	}
	writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
	return () => rmSync(path, { force: true });
}
