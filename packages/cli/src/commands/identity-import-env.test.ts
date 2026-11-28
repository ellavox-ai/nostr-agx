import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "../lib/identity.js";
import { setStdinForTests, stdinStream } from "../lib/stdin.js";
import { agx, type CliRun, jsonDocuments, sandbox } from "../test/helpers.js";

// `agx identity import --from-env NAME` reads the secret key from the environment variable NAME of the
// process. The key goes through the same reading as the key piped in with `--stdin`, so every check that
// applies there applies here. Only the name is ever printed, and only after it has passed the rule for a
// variable name; the variable's value is never printed, logged or stored anywhere but the identity file.
// Every key in this file is made when the test runs.

let box: ReturnType<typeof sandbox>;
let restoreStdin: (() => void) | undefined;
const VAR = "IMPORT_KEY_FOR_TEST";
const mine = createIdentity();
const incoming = createIdentity();
const HEX = incoming.secretKeyHex;
const NSEC = nip19.nsecEncode(hexToBytes(HEX));
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
const TEXT = "correct-horse-battery-staple-1234";

const COULD_NOT_DECODE =
	"Could not decode that nsec: it is not a valid secret key (a character is wrong or missing). It is not shown here.";
const NOT_USABLE =
	"Could not use that secret key: it decodes, but it is not a valid secret key (for example all zeros, out of range, or not 32 bytes long). It is not shown here.";
const NOT_A_KEY = "Expected an `nsec1…` key or a 64-character hex secret key.";
const NOT_SET_HINT = "Set the variable to the key in the environment this command runs in, or pipe the key in with --stdin.";
const ONE_WAY = "Give the key one way only: as an argument, with --stdin or with --from-env.";
const ONE_WAY_HINT = "Use one of:\n    agx identity import --stdin\n    agx identity import --from-env NAME";
const LEFT = ", so it was not used and is not shown here.";
const SLOT = "The value of `--from-env` (agx identity import)";
const NOT_A_NAME = `${SLOT} is not a valid environment variable name (letters, digits and "_", not starting with a digit)${LEFT}`;
const NAME_HINT = "Name the variable that holds the key, for example:  agx identity import --from-env AGENT_KEY";
const KEY_HINT = "A secret key belongs only in `agx identity import` (pipe it in with --stdin). Check what each command takes with `agx --help`.";

/** What reaches stderr for an error with a remediation: a blank line, a cross, the message, the advice. */
function failure(message: string, remediation?: string): string {
	return remediation === undefined ? `\n✗ ${message}\n` : `\n✗ ${message}\n\n  ${remediation}\n\n`;
}

/** What reaches stderr (colour codes dropped: kleur adds them when FORCE_COLOR is set). */
function plain(stderr: string): string {
	return stderr.replace(/\u001b\[[0-9;]*m/g, "");
}

/** The first 10-character stretch of `key` found in `shown`, in any case, starting `from` characters in; null if none. */
function leakedPart(shown: string, key: string, from = 0): string | null {
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

/** Both forms of a key (the hex and the nsec1) looked for in `shown`. */
function holdsKey(shown: string, hex: string): boolean {
	const nsec = nip19.nsecEncode(hexToBytes(hex));
	return leakedPart(shown, hex) !== null || leakedPart(shown, nsec, 5) !== null;
}

/** Every file under `home` that holds a stretch of the key, by path relative to `home`; the file names are looked at too. */
function filesHolding(home: string, hex: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const rel = relative(home, path);
			if (holdsKey(rel, hex)) {
				found.push(`${rel} (name)`);
			}
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (holdsKey(readFileSync(path, "utf8"), hex)) {
				found.push(rel);
			}
		}
	};
	walk(home);
	return found.sort();
}

/** The paths of every file under `home`. */
function listing(home: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			found.push(relative(home, path));
			if (statSync(path).isDirectory()) {
				walk(path);
			}
		}
	};
	walk(home);
	return found.sort();
}

function stored(profile = "default"): { secretKeyHex: string; npub: string } {
	return loadIdentityFile(profile);
}

/** `value` with the character at `index` swapped for another valid bech32 character. */
function flip(value: string, index: number): string {
	return `${value.slice(0, index)}${value[index] === "q" ? "p" : "q"}${value.slice(index + 1)}`;
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	restoreStdin?.();
	restoreStdin = undefined;
	delete process.env[VAR];
	box.restore();
});

describe("identity import --from-env: a good key in the variable", () => {
	it.each([
		["an nsec1 key", NSEC],
		["an nsec1 key in capitals", NSEC.toUpperCase()],
		["an nsec1 key behind nostr:", `nostr:${NSEC}`],
		["64 hex characters", HEX],
		["64 hex characters in capitals", HEX.toUpperCase()],
		["an nsec1 key with spaces and a newline around it", `  ${NSEC}\n`],
	])("%s: is imported, and none of it is printed", async (_name, value) => {
		process.env[VAR] = value;
		const run = await agx("identity", "import", "--from-env", VAR);
		expect(run.stderr).toBe("");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain(incoming.npub);
		expect(run.stdout).toContain('Imported identity');
		expect(holdsKey(run.stdout, HEX)).toBe(false);
		expect(stored().secretKeyHex === HEX).toBe(true);
		expect(stored().npub).toBe(incoming.npub);
	});

	it("leaves the variable as it was: it belongs to the caller", async () => {
		process.env[VAR] = NSEC;
		await agx("identity", "import", "--from-env", VAR);
		expect(process.env[VAR]).toBe(NSEC);
	});

	it("prints the same in --json mode, and the one document holds only the public key", async () => {
		process.env[VAR] = NSEC;
		const run = await agx("--json", "identity", "import", "--from-env", VAR);
		expect(run.code).toBe(EXIT.ok);
		expect(run.stderr).toBe("");
		expect(jsonDocuments(run.stdout)).toEqual([{ npub: incoming.npub, pubkey: incoming.publicKey }]);
		expect(holdsKey(run.stdout, HEX)).toBe(false);
	});

	it("keeps the key in the identity file only: no other file and no file name holds a part of it", async () => {
		process.env[VAR] = NSEC;
		await agx("identity", "import", "--from-env", VAR);
		expect(filesHolding(box.home, HEX)).toEqual([join("profiles", "default", "identity.json")]);
	});

	it("imports into the profile named with --profile", async () => {
		process.env[VAR] = NSEC;
		const run = await agx("--profile", "fresh", "identity", "import", "--from-env", VAR);
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain('into profile "fresh"');
		expect(stored("fresh").secretKeyHex === HEX).toBe(true);
		expect(existsSync(join(box.home, "profiles", "default"))).toBe(false);
	});
});

describe("identity import --from-env: the same checks as --stdin, with the same words", () => {
	const VALUES: Array<[string, string]> = [
		["a good nsec1 key", NSEC],
		["a good hex key", HEX],
		["a good key behind nostr:", `nostr:${NSEC.toUpperCase()}`],
		["a typo in the middle of an nsec1 key", flip(NSEC, 30)],
		["an nsec1 key with a character missing", NSEC.slice(0, -1)],
		["capitals and lower case mixed", `${NSEC.slice(0, 20)}${NSEC.slice(20).toUpperCase()}`],
		["an ncryptsec1 key", NCRYPTSEC],
		["a hex key with a character missing", HEX.slice(1)],
		["a hex key with a character too many", `${HEX}a`],
		["a hex key with a character that is not hex", `${HEX.slice(0, 63)}z`],
		["64 zeros", "0".repeat(64)],
		["the curve order", "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"],
		["an nsec1 key of 31 bytes", nip19.nsecEncode(hexToBytes(HEX).slice(0, 31))],
		["an all-zero nsec1 key", nip19.nsecEncode(new Uint8Array(32))],
		["words that are not a key", TEXT],
		["two lines", `${NSEC}\n${NSEC}`],
	];

	it.each(VALUES)("%s: exit code, standard output and standard error are those of --stdin", async (_name, value) => {
		saveIdentity("default", mine);
		restoreStdin = setStdinForTests(`${value}\n`);
		const viaStdin = await agx("identity", "import", "--stdin", "--force");
		restoreStdin();
		restoreStdin = undefined;
		saveIdentity("default", mine);
		process.env[VAR] = `${value}\n`;
		const viaEnv = await agx("identity", "import", "--from-env", VAR, "--force");
		expect(viaEnv).toEqual(viaStdin);
	});

	it.each(VALUES)("%s: also in --json mode and with AGX_DEBUG=1", async (_name, value) => {
		process.env[VAR] = value;
		for (const [flags, debug] of [[["--json"], false], [[], true]] as const) {
			saveIdentity("default", mine);
			if (debug) {
				process.env.AGX_DEBUG = "1";
			}
			const run: CliRun = await agx(...flags, "identity", "import", "--from-env", VAR, "--force");
			delete process.env.AGX_DEBUG;
			if (run.code !== EXIT.ok) {
				expect(run.code).toBe(EXIT.usage);
				expect(run.stdout).toBe("");
				expect(holdsKey(run.stderr, HEX)).toBe(false);
				expect(leakedPart(run.stderr, value.replace(/^nostr:/i, ""), 10)).toBeNull();
				expect(run.stderr).not.toContain(TEXT);
				expect(run.stderr).not.toMatch(/\n\s+at /);
			}
		}
	});

	it("leaves the identity that was there as it was when the key is refused", async () => {
		saveIdentity("default", mine);
		for (const [, value] of VALUES.slice(3)) {
			process.env[VAR] = value;
			await agx("identity", "import", "--from-env", VAR, "--force");
		}
		expect(stored().secretKeyHex === mine.secretKeyHex).toBe(true);
	});
});

describe("identity import --from-env: a variable that is not set, or empty", () => {
	it("names the variable and nothing else when it is not set", async () => {
		const run = await agx("identity", "import", "--from-env", VAR);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(failure(`The environment variable ${VAR} is not set.`, NOT_SET_HINT));
		expect(listing(box.home)).toEqual([]);
	});

	it.each([
		["empty", ""],
		["only spaces", "   "],
		["only a newline and a tab", "\n\t"],
	])("names the variable when it is %s", async (_name, value) => {
		process.env[VAR] = value;
		const run = await agx("identity", "import", "--from-env", VAR);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(failure(`The environment variable ${VAR} is empty.`, NOT_SET_HINT));
		expect(listing(box.home)).toEqual([]);
	});

	it("says the same in --json mode: standard output stays empty", async () => {
		const plainRun = await agx("identity", "import", "--from-env", VAR);
		const jsonRun = await agx("--json", "identity", "import", "--from-env", VAR);
		expect(jsonRun.code).toBe(EXIT.usage);
		expect(jsonRun.stdout).toBe("");
		expect(jsonRun.stderr).toBe(plainRun.stderr);
	});
});

describe("identity import --from-env: one source for the key", () => {
	it.each([
		["a key as an argument", ["identity", "import", "--from-env", VAR, NSEC]],
		["a hex key as an argument", ["identity", "import", "--from-env", VAR, HEX]],
		["a key as an argument, written first", ["identity", "import", NSEC, "--from-env", VAR]],
		["an empty argument", ["identity", "import", "--from-env", VAR, ""]],
		["an empty argument, written first", ["identity", "import", "", "--from-env", VAR]],
		["--stdin", ["identity", "import", "--from-env", VAR, "--stdin"]],
		["--stdin and a key as an argument", ["identity", "import", "--stdin", "--from-env", VAR, NSEC]],
		["--force and a key as an argument", ["identity", "import", "--force", "--from-env", VAR, NSEC]],
		["--json and a key as an argument", ["--json", "identity", "import", "--from-env", VAR, NSEC]],
	])("with %s: a usage error that repeats nothing, and nothing is read or written", async (_name, args) => {
		process.env[VAR] = NSEC;
		restoreStdin = setStdinForTests(`${NSEC}\n`);
		const run = await agx(...args);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(failure(ONE_WAY, ONE_WAY_HINT));
		expect(holdsKey(run.stderr, HEX)).toBe(false);
		expect(listing(box.home)).toEqual([]);
	});

	it("says so before it looks at the variable, which is not set here", async () => {
		const run = await agx("identity", "import", "--from-env", VAR, NSEC);
		expect(run.code).toBe(EXIT.usage);
		expect(plain(run.stderr)).toBe(failure(ONE_WAY, ONE_WAY_HINT));
	});

	it("does not read standard input when the key is in a variable", async () => {
		process.env[VAR] = NSEC;
		restoreStdin = setStdinForTests(`${nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex))}\n`);
		const piped = stdinStream();
		const run = await agx("identity", "import", "--from-env", VAR);
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === HEX).toBe(true);
		expect(piped.readableDidRead).toBe(false);
	});
});

describe("identity import --from-env: the profile already has an identity", () => {
	beforeEach(() => {
		saveIdentity("default", mine);
	});

	it("refuses first, whatever the variable holds, with the words --stdin uses, and does not read it", async () => {
		restoreStdin = setStdinForTests(`${NSEC}\n`);
		const viaStdin = await agx("identity", "import", "--stdin");
		restoreStdin();
		restoreStdin = undefined;
		expect(viaStdin.code).toBe(EXIT.config);
		expect(plain(viaStdin.stderr)).toContain('Profile "default" already has an identity.');
		for (const value of [undefined, "", NSEC, flip(NSEC, 30), TEXT]) {
			if (value === undefined) {
				delete process.env[VAR];
			} else {
				process.env[VAR] = value;
			}
			const run = await agx("identity", "import", "--from-env", VAR);
			expect(run).toEqual(viaStdin);
		}
		expect(stored().secretKeyHex === mine.secretKeyHex).toBe(true);
	});

	it("replaces it with --force", async () => {
		process.env[VAR] = NSEC;
		const run = await agx("identity", "import", "--from-env", VAR, "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === HEX).toBe(true);
	});
});

describe("identity import --from-env: what is given as the name", () => {
	const keyForms: Array<[string, () => string]> = [
		["an nsec1 key", () => NSEC],
		["an nsec1 key in capitals", () => NSEC.toUpperCase()],
		["an nsec1 key behind nostr:", () => `nostr:${NSEC}`],
		["an nsec1 key written as %xx escapes", () => [...NSEC].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")],
		["an ncryptsec1 key", () => NCRYPTSEC],
		["64 hex characters that start with a letter", () => `a${HEX.slice(1)}`],
		["64 hex characters that start with a letter, in capitals", () => `A${HEX.slice(1)}`.toUpperCase()],
		["64 hex characters that start with a digit", () => `7${HEX.slice(1)}`],
	];

	it.each(keyForms)("%s: refused as a name before anything is read, and not printed", async (_name, make) => {
		const name = make();
		// A variable of that very name holds a good key: if the name were used, this would import it.
		process.env[name] = NSEC;
		try {
			const run = await agx("identity", "import", "--from-env", name);
			expect(run.code).toBe(EXIT.usage);
			expect(run.stdout).toBe("");
			const message = /^nsec1|^nostr:|^ncryptsec1|^%/i.test(name)
				? `${SLOT} holds a secret key (nsec1… or ncryptsec1…)${LEFT}`
				: `${SLOT} holds a 64-character hex string, which may be a secret key${LEFT}`;
			expect(plain(run.stderr)).toBe(failure(message, KEY_HINT));
			expect(leakedPart(run.stderr, name.replace(/^nostr:/i, ""), 5)).toBeNull();
			expect(listing(box.home)).toEqual([]);
		} finally {
			delete process.env[name];
		}
	});

	it("refuses the key given as the name in --json mode with the same words", async () => {
		const plainRun = await agx("identity", "import", "--from-env", NSEC);
		const jsonRun = await agx("--json", "identity", "import", "--from-env", NSEC);
		expect(jsonRun.code).toBe(EXIT.usage);
		expect(jsonRun.stdout).toBe("");
		expect(jsonRun.stderr).toBe(plainRun.stderr);
	});

	it.each([
		["a hex key one digit short", () => `a${HEX.slice(2)}`],
		["a hex key eight digits short", () => `a${HEX.slice(9)}`],
		["41 characters", () => "Z".repeat(41)],
		["a letter and 55 hex digits of a key", () => `x${HEX.slice(0, 55)}`],
		["an nsec1 key typed without its 1", () => NSEC.replace("nsec1", "nsec")],
	])("%s: not a name, and not printed", async (_name, make) => {
		const name = make();
		process.env[name] = NSEC;
		try {
			const run = await agx("identity", "import", "--from-env", name);
			expect(run.code).toBe(EXIT.usage);
			expect(plain(run.stderr)).toBe(failure(NOT_A_NAME, NAME_HINT));
			expect(leakedPart(run.stderr, HEX)).toBeNull();
			expect(listing(box.home)).toEqual([]);
		} finally {
			delete process.env[name];
		}
	});

	it("takes a name of exactly 40 characters (control for the 41 above), and says it when it is not set", async () => {
		const name = "ABCDEFGHIJ".repeat(4);
		const run = await agx("identity", "import", "--from-env", name);
		expect(run.code).toBe(EXIT.usage);
		expect(plain(run.stderr)).toBe(failure(`The environment variable ${name} is not set.`, NOT_SET_HINT));
	});

	it.each([
		["a digit first", "1KEY"],
		["a hyphen", "MY-KEY"],
		["a space", "MY KEY"],
		["a dot", "MY.KEY"],
		["an equals sign", "KEY=1"],
		["a dollar sign", "$HOME"],
		["a semicolon", "KEY;ls"],
		["a slash", "a/b"],
		["a letter with an accent", "clé"],
		["a newline", "KEY\n"],
		["nothing at all", ""],
		["only a space", " "],
	])("%s: not the name of a variable, said without repeating it", async (_name, name) => {
		const run = await agx("identity", "import", "--from-env", name);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(failure(NOT_A_NAME, NAME_HINT));
		expect(listing(box.home)).toEqual([]);
	});

	it.each(["KEY", "_KEY", "key", "Key_1", "A", "_", "AGENT_KEY_2", "x".repeat(40)])("%s: is a name", async (name) => {
		process.env[name] = NSEC;
		try {
			const run = await agx("identity", "import", "--from-env", name);
			expect(run.code).toBe(EXIT.ok);
			expect(stored().secretKeyHex === HEX).toBe(true);
		} finally {
			delete process.env[name];
		}
	});
});

describe("identity import --from-env: the key is never printed, logged or kept apart from the identity file", () => {
	it.each([
		["a bad key", flip(NSEC, 30)],
		["an unusable key", "0".repeat(64)],
		["an ncryptsec1 key", NCRYPTSEC],
		["words", TEXT],
	])("%s: no part of it in standard output, standard error, the identity or the home", async (_name, value) => {
		process.env[VAR] = value;
		for (const args of [["identity", "import", "--from-env", VAR], ["--json", "identity", "import", "--from-env", VAR], ["--profile", "other", "identity", "import", "--from-env", VAR]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.usage);
			expect(run.stdout).toBe("");
			expect(leakedPart(run.stderr, value.replace(/^nostr:/i, ""), 10)).toBeNull();
		}
		expect(listing(box.home)).toEqual([]);
	});
});

describe("identity import --from-env: a name that every object already has (toString, constructor ...)", () => {
	const PROTOTYPE_NAMES = ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"];

	it.each(PROTOTYPE_NAMES)("%s, not set: says it is not set, like any other name", async (name) => {
		expect(Object.hasOwn(process.env, name)).toBe(false);
		const run = await agx("identity", "import", "--from-env", name);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(plain(run.stderr)).toBe(failure(`The environment variable ${name} is not set.`, NOT_SET_HINT));
		expect(listing(box.home)).toEqual([]);
	});

	it.each(PROTOTYPE_NAMES)("%s, set to a key: imports it", async (name) => {
		process.env[name] = NSEC;
		try {
			const run = await agx("identity", "import", "--from-env", name);
			expect(run.stderr).toBe("");
			expect(run.code).toBe(EXIT.ok);
			expect(stored().secretKeyHex === HEX).toBe(true);
			expect(holdsKey(run.stdout, HEX)).toBe(false);
		} finally {
			delete process.env[name];
		}
	});

	it.each(PROTOTYPE_NAMES)("%s, set to words: the --stdin text, not a crash", async (name) => {
		process.env[name] = TEXT;
		try {
			const run = await agx("identity", "import", "--from-env", name);
			expect(run.code).toBe(EXIT.usage);
			expect(plain(run.stderr)).toBe(failure(NOT_A_KEY));
		} finally {
			delete process.env[name];
		}
	});
});
