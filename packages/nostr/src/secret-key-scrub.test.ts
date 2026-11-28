import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { describe, expect, it } from "vitest";
import { bytesToHex, generateKeypair } from "./keys";
import { holdsSecretKey, scrubSecretKeys, secretKeyKinds } from "./secret-key-text";

// Every key here is made when the test runs, from a throwaway key: none is real
// and none is written to a file.
const pair = generateKeypair();
const HEX = bytesToHex(pair.secretKey);
const NSEC = nip19.nsecEncode(pair.secretKey);
const NCRYPTSEC = encrypt(pair.secretKey, "throwaway-password", 4);
const NPUB = nip19.npubEncode(pair.publicKey);
const PUBKEY = pair.publicKey;

const MARK = "[redacted]";

/** Every character as `%xx`, the way a URL-encoder that escapes everything writes it. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** `escapeAll` applied `times` times: the escapes are themselves written as escapes, that many layers deep. */
function escapeTimes(text: string, times: number): string {
	let out = text;
	for (let layer = 0; layer < times; layer++) {
		out = escapeAll(out);
	}
	return out;
}

const scrub = (text: string): string => scrubSecretKeys(text, MARK);

describe("scrubSecretKeys takes a secret key out of text and leaves the rest as it was", () => {
	it.each([
		["a key alone", NSEC, MARK],
		["a key in capitals", NSEC.toUpperCase(), MARK],
		["a key in a sentence", `my key is ${NSEC} and please keep it safe`, `my key is ${MARK} and please keep it safe`],
		["a key behind nostr:", `nostr:${NSEC}`, `nostr:${MARK}`],
		["a key behind NOSTR: in capitals", `NOSTR:${NSEC.toUpperCase()}`, `NOSTR:${MARK}`],
		["a password-protected key", NCRYPTSEC, MARK],
		["a password-protected key in capitals", NCRYPTSEC.toUpperCase(), MARK],
		["a password-protected key behind nostr:", `nostr:${NCRYPTSEC}`, `nostr:${MARK}`],
		["a key in a JSON string", `{"profile":"${NSEC}","n":1}`, `{"profile":"${MARK}","n":1}`],
		["a key as a JSON name", `{"${NSEC}":1}`, `{"${MARK}":1}`],
		["a key in a URL query", `https://example.com/hook?k=${NSEC}&x=1`, `https://example.com/hook?k=${MARK}&x=1`],
		["a key in a path", `/home/me/.agx/profiles/${NSEC}/identity.json`, `/home/me/.agx/profiles/${MARK}/identity.json`],
		["a key in quotes", `unknown command '${NSEC}'`, `unknown command '${MARK}'`],
		["a key between colour codes", `\u001b[1m${NSEC}\u001b[22m`, `\u001b[1m${MARK}\u001b[22m`],
		["a key stuck to a letter on its left", `x${NSEC}`, `x${MARK}`],
		["a key stuck to an underscore on its left", `_${NSEC}`, `_${MARK}`],
		["a key stuck to a backslash on its left", `C:\\profiles\\${NSEC}`, `C:\\profiles\\${MARK}`],
		["a key followed by an underscore", `${NSEC}_backup`, `${MARK}_backup`],
		["a key followed by an ellipsis", `${NSEC}…`, `${MARK}…`],
		["a key at the end of a line", `key:\n${NSEC}\n`, `key:\n${MARK}\n`],
		["two keys", `${NSEC} and ${NCRYPTSEC}`, `${MARK} and ${MARK}`],
		["the same key twice", `${NSEC}${NSEC}`, MARK],
		["the same key twice, with a space", `${NSEC} ${NSEC}`, `${MARK} ${MARK}`],
		["a key with a typo in it (an i, which bech32 does not use)", `${NSEC.slice(0, 20)}i${NSEC.slice(21)}`, MARK],
		["a key with a typo in it (a b)", `${NSEC.slice(0, 20)}b${NSEC.slice(21)}`, MARK],
		["a key with a typo in it (a 1)", `${NSEC.slice(0, 20)}1${NSEC.slice(21)}`, MARK],
		["a key with a typo in it (an o)", `${NSEC.slice(0, 20)}o${NSEC.slice(21)}`, MARK],
		["a key cut short to 10 characters", `${NSEC.slice(0, 10)}`, MARK],
		["a key cut short to 20 characters", `see ${NSEC.slice(0, 20)}…`, `see ${MARK}…`],
		["a password-protected key cut short", `${NCRYPTSEC.slice(0, 15)}`, MARK],
		["a key in capitals mixed with lower case", `Nsec1${NSEC.slice(5, 30)}${NSEC.slice(30).toUpperCase()}`, MARK],
	])("%s", (_name, text, expected) => {
		expect(scrub(text)).toBe(expected);
	});

	it("takes the marker it is given", () => {
		expect(scrubSecretKeys(`a ${NSEC} b`, "<key removed>")).toBe("a <key removed> b");
		expect(scrubSecretKeys(`a ${NSEC} b`, "")).toBe("a  b");
	});

	it("takes out every key of a long text, and only the keys", () => {
		const keys = Array.from({ length: 200 }, () => nip19.nsecEncode(generateKeypair().secretKey));
		const text = keys.map((key, i) => `line ${i}: ${key} done`).join("\n");
		const expected = keys.map((_key, i) => `line ${i}: ${MARK} done`).join("\n");
		expect(scrub(text)).toBe(expected);
	});
});

describe("a key written as %xx escapes is found as the matcher reads it, and only its escapes are replaced", () => {
	it.each([
		["every character escaped", escapeAll(NSEC), MARK],
		["every character escaped, in a sentence", `a ${escapeAll(NSEC)} b`, `a ${MARK} b`],
		["every character escaped, in lower case digits", escapeAll(NSEC).toLowerCase(), MARK],
		["a password-protected key, every character escaped", escapeAll(NCRYPTSEC), MARK],
		["escaped behind nostr:", `nostr:${escapeAll(NSEC)}`, `nostr:${MARK}`],
		["the prefix escaped, the data as written", `${escapeAll("nsec1")}${NSEC.slice(5)}`, MARK],
		["the prefix as written, the data escaped", `nsec1${escapeAll(NSEC.slice(5))}`, MARK],
		["only the first letter escaped", `%6E${NSEC.slice(1)}`, MARK],
		["only the last character escaped", `${NSEC.slice(0, -1)}%${NSEC.charCodeAt(NSEC.length - 1).toString(16)}`, MARK],
		["every character escaped, then more key characters as written", `${escapeAll(NSEC)}abcdef`, MARK],
		["every character escaped, then an escaped underscore", `${escapeAll(NSEC)}%5Ftail`, `${MARK}%5Ftail`],
		["every character escaped, then a space", `${escapeAll(NSEC)} tail`, `${MARK} tail`],
		["every character escaped, between quotes", `'--${escapeAll(NSEC)}'`, `'--${MARK}'`],
		["escaped twice", escapeTimes(NSEC, 2), MARK],
		["escaped three times", escapeTimes(NSEC, 3), MARK],
		["escaped four times", escapeTimes(NSEC, 4), MARK],
		["a password-protected key, escaped four times", escapeTimes(NCRYPTSEC, 4), MARK],
		["the same key as written and escaped", `${NSEC} ${escapeAll(NSEC)}`, `${MARK} ${MARK}`],
		["two different keys, one of them escaped", `${NCRYPTSEC} / ${escapeAll(NSEC)}`, `${MARK} / ${MARK}`],
		["escapes of other characters around it are left alone", `%41${escapeAll(NSEC)}%2E`, `%41${MARK}%2E`],
		["an escaped letter after it is part of the run, as a letter written there would be", `${escapeAll(NSEC)}%42`, MARK],
	])("%s", (_name, text, expected) => {
		expect(scrub(text)).toBe(expected);
	});

	it("reads four rounds of decoding and no more, as holdsSecretKey does", () => {
		for (const times of [1, 2, 3, 4, 5, 6]) {
			const text = `x ${escapeTimes(NSEC, times)} y`;
			expect(holdsSecretKey(text)).toBe(times <= 4);
			expect(scrub(text) !== text).toBe(times <= 4);
		}
	});

	it("leaves an escape that does not decode as it is", () => {
		expect(scrub("100%")).toBe("100%");
		expect(scrub("%4")).toBe("%4");
		expect(scrub("%zz%6")).toBe("%zz%6");
		expect(scrub(`%zz${NSEC}%6`)).toBe(`%zz${MARK}%6`);
	});
});

describe("text with no secret key comes back exactly as it was", () => {
	it.each([
		["nothing", ""],
		["a sentence", "Imported identity into profile default."],
		["a public key as hex", PUBKEY],
		["a secret key as hex (indistinguishable from a public key)", HEX],
		["an event id and a signature", `${"ab".repeat(32)} ${"cd".repeat(64)}`],
		["an npub", NPUB],
		["an npub in a sentence", `from ${NPUB} — not on the allowlist`],
		["other bech32", "note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq nevent1qqqqqqqqqq"],
		["the name nsec1 with an ellipsis", "import an nsec1… or 64-char hex secret key"],
		["the name nsec1 in a sentence", "a secret key starts with nsec1 and is 63 characters long"],
		["the name ncryptsec1 with an ellipsis", "a password-protected key (ncryptsec1…)"],
		["nsec1 and four characters", "nsec1abcd"],
		["nsec1 and four characters, then a space", "nsec1abcd more"],
		["ncryptsec1 and four characters", "ncryptsec1abcd"],
		["a word that ends in nsec", "the licensec is nsec"],
		["escapes that hold no key", "a%20b%2Fc%3Fd=%E2%9C%93"],
		["a percent sign", "100% done, 50%d, %%, %"],
		["unicode and control characters", "caf\u00e9 \u2014 \u2713 \u0007 \u001b[31mred\u001b[39m \u2028 \ud83d\ude00"],
		["a JSON document", JSON.stringify({ npub: NPUB, pubkey: PUBKEY, n: [1, 2, { ok: true }] }, null, 2)],
	])("%s", (_name, text) => {
		expect(scrub(text)).toBe(text);
	});

	it("does not change a long text that holds no key, and answers in about as much time as it takes to read it", () => {
		const text = `${"The quick brown fox jumps over the lazy dog. ".repeat(100_000)}${PUBKEY}\n`;
		expect(text.length).toBeGreaterThan(4_000_000);
		expect(scrub(text)).toBe(text);
		const escapes = "%41%2F".repeat(1_000_000);
		expect(scrub(escapes)).toBe(escapes);
	});
});

describe("what it removes, the matcher's strict check no longer finds", () => {
	it.each([
		["a key", NSEC],
		["a key in capitals", NSEC.toUpperCase()],
		["a key behind nostr:", `nostr:${NSEC}`],
		["a password-protected key", NCRYPTSEC],
		["a key in a sentence", `see ${NSEC}, it is mine`],
		["an escaped key", escapeAll(NSEC)],
		["a key escaped twice", escapeTimes(NSEC, 2)],
		["a key followed by an escaped underscore", `${NSEC}%5F`],
		["a key followed by an escaped letter", `${NSEC}%62`],
		["a key between escaped quotes", `%22${NSEC}%22`],
		["a key in the middle of other escapes", `a%20${NSEC}%20b`],
	])("%s", (_name, text) => {
		expect(secretKeyKinds(text).length).toBeGreaterThan(0);
		const after = scrub(text);
		expect(secretKeyKinds(after)).toEqual([]);
		expect(after).not.toContain(NSEC.slice(5, 25));
		expect(after).not.toContain(NSEC.toUpperCase().slice(5, 25));
	});

	it("is idempotent: scrubbing the result changes nothing", () => {
		for (const text of [NSEC, `a ${NSEC} b ${NCRYPTSEC}`, escapeAll(NSEC), escapeTimes(NSEC, 3), `nostr:${NSEC.toUpperCase()}`]) {
			const once = scrub(text);
			expect(scrub(once)).toBe(once);
			expect(holdsSecretKey(once.replaceAll(MARK, ""))).toBe(false);
		}
	});
});

describe("it never throws, and fails closed", () => {
	const RUN = "q".repeat(6_000_000);

	it.each([
		["a very long run after nsec1", `nsec1${RUN}`],
		["a very long run after NSEC1 in capitals", `NSEC1${RUN.toUpperCase()}`],
		["a very long run after ncryptsec1", `ncryptsec1${RUN}`],
		["a very long run after an escaped nsec1", `${escapeAll("nsec1")}${RUN}`],
		["a very long run with a key in front of it", `${NSEC} ${RUN}`],
	])("%s", (_name, text) => {
		const out = scrub(text);
		expect(typeof out).toBe("string");
		expect(out.length).toBeLessThan(text.length);
		expect(out).not.toMatch(/n(crypt)?sec1[0-9a-z]{5}/i);
	});

	it("answers the marker, not an error, for input that is not text at all", () => {
		for (const input of [undefined, null, 42, {}]) {
			expect(scrubSecretKeys(input as unknown as string, MARK)).toBe(MARK);
		}
	});

	it("answers for text with lone surrogates, a NUL and a very long line", () => {
		expect(scrub(`\ud800 ${NSEC} \udc00 \u0000`)).toBe(`\ud800 ${MARK} \udc00 \u0000`);
		expect(scrub(`${"a".repeat(1_000_000)}${NSEC}`)).toBe(`${"a".repeat(1_000_000)}${MARK}`);
	});
});
