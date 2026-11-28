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
 * taken from the words `nsec1` and `ncryptsec1` alone: a text that holds either one
 * anywhere is read as holding a key of that kind, so such a run is read as a key.
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
