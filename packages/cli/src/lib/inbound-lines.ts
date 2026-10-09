import kleur from "kleur";
import { shortNpub } from "./output.js";
import type { HoldResult } from "./store/types.js";

/**
 * How `agx serve` prints an inbound plain message. Pure, so the one piece of
 * `serve` whose output a model may read as context can be tested on its own.
 *
 * Two properties matter once stdout is a machine's input (Claude Code's Monitor
 * turns every stdout line into a notification):
 *
 *   - **No forged headers.** Every line of the body is indented, and control
 *     characters are neutralized, so a body cannot start a line that reads as
 *     `RECV`/`HOLD` or rewrite one with a carriage return or ANSI escape.
 *   - **`allowedOnly` withholds, it does not filter.** A sender off the allowlist
 *     still gets one line — its npub, which is bech32 and cannot carry text — so
 *     nothing arrives unseen, but nothing it wrote reaches the reader.
 *
 * A held message is still recorded as seen, so allowing its sender afterwards
 * does not bring it back — not even with `--reset-cursor`. The HOLD line says
 * so: the sender has to resend once they are allowed.
 */

/** Width of the `RECV `/`HOLD ` label plus its separator; bodies align under it. */
export const BODY_INDENT = "       ";

export interface InboundMessageView {
	/** Sender, as a bech32 npub. */
	fromNpub: string;
	/** Whether the sender is on the allowlist (profile + session `--allow`). */
	allowed: boolean;
	subject: string | null | undefined;
	contextId: string | null | undefined;
	text: string;
	/** Withhold everything but the npub for a sender that is not allowed. */
	allowedOnly: boolean;
	/** Print the full npub and contextId instead of the scannable short forms. */
	fullIds: boolean;
	/** What the store did with a withheld message; "kept" when not given. */
	held?: HoldResult | "stored";
}

const DECIDE = (npub: string): string => `agx held allow ${npub} (or: agx held ignore | agx held block)`;

function holdLine(npub: string, held: HoldResult | "stored"): string {
	const head = `${kleur.yellow("HOLD ")} from ${npub} — not on the allowlist; text withheld here and`;
	switch (held) {
		case "capped":
			return `${head} not kept: the limit for kept messages is reached. To read what is kept: ${DECIDE(npub)}`;
		case "rate-limited":
			return `${head} not kept: too many new senders this hour. To allow this one: ${DECIDE(npub)}`;
		case "suppressed":
			return `${head} not kept: you ignored or blocked this sender. To change that: agx held allow ${npub}`;
		default:
			return `${head} kept for your decision. To read it: ${DECIDE(npub)}`;
	}
}

export function renderInboundLines(view: InboundMessageView): string[] {
	if (view.allowedOnly && !view.allowed) {
		return [holdLine(view.fromNpub, view.held ?? "kept")];
	}
	const from = view.fullIds ? view.fromNpub : shortNpub(view.fromNpub);
	const subject = view.subject
		? `  subject ${escapeLineBreakers(JSON.stringify(view.subject))}`
		: "";
	const context = view.contextId
		? kleur.dim(`  ctx ${renderContextId(view.contextId, view.fullIds)}`)
		: "";
	return [
		`${kleur.cyan("RECV ")} from ${from}${subject}${context}`,
		...bodyLines(view.text),
	];
}

/**
 * `--full-ids` prints the contextId so a reader can paste it into
 * `agx send … --context-id <id>`. The sender chose it (any string up to 200
 * chars), so a value outside a shell-inert charset is withheld rather than
 * printed for pasting: the reader starts a new thread instead.
 */
function renderContextId(contextId: string, fullIds: boolean): string {
	if (!fullIds) {
		return neutralizeControls(contextId.slice(0, 8));
	}
	return SAFE_ID_RE.test(contextId)
		? contextId
		: "withheld (unsafe characters; reply without --context-id)";
}

/**
 * The body, one output line per input line, each indented. Splits on every
 * sequence a line-oriented reader might treat as a break — not only `\n`.
 */
export function bodyLines(text: string): string[] {
	return text
		.split(LINE_BREAK_RE)
		.map((line) => `${BODY_INDENT}${neutralizeControls(line)}`);
}

/** Replace control characters (C0 except tab, DEL, C1) — ESC among them, so no
 * ANSI sequence survives — and the U+2028/U+2029 separators with U+FFFD.
 * Visible, never interpreted, never a line break. For single-line fields a peer
 * controls (contextId, taskId, a receipt's refEventId). */
export function neutralizeControls(value: string): string {
	return value.replace(CONTROL_RE, "\uFFFD");
}

/** For a multi-line body: keeps newlines and tabs, normalises CRLF/CR to LF, and
 * replaces the other control characters, C1 and U+2028/U+2029 with U+FFFD. */
export function neutralizeBodyControls(value: string): string {
	return value.replace(/\r\n?/g, "\n").replace(BODY_CONTROL_RE, "\uFFFD");
}

/** Whether a peer-supplied id is safe to print for pasting into a shell. */
export function isSafeId(value: string): boolean {
	return SAFE_ID_RE.test(value);
}

/** A peer-supplied value as JSON on one line, safe to print after a header. */
// `unknown`: a task payload and a `--handler` result are arbitrary JSON by contract.
export function oneLineJson(value: unknown): string {
	return escapeLineBreakers(JSON.stringify(value) ?? "undefined");
}

/** `JSON.stringify` escapes C0 controls but emits U+2028/U+2029/U+0085 and the
 * rest of C1 raw; escape those too so a quoted subject stays on one line. */
function escapeLineBreakers(quoted: string): string {
	return quoted.replace(
		C1_AND_SEPARATORS_RE,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const LINE_BREAK_RE = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** Ids agx mints (hex, UUIDs) and common peer formats; nothing a shell expands. */
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
const C1_AND_SEPARATORS_RE = /[\u007f-\u009f\u2028\u2029]/g;
