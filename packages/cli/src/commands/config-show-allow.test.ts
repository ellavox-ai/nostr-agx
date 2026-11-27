import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePubkey, toNpub } from "@nostr-agx/nostr";
import kleur from "kleur";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_API_BASE_URL, profileSchema } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { createIdentity, toNsec } from "../lib/identity.js";
import { escapeLineBreakers } from "../lib/output.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx config show --json` prints the profile as it is saved, and that includes the `allow` list (the
// peers whose task requests this agent accepts). An entry of that list that is not a valid peer key
// (an npub, or a 64-character hex pubkey) is nearly always there because config.json was edited by
// hand. It may be a secret key pasted into the wrong place, so `config show` must not print its text.
// It leaves the entry out of `allow` and names it by its place in the list instead (`invalidPositions`,
// counted from 1 over the whole saved list, the way `agx doctor` counts). The readable `config show`
// prints only how many entries there are and no entry at all; that must stay so.

kleur.enabled = false;

let box: ReturnType<typeof sandbox>;
const a = createIdentity();
const b = createIdentity();
const c = createIdentity();
const d = createIdentity();
const e = createIdentity();

// Invisible characters are built here, not written into the file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CSI = String.fromCharCode(0x9b);
const NUL = String.fromCharCode(0);
/** Characters that do not show on screen: a right-to-left override, a zero-width space, a bidi isolate and its end mark. */
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

/** Made-up text shaped like a secret key. It is not a key. */
const FAKE_NSEC = `nsec1${"fakekey".repeat(8)}fa`;
const FAKE_NCRYPTSEC = `ncryptsec1${"fakekey".repeat(20)}`;
/** The secret key of a throwaway identity made when the test runs, written as nsec1…; it is used nowhere else. */
const THROWAWAY_NSEC = toNsec(Buffer.from(createIdentity().secretKeyHex, "hex"));
const WITH_CONTROLS = `FAKECTRL-before${ESC}[31mred${BEL}\r\nFAKECTRL-after-the-line-break${LINE_SEPARATOR}x${CSI}2J`;
const VERY_LONG = `FAKELONG${"x".repeat(5000)}`;
const HEX_ONE_SHORT = "0123456789abcdef".repeat(4).slice(0, 63);
const HEX_ONE_LONG = `${"fedcba9876543210".repeat(4)}0`;
/** Two hex keys, neither of them one that the tests list as a valid entry, so no part of it is in the output by right. */
const HEX_TWO_KEYS = `${d.publicKey}${e.publicKey}`;
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
	writeFileSync(join(box.home, "config.json"), JSON.stringify({ profiles: { default: { relays: [], allow } } }));
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

/**
 * The text `config show --json` prints for the profile `writeAllow` writes: the saved profile with
 * `allow` as given, then `credentials`, then (only when something was left out) `invalidPositions`.
 */
function expectedJson(allow: string[], invalidPositions?: number[], profileName = "default"): string {
	const { apiKey: _key, ...profile } = profileSchema.parse({ relays: [], allow });
	const doc = { profile: profileName, ...profile, credentials: null, ...(invalidPositions ? { invalidPositions } : {}) };
	return `${escapeLineBreakers(JSON.stringify(doc, null, 2))}\n`;
}

/** The text the readable `config show` prints for that profile when `allow` holds `count` entries. */
function expectedHuman(count: number): string {
	const row = (key: string, value: string) => `  ${key.padEnd(16)} ${value}\n`;
	return (
		'\nprofile "default"\n' +
		row("apiBaseUrl", DEFAULT_API_BASE_URL) +
		row("credentials", "not logged in (agx login)") +
		row("orgSlug", "—") +
		row("relays", "—") +
		row("org", "—") +
		row("nip05", "—") +
		row("allow", `${count} peer(s)`) +
		row("file", join(box.home, "config.json"))
	);
}

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

/** Each kind of entry that is not a valid peer key, and the text of it to look for in the output (null: nothing to look for). */
const kinds: Array<[string, string, string | null]> = [
	["a secret key (nsec1…), made up", FAKE_NSEC, FAKE_NSEC],
	["a secret key (nsec1…) made from a throwaway key", THROWAWAY_NSEC, THROWAWAY_NSEC],
	["a secret key in capitals (NSEC1…)", THROWAWAY_NSEC.toUpperCase(), THROWAWAY_NSEC.toUpperCase()],
	["a secret key with its first letter missing (sec1…)", THROWAWAY_NSEC.slice(1), THROWAWAY_NSEC.slice(1)],
	["the part of a secret key that follows nsec1", THROWAWAY_NSEC.slice(5), THROWAWAY_NSEC.slice(5)],
	["a password-protected secret key (ncryptsec1…)", FAKE_NCRYPTSEC, FAKE_NCRYPTSEC],
	["text with control characters and a line break", WITH_CONTROLS, "FAKECTRL"],
	["a string of 5000 characters", VERY_LONG, VERY_LONG],
	["a 64-character hex key with one character missing", HEX_ONE_SHORT, HEX_ONE_SHORT],
	["a 64-character hex key with one character too many", HEX_ONE_LONG, HEX_ONE_LONG],
	["two hex keys written one after the other", HEX_TWO_KEYS, HEX_TWO_KEYS],
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
	// A valid key with more text after it: a check of only the first word would let the whole entry through.
	["a valid npub, a space, then a secret key", `${d.npub} ${THROWAWAY_NSEC}`, `${d.npub} ${THROWAWAY_NSEC}`],
	["a valid hex key, a line break, then a secret key", `${d.publicKey}\n${THROWAWAY_NSEC}`, `${d.publicKey}\n${THROWAWAY_NSEC}`],
	["a valid hex key, a NUL character, then x", `${d.publicKey}${NUL}x`, `${d.publicKey}${NUL}x`],
	// A valid key with a character around it that does not show on screen. Each of these is left out like any other
	// entry that is not exactly a key.
	["a valid hex key with a right-to-left override in front", `${RLO}${e.publicKey}`, `${RLO}${e.publicKey}`],
	["a valid hex key with a zero-width space in front", `${ZWSP}${d.publicKey}`, `${ZWSP}${d.publicKey}`],
	["a valid npub with a zero-width space after it", `${e.npub}${ZWSP}`, `${e.npub}${ZWSP}`],
	["a valid hex key between a bidi isolate and its end mark", `${LRI}${e.publicKey}${PDI}`, `${LRI}${e.publicKey}${PDI}`],
	["an empty string", "", null],
	["a string of spaces", "   ", null],
];

describe("agx config show --json: an entry of allow that is not a valid peer key", () => {
	it.each(kinds)("%s is not printed", async (_name, entry, secret) => {
		writeAllow([a.publicKey, entry, b.publicKey]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		if (secret !== null) {
			expect(leaked(run.stdout, secret)).toBeNull();
		}
		const doc = JSON.parse(run.stdout) as { allow: string[]; invalidPositions?: number[] };
		expect(doc.allow).toEqual([a.publicKey, b.publicKey]);
		expect(doc.invalidPositions).toEqual([2]);
		// The whole document, so that even a few characters of the entry would show up here.
		expect(run.stdout).toBe(expectedJson([a.publicKey, b.publicKey], [2]));
	});

	it("prints the same document whatever the text of the entry is, however long", async () => {
		const documents = new Set<string>();
		for (const entry of [FAKE_NSEC, NOT_A_KEY, VERY_LONG, "", WITH_CONTROLS, OTHER_SCRIPT]) {
			writeAllow([a.publicKey, entry, b.publicKey]);
			documents.add((await agx("config", "show", "--json")).stdout);
		}
		expect([...documents]).toEqual([expectedJson([a.publicKey, b.publicKey], [2])]);
	});

	it("keeps the valid entries in order and names each bad one by its place, counted from 1 over the whole list", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY, b.npub, FAKE_NCRYPTSEC, c.publicKey.toUpperCase()]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(JSON.parse(run.stdout)).toMatchObject({
			allow: [a.publicKey, b.npub, c.publicKey.toUpperCase()],
			invalidPositions: [1, 3, 5],
		});
		expect(run.stdout).toBe(expectedJson([a.publicKey, b.npub, c.publicKey.toUpperCase()], [1, 3, 5]));
	});

	it("gives a script that reads allow only valid peer keys", async () => {
		writeAllow([
			FAKE_NSEC,
			a.publicKey,
			NOT_A_KEY,
			b.npub,
			WITH_CONTROLS,
			"",
			HEX_ONE_SHORT,
			NPUB_20_BYTES,
			NPUB_NO_BYTES,
		]);
		const run = await agx("config", "show", "--json");
		const doc = JSON.parse(run.stdout) as { allow: string[]; invalidPositions: number[] };
		expect(doc.allow).toEqual([a.publicKey, b.npub]);
		for (const entry of doc.allow) {
			expect(normalizePubkey(entry)).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(doc.invalidPositions).toEqual([1, 3, 5, 6, 7, 8, 9]);
		expect(run.stdout).toBe(expectedJson([a.publicKey, b.npub], [1, 3, 5, 6, 7, 8, 9]));
	});

	it("checks every entry of a long list, however far down the bad one is", async () => {
		const valid = Array.from({ length: 18 }, (_unused, i) => {
			const peer = createIdentity();
			return [peer.npub, peer.publicKey, peer.publicKey.toUpperCase()][i % 3] as string;
		});
		// 20 entries: a bad one right after the first nine, and a bad one last.
		writeAllow([...valid.slice(0, 9), FAKE_NSEC, ...valid.slice(9), THROWAWAY_NSEC]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(leaked(run.stdout, THROWAWAY_NSEC)).toBeNull();
		expect(run.stdout).toBe(expectedJson(valid, [10, 20]));
	});

	it("counts a list of only bad entries as a list with entries, with nothing left in allow", async () => {
		writeAllow([FAKE_NSEC, NOT_A_KEY]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(JSON.parse(run.stdout)).toMatchObject({ allow: [], invalidPositions: [1, 2] });
		expect(run.stdout).toBe(expectedJson([], [1, 2]));
	});

	it("hides the entry of a list that holds just that one entry", async () => {
		writeAllow([FAKE_NSEC]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(JSON.parse(run.stdout)).toMatchObject({ allow: [], invalidPositions: [1] });
		expect(run.stdout).toBe(expectedJson([], [1]));
	});

	it("names two equal bad entries by their own places and keeps a repeated valid entry", async () => {
		writeAllow([a.publicKey, a.publicKey, FAKE_NSEC, FAKE_NSEC, b.publicKey, FAKE_NSEC]);
		const run = await agx("config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toBe(expectedJson([a.publicKey, a.publicKey, b.publicKey], [3, 4, 6]));
	});

	it("hides the entry of the profile chosen with --profile, and says which profile it printed", async () => {
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				profiles: {
					default: { relays: [], allow: [a.publicKey] },
					work: { relays: [], allow: [FAKE_NSEC, b.publicKey] },
				},
			}),
		);
		const run = await agx("--profile", "work", "config", "show", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(JSON.parse(run.stdout)).toMatchObject({ profile: "work", allow: [b.publicKey], invalidPositions: [1] });
		expect(run.stdout).toBe(expectedJson([b.publicKey], [1], "work"));
	});

	it("hides the entry in the same way when colour is on, as it is on a terminal", async () => {
		writeAllow([a.publicKey, FAKE_NSEC, b.publicKey]);
		const run = await withColour(() => agx("config", "show", "--json"));
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(run.stdout).toBe(expectedJson([a.publicKey, b.publicKey], [2]));
	});
});

describe("agx config show (readable): output that must not change", () => {
	it.each(kinds)("%s is not printed, and only the number of entries is", async (_name, entry, secret) => {
		writeAllow([a.publicKey, entry, b.publicKey]);
		const run = await agx("config", "show");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		if (secret !== null) {
			expect(leaked(run.stdout, secret)).toBeNull();
		}
		expect(run.stdout).toBe(expectedHuman(3));
	});

	it("is the same text for a list with bad entries as for a list of as many valid entries", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY, b.npub, FAKE_NCRYPTSEC, c.publicKey]);
		const withBad = await agx("config", "show");
		writeAllow([d.publicKey, a.publicKey, e.publicKey, b.npub, c.publicKey, c.npub]);
		const allValid = await agx("config", "show");
		expect(withBad.code).toBe(0);
		expect(withBad.stderr).toBe("");
		expect(withBad.stdout).toBe(allValid.stdout);
		expect(withBad.stdout).toBe(expectedHuman(6));
	});

	it("is the same when colour is on, as it is on a terminal", async () => {
		writeAllow([a.publicKey, FAKE_NSEC, b.publicKey]);
		const run = await withColour(() => agx("config", "show"));
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain(ESC);
		expect(leaked(run.stdout, FAKE_NSEC)).toBeNull();
		expect(run.stdout.replace(COLOUR_CODES, "")).toBe(expectedHuman(3));
	});
});

describe("agx config show: other output that must not change", () => {
	it("prints a list of valid entries, as the CLI saves them, in both modes as before", async () => {
		writeAllow([a.publicKey, b.publicKey, c.publicKey]);
		const human = await agx("config", "show");
		expect(human.code).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe(expectedHuman(3));
		const json = await agx("config", "show", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(json.stdout).toBe(expectedJson([a.publicKey, b.publicKey, c.publicKey]));
		expect(JSON.parse(json.stdout)).not.toHaveProperty("invalidPositions");
	});

	it("prints a valid entry exactly as it is saved, whatever form it is saved in", async () => {
		const saved = [
			a.publicKey,
			b.npub,
			c.publicKey.toUpperCase(),
			`  ${d.npub}\n`,
			`\t${e.publicKey} `,
			`${LINE_SEPARATOR}${a.publicKey}`,
		];
		writeAllow(saved);
		const human = await agx("config", "show");
		expect(human.stdout).toBe(expectedHuman(6));
		const json = await agx("config", "show", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(json.stdout).toBe(expectedJson(saved));
		expect(JSON.parse(json.stdout)).not.toHaveProperty("invalidPositions");
	});

	it("prints an empty list as an empty list, with no invalidPositions", async () => {
		writeAllow([]);
		const human = await agx("config", "show");
		expect(human.stdout).toBe(expectedHuman(0));
		const json = await agx("config", "show", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(json.stdout).toBe(expectedJson([]));
		expect(JSON.parse(json.stdout)).toMatchObject({ allow: [] });
		expect(JSON.parse(json.stdout)).not.toHaveProperty("invalidPositions");
	});

	it("prints a profile with no config file as an empty list, with no invalidPositions", async () => {
		const json = await agx("config", "show", "--json");
		expect(json.code).toBe(0);
		expect(json.stderr).toBe("");
		expect(JSON.parse(json.stdout)).toMatchObject({ profile: "default", allow: [] });
		expect(JSON.parse(json.stdout)).not.toHaveProperty("invalidPositions");
	});

	it("leaves config.json exactly as it was, bad entries included", async () => {
		writeAllow([FAKE_NSEC, a.publicKey, NOT_A_KEY]);
		const before = readFileSync(join(box.home, "config.json"), "utf8");
		await agx("config", "show");
		await agx("config", "show", "--json");
		expect(readFileSync(join(box.home, "config.json"), "utf8")).toBe(before);
	});

	it.each([
		["a number", 123],
		["null", null],
		["an object that holds text shaped like a secret key", { key: FAKE_NSEC }],
		["a list that holds text shaped like a secret key", [FAKE_NSEC]],
	])("refuses a config file whose allow list holds %s, and prints none of it", async (_name, value) => {
		writeAllow([a.publicKey, value]);
		for (const args of [["config", "show"], ["config", "show", "--json"]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("does not match the expected shape");
			expect(leaked(run.stderr, FAKE_NSEC)).toBeNull();
		}
	});
});
