import kleur from "kleur";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";
import { profileDir } from "../lib/paths.js";
import { MessageStore } from "../lib/store/message-store.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

// `agx thread <id>` says "No thread" and repeats the id the caller typed. A
// caller can be a person or an agent that built the id from message text, so the
// repeated id must be shown as text: no control character, no line break, nothing
// a terminal would act on.

let box: ReturnType<typeof sandbox>;
let coloursWere: boolean;

beforeEach(() => {
	box = sandbox();
	coloursWere = kleur.enabled;
	// The "✗" prefix is coloured when colours are on, and colour codes are escape sequences too.
	kleur.enabled = false;
});

afterEach(() => {
	kleur.enabled = coloursWere;
	box.restore();
});

/** What the error looks like for an id shown as `shown`: one message line, then the hint. */
function noThread(shown: string): string {
	return `\n✗ No thread "${shown}".\n\n  List threads with: agx threads\n\n`;
}

/** Every character that a terminal could act on, other than the line break that ends a line. */
function strayControls(text: string): string[] {
	return [...text]
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return (code <= 0x1f && ch !== "\n") || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
		})
		.map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

/** [what it is, what is typed, how the id is shown back]. */
const TYPED: Array<[string, string, string]> = [
	["an escape sequence", "a\u001b[31mb", "a�[31mb"],
	["a bell and a backspace", "a\u0007\u0008b", "a��b"],
	["a null character", "a\u0000b", "a�b"],
	["a line feed", "a\nb", "a�b"],
	["a carriage return", "a\rb", "a�b"],
	["a vertical tab and a form feed", "a\u000b\u000cb", "a��b"],
	["a delete character", "a\u007fb", "a�b"],
	["a one-character control sequence introducer (U+009B)", "a\u009b31mb", "a�31mb"],
	["a next-line character (U+0085)", "a\u0085b", "a�b"],
	["a line separator (U+2028)", "a\u2028b", "a�b"],
	["a paragraph separator (U+2029)", "a\u2029b", "a�b"],
	["a second error line", 'x".\n✗ Disk full', 'x".�✗ Disk full'],
];

describe("agx thread with an id that does not exist", () => {
	it.each(TYPED)("shows %s as text, on one line", async (_name, typed, shown) => {
		const run = await agx("thread", typed);
		expect(run.code).toBe(1);
		expect(strayControls(run.stderr)).toEqual([]);
		expect(run.stderr).toBe(noThread(shown));
		expect(run.stdout).toBe("");
	});

	it.each(TYPED)("shows %s as text with --json too", async (_name, typed, shown) => {
		const run = await agx("thread", typed, "--json");
		expect(run.code).toBe(1);
		expect(strayControls(run.stderr)).toEqual([]);
		expect(run.stderr).toBe(noThread(shown));
		expect(run.stdout).toBe("");
	});

	it("prints one error line, whatever the id holds", async () => {
		const run = await agx("thread", 'x".\n✗ Disk full\n✗ Another');
		const errorLines = run.stderr.split("\n").filter((line) => line.includes("✗"));
		expect(errorLines).toHaveLength(1);
	});

	// Controls: an ordinary id is shown exactly as typed, as before.
	it("repeats an ordinary id as typed", async () => {
		const run = await agx("thread", "no-such-thread");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(noThread("no-such-thread"));
		expect(run.stdout).toBe("");
	});

	it("repeats an id with accents, other scripts and an emoji as typed", async () => {
		const typed = "café-日本語-🙂";
		const run = await agx("thread", typed);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(noThread(typed));
	});

	it("repeats a long id in full", async () => {
		const typed = "t".repeat(200);
		const run = await agx("thread", typed);
		expect(run.stderr).toBe(noThread(typed));
	});
});

describe("agx thread with an id that exists", () => {
	const PEER = createIdentity().npub;

	beforeEach(() => {
		const store = new MessageStore(profileDir("default"));
		store.addInbound({
			id: "e1",
			peer: PEER,
			subject: "Hi",
			contextId: "ctx-1",
			text: "hello there",
			at: "2026-10-07T10:00:00.000Z",
		});
		store.flush();
	});

	it("still prints the thread", async () => {
		const run = await agx("thread", "ctx-1");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain("RECV");
		expect(run.stdout).toContain("hello there");
	});

	it("still prints the thread as JSON", async () => {
		const run = await agx("thread", "ctx-1", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		const [report] = jsonDocuments(run.stdout) as Array<{ schema: string; contextId: string; messages: Array<{ text: string }> }>;
		expect(report).toMatchObject({ schema: "agx.thread/1", contextId: "ctx-1" });
		expect(report?.messages.map((m) => m.text)).toEqual(["hello there"]);
	});

	it("does not find it by an id that only looks like it once controls are removed", async () => {
		const run = await agx("thread", "ctx\u001b-1");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(noThread("ctx�-1"));
	});
});
