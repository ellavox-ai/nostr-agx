import kleur from "kleur";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayKey, listGatewayKeys } from "../lib/gateway/keys.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx gateway key revoke <id>` says "No gateway API key with id <id>" and repeats
// the id the caller typed. As with `agx thread`, the repeated id must be shown as
// text: no control character, no line break, nothing a terminal would act on.

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
function noKey(shown: string): string {
	return `\n✗ No gateway API key with id ${shown}.\n\n  List them with \`agx gateway key list\`.\n\n`;
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
	["a line feed", "a\nb", "a�b"],
	["a carriage return", "a\rb", "a�b"],
	["a one-character control sequence introducer (U+009B)", "a\u009b31mb", "a�31mb"],
	["a line separator (U+2028)", "a\u2028b", "a�b"],
	["a second error line", "x.\n✗ Disk full", "x.�✗ Disk full"],
];

describe("agx gateway key revoke with an id that does not exist", () => {
	it.each(TYPED)("shows %s as text, on one line", async (_name, typed, shown) => {
		const run = await agx("gateway", "key", "revoke", typed);
		expect(run.code).toBe(2);
		expect(strayControls(run.stderr)).toEqual([]);
		expect(run.stderr).toBe(noKey(shown));
		expect(run.stdout).toBe("");
	});

	it.each(TYPED)("shows %s as text with --json too", async (_name, typed, shown) => {
		const run = await agx("gateway", "key", "revoke", typed, "--json");
		expect(run.code).toBe(2);
		expect(strayControls(run.stderr)).toEqual([]);
		expect(run.stderr).toBe(noKey(shown));
		expect(run.stdout).toBe("");
	});

	// Controls: an ordinary id is shown exactly as typed, as before.
	it("repeats an ordinary id as typed", async () => {
		const run = await agx("gateway", "key", "revoke", "deadbeef");
		expect(run.code).toBe(2);
		expect(run.stderr).toBe(noKey("deadbeef"));
		expect(run.stdout).toBe("");
	});

	it("repeats an id with accents, other scripts and an emoji as typed", async () => {
		const typed = "café-日本語-🙂";
		const run = await agx("gateway", "key", "revoke", typed);
		expect(run.code).toBe(2);
		expect(run.stderr).toBe(noKey(typed));
	});
});

describe("agx gateway key revoke with an id that exists", () => {
	it("still revokes the key", async () => {
		const { id } = createGatewayKey("default", "short-lived");
		const run = await agx("gateway", "key", "revoke", id);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(listGatewayKeys("default")).toEqual([]);
	});
});
