import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "../lib/identity.js";
import { identityPath } from "../lib/paths.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, type CliRun, sandbox } from "../test/helpers.js";

// `agx identity import` takes a secret key. A key that does not decode (one
// character wrong, one missing, one too many) must be refused WITHOUT being
// printed: nostr-tools' decoder quotes its whole input in its error ("Invalid
// checksum in nsec1…"), and stderr lives on in terminal scrollback, logs and an
// agent's context. A key that is valid but written in capitals, or behind the
// `nostr:` scheme, is still a key: it imports. A key that decodes but cannot be
// a secret key (all zeros, not below the curve order, not 32 bytes) is refused
// with a fixed message too, not with the curve library's own error.

let box: ReturnType<typeof sandbox>;
let restoreStdin: (() => void) | undefined;
const mine = createIdentity();
const incoming = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(incoming.secretKeyHex));
/** The whole of what is printed for a key that does not decode: pinned exactly, so it cannot be edited into one that shows part of the key. */
const COULD_NOT_DECODE =
	"Could not decode that nsec: it is not a valid secret key (a character is wrong or missing). It is not shown here.";

/** The whole of what is printed for a key that decodes but cannot be a secret key: pinned exactly as well. */
const NOT_USABLE =
	"Could not use that secret key: it decodes, but it is not a valid secret key (for example all zeros, out of range, or not 32 bytes long). It is not shown here.";

/** What reaches stderr for an error: a blank line, a cross, the message. Colour codes are dropped (kleur adds them when FORCE_COLOR is set). */
function plain(stderr: string): string {
	return stderr.replace(/\u001b\[[0-9;]*m/g, "");
}

/** `value` with the character at `index` swapped for another valid bech32 character. */
function flip(value: string, index: number): string {
	return `${value.slice(0, index)}${value[index] === "q" ? "p" : "q"}${value.slice(index + 1)}`;
}

/** `value` with one letter inside it in the other case: bech32 forbids mixed case. */
function mixCase(value: string): string {
	const at = [...value].findIndex((char, index) => index > 10 && /[a-z]/.test(char));
	return `${value.slice(0, at)}${value[at].toUpperCase()}${value.slice(at + 1)}`;
}

/** The first 10-character stretch of the key found in `shown`, in any case, starting `from` characters in (default: past the constant `nsec1`); null if none. */
function leakedPart(shown: string, key: string, from = 5): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = from; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

function stored(): { secretKeyHex: string; npub: string } {
	return loadIdentityFile("default");
}

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
});

afterEach(() => {
	restoreStdin?.();
	restoreStdin = undefined;
	box.restore();
});

describe("a secret key that does not decode, given to identity import", () => {
	const BAD: Array<[string, string]> = [
		["a typo in the middle", flip(NSEC, 30)],
		["a typo in the first character after nsec1", flip(NSEC, 5)],
		["a typo in the last character", flip(NSEC, NSEC.length - 1)],
		["one character missing", NSEC.slice(0, -1)],
		["one character too many", `${NSEC}q`],
		["cut short", NSEC.slice(0, 25)],
		["a typo, in capitals", flip(NSEC, 30).toUpperCase()],
		["a typo, behind nostr:", `nostr:${flip(NSEC, 30)}`],
		["capitals and lower case mixed", mixCase(NSEC)],
		["capitals and lower case mixed, behind nostr:", `nostr:${mixCase(NSEC)}`],
		["a capital NSEC1 prefix and a lower-case rest", `NSEC1${NSEC.slice(5)}`],
	];

	it.each(BAD)("%s: says it could not be decoded and prints none of it", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		for (const out of [run.stdout, run.stderr]) {
			expect(out.includes(NSEC)).toBe(false);
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(`\n✗ ${COULD_NOT_DECODE}\n`);
	});

	it.each(BAD)("%s: the same in --json mode", async (_name, value) => {
		const run = await agx("--json", "identity", "import", "--force", value);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(`\n✗ ${COULD_NOT_DECODE}\n`);
	});

	it.each(BAD)("%s: the same when piped in with --stdin", async (_name, value) => {
		restoreStdin = setStdinForTests(`${value}\n`);
		const run = await agx("identity", "import", "--stdin", "--force");
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(`\n✗ ${COULD_NOT_DECODE}\n`);
	});

	it("leaves the identity that was there as it was", async () => {
		await agx("identity", "import", "--force", flip(NSEC, 30));
		await agx("identity", "import", "--force", mixCase(NSEC));
		expect(stored().secretKeyHex === mine.secretKeyHex).toBe(true);
	});
});

describe("a hex secret key that is not 64 characters, given to identity import", () => {
	it.each([
		["one character missing", incoming.secretKeyHex.slice(1)],
		["one character too many", `${incoming.secretKeyHex}a`],
		["a character that is not hex", `${incoming.secretKeyHex.slice(0, 63)}z`],
	])("%s: still says what is expected and prints none of it", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("Expected an `nsec1…` key or a 64-character hex secret key.");
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, incoming.secretKeyHex, 0)).toBeNull();
		}
	});
});

describe("a secret key that decodes but cannot be used, given to identity import", () => {
	/** secp256k1's group order: a public constant. A secret key must be below it, and not zero. */
	const CURVE_ORDER = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
	const THROWAWAY = hexToBytes(incoming.secretKeyHex);
	const ZERO_NSEC = nip19.nsecEncode(new Uint8Array(32));
	const NSEC_31_BYTES = nip19.nsecEncode(THROWAWAY.slice(0, 31));
	const UNUSABLE: Array<[string, string]> = [
		["64 zeros in hex", "0".repeat(64)],
		["the curve order in hex", CURVE_ORDER],
		["the curve order in hex, in capitals", CURVE_ORDER.toUpperCase()],
		["64 f in hex (above the curve order)", "f".repeat(64)],
		["an nsec of 16 bytes", nip19.nsecEncode(THROWAWAY.slice(0, 16))],
		["an nsec of 31 bytes", NSEC_31_BYTES],
		["an nsec of 33 bytes", nip19.nsecEncode(new Uint8Array([...THROWAWAY, 7]))],
		["an nsec above the curve order", nip19.nsecEncode(new Uint8Array(32).fill(255))],
		["an all-zero nsec", ZERO_NSEC],
		["an all-zero nsec, in capitals", ZERO_NSEC.toUpperCase()],
		["an all-zero nsec, behind nostr:", `nostr:${ZERO_NSEC}`],
		["an nsec of 31 bytes, behind nostr:", `nostr:${NSEC_31_BYTES}`],
	];

	/** The run was refused with the fixed message only: exit 2, nothing on stdout, no part of the key anywhere. */
	function expectRefused(run: CliRun, value: string): void {
		const key = value.replace(/^nostr:/i, "");
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, key, /^nsec1/i.test(key) ? 5 : 0)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(`\n✗ ${NOT_USABLE}\n`);
	}

	it.each(UNUSABLE)("%s: says it is not usable and prints none of it", async (_name, value) => {
		expectRefused(await agx("identity", "import", "--force", value), value);
	});

	it.each(UNUSABLE)("%s: the same in --json mode", async (_name, value) => {
		expectRefused(await agx("--json", "identity", "import", "--force", value), value);
	});

	it.each(UNUSABLE)("%s: the same when piped in with --stdin", async (_name, value) => {
		restoreStdin = setStdinForTests(`${value}\n`);
		expectRefused(await agx("identity", "import", "--stdin", "--force"), value);
	});

	it.each(UNUSABLE)("%s: the same into a new profile, without --force", async (_name, value) => {
		expectRefused(await agx("identity", "import", "--profile", "fresh", value), value);
		expect(existsSync(identityPath("fresh"))).toBe(false);
	});

	it.each(UNUSABLE)("%s: the same with AGX_DEBUG=1, and no stack trace follows", async (_name, value) => {
		process.env.AGX_DEBUG = "1";
		expectRefused(await agx("identity", "import", "--force", value), value);
	});

	it("leaves the identity that was there as it was", async () => {
		for (const [, value] of UNUSABLE) {
			await agx("identity", "import", "--force", value);
		}
		expect(stored().secretKeyHex === mine.secretKeyHex).toBe(true);
	});
});

describe("the other failures of identity import keep their own messages", () => {
	it("an existing identity is still refused first, whatever the key is", async () => {
		for (const value of ["0".repeat(64), flip(NSEC, 30), incoming.secretKeyHex]) {
			const run = await agx("identity", "import", value);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain('Profile "default" already has an identity.');
			expect(run.stderr).not.toContain("Could not use that secret key");
		}
		expect(stored().secretKeyHex === mine.secretKeyHex).toBe(true);
	});

	it("a profile directory that cannot be created is still reported as what it is", async () => {
		mkdirSync(join(box.home, "profiles"), { recursive: true });
		writeFileSync(join(box.home, "profiles", "blocked"), "a file where the profile directory should be");
		const run = await agx("identity", "import", "--profile", "blocked", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr).toMatch(/EEXIST|ENOTDIR/);
		expect(run.stderr).not.toContain("Could not use that secret key");
		expect(leakedPart(run.stderr, incoming.secretKeyHex, 0)).toBeNull();
	});

	// A directory the process cannot write to; root ignores permissions, and Windows has no chmod.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a profile directory that cannot be written is still reported as what it is",
		async () => {
			const profiles = join(box.home, "profiles");
			mkdirSync(profiles, { recursive: true });
			chmodSync(profiles, 0o500);
			try {
				const run = await agx("identity", "import", "--profile", "locked", incoming.secretKeyHex);
				expect(run.code).toBe(EXIT.generic);
				expect(run.stderr).toMatch(/EACCES/);
				expect(run.stderr).not.toContain("Could not use that secret key");
				expect(leakedPart(run.stderr, incoming.secretKeyHex, 0)).toBeNull();
			} finally {
				chmodSync(profiles, 0o700);
			}
		},
	);
});

describe("a valid secret key given to identity import", () => {
	it.each([
		["nsec1… in lower case", NSEC],
		["NSEC1… in capitals", NSEC.toUpperCase()],
		["nsec1… behind nostr:", `nostr:${NSEC}`],
		["NSEC1… in capitals, behind nostr:", `nostr:${NSEC.toUpperCase()}`],
		["nsec1… behind NOSTR:", `NOSTR:${NSEC}`],
		["nsec1… with spaces and a newline around it", `  ${NSEC}\n`],
		["64 hex characters", incoming.secretKeyHex],
		["64 hex characters in capitals", incoming.secretKeyHex.toUpperCase()],
	])("%s: is imported", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		expect(run.stderr).toBe("");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain(incoming.npub);
		expect(stored().secretKeyHex === incoming.secretKeyHex).toBe(true);
		expect(stored().npub).toBe(incoming.npub);
	});

	it("is imported from stdin in capitals too", async () => {
		restoreStdin = setStdinForTests(`${NSEC.toUpperCase()}\n`);
		const run = await agx("identity", "import", "--stdin", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === incoming.secretKeyHex).toBe(true);
	});
});

describe("an ordinary mistake in identity import still gets a helpful message", () => {
	it("says what is expected when the value is not a key at all", async () => {
		const run = await agx("identity", "import", "--force", "not-a-key");
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("Expected an `nsec1…` key or a 64-character hex secret key.");
	});

	it("says how to give a key when there is none, leading with the ways that keep it off the command line", async () => {
		restoreStdin = setStdinForTests(null);
		const run = await agx("identity", "import", "--force");
		expect(run.code).toBe(EXIT.usage);
		expect(plain(run.stderr)).toBe(
			'\n✗ No secret key provided.\n\n  Pipe it in, so it never appears in argv:\n    printf %s "$KEY" | agx identity import --stdin\n  Or read it from an environment variable:\n    agx identity import --from-env NAME\n\n',
		);
		expect(run.stderr).not.toContain("nsec1");
	});

	it("suggests --stdin, not a key on the command line, when the profile already has an identity", async () => {
		const run = await agx("identity", "import", flip(NSEC, 30));
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toBe(
			'\n✗ Profile "default" already has an identity.\n\n  Import into a fresh profile:\n    agx identity import --stdin --profile imported\n  Or overwrite:  agx identity import --stdin --force\n\n',
		);
	});

	it("says the profile already has an identity, and does not read the key", async () => {
		const run = await agx("identity", "import", flip(NSEC, 30));
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toContain('Profile "default" already has an identity.');
		expect(leakedPart(run.stderr, NSEC)).toBeNull();
	});
});
