import kleur from "kleur";
import type { ActionRequired } from "./errors.js";
import { usageError } from "./errors.js";
import { emitStderrJson, isJsonMode } from "./output.js";

/**
 * Shared pieces of the `--wait` loops (`listing publish --wait`,
 * `domain verify --wait`).
 *
 * Both poll at 15 s or slower: an agx login key's rate limit only resets after
 * a quiet gap of 10 s, and `verifyDomain` makes an outbound NIP-05
 * fetch on every call.
 */

export const WAIT_POLL_MS = 15_000;

/** `90`, `90s`, `10m`, `1h` → milliseconds. A bare number is seconds. */
export function parseDuration(raw: string, flag = "--timeout"): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(raw);
	if (!match) {
		throw usageError(
			`${flag} "${raw}" is not a duration.`,
			`Use seconds, minutes or hours, for example ${flag} 10m`,
		);
	}
	const value = Number(match[1]);
	const unit = (match[2] ?? "s").toLowerCase();
	const factor =
		unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	const ms = Math.round(value * factor);
	if (ms <= 0) {
		throw usageError(`${flag} must be greater than zero.`);
	}
	return ms;
}

/**
 * Tell whoever is watching, once, that a human has to act before the wait can
 * end: one `{"actionRequired":…}` line on stderr under `--json` (stdout stays
 * the final result), the URL in words otherwise.
 */
export function announceActionRequired(
	action: ActionRequired,
	message: string,
): void {
	if (isJsonMode()) {
		emitStderrJson({ actionRequired: action });
		return;
	}
	console.error(`\n${kleur.yellow("!")} ${message}`);
	console.error(`\n  ${kleur.bold(action.url)}\n`);
	console.error(kleur.dim("  Waiting… (Ctrl-C to stop; re-run to check again)"));
}
