import kleur from "kleur";
import { scrubbedJson, scrubOutput } from "./scrub.js";

/** Terminal output helpers. Every line the CLI prints goes through here so the
 * `--json` mode has exactly one place to suppress human formatting, and so a
 * secret key that reaches any of them is replaced before it is written
 * (`scrub.ts`). The one deliberate print of a key, `agx identity export`, does not
 * pass through here. */

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
	jsonMode = enabled;
}

export function isJsonMode(): boolean {
	return jsonMode;
}

export function setColor(enabled: boolean): void {
	kleur.enabled = enabled;
}

export function say(message = ""): void {
	if (!jsonMode) {
		console.log(scrubOutput(message));
	}
}

/** One line on stdout, `--json` or not: for the few lines that are data, not a report. */
export function outLine(message = ""): void {
	console.log(scrubOutput(message));
}

/** One line on stderr, `--json` or not. */
export function errLine(message = ""): void {
	console.error(scrubOutput(message));
}

/** Text to stdout as given, with no newline added: what commander's own writer does (help, version). */
export function writeOut(text: string): void {
	process.stdout.write(scrubOutput(text));
}

/** Text to stderr as given, with no newline added: what commander's own writer does (usage errors). */
export function writeErr(text: string): void {
	process.stderr.write(scrubOutput(text));
}

export function ok(message: string): void {
	say(`${kleur.green("✓")} ${message}`);
}

export function info(message: string): void {
	say(`${kleur.cyan("·")} ${message}`);
}

export function warn(message: string): void {
	say(`${kleur.yellow("!")} ${message}`);
}

export function fail(message: string): void {
	say(`${kleur.red("✗")} ${message}`);
}

/**
 * A line for the person at the terminal that `--json` does NOT suppress: it
 * goes to stderr, so stdout stays exactly one JSON document. For deprecations,
 * security warnings and "what just happened" notes a harness should log.
 */
export function notice(message: string): void {
	errLine(`${kleur.yellow("!")} ${message}`);
}

/** One compact JSON object on one stderr line, `--json` or not. Used for the
 * blocking `agx login --json` hand-off, where stdout is reserved for the
 * final result. */
export function emitStderrJson(payload: unknown): void {
	console.error(scrubbedJson(payload));
}

/** One compact JSON object on one stdout line. */
export function emitStdoutJson(payload: unknown): void {
	console.log(scrubbedJson(payload));
}

export function step(n: number, total: number, message: string): void {
	say(`${kleur.dim(`[${n}/${total}]`)} ${message}`);
}

export function heading(message: string): void {
	say(`\n${kleur.bold(message)}`);
}

export function kv(key: string, value: string | number | null): void {
	const rendered =
		value === null || value === "" ? kleur.dim("—") : `${value}`;
	say(`  ${kleur.dim(key.padEnd(16))} ${rendered}`);
}

const C1_AND_SEPARATORS_RE = /[\u007f-\u009f\u2028\u2029]/g;

/** `JSON.stringify` escapes C0 controls but emits U+2028/U+2029/U+0085 and the
 * rest of C1 raw; escape those too so a quoted subject stays on one line. */
export function escapeLineBreakers(quoted: string): string {
	return quoted.replace(
		C1_AND_SEPARATORS_RE,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** Emit the machine-readable payload. Always printed, `--json` or not — but in
 * human mode it is the only thing on stdout that is not decorated, so piping to
 * `jq` still works when the caller opts in. */
export function json(payload: unknown): void {
	if (jsonMode) {
		// These characters can only sit inside a JSON string, where `\uXXXX` parses
		// back to the same value, so escaping the whole text loses nothing. Peer
		// text can carry them, and a terminal may act on U+009B (CSI).
		console.log(escapeLineBreakers(scrubbedJson(payload, 2)));
	}
}

export function table(rows: string[][], headers: string[]): void {
	if (jsonMode) {
		return;
	}
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	const line = (cells: string[]) =>
		cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
	say(kleur.dim(line(headers)));
	for (const row of rows) {
		say(line(row));
	}
	if (rows.length === 0) {
		say(kleur.dim("  (none)"));
	}
}

/** Short, scannable npub — enough to recognise, short enough to fit a table. */
export function shortNpub(npub: string): string {
	return npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : npub;
}

/**
 * `alice@acme.com` → `a•••@acme.com`. A fixed bullet count, so the mask leaks
 * nothing about the length of the local part. Matches the server's
 * `emailMasked`, so a masked value passes through unchanged.
 */
export function maskEmail(email: string | null | undefined): string | null {
	if (!email) {
		return null;
	}
	const at = email.lastIndexOf("@");
	if (at <= 0) {
		return "•••";
	}
	const local = email.slice(0, at);
	if (local.endsWith("•••") && local.length === 4) {
		return email;
	}
	return `${local[0]}•••${email.slice(at)}`;
}

/** `ela_AbCd…wxyz` → `ela_…wxyz`: enough to tell two keys apart, never enough
 * to use one. */
export function maskKey(key: string | null | undefined): string | null {
	if (!key) {
		return null;
	}
	const prefix = /^[a-z]+_/.exec(key)?.[0] ?? "";
	return key.length <= prefix.length + 8
		? `${prefix}…`
		: `${prefix}…${key.slice(-4)}`;
}
