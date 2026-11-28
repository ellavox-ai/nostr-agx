import { hexToBytes } from "@nostr-agx/nostr";
import kleur from "kleur";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../test/helpers.js";
import { createIdentity } from "./identity.js";
import {
	emitStderrJson,
	emitStdoutJson,
	errLine,
	fail,
	heading,
	info,
	json,
	kv,
	notice,
	ok,
	outLine,
	say,
	setJsonMode,
	step,
	table,
	warn,
	writeErr,
	writeOut,
} from "./output.js";

// Everything the CLI prints goes through the helpers in `output.ts` (a source scan in
// `output-writers.test.ts` says so), and each of them scrubs a secret key out of what it
// is given first. These tests call them directly, in human and in `--json` mode, on both streams.
//
// Every key here is made when the test runs, from a throwaway key.

const stranger = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(stranger.secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(stranger.secretKeyHex), "throwaway-password", 4);
const MARK = "[redacted]";

function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** `text` with every valid `%xx` sequence replaced by its character, as often as that changes it (at most 4 times). */
function decoded(text: string): string {
	let out = text;
	for (let round = 0; round < 4; round++) {
		const next = out.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		if (next === out) {
			break;
		}
		out = next;
	}
	return out;
}

/** The first 10-character stretch of the key's data part (not the constant prefix) found in `shown`, as written or %xx-decoded, in any case; null if none. */
function leakedPart(shown: string, key: string, prefix: number): string | null {
	const texts = [shown.toLowerCase(), decoded(shown).toLowerCase()];
	const secretText = key.toLowerCase();
	for (let i = prefix; i + 10 <= secretText.length; i++) {
		const part = secretText.slice(i, i + 10);
		if (texts.some((text) => text.includes(part))) {
			return part;
		}
	}
	return null;
}

let colour: boolean;

beforeEach(() => {
	colour = kleur.enabled;
	kleur.enabled = false;
	setJsonMode(false);
});

afterEach(() => {
	kleur.enabled = colour;
	setJsonMode(false);
});

const FORMS: Array<[string, string]> = [
	["an nsec1…", NSEC],
	["an nsec1… in capitals", NSEC.toUpperCase()],
	["an nsec1… behind nostr:", `nostr:${NSEC}`],
	["an ncryptsec1…", NCRYPTSEC],
	["an nsec1… written as %xx escapes", escapeAll(NSEC)],
	["an nsec1… in a sentence", `my key is ${NSEC} and please keep it safe`],
];

/** The helpers that write one line to stdout, and the line they write for `text`. */
const STDOUT_HELPERS: Array<[string, (text: string) => void]> = [
	["say", (text) => say(text)],
	["ok", (text) => ok(text)],
	["info", (text) => info(text)],
	["warn", (text) => warn(text)],
	["fail", (text) => fail(text)],
	["step", (text) => step(1, 3, text)],
	["heading", (text) => heading(text)],
	["kv", (text) => kv("profile", text)],
	["table", (text) => table([[text, "x"]], ["name", "other"])],
	["outLine", (text) => outLine(text)],
	["writeOut", (text) => writeOut(`${text}\n`)],
];

const STDERR_HELPERS: Array<[string, (text: string) => void]> = [
	["notice", (text) => notice(text)],
	["errLine", (text) => errLine(text)],
	["writeErr", (text) => writeErr(`${text}\n`)],
];

describe("a secret key given to a stdout helper does not come out", () => {
	for (const [helper, write] of STDOUT_HELPERS) {
		it.each(FORMS)(`${helper}: %s`, async (_form, text) => {
			const { stdout, stderr } = await capture(async () => write(text));
			expect(stdout).toContain(MARK);
			expect(leakedPart(stdout + stderr, NSEC, 5)).toBeNull();
			expect(leakedPart(stdout + stderr, NCRYPTSEC, 10)).toBeNull();
			expect(stderr).toBe("");
		});
	}
});

describe("a secret key given to a stderr helper does not come out", () => {
	for (const [helper, write] of STDERR_HELPERS) {
		it.each(FORMS)(`${helper}: %s`, async (_form, text) => {
			const { stdout, stderr } = await capture(async () => write(text));
			expect(stderr).toContain(MARK);
			expect(leakedPart(stdout + stderr, NSEC, 5)).toBeNull();
			expect(leakedPart(stdout + stderr, NCRYPTSEC, 10)).toBeNull();
			expect(stdout).toBe("");
		});
	}
});

describe("a secret key in a JSON document does not come out, and the document stays valid JSON", () => {
	const payload = { profile: NSEC, list: [NCRYPTSEC, `x ${escapeAll(NSEC)} y`], nested: { [`nostr:${NSEC}`]: 1 }, keep: stranger.publicKey };
	const expected = { profile: MARK, list: [MARK, `x ${MARK} y`], nested: { [`nostr:${MARK}`]: 1 }, keep: stranger.publicKey };

	it("json() in --json mode", async () => {
		setJsonMode(true);
		const { stdout, stderr } = await capture(async () => json(payload));
		expect(JSON.parse(stdout)).toEqual(expected);
		expect(leakedPart(stdout + stderr, NSEC, 5)).toBeNull();
	});

	it("emitStdoutJson", async () => {
		const { stdout, stderr } = await capture(async () => emitStdoutJson(payload));
		expect(JSON.parse(stdout)).toEqual(expected);
		expect(leakedPart(stdout + stderr, NSEC, 5)).toBeNull();
		expect(stderr).toBe("");
	});

	it("emitStderrJson", async () => {
		const { stdout, stderr } = await capture(async () => emitStderrJson(payload));
		expect(JSON.parse(stderr)).toEqual(expected);
		expect(leakedPart(stdout + stderr, NSEC, 5)).toBeNull();
		expect(stdout).toBe("");
	});

	it("a value with a line feed and then `sec1…` stays what it was, and the document stays valid", async () => {
		setJsonMode(true);
		const value = { text: "first line\nsec1abcdefghijklmnop" };
		const { stdout } = await capture(async () => json(value));
		expect(JSON.parse(stdout)).toEqual(value);
	});

	// A document 3000 levels deep is about 18 KB, which `JSON.stringify` writes without trouble: a peer
	// can send one as the answer to its own task, and `--json` prints it.
	describe("a document 3000 levels deep, with a key as the name at every level", () => {
		const deep = () => {
			let doc: unknown = "end";
			for (let i = 0; i < 3000; i++) {
				doc = { [NSEC]: doc };
			}
			return doc;
		};
		const depthOf = (text: string) => {
			let levels = 0;
			let node: unknown = JSON.parse(text);
			while (typeof node === "object" && node !== null) {
				const names = Object.keys(node);
				expect(names).toEqual([MARK]);
				node = (node as Record<string, unknown>)[MARK];
				levels++;
			}
			return { levels, leaf: node };
		};

		it.each([
			["json() in --json mode", (value: unknown) => json(value), true, "stdout"],
			["emitStdoutJson", (value: unknown) => emitStdoutJson(value), false, "stdout"],
			["emitStderrJson", (value: unknown) => emitStderrJson(value), false, "stderr"],
		] as const)("%s prints it with every name replaced, as valid JSON", async (_name, write, jsonOn, stream) => {
			setJsonMode(jsonOn);
			const out = await capture(async () => write(deep()));
			expect(depthOf(out[stream])).toEqual({ levels: 3000, leaf: "end" });
			expect(leakedPart(out.stdout + out.stderr, NSEC, 5)).toBeNull();
		});
	});
});

describe("ordinary output comes out exactly as it did", () => {
	const own = createIdentity();
	const line = (text: string) => `${text}\n`;

	it("the human helpers print what they printed", async () => {
		const { stdout } = await capture(async () => {
			say("hello");
			ok("done");
			info("note");
			warn("careful");
			fail("broke");
			kv("npub", own.npub);
			kv("pubkey", own.publicKey);
			kv("nothing", null);
			step(2, 5, "next");
			heading("title");
			table([["a", own.publicKey]], ["name", "key"]);
		});
		const expected = [
			"hello",
			"✓ done",
			"· note",
			"! careful",
			"✗ broke",
			`  ${"npub".padEnd(16)} ${own.npub}`,
			`  ${"pubkey".padEnd(16)} ${own.publicKey}`,
			`  ${"nothing".padEnd(16)} —`,
			"[2/5] next",
			"",
			"title",
			`${"name".padEnd(4)}  ${"key".padEnd(64)}`,
			`${"a".padEnd(4)}  ${own.publicKey}`,
		];
		expect(stdout).toBe(expected.map(line).join(""));
	});

	it("notice and the JSON helpers print what they printed", async () => {
		const doc = { npub: own.npub, pubkey: own.publicKey, id: "ab".repeat(32), sig: "cd".repeat(64), n: [1, null, "x"] };
		const { stdout, stderr } = await capture(async () => {
			notice("deprecated");
			emitStdoutJson(doc);
			emitStderrJson(doc);
			setJsonMode(true);
			json(doc);
		});
		expect(stderr).toBe(`! deprecated\n${JSON.stringify(doc)}\n`);
		expect(stdout).toBe(`${JSON.stringify(doc)}\n${JSON.stringify(doc, null, 2)}\n`);
	});

	it("writeOut and writeErr add no newline of their own, as commander's own writers do not", async () => {
		const { stdout, stderr } = await capture(async () => {
			writeOut("one");
			writeOut("two\n");
			writeErr("three");
		});
		expect(stdout).toBe("onetwo\n");
		expect(stderr).toBe("three");
	});
});

describe("a key written in two separate writes", () => {
	it("is scrubbed write by write: the half that has no prefix is not a key, so it comes out. No agx code writes a key in pieces", async () => {
		// Pinned, not promised. Every message is written whole (`output-writers.test.ts` lists the only
		// places that write at all), so this is a limit of a per-write scrub, not something a command does.
		const { stdout } = await capture(async () => {
			say(NSEC.slice(0, 30));
			say(NSEC.slice(30));
		});
		const [first, second] = stdout.split("\n");
		expect(first).toBe(MARK);
		expect(second).toBe(NSEC.slice(30));
	});

	it("is scrubbed when the writes are joined into one message, which is how the CLI writes a line", async () => {
		const { stdout } = await capture(async () => say(`${NSEC.slice(0, 30)}${NSEC.slice(30)}`));
		expect(stdout).toBe(`${MARK}\n`);
	});

	it("a message with line breaks in it is one write: a key is scrubbed wherever in it it stands", async () => {
		const { stdout } = await capture(async () => say(`first\nsecond ${NSEC}\nthird`));
		expect(stdout).toBe(`first\nsecond ${MARK}\nthird\n`);
	});
});
