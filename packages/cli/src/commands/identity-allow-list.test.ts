import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toNpub } from "@nostr-agx/nostr";
import kleur from "kleur";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx identity allow --list` prints the saved allowlist. An entry that is not a valid peer key (an
// npub or a 64-character hex pubkey) is nearly always there because config.json was edited by hand:
// `identity allow` refuses such a value, with one known gap (an npub that carries 20 bytes, for
// example, is accepted and stored as 40 hex characters; see open issue #55). It may be a secret key
// pasted into the wrong place, so the listing must never print its text, in the readable output or
// in `--json`. It names the entry by its place instead.

kleur.enabled = false;

let box: ReturnType<typeof sandbox>;
const a = createIdentity();
const b = createIdentity();
const c = createIdentity();
const d = createIdentity();

// Invisible characters are built here, not written into the file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CSI = String.fromCharCode(0x9b);

/** Made-up text shaped like a secret key. It is not a key. */
const FAKE_NSEC = `nsec1${"fakekey".repeat(8)}fa`;
const FAKE_NCRYPTSEC = `ncryptsec1${"fakekey".repeat(20)}`;
const WITH_CONTROLS = `FAKECTRL-before${ESC}[31mred${BEL}\r\nFAKECTRL-after-the-line-break${LINE_SEPARATOR}x${CSI}2J`;
const VERY_LONG = `FAKELONG${"x".repeat(5000)}`;
const HEX_ONE_SHORT = "0123456789abcdef".repeat(4).slice(0, 63);
const HEX_WITH_PREFIX = `0x${"fedcba9876543210".repeat(4)}`;
const NOT_A_KEY = "garbage-entry-FAKEJUNK";
const OTHER_SCRIPT = "ключ-🔑-FAKE";
/** A real npub with its last character changed, so the checksum no longer holds. */
const MISTYPED_NPUB = `${d.npub.slice(0, -1)}${d.npub.endsWith("q") ? "p" : "q"}`;
/** An npub that carries `length` bytes of made-up text instead of a public key. */
const npubWithBytes = (length: number) =>
	toNpub(Buffer.from("fakepayload".repeat(8)).subarray(0, length).toString("hex"));
const NPUB_NO_BYTES = toNpub("");
const NPUB_NO_BYTES_PADDED = `  ${NPUB_NO_BYTES}${LINE_SEPARATOR}\t`;
const NPUB_20_BYTES = npubWithBytes(20);
const NPUB_33_BYTES = npubWithBytes(33);
const NPUB_64_BYTES = npubWithBytes(64);

/** Write config.json by hand, the way a person editing it would, with `allow` as given. */
function writeAllow(allow: unknown[]): void {
	writeFileSync(join(box.home, "config.json"), JSON.stringify({ profiles: { default: { allow } } }));
}

/** The first piece of `text` (all of it, or any 10 characters in a row) that shows up in `shown`; null if none. */
function leaked(shown: string, text: string): string | null {
	if (shown.includes(text)) {
		return text;
	}
	for (let i = 0; i + 10 <= text.length; i++) {
		const part = text.slice(i, i + 10);
		if (shown.includes(part)) {
			return part;
		}
	}
	return null;
}

const HEADING = '\nallowlist (profile "default")\n';
const entryLine = (position: number) => `  ! entry #${position} is not a valid peer key and is not shown\n`;
const HINT = '  To fix this, edit "allow" in config.json (agx config path shows where it is).\n';
const npubLines = (npubs: string[]) => npubs.map((npub) => `  ${npub}\n`).join("");
/** The colour codes that kleur writes when colour is on. */
const COLOUR_CODES = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Run `fn` with colour on, as it is on a terminal, and put colour back off afterwards. */
async function withColour<T>(fn: () => Promise<T>): Promise<T> {
	kleur.enabled = true;
	try {
		return await fn();
	} finally {
		kleur.enabled = false;
	}
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("agx identity allow --list: an entry that is not a valid peer key", () => {
	const kinds: Array<[string, string, string | null]> = [
		["a secret key (nsec1…)", FAKE_NSEC, FAKE_NSEC],
		["a password-protected secret key (ncryptsec1…)", FAKE_NCRYPTSEC, FAKE_NCRYPTSEC],
		["text with control characters and a line break", WITH_CONTROLS, "FAKECTRL"],
		["a string of 5000 characters", VERY_LONG, VERY_LONG],
		["a 64-character hex key with one character missing", HEX_ONE_SHORT, HEX_ONE_SHORT],
		["hex with a 0x prefix", HEX_WITH_PREFIX, HEX_WITH_PREFIX],
		["a word that is not a key", NOT_A_KEY, NOT_A_KEY],
		["text in another script with an emoji", OTHER_SCRIPT, OTHER_SCRIPT],
		["an npub with a wrong checksum", MISTYPED_NPUB, MISTYPED_NPUB],
		["an npub that carries no bytes", NPUB_NO_BYTES, NPUB_NO_BYTES],
		["an npub that carries no bytes, with a line separator and a tab around it", NPUB_NO_BYTES_PADDED, NPUB_NO_BYTES_PADDED],
		["an npub that carries 20 bytes", NPUB_20_BYTES, NPUB_20_BYTES],
		["an npub that carries 33 bytes", NPUB_33_BYTES, NPUB_33_BYTES],
		["an npub that carries 64 bytes", NPUB_64_BYTES, NPUB_64_BYTES],
		["an npub written in capitals", c.npub.toUpperCase(), c.npub.toUpperCase()],
		["an empty string", "", null],
		["a string of spaces", "   ", null],
	];

	it.each(kinds)("%s is not printed in the readable output", async (_name, entry, secret) => {
		writeAllow([a.publicKey, entry, b.publicKey]);
		const run = await agx("identity", "allow", "--list");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		if (secret !== null) {
			expect(leaked(run.stdout, secret)).toBeNull();
		}
		// The whole output, so that even a few characters of the entry would show up here.
		expect(run.stdout).toBe(HEADING + npubLines([a.npub]) + entryLine(2) + npubLines([b.npub]) + HINT);
	});

	it.each(kinds)("%s is not printed in --json", async (_name, entry, secret) => {
		writeAllow([a.publicKey, entry, b.publicKey]);
		const run = await agx("identity", "allow", "--list", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		if (secret !== null) {
			expect(leaked(run.stdout, secret)).toBeNull();
		}
		expect(JSON.parse(run.stdout)).toEqual({ allow: [a.npub, b.npub], invalidPositions: [2] });
	});

	it("does not make the output longer when the entry is longer", async () => {
		writeAllow([a.publicKey, VERY_LONG]);
		for (const args of [["identity", "allow", "--list"], ["identity", "allow", "--list", "--json"]]) {
			const run = await agx(...args);
			expect(run.stdout.length).toBeLessThan(600);
		}
	});

	it("shows the valid entries in order and names each bad one by its place, counted from 1 over the whole list", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY, b.npub, FAKE_NCRYPTSEC, c.publicKey.toUpperCase()]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(
			HEADING + entryLine(1) + npubLines([a.npub]) + entryLine(3) + npubLines([b.npub]) + entryLine(5) + npubLines([c.npub]) + HINT,
		);
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(JSON.parse(json.stdout)).toEqual({ allow: [a.npub, b.npub, c.npub], invalidPositions: [1, 3, 5] });
	});

	it("gives a script that reads allow from --json only valid npubs", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY, b.npub, WITH_CONTROLS, "", HEX_ONE_SHORT, NPUB_20_BYTES, NPUB_NO_BYTES]);
		const run = await agx("identity", "allow", "--list", "--json");
		const doc = JSON.parse(run.stdout) as { allow: string[]; invalidPositions: number[] };
		expect(doc.allow).toEqual([a.npub, b.npub]);
		for (const entry of doc.allow) {
			expect(entry).toMatch(/^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/);
		}
		expect(doc.invalidPositions).toEqual([1, 3, 5, 6, 7, 8, 9]);
	});

	it("counts a list of only bad entries as a list with entries, not as an empty one", async () => {
		writeAllow([FAKE_NSEC, NOT_A_KEY]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(HEADING + entryLine(1) + entryLine(2) + HINT);
		expect(human.stdout).not.toContain("Empty");
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({ allow: [], invalidPositions: [1, 2] });
	});

	it("hides the entry of a list that holds just that one entry", async () => {
		writeAllow([FAKE_NSEC]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(HEADING + entryLine(1) + HINT);
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(leaked(json.stdout, FAKE_NSEC)).toBeNull();
		expect(JSON.parse(json.stdout)).toEqual({ allow: [], invalidPositions: [1] });
	});

	it("names two equal bad entries by their own places and keeps a repeated valid entry", async () => {
		writeAllow([a.publicKey, a.publicKey, FAKE_NSEC, FAKE_NSEC, b.publicKey, FAKE_NSEC]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(
			HEADING + npubLines([a.npub, a.npub]) + entryLine(3) + entryLine(4) + npubLines([b.npub]) + entryLine(6) + HINT,
		);
		const json = await agx("identity", "allow", "--list", "--json");
		expect(JSON.parse(json.stdout)).toEqual({ allow: [a.npub, a.npub, b.npub], invalidPositions: [3, 4, 6] });
	});

	it("hides the entry in the same way when colour is on, as it is on a terminal", async () => {
		writeAllow([a.publicKey, FAKE_NSEC, b.publicKey]);
		const run = await withColour(() => agx("identity", "allow", "--list"));
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain(ESC);
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(run.stdout.replace(COLOUR_CODES, "")).toBe(
			HEADING + npubLines([a.npub]) + entryLine(2) + npubLines([b.npub]) + HINT,
		);
	});
});

describe("agx identity allow --list: output that must not change", () => {
	it("lists valid entries, whatever form they are saved in, as npubs, one per line", async () => {
		writeAllow([a.publicKey, b.npub, c.publicKey.toUpperCase()]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(HEADING + npubLines([a.npub, b.npub, c.npub]));
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(json.stdout).toBe(`{\n  "allow": [\n    "${a.npub}",\n    "${b.npub}",\n    "${c.npub}"\n  ]\n}\n`);
	});

	it("still shows a valid entry that has spaces or line breaks around it as its npub", async () => {
		writeAllow([`  ${a.npub}\n`, `\t${b.publicKey} `]);
		const human = await agx("identity", "allow", "--list");
		expect(human.stdout).toBe(HEADING + npubLines([a.npub, b.npub]));
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.stdout).toBe(`{\n  "allow": [\n    "${a.npub}",\n    "${b.npub}"\n  ]\n}\n`);
	});

	it("leaves config.json exactly as it was, bad entries included", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY]);
		const before = readFileSync(join(box.home, "config.json"), "utf8");
		await agx("identity", "allow", "--list");
		await agx("identity", "allow", "--list", "--json");
		expect(readFileSync(join(box.home, "config.json"), "utf8")).toBe(before);
	});

	it("still warns that an empty list refuses every task request", async () => {
		writeAllow([]);
		const human = await agx("identity", "allow", "--list");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(
			`${HEADING}! Empty — authorization is default-deny, so every task request will be refused.\n  agx identity allow <npub>\n`,
		);
		const json = await agx("identity", "allow", "--list", "--json");
		expect(json.stdout).toBe('{\n  "allow": []\n}\n');
	});

	it.each([
		["a number", 123],
		["null", null],
		["an object that holds text shaped like a secret key", { key: FAKE_NSEC }],
		["a list that holds text shaped like a secret key", [FAKE_NSEC]],
	])("refuses a config file whose allow list holds %s, and prints none of it", async (_name, value) => {
		writeAllow([a.publicKey, value]);
		for (const args of [["identity", "allow", "--list"], ["identity", "allow", "--list", "--json"]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("does not match the expected shape");
			expect(leaked(run.stderr, FAKE_NSEC)).toBeNull();
		}
	});
});
