/**
 * Recognising a Nostr secret key in text. Pure string work: nothing here decodes
 * a key, reads a file or opens a connection, and nothing returns the text it
 * matched, so a caller can quote a result without quoting the key.
 *
 * This is the one place that says what "this text holds a secret key" means, for
 * the CLI, its web UI and the n8n nodes. There are three answers, because a wrong
 * answer costs something different in each place:
 *
 * - {@link holdsSecretKey} is lenient. It is for text that is about to be shown or
 *   kept: a false positive hides a harmless value, a false negative prints a key.
 * - {@link secretKeyKinds} is strict. It is for a warning the user can dismiss:
 *   the word `nsec1` in a sentence is not a key.
 * - {@link hexKeyRuns} finds runs of 64 hex digits. A secret key written as hex is
 *   those 64 digits and nothing else, so a run is only a CANDIDATE: a public key, an
 *   event id and a SHA-256 hash look exactly the same. Only the slot the text came
 *   from, or the exact value of a key that is already known, can tell them apart.
 *
 * {@link scrubSecretKeys} is the same lenient reading turned into an action: it takes
 * the keys out of a text. It leaves 64-hex runs alone for the reason above.
 *
 * `nsec1` and `ncryptsec1` (a password-protected key, NIP-49) are matched in any
 * case (bech32 allows all capitals), behind `nostr:`, and with `%xx` escapes
 * decoded.
 */

/** The characters bech32 uses after the `1`: all but `1`, `b`, `i` and `o`. */
const BECH32_DATA = "[02-9ac-hj-np-z]";

/** A key has at least this many characters of data after its prefix to count as one. A real `nsec1` has 58. */
const MIN_KEY_DATA = 20;

const NSEC_SHAPE = new RegExp(`\\bnsec1${BECH32_DATA}{${MIN_KEY_DATA},}\\b`, "i");
const NCRYPTSEC_SHAPE = new RegExp(`\\bncryptsec1${BECH32_DATA}{${MIN_KEY_DATA},}\\b`, "i");

/**
 * `text` as given, then the text after each round of `%xx` decoding that changed
 * something, until none is left that decodes (at most four rounds), so a key escaped
 * twice is read too. Never throws: an escape that is not two hex digits is left as it
 * is. Only for looking at text, never for acting on it.
 */
function escapeRounds(text: string): string[] {
	const rounds = [text];
	let out = text;
	for (let round = 0; round < 4 && out.includes("%"); round++) {
		const next = out.replace(/%([0-9a-f]{2})/gi, (_all, digits: string) =>
			String.fromCharCode(Number.parseInt(digits, 16)),
		);
		if (next === out) {
			break;
		}
		out = next;
		rounds.push(out);
	}
	return rounds;
}

/** `text` with its `%xx` escapes decoded as far as they go: the last of {@link escapeRounds}. */
function decodeEscapes(text: string): string {
	const rounds = escapeRounds(text);
	return rounds[rounds.length - 1] as string;
}

/**
 * True when `text` holds `nsec1` or `ncryptsec1` anywhere, even in the middle of
 * another word, so also a key with a typo in it, a key cut short, and `nostr:nsec1…`.
 * False positive: ordinary text that happens to spell `nsec1`. False negative: a
 * key written as 64 hex digits (see {@link hexKeyRuns}).
 */
export function holdsSecretKey(text: string): boolean {
	return /n(crypt)?sec1/i.test(decodeEscapes(text));
}

/** What kind of secret key a text holds: a plain `nsec1…`, or a password-protected `ncryptsec1…` (NIP-49). */
export type SecretKeyKind = "nsec" | "ncryptsec";

/**
 * The kinds of secret key `text` holds, strictly: `nsec1` or `ncryptsec1` followed
 * by at least 20 characters of bech32 data, standing alone as a word. Each kind
 * once, `nsec` first. A key with a typo in it still counts while its data is bech32
 * characters and long enough; the bare word `nsec1` in a sentence does not.
 *
 * The text is looked at as given and after each round of `%xx` decoding, and a kind
 * counts if any of them shows it: a key followed by `%5F` is a key as written, though
 * decoded it is stuck to an underscore. Never throws: a single run of about 6 million
 * key characters makes the regular expression run out of stack, and the answer is then
 * taken from the prefix alone, so such a run is read as a key.
 */
export function secretKeyKinds(text: string): SecretKeyKind[] {
	const rounds = escapeRounds(text);
	const kinds: SecretKeyKind[] = [];
	try {
		if (rounds.some((round) => NSEC_SHAPE.test(round))) {
			kinds.push("nsec");
		}
		if (rounds.some((round) => NCRYPTSEC_SHAPE.test(round))) {
			kinds.push("ncryptsec");
		}
	} catch {
		kinds.length = 0;
		if (rounds.some((round) => /nsec1/i.test(round))) {
			kinds.push("nsec");
		}
		if (rounds.some((round) => /ncryptsec1/i.test(round))) {
			kinds.push("ncryptsec");
		}
	}
	return kinds;
}

export interface HexRun {
	/** The 64 hex digits as they are written, in whatever case. */
	hex: string;
	/** Where the run starts in the text that was given. */
	index: number;
}

/**
 * Every run of exactly 64 hex digits that stands alone: not part of a longer run and
 * not stuck to a letter, a digit or an underscore. Escapes are NOT decoded, so
 * `index` is a place in `text`.
 *
 * A candidate, not a finding. A secret key as hex, a public key, an event id and a
 * hash are all such a run, and nothing here can say which. Use it with something that
 * can: the slot the text is for, or the words next to it.
 */
export function hexKeyRuns(text: string): HexRun[] {
	const runs: HexRun[] = [];
	for (const match of text.matchAll(/(?<![0-9a-z_])[0-9a-f]{64}(?![0-9a-z_])/gi)) {
		runs.push({ hex: match[0], index: match.index });
	}
	return runs;
}

/**
 * True when `text` holds a run of at least `digits` hex digits, in either case, as given
 * or after the `%xx` decoding {@link holdsSecretKey} reads. The run does not have to
 * stand alone: it may be stuck to other letters, or be part of a longer run (a key
 * pasted twice). False for a `digits` that is not a whole number above zero.
 *
 * A candidate, like {@link hexKeyRuns}: the same run is a public key, an event id or a
 * hash anywhere else. For a string, it never throws and takes time in proportion to the
 * length of the text.
 */
export function holdsHexRun(text: string, digits: number): boolean {
	if (!Number.isInteger(digits) || digits < 1) {
		return false;
	}
	const run = new RegExp(`[0-9a-f]{${digits}}`, "i");
	return escapeRounds(text).some((round) => run.test(round));
}

/**
 * True when `text` holds 64 hex digits in a row, in either case, as given or after the
 * `%xx` decoding {@link holdsSecretKey} reads. The run does not have to stand alone: it
 * may be stuck to other letters, or be part of a longer run (a key pasted twice).
 * Looser than {@link hexKeyRuns} on purpose: it is for a slot where no hex string
 * belongs at all, so a run that is not alone is no more welcome there.
 *
 * With `only`, true just when the text holds those 64 digits (any case): for asking
 * whether a text holds one known key. An `only` that is not 64 hex digits matches
 * nothing.
 *
 * A candidate, like {@link hexKeyRuns}: the same run is a public key, an event id or a
 * hash anywhere else. For a string, it never throws and takes time in proportion to the
 * length of the text.
 */
export function holdsHexKey(text: string, only?: string): boolean {
	if (only === undefined) {
		return holdsHexRun(text, 64);
	}
	if (!/^[0-9a-f]{64}$/i.test(only)) {
		return false;
	}
	const wanted = only.toLowerCase();
	return escapeRounds(text).some((round) => round.toLowerCase().includes(wanted));
}

/** A stretch of text: `start` up to, not including, `end`. */
interface Span {
	start: number;
	end: number;
}

/** An `nsec1` or `ncryptsec1` needs at least this many characters after it to be taken out: fewer is the name of the thing, not a key. */
const SCRUB_MIN_DATA = 5;

/** True for an ASCII letter or digit: what a mistyped key can still be made of. */
function isKeyChar(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isHexDigit(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/**
 * Where a key stands in `text` as it is written: each `nsec1` or `ncryptsec1` (any
 * case) followed by at least {@link SCRUB_MIN_DATA} letters or digits, taken together
 * with every letter and digit after it. Only the short prefix is looked for with a
 * regular expression and the run after it is walked by hand, so the length of a run
 * can never make the match fail.
 */
function keyRuns(text: string): Span[] {
	const runs: Span[] = [];
	const prefix = /n(?:crypt)?sec1/gi;
	for (let found = prefix.exec(text); found !== null; found = prefix.exec(text)) {
		const dataStart = found.index + found[0].length;
		let end = dataStart;
		while (end < text.length && isKeyChar(text.charCodeAt(end))) {
			end++;
		}
		if (end - dataStart >= SCRUB_MIN_DATA) {
			runs.push({ start: found.index, end });
			prefix.lastIndex = end;
		}
	}
	return runs;
}

/**
 * Every place in `text` that holds a key, in the text as given and in each round of
 * `%xx` decoding (see {@link escapeRounds}), as places in the text as given. A key
 * written as escapes is taken out as the escapes it was written in; the escapes of
 * other characters next to it are left where they are.
 */
function keySpans(text: string): Span[] {
	const rounds = escapeRounds(text);
	const runsByRound = rounds.map(keyRuns);
	let last = 0;
	for (let round = 0; round < runsByRound.length; round++) {
		if ((runsByRound[round] as Span[]).length > 0) {
			last = round;
		}
	}
	const spans: Span[] = [...(runsByRound[0] as Span[])];
	// `before[i]` is where character i of the previous round began in `text`; null stands for "at i".
	let before: Int32Array | null = null;
	for (let round = 1; round <= last; round++) {
		const from = rounds[round - 1] as string;
		const to = rounds[round] as string;
		const after = new Int32Array(to.length + 1);
		let out = 0;
		for (let i = 0; i < from.length; ) {
			after[out++] = before ? (before[i] as number) : i;
			const escaped =
				from.charCodeAt(i) === 37 &&
				i + 2 < from.length &&
				isHexDigit(from.charCodeAt(i + 1)) &&
				isHexDigit(from.charCodeAt(i + 2));
			i += escaped ? 3 : 1;
		}
		if (out !== to.length) {
			throw new Error("escape rounds out of step");
		}
		after[to.length] = text.length;
		before = after;
		for (const run of runsByRound[round] as Span[]) {
			spans.push({ start: after[run.start] as number, end: after[run.end] as number });
		}
	}
	return spans;
}

/**
 * `text` with every secret key in it replaced by `marker`, and everything else exactly
 * as it was. A key is `nsec1` or `ncryptsec1` (any case, behind `nostr:` or not, written
 * as `%xx` escapes up to the four rounds {@link holdsSecretKey} reads) and at least five
 * letters or digits after it, and everything after those that is a letter or a digit:
 * so a key with a typo in it or one cut short goes too, and a bare `nsec1…` in a sentence
 * stays. A run of 64 hex digits is NOT touched: it is as likely a public key or an event
 * id as a secret key (see {@link hexKeyRuns}), and only a caller that knows a key's exact
 * value can say so.
 *
 * Never throws and takes time in proportion to the length of the text. If anything goes
 * wrong inside, the whole text is replaced by `marker`: a scrub that fails shows nothing
 * rather than showing a key. A key written in two pieces that are given in two calls is
 * two texts, and neither piece is a key.
 */
export function scrubSecretKeys(text: string, marker: string): string {
	try {
		const spans = keySpans(text).sort((a, b) => a.start - b.start || b.end - a.end);
		if (spans.length === 0) {
			return text;
		}
		let out = "";
		let copied = 0;
		let open = spans[0] as Span;
		const flush = (span: Span): void => {
			out += text.slice(copied, span.start) + marker;
			copied = span.end;
		};
		for (const span of spans.slice(1)) {
			if (span.start <= open.end) {
				open = { start: open.start, end: Math.max(open.end, span.end) };
			} else {
				flush(open);
				open = span;
			}
		}
		flush(open);
		return out + text.slice(copied);
	} catch {
		return marker;
	}
}

/** What was typed where a secret key is expected, sorted by its shape. */
export type SecretKeyInput =
	/** `bech32` is the `nsec1…` text without any `nostr:` prefix. It may be mistyped: decoding it is the caller's job. */
	| { kind: "nsec"; bech32: string }
	/** `hex` is the 64 digits, in lower case. */
	| { kind: "hex"; hex: string };

/**
 * Sorts the whole of what was typed: `nsec1…` (any case, with or without `nostr:`) or
 * 64 hex digits, with white space around it allowed. Anything else, a public key and
 * an `ncryptsec1…` included, is `null`. Only the shape is checked.
 */
export function readSecretKeyInput(input: string): SecretKeyInput | null {
	const trimmed = input.trim();
	const unprefixed = trimmed.replace(/^nostr:/i, "");
	if (/^nsec1/i.test(unprefixed)) {
		return { kind: "nsec", bech32: unprefixed };
	}
	if (/^[0-9a-f]{64}$/i.test(trimmed)) {
		return { kind: "hex", hex: trimmed.toLowerCase() };
	}
	return null;
}
