import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "./identity.js";
import { REDACTED, scrubbedJson, scrubOutput } from "./scrub.js";
import { redactSecrets, rememberSecret } from "./secrets.js";

// The last net before output: every line the CLI prints and every body the gateway sends goes
// through `scrubOutput` (text) or `scrubbedJson` (a JSON document) first. A secret key shape is
// replaced by one fixed marker; so is any value `redactSecrets` already knows (the profile's own
// key after its file is read). Nothing else changes: a public key, an event id and a signature
// are 64 hex digits too, and come out exactly as they went in.
//
// Every key here is made when the test runs, from a throwaway key.

let box: ReturnType<typeof sandbox>;
const stranger = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(stranger.secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(stranger.secretKeyHex), "throwaway-password", 4);

function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("scrubOutput", () => {
	it("the marker is the one redactSecrets already prints", () => {
		expect(REDACTED).toBe("[redacted]");
		rememberSecret("throwaway-value-b105");
		expect(redactSecrets("a throwaway-value-b105 b")).toBe(`a ${REDACTED} b`);
		expect(scrubOutput("a throwaway-value-b105 b")).toBe(`a ${REDACTED} b`);
	});

	it.each([
		["an nsec1…", NSEC, REDACTED],
		["an nsec1… in capitals", NSEC.toUpperCase(), REDACTED],
		["an nsec1… behind nostr:", `nostr:${NSEC}`, `nostr:${REDACTED}`],
		["an ncryptsec1…", NCRYPTSEC, REDACTED],
		["an nsec1… written as %xx escapes", escapeAll(NSEC), REDACTED],
		["an nsec1… in a sentence", `my key is ${NSEC} and please keep it safe`, `my key is ${REDACTED} and please keep it safe`],
		["an error line that quotes one", `✗ --port must be a port number, not "${NSEC}".`, `✗ --port must be a port number, not "${REDACTED}".`],
		["a table row", `  profile          ${NSEC}  acme`, `  profile          ${REDACTED}  acme`],
	])("replaces %s", (_name, text, expected) => {
		expect(scrubOutput(text)).toBe(expected);
	});

	it("is idempotent", () => {
		for (const text of [NSEC, `a ${NCRYPTSEC} b`, escapeAll(NSEC), `nostr:${NSEC.toUpperCase()}`]) {
			expect(scrubOutput(scrubOutput(text))).toBe(scrubOutput(text));
		}
	});

	it("does not throw for one run of 6 million key characters", () => {
		const out = scrubOutput(`nsec1${"q".repeat(6_000_000)}`);
		expect(out).not.toMatch(/n(crypt)?sec1[0-9a-z]{5}/i);
	});

	describe("the profile's own key, once its identity file has been read", () => {
		it("is replaced in every form agx can print it, in both cases", () => {
			const own = createIdentity();
			saveIdentity("default", own);
			// Not known yet: nothing has read the identity file in this process.
			expect(scrubOutput(`own ${own.secretKeyHex}`)).toBe(`own ${own.secretKeyHex}`);
			loadIdentityFile("default");
			const nsec = nip19.nsecEncode(hexToBytes(own.secretKeyHex));
			const npubOfSecret = nip19.npubEncode(own.secretKeyHex);
			for (const form of [own.secretKeyHex, own.secretKeyHex.toUpperCase(), nsec, nsec.toUpperCase(), npubOfSecret]) {
				expect(scrubOutput(`own ${form} end`)).toBe(`own ${REDACTED} end`);
			}
			expect(scrubOutput(JSON.stringify({ profile: own.secretKeyHex }))).toBe(`{"profile":"${REDACTED}"}`);
		});

		it("leaves every other 64-hex run alone: the profile's own public key, an event id, a signature", () => {
			const own = createIdentity();
			saveIdentity("default", own);
			loadIdentityFile("default");
			const text = [own.publicKey, own.npub, "ab".repeat(32), "cd".repeat(64), stranger.publicKey, stranger.secretKeyHex].join("\n");
			expect(scrubOutput(text)).toBe(text);
		});
	});

	describe("text that holds no key comes out exactly as it went in", () => {
		const own = createIdentity();
		it.each([
			["nothing", ""],
			["a profile summary", `  npub             ${own.npub}\n  pubkey           ${own.publicKey}\n  file             /home/me/.agx/profiles/default/identity.json`],
			["an inbound line", `RECV  from ${own.npub.slice(0, 12)}…${own.npub.slice(-4)}  subject "hello"\n       it works`],
			["an error with a hint", "✗ No relays are set.\n\n  agx config set relays ws://127.0.0.1:7447"],
			["a parser error with a suggestion", "error: unknown command 'idnetity'\n(Did you mean identity?)\n"],
			["help that names the key shape", "import an nsec1… or 64-char hex secret key\nagx identity import nsec1…    (or pipe it: echo nsec1… | agx identity import --stdin)"],
			["a url and a token that is not a key", "https://app.ellaworks.ai/device?code=ABCD-EFGH and agxg_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
			["an event as JSON", JSON.stringify({ id: "ab".repeat(32), pubkey: own.publicKey, sig: "cd".repeat(64), kind: 1, tags: [["p", own.publicKey]] }, null, 2)],
			["colour codes", "\u001b[32m✓\u001b[39m done \u001b[1m\u001b[2mwhat\u001b[22m"],
		])("%s", (_name, text) => {
			expect(scrubOutput(text)).toBe(text);
		});
	});
});

describe("scrubbedJson", () => {
	it.each([
		["an object", { npub: stranger.npub, pubkey: stranger.publicKey, createdAt: "2026-11-27T10:00:00.000Z" }],
		["nested values", { a: [1, 2.5, null, true, { b: "text", c: [] }], d: {} }],
		["unicode", { name: "café — ✓ 😀", sep: "a\u2028b\u2029c", ctl: "\u0007\u001b[31m" }],
		["a date", { at: new Date(0) }],
		["a string", "just text"],
		["a number", 42],
		["null", null],
		["an event", { id: "ab".repeat(32), sig: "cd".repeat(64), content: "100% sure: %20 %zz" }],
	])("writes %s exactly as JSON.stringify does", (_name, value) => {
		expect(scrubbedJson(value)).toBe(JSON.stringify(value));
		expect(scrubbedJson(value, 2)).toBe(JSON.stringify(value, null, 2));
	});

	it("answers undefined for undefined, as JSON.stringify does", () => {
		expect(scrubbedJson(undefined)).toBeUndefined();
	});

	it("replaces a key in a value, deep in the document, and the document stays valid", () => {
		const value = { error: { code: "bad", message: `not "${NSEC}"` }, list: [`x ${NCRYPTSEC} y`, escapeAll(NSEC), { deeper: `nostr:${NSEC.toUpperCase()}` }], keep: stranger.publicKey };
		const text = scrubbedJson(value, 2);
		expect(JSON.parse(text)).toEqual({
			error: { code: "bad", message: `not "${REDACTED}"` },
			list: [`x ${REDACTED} y`, REDACTED, { deeper: `nostr:${REDACTED}` }],
			keep: stranger.publicKey,
		});
	});

	it("replaces a key used as a name", () => {
		const text = scrubbedJson({ [NSEC]: 1, ok: 2, nested: { [`nostr:${NSEC}`]: [3] } });
		expect(JSON.parse(text)).toEqual({ [REDACTED]: 1, ok: 2, nested: { [`nostr:${REDACTED}`]: [3] } });
		expect(text).not.toContain(NSEC.slice(5, 25));
	});

	it("keeps a name that is __proto__ as an ordinary name when another name of the same object holds a key", () => {
		// JSON.parse makes `__proto__` an own name; an object built the usual way would turn it into a prototype and lose it.
		const value = JSON.parse(`{"__proto__":{"a":1},"${NSEC}":2}`);
		expect(scrubbedJson(value)).toBe(`{"__proto__":{"a":1},"${REDACTED}":2}`);
	});

	it("replaces the profile's own key, once read", () => {
		const own = createIdentity();
		saveIdentity("default", own);
		loadIdentityFile("default");
		expect(JSON.parse(scrubbedJson({ profile: own.secretKeyHex, [own.secretKeyHex]: 1 }))).toEqual({ profile: REDACTED, [REDACTED]: 1 });
	});

	it("keeps the JSON valid when a value holds a line feed followed by `sec1…`, which a text scrub would break", () => {
		// Written as JSON, a line feed is a backslash and an `n`: the `n` would start a match and leave a lone backslash.
		const value = { text: "first line\nsec1abcdefghijklmnop" };
		const asText = JSON.stringify(value);
		expect(() => JSON.parse(scrubOutput(asText))).toThrow();
		expect(JSON.parse(scrubbedJson(value))).toEqual(value);
	});

	it("does not throw for a value with one run of 6 million key characters", () => {
		const text = scrubbedJson({ text: `nsec1${"q".repeat(6_000_000)}` }) as string;
		expect(JSON.parse(text)).toEqual({ text: REDACTED });
	});
});

/** `levels` objects inside one another, each holding the one name `name`, with `leaf` at the bottom. Built from the inside out, so building it takes no stack. */
function nested(levels: number, name: string, leaf: unknown): unknown {
	let doc = leaf;
	for (let i = 0; i < levels; i++) {
		doc = { [name]: doc };
	}
	return doc;
}

/** Walks a parsed `nested` document from the outside in, one level at a time (no recursion): how deep it is, every name met, and what is at the bottom. */
function descend(doc: unknown): { levels: number; names: Set<string>; leaf: unknown } {
	const names = new Set<string>();
	let levels = 0;
	let node = doc;
	while (typeof node === "object" && node !== null && !Array.isArray(node)) {
		const own = Object.keys(node);
		if (own.length !== 1) {
			break;
		}
		names.add(own[0] as string);
		node = (node as Record<string, unknown>)[own[0] as string];
		levels++;
	}
	return { levels, names, leaf: node };
}

// A document 3000 levels deep is about 18 KB, which `JSON.stringify` writes without trouble. The
// scrub must write it too: a peer controls the answer to its own task, and the gateway sends that
// answer through `sendJson`.
describe("scrubbedJson on a very deep document", () => {
	const DEEP = 3000;

	it("replaces a key used as a name at every level, and the document stays valid and as deep", () => {
		const text = scrubbedJson(nested(DEEP, NSEC, "end")) as string;
		const { levels, names, leaf } = descend(JSON.parse(text));
		expect(levels).toBe(DEEP);
		expect([...names]).toEqual([REDACTED]);
		expect(leaf).toBe("end");
		expect(text).not.toContain(NSEC.slice(5, 25));
	});

	it("does the same when the text is indented", () => {
		const text = scrubbedJson(nested(DEEP, NCRYPTSEC, "end"), 2) as string;
		const { levels, names, leaf } = descend(JSON.parse(text));
		expect(levels).toBe(DEEP);
		expect([...names]).toEqual([REDACTED]);
		expect(leaf).toBe("end");
		expect(text).not.toContain(NCRYPTSEC.slice(10, 30));
		expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
	});

	it("replaces a key used as the value at the bottom, behind ordinary names", () => {
		const text = scrubbedJson(nested(DEEP, "a", `x ${NSEC} y`)) as string;
		const { levels, leaf } = descend(JSON.parse(text));
		expect(levels).toBe(DEEP);
		expect(leaf).toBe(`x ${REDACTED} y`);
	});

	it("keeps a line feed followed by `sec1…` at the bottom as it was, which a text scrub of the written JSON would break", () => {
		const value = "first line\nsec1abcdefghijklmnop";
		const { levels, names, leaf } = descend(JSON.parse(scrubbedJson(nested(DEEP, NSEC, value)) as string));
		expect(levels).toBe(DEEP);
		expect([...names]).toEqual([REDACTED]);
		expect(leaf).toBe(value);
	});

	it("keeps an escaped backslash before a key as it was, and replaces only the key", () => {
		const { leaf } = descend(JSON.parse(scrubbedJson(nested(DEEP, NSEC, `back${String.fromCharCode(92)}${NSEC}`)) as string));
		expect(leaf).toBe(`back${String.fromCharCode(92)}${REDACTED}`);
	});

	it("writes two names that are keys in one object as two entries, which JSON.parse reads as one", () => {
		// The walk of a shallow document merges names that scrub to the same text (the later one wins);
		// the text scrub of a deep one cannot, and leaves both in the text.
		const text = scrubbedJson(nested(DEEP, NSEC, { [NSEC]: 1, [NCRYPTSEC]: 2 })) as string;
		expect(text.split(`"${REDACTED}":`).length - 1).toBe(DEEP + 2);
		expect(text).not.toContain(NSEC.slice(5, 25));
		expect(text).not.toContain(NCRYPTSEC.slice(10, 30));
		expect(descend(JSON.parse(text))).toMatchObject({ levels: DEEP + 1, leaf: 2 });
	});

	it("writes a deep document with no key in it exactly as JSON.stringify does", () => {
		// How deep `JSON.stringify` itself can go depends on the machine's stack: 5000 levels is already too deep
		// on the Linux runners, so this uses the same depth as the other cases here.
		const doc = nested(DEEP, "a", { text: "plain", list: [1, 2, null] });
		expect(scrubbedJson(doc)).toBe(JSON.stringify(doc));
		expect(scrubbedJson(doc, 2)).toBe(JSON.stringify(doc, null, 2));
	});

	it.each([
		["with ordinary names", "a"],
		["with names that are keys", NSEC],
	])("fails as JSON.stringify fails on a document too deep for it to write, %s", (_name, name) => {
		const doc = nested(20_000, name, 1);
		expect(() => JSON.stringify(doc)).toThrow(RangeError);
		expect(() => scrubbedJson(doc)).toThrow(RangeError);
	});

	it("fails as JSON.stringify fails on a circular document, also when a name in it is a key", () => {
		const circular: Record<string, unknown> = { [NSEC]: 1 };
		circular.again = circular;
		expect(() => JSON.stringify(circular)).toThrow(TypeError);
		expect(() => scrubbedJson(circular)).toThrow(TypeError);
	});
});
