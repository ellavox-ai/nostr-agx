import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed. A secret key written as
// hex (the form a raw key has in a file or an env var) is not recognisable as a key by its prefix,
// so the parser's errors hide any run of 56 or more hex digits (a key one digit short is a key
// after a few guesses), and say that the line may hold a key. For "too many arguments" the usual
// words up to the colon stay and only the words that were typed are not shown. Every key here is
// made when the test runs and none is real.

let box: ReturnType<typeof sandbox>;
const HEX = createIdentity().secretKeyHex;
const OTHER_HEX = createIdentity().secretKeyHex;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
/** The whole of what is printed instead. Pinned exactly, so it cannot be edited into one that shows part of the key. */
const HIDDEN =
	"error: the command line may contain a secret key (a run of 56 or more hex digits), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";
/** What "too many arguments" prints when the words typed hold a run: commander's own text up to the colon, then one fixed phrase. */
const TOO_MANY = (command: string, expected: number, got: number): string =>
	`error: too many arguments for '${command}'. Expected ${expected} argument${expected === 1 ? "" : "s"} but got ${got}: the words may contain a secret key and are not shown.\n`;
/** A run of this many hex digits, made of the key. */
const run = (digits: number): string => (HEX + HEX).slice(0, digits);
/** The message for a key that starts with nsec1: unchanged. */
const HIDDEN_NSEC =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** Any 12-digit stretch of the run, in either case, also after %xx decoding; null if none. */
function leakedPart(shown: string, hex: string): string | null {
	const text = shown.toLowerCase();
	const decoded = text.replace(/%([0-9a-f]{2})/g, (_all, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)));
	for (let i = 0; i + 12 <= hex.length; i += 4) {
		const part = hex.slice(i, i + 12);
		if (text.includes(part) || decoded.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("a run of hex digits on a command line the parser rejects", () => {
	it.each([
		["an option written --name=<hex> (the case that was echoed whole)", [`--authkey=${HEX}`]],
		["an option written --name=<hex> of a subcommand", ["send", `--nope=${HEX}`, "someone", "hello"]],
		["an unknown command", [HEX]],
		["an unknown command, in capitals", [HEX.toUpperCase()]],
		["an unknown subcommand", ["identity", HEX]],
		["an unknown option made of the digits", [`--${HEX}`]],
		["a choice option given the digits", ["register", "--slug", "demo", "--visibility", HEX]],
		["a run stuck to other text", [`key${HEX}more`]],
		["a run longer than 64 digits", [`${HEX}${HEX}`]],
		["the run written as %xx escapes", [[...HEX].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")]],
		["a line break before the run", [`first\n${HEX}`]],
		["a line break before the run, in a subcommand", ["identity", `x\n${HEX}`]],
		["a run of 56 digits", [run(56)]],
		["a run of 63 digits (a key without its last digit)", [run(63)]],
		["a run of 65 digits", [run(65)]],
		["a run of 128 digits", [run(128)]],
		["a run of 56 digits in an option", [`--authkey=${run(56)}`]],
		["a run of 63 digits as an unknown subcommand", ["identity", run(63)]],
	])("%s: says it may be a key and prints none of it", async (_name, args) => {
		const result = await agx(...args);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(HIDDEN);
		for (const out of [result.stdout, result.stderr]) {
			expect(out).not.toContain(HEX);
			expect(leakedPart(out, HEX)).toBeNull();
			expect(leakedPart(out, OTHER_HEX)).toBeNull();
		}
	});

	it.each([
		["a run among the extra words", ["send", HEX, "hello", "world"], TOO_MANY("send", 2, 3)],
		["a run among the extra words, in capitals", ["send", HEX.toUpperCase(), "hello", "world"], TOO_MANY("send", 2, 3)],
		["a run in the last word", ["send", "someone", "hello", HEX], TOO_MANY("send", 2, 3)],
		["--json mode", ["--json", "send", HEX, "hello", "world"], TOO_MANY("send", 2, 3)],
		["two runs on one line", ["send", HEX, "hello", OTHER_HEX], TOO_MANY("send", 2, 3)],
		["a command that takes one argument", ["thread", HEX, "extra"], TOO_MANY("thread", 1, 2)],
		["a command that takes one argument, given two runs", ["card", HEX, OTHER_HEX], TOO_MANY("card", 1, 2)],
		["a command that takes none", ["identity", "show", HEX], TOO_MANY("show", 0, 1)],
		["a run of 56 digits", ["send", run(56), "hello", "world"], TOO_MANY("send", 2, 3)],
		["a run of 63 digits", ["send", run(63), "hello", "world"], TOO_MANY("send", 2, 3)],
		["a line break before the run", ["send", `a\n${HEX}`, "hello", "world"], TOO_MANY("send", 2, 3)],
		["the run written as %xx escapes", ["send", [...HEX].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join(""), "hello", "world"], TOO_MANY("send", 2, 3)],
	])("too many arguments, %s: keeps the usual words up to the colon and does not show the words typed", async (_name, args, expected) => {
		const result = await agx(...args);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(expected);
		expect(leakedPart(result.stderr, HEX)).toBeNull();
		expect(leakedPart(result.stderr, OTHER_HEX)).toBeNull();
	});

	it("keeps the message for a key that starts with nsec1 as it was, and uses it when both are on the line", async () => {
		expect((await agx("send", NSEC, "hello", "world")).stderr).toBe(HIDDEN_NSEC);
		expect((await agx("send", NSEC, HEX, "hello", "world")).stderr).toBe(HIDDEN_NSEC);
	});

	it("does not hide an option written --name=<value> that holds no key: the usual help stays", async () => {
		const run = await agx("--authkey=abc123");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--authkey=abc123'\n");
	});
});

describe("every other parser error is unchanged", () => {
	it.each([
		["a typo in a command", ["sned"], ["unknown command 'sned'", "Did you mean send?"]],
		["a typo in an option", ["send", "--subjct", "x", "npub1abc", "hello"], ["unknown option '--subjct'", "Did you mean --subject?"]],
		["too many arguments", ["send", "npub1abc", "hello", "world"], ["too many arguments for 'send'", "npub1abc, hello, world"]],
		["a run of 55 digits", ["send", run(55), "hello", "world"], ["too many arguments for 'send'", run(55)]],
		["a run of 40 digits (a commit id)", ["send", HEX.slice(0, 40), "hello", "world"], ["too many arguments for 'send'", HEX.slice(0, 40)]],
		["a choice option with a wrong word", ["register", "--slug", "demo", "--visibility", "everyone"], ["argument 'everyone' is invalid", "Allowed choices are"]],
	])("%s", async (_name, args, expected) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		for (const part of expected) {
			expect(run.stderr).toContain(part);
		}
		expect(run.stderr).not.toContain("secret key");
	});

	// What the base build printed, byte for byte, for twenty mistakes that hold no key: the help
	// that names the command or option the person probably meant ("Did you mean ...?") stays.
	it.each([
		[["sned"], "error: unknown command 'sned'\n(Did you mean send?)\n"],
		[["identiy"], "error: unknown command 'identiy'\n(Did you mean identity?)\n"],
		[["idnetity"], "error: unknown command 'idnetity'\n(Did you mean identity?)\n"],
		[["cofig"], "error: unknown command 'cofig'\n(Did you mean config?)\n"],
		[["serch"], "error: unknown command 'serch'\n(Did you mean search?)\n"],
		[["regster"], "error: unknown command 'regster'\n(Did you mean register?)\n"],
		[["listing", "creat"], "error: unknown command 'creat'\n(Did you mean create?)\n"],
		[["identity", "nwe"], "error: unknown command 'nwe'\n(Did you mean new?)\n"],
		[["config", "shwo"], "error: unknown command 'shwo'\n(Did you mean show?)\n"],
		[["peers", "lst"], "error: unknown command 'lst'\n(Did you mean list?)\n"],
		[["gateway", "kay"], "error: too many arguments for 'gateway'. Expected 0 arguments but got 1: kay.\n"],
		[["held", "alow"], "error: unknown command 'alow'\n(Did you mean allow?)\n"],
		[["inbx"], "error: unknown command 'inbx'\n(Did you mean inbox?)\n"],
		[["wiat"], "error: unknown command 'wiat'\n(Did you mean wait?)\n"],
		[["card", "--relya"], "error: unknown option '--relya'\n(Did you mean --relay?)\n"],
		[["send", "--subjct", "x"], "error: unknown option '--subjct'\n(Did you mean --subject?)\n"],
		[["register", "--slg", "x"], "error: required option '--slug <slug>' not specified\n"],
		[["serve", "--alow", "x"], "error: unknown option '--alow'\n(Did you mean --allow?)\n"],
		[["tailscale", "enabel"], "error: unknown command 'enabel'\n(Did you mean enable?)\n"],
		[["domain", "ad"], "error: unknown command 'ad'\n(Did you mean add?)\n"],
	] as Array<[string[], string]>)("a typo, `agx %j`, prints exactly what it printed before", async (args, expected) => {
		const result = await agx(...args);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(expected);
	});

	it("prints the usual help for --help and the version for --version", async () => {
		expect((await agx("--help")).stdout).toContain("Usage: agx");
		expect((await agx("--version")).stdout).toMatch(/^\d+\.\d+\.\d+/);
	});
});
