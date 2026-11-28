import { bytesToHex, hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, loadIdentityFile, parseSecretInput, saveIdentity } from "./identity.js";
import { holdsSecretKey, redactSecrets } from "./secrets.js";
import { agx, sandbox } from "../test/helpers.js";

// One rule says what "this text holds a secret key" means (`holdsSecretKey` in
// `@nostr-agx/nostr`), and the profile's own key is known to `redactSecrets` in
// every form it is written in. These tests drive the CLI's own uses of both.
//
// Every key here is made when the test runs, from a throwaway key.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
/** The whole of what the parser prints instead of an error that quotes a secret key. */
const REPLACED =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** Every character as `%xx`, the way a URL-encoder that escapes everything writes it. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** The first 10-character stretch of the key's data part (not the constant prefix) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string, prefix: number): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = prefix; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
});

afterEach(() => {
	box.restore();
});

describe("a secret key written as %xx escapes on a command line the parser rejects", () => {
	const escaped = escapeAll(NSEC);
	it.each([
		["an unknown command", [escaped]],
		["an unknown command, in lower-case digits", [escaped.toLowerCase()]],
		["an unknown command behind nostr:", [`nostr:${escaped}`]],
		["an unknown command, escaped twice", [escapeAll(escaped)]],
		["an unknown command, only the prefix escaped", [`${escapeAll("nsec1")}${NSEC.slice(5)}`]],
		["an unknown subcommand", ["identity", escaped]],
		["an unknown option", [`--${escaped}`]],
		["an unknown option of a subcommand", ["send", `--${escaped}`, "someone", "hello"]],
		["a surplus argument", ["config", "list", escaped]],
		["an unquoted message after a peer (too many arguments)", ["send", escaped, "hello", "world"]],
		["--json mode", ["--json", "send", escaped, "hello", "world"]],
		["an encrypted key (ncryptsec1…)", [escapeAll(NCRYPTSEC)]],
	])("%s: says why and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(REPLACED);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC, 5)).toBeNull();
			expect(leakedPart(out, NCRYPTSEC, 10)).toBeNull();
			expect(out.toLowerCase()).not.toContain("%6e%73%65%63");
		}
	});
});

describe("holdsSecretKey in the CLI", () => {
	it("sees a key written as %xx escapes, in any case, as the one shared rule does", () => {
		expect(holdsSecretKey(escapeAll(NSEC))).toBe(true);
		expect(holdsSecretKey(escapeAll(NSEC).toLowerCase())).toBe(true);
		expect(holdsSecretKey(`nostr:${NSEC.toUpperCase()}`)).toBe(true);
		expect(holdsSecretKey(NCRYPTSEC)).toBe(true);
	});

	it("still sees what it saw: a key, in capitals, behind nostr:, with a typo", () => {
		for (const text of [NSEC, NSEC.toUpperCase(), `nostr:${NSEC}`, `${NSEC}q`, NSEC.slice(0, 12), `--${NSEC}`]) {
			expect(holdsSecretKey(text)).toBe(true);
		}
	});

	it("is still false for text that is not a key", () => {
		for (const text of ["", "hello", "npub1abc", mine.publicKey, "a%20b", "100%"]) {
			expect(holdsSecretKey(text)).toBe(false);
		}
	});
});

describe("every other parser error is unchanged", () => {
	it("still names an ordinary 'too many arguments' and suggests the nearest command", async () => {
		const many = await agx("send", "npub1abc", "hello", "world");
		expect(many.code).toBe(1);
		expect(many.stderr).toContain("too many arguments for 'send'");
		expect(many.stderr).toContain("npub1abc, hello, world");
		const typo = await agx("sned");
		expect(typo.stderr).toContain("unknown command 'sned'");
		expect(typo.stderr).toContain("Did you mean send?");
	});

	it("still prints an unknown command that holds ordinary escapes", async () => {
		const run = await agx("a%20b%2Fc");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'a%20b%2Fc'");
	});
});

describe("the profile's own secret key", () => {
	const hex = mine.secretKeyHex;
	const nsec = nip19.nsecEncode(hexToBytes(hex));
	/** The same 32 bytes read as a public key: what `agx card <hex>` prints back for a pasted key. */
	const npubOfKey = nip19.npubEncode(hex);
	const forms = [hex, hex.toUpperCase(), nsec, nsec.toUpperCase(), npubOfKey, npubOfKey.toUpperCase()];

	it("is removed from an error message, in every form it is written in, once the profile is read", () => {
		loadIdentityFile("default");
		for (const form of forms) {
			expect(redactSecrets(`failed for ${form} just now`)).toBe("failed for [redacted] just now");
		}
		expect(redactSecrets(`nostr:${nsec}`)).toBe("nostr:[redacted]");
	});

	it("is removed wherever it stands in the text, more than once", () => {
		loadIdentityFile("default");
		expect(redactSecrets(`${hex} ${nsec} ${hex}`)).toBe("[redacted] [redacted] [redacted]");
	});

	it("leaves the profile's public key and everything else alone", () => {
		loadIdentityFile("default");
		for (const text of [mine.publicKey, mine.npub, "a message", "", `${mine.publicKey.slice(0, 32)}${hex.slice(32)}`, hex.slice(1)]) {
			expect(redactSecrets(text)).toBe(text);
		}
	});

	it("is not known before the profile is read", () => {
		// A key that no test in this file has read.
		const stranger = createIdentity();
		expect(redactSecrets(`value ${stranger.secretKeyHex}`)).toBe(`value ${stranger.secretKeyHex}`);
	});
});

describe("parseSecretInput reads a typed-in key as it did before the rule was shared", () => {
	/** `parseSecretInput` as it was written before it used the shared rule: the answer to compare with. */
	function before(input: string): Uint8Array {
		const trimmed = input.trim();
		const unprefixed = trimmed.replace(/^nostr:/i, "");
		if (/^nsec1/i.test(unprefixed)) {
			try {
				const decoded = nip19.decode(unprefixed);
				if (decoded.type !== "nsec") {
					throw new Error(`expected an nsec, got ${decoded.type}`);
				}
				return decoded.data as Uint8Array;
			} catch {
				throw new Error("nsec does not decode");
			}
		}
		if (/^[0-9a-f]{64}$/i.test(trimmed)) {
			return hexToBytes(trimmed.toLowerCase());
		}
		throw new Error("not a key");
	}

	/** What `parseSecretInput` gives for `input`, as text that can be compared: the key's bytes in hex, or a short name for the refusal. */
	function outcome(read: (input: string) => Uint8Array, input: string): string {
		try {
			return bytesToHex(read(input));
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/Could not decode that nsec|nsec does not decode/.test(message)) {
				return "nsec does not decode";
			}
			if (/Expected an `nsec1…` key|not a key/.test(message)) {
				return "not a key";
			}
			return `other: ${message.slice(0, 40)}`;
		}
	}

	const hex = mine.secretKeyHex;
	const nsec = nip19.nsecEncode(hexToBytes(hex));
	const inputs: [string, string][] = [
		["an nsec1…", nsec],
		["an nsec1… in capitals", nsec.toUpperCase()],
		["an nsec1… behind nostr:", `nostr:${nsec}`],
		["an nsec1… in capitals behind NOSTR:", `NOSTR:${nsec.toUpperCase()}`],
		["an nsec1… with a new line after it", `  ${nsec}\n`],
		["an nsec1… behind nostr: with white space around it", `\t nostr:${nsec} `],
		["64 hex digits", hex],
		["64 hex digits in capitals", hex.toUpperCase()],
		["64 hex digits with white space around them", ` ${hex} `],
		["64 hex digits behind nostr:", `nostr:${hex}`],
		["65 hex digits", `${hex}a`],
		["63 hex digits", hex.slice(1)],
		["64 zeros", "0".repeat(64)],
		["64 f", "f".repeat(64)],
		["an nsec1… with a character too many", `${nsec}q`],
		["an nsec1… cut short", nsec.slice(0, 40)],
		["an nsec1… with a character changed", `${nsec.slice(0, 30)}${nsec[30] === "q" ? "p" : "q"}${nsec.slice(31)}`],
		["an nsec1… with a space in it", `${nsec.slice(0, 30)} ${nsec.slice(30)}`],
		["only nsec1", "nsec1"],
		["nsec1 and zeros", `nsec1${"q".repeat(58)}`],
		["an nsec1… of an odd key", nip19.nsecEncode(new Uint8Array(32).fill(1))],
		["an encrypted key", NCRYPTSEC],
		["an npub1…", mine.npub],
		["a public key as hex", mine.publicKey],
		["an nsec1… escaped", escapeAll(nsec)],
		["an nsec1… in a sentence", `my key is ${nsec}`],
		["nothing", ""],
		["white space", "  "],
		["a word", "nope"],
		["NSEC1", "NSEC1"],
		["nostr:", "nostr:"],
		["nostr:nsec1", "nostr:nsec1"],
	];

	it.each(inputs)("%s gets the answer it got before", (_name, input) => {
		expect(outcome(parseSecretInput, input)).toBe(outcome(before, input));
	});

	it("the table holds every kind of answer: a key, a key that does not decode, and a refusal", () => {
		const answers = new Set(inputs.map(([, input]) => outcome(before, input).replace(/^[0-9a-f]{64}$/, "a key")));
		expect([...answers].sort()).toEqual(["a key", "not a key", "nsec does not decode"]);
	});

	it("takes the key in each of the forms it took before", () => {
		for (const input of [nsec, nsec.toUpperCase(), `nostr:${nsec}`, hex, hex.toUpperCase()]) {
			expect(bytesToHex(parseSecretInput(input))).toBe(hex);
		}
	});
});
