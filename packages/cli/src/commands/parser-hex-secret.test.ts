import { bytesToHex, publicKeyFromSecret } from "@nostr-agx/nostr";
import type { Command } from "commander";
import { generateSecretKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import { type CliRun, agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed. A
// hex SECRET key typed where a command name or an option name belongs
// (`agx <hex>`, `agx --<hex>`, `agx identity <hex>` after forgetting `import`)
// came back in full in `unknown command '…'` / `unknown option '…'`.
//
// A run of 56 or more hex digits counts as a key (a 63-digit paste, a 65-digit
// one and a doubled key too); a 40-digit commit id or a 55-digit run does not.
//
// This pins only that narrow case. Whether agx should hide ANY long hex string
// (a hex public key is legitimate in other errors) is an open question
// (issue #57), so every error that is not an unknown-command / unknown-option
// error quoting such a run (or, for `gateway` only, a "too many arguments"
// error quoting one) must stay as it was.
//
// Assertions compare small summaries, never the printed text itself, so a
// failing run cannot dump a key into a log.

let box: ReturnType<typeof sandbox>;
const SECRET = bytesToHex(generateSecretKey());
/** A hex PUBLIC key: legitimate in parser errors, must stay visible. */
const PEER = publicKeyFromSecret(generateSecretKey());
const NSEC = nip19.nsecEncode(generateSecretKey());

/** The whole of what is printed instead: pinned exactly, so the message cannot be edited into one that shows part of the key. */
const REPLACED_HEX =
	"error: a long hex string that may be a secret key sits where a command or option name belongs, so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";
/** The text PR #53 prints for an nsec1… key: unchanged. */
const REPLACED_NSEC =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** True when any 10-character stretch of `key` (in any case) is in `shown`. */
function leaks(shown: string, key: string): boolean {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = 0; i + 10 <= secret.length; i++) {
		if (text.includes(secret.slice(i, i + 10))) {
			return true;
		}
	}
	return false;
}

/** What a run printed, without the printed text: safe to show in a failing assertion. */
function summarize(run: CliRun, key: string, replacement: string) {
	return {
		code: run.code,
		stdout: run.stdout === "" ? "" : "(something was printed)",
		stderr: run.stderr === replacement ? "(the fixed replacement)" : "(something else)",
		leaked: leaks(run.stdout + run.stderr, key),
	};
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

const MISPLACED: Array<[string, (hex: string) => string[]]> = [
	["agx <hex>", (hex) => [hex]],
	["agx --<hex>", (hex) => [`--${hex}`]],
	["agx identity <hex> (forgot import)", (hex) => ["identity", hex]],
	["agx identity --<hex> import", (hex) => ["identity", `--${hex}`, "import"]],
	["agx --<hex> identity import", (hex) => [`--${hex}`, "identity", "import"]],
	["agx --<hex>=value", (hex) => [`--${hex}=value`]],
	["agx --secret=<hex>", (hex) => [`--secret=${hex}`]],
	["agx -<hex>", (hex) => [`-${hex}`]],
	["agx identity --<hex>", (hex) => ["identity", `--${hex}`]],
	["agx send --<hex> someone hello", (hex) => ["send", `--${hex}`, "someone", "hello"]],
	["agx gateway key <hex>", (hex) => ["gateway", "key", hex]],
	["agx gateway --<hex>", (hex) => ["gateway", `--${hex}`]],
	["a quote before the key", (hex) => [`it's${hex}`]],
	["a line break before the key", (hex) => [`a\n${hex}`]],
	["the key inside a longer word", (hex) => [`key-${hex}-copy`]],
	["a key twice as long", (hex) => [`${hex}${hex}`]],
];

/**
 * `gateway` is the one command with its own action AND subcommands, so a mistyped
 * subcommand word is not "unknown command": Commander reports it as "too many
 * arguments for 'gateway'. Expected 0 arguments but got 1: <what was typed>."
 */
const GATEWAY_EXCESS: Array<[string, (hex: string) => string[]]> = [
	["agx gateway <hex>", (hex) => ["gateway", hex]],
	["agx gateway --port 1 <hex>", (hex) => ["gateway", "--port", "1", hex]],
	["agx gateway <hex> --port 1", (hex) => ["gateway", hex, "--port", "1"]],
	["agx gateway foo <hex>", (hex) => ["gateway", "foo", hex]],
	["agx gateway <hex> foo", (hex) => ["gateway", hex, "foo"]],
];

/** Every case, in lower and UPPER case, in text and --json mode: says why and prints none of it. */
function leakMatrix(cases: Array<[string, (hex: string) => string[]]>) {
	describe.each([
		["lower case", SECRET],
		["UPPER CASE", SECRET.toUpperCase()],
	])("%s", (_label, hex) => {
		describe.each([
			["text", [] as string[]],
			["--json", ["--json"]],
		])("%s", (_mode, flags) => {
			it.each(cases)("%s: says why and prints none of it", async (_name, make) => {
				const run = await agx(...flags, ...make(hex));
				expect(summarize(run, SECRET, REPLACED_HEX)).toEqual({
					code: 1,
					stdout: "",
					stderr: "(the fixed replacement)",
					leaked: false,
				});
			});
		});
	});
}

describe("a hex secret key typed as a command or option name", () => {
	leakMatrix(MISPLACED);
});

describe("a hex secret key typed after `gateway` (a command with its own action and subcommands)", () => {
	leakMatrix(GATEWAY_EXCESS);

	it("keeps the normal 'too many arguments' error for a word that is not a key", async () => {
		const run = await agx("gateway", "foo");
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe("error: too many arguments for 'gateway'. Expected 0 arguments but got 1: foo.\n");
	});

	it("leaves `gateway key new <hex>` as it was: a zero-argument subcommand is left for issue #57", async () => {
		const run = await agx("gateway", "key", "new", SECRET);
		const was = `error: too many arguments for 'new'. Expected 0 arguments but got 1: ${SECRET}.\n`;
		expect({
			code: run.code,
			stdout: run.stdout,
			stderr: run.stderr === was ? "(unchanged, shows the typed word)" : "(something else)",
		}).toEqual({ code: 1, stdout: "", stderr: "(unchanged, shows the typed word)" });
	});
});

/** The path of every command that has at least one subcommand (the root is `[]`). */
function commandsWithSubcommands(command: Command, path: string[] = []): string[][] {
	const found = command.commands.length > 0 ? [path] : [];
	for (const sub of command.commands) {
		found.push(...commandsWithSubcommands(sub, [...path, sub.name()]));
	}
	return found;
}

describe("every command that has subcommands", () => {
	const paths = commandsWithSubcommands(buildProgram());

	it("includes the ones this test exists for", () => {
		const names = paths.map((path) => path.join(" "));
		expect(names).toEqual(expect.arrayContaining(["", "identity", "gateway", "gateway key"]));
		expect(paths.length).toBeGreaterThanOrEqual(8);
	});

	// A future command with its own action AND subcommands reports a mistyped
	// subcommand as "too many arguments" and would quote the key: this walk fails then.
	describe.each([
		["lower case", SECRET],
		["UPPER CASE", SECRET.toUpperCase()],
	])("%s", (_label, hex) => {
		it.each(paths.map((path) => [path.join(" ") || "(the root)", path] as const))(
			"`agx %s <hex>` prints no part of the key",
			async (_name, path) => {
				const run = await agx(...path, hex);
				expect({ leaked: leaks(run.stdout + run.stderr, SECRET) }).toEqual({ leaked: false });
			},
		);
	});
});

/** `count` hex digits (up to 128) of the throwaway key, repeated if need be. */
function digitsOf(key: string, count: number): string {
	return `${key}${key}`.slice(0, count);
}

const LENGTH_FORMS: Array<[string, (digits: string) => string[]]> = [
	["agx <digits>", (digits) => [digits]],
	["agx --<digits>", (digits) => [`--${digits}`]],
	["agx gateway <digits>", (digits) => ["gateway", digits]],
];

describe("how long a hex run has to be to count as a key", () => {
	describe.each([56, 63, 64, 65, 128])("%i hex digits are hidden", (count) => {
		describe.each([
			["lower case", SECRET],
			["UPPER CASE", SECRET.toUpperCase()],
		])("%s", (_label, hex) => {
			it.each(LENGTH_FORMS)("%s: says why and prints none of it", async (_name, make) => {
				const run = await agx(...make(digitsOf(hex, count)));
				expect(summarize(run, SECRET, REPLACED_HEX)).toEqual({
					code: 1,
					stdout: "",
					stderr: "(the fixed replacement)",
					leaked: false,
				});
			});
		});
	});

	// Public-key digits: a run this short is not taken for a key, so the error shows it.
	describe.each([40, 55])("%i hex digits stay visible", (count) => {
		it("an unknown command", async () => {
			const word = digitsOf(PEER, count);
			const run = await agx(word);
			expect(run.code).toBe(1);
			expect(run.stderr).toBe(`error: unknown command '${word}'\n`);
		});

		it("an unknown option", async () => {
			const word = `--${digitsOf(PEER, count)}`;
			const run = await agx(word);
			expect(run.code).toBe(1);
			expect(run.stderr).toBe(`error: unknown option '${word}'\n`);
		});

		it("a word after `gateway`", async () => {
			const word = digitsOf(PEER, count);
			const run = await agx("gateway", word);
			expect(run.code).toBe(1);
			expect(run.stderr).toBe(
				`error: too many arguments for 'gateway'. Expected 0 arguments but got 1: ${word}.\n`,
			);
		});
	});
});

describe("every other parser error is unchanged", () => {
	it("still shows a hex public key in 'too many arguments' (peer plus an unquoted message)", async () => {
		const run = await agx("send", PEER, "hello", "world");
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			`error: too many arguments for 'send'. Expected 2 arguments but got 3: ${PEER}, hello, world.\n`,
		);
	});

	it("still shows a hex public key in 'too many arguments' of an identity subcommand, in --json mode too", async () => {
		const run = await agx("--json", "identity", "show", PEER);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			`error: too many arguments for 'show'. Expected 0 arguments but got 1: ${PEER}.\n`,
		);
	});

	it("does not replace 'too many arguments' because an argument looks like an unknown-command error", async () => {
		const run = await agx("send", "error: unknown command '", PEER, "extra");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(
			`error: too many arguments for 'send'. Expected 2 arguments but got 3: error: unknown command ', ${PEER}, extra.\n`,
		);
	});

	it("still names an unknown option of send, next to a hex public key", async () => {
		const run = await agx("send", PEER, "hello", "--bogus");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--bogus'\n");
	});

	it("still names a missing argument of identity deny", async () => {
		const run = await agx("identity", "deny");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: missing required argument 'peers'\n");
	});

	it("leaves identity allow <pubkey> <word> to its own error (not a parser error)", async () => {
		const run = await agx("identity", "allow", PEER, "extra");
		expect(run.code).toBe(2);
		expect(run.stderr).toContain('"extra" is not a valid peer');
	});

	it("still suggests the nearest command for a mistyped command", async () => {
		const run = await agx("sned");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown command 'sned'\n(Did you mean send?)\n");
	});

	it("still suggests the nearest subcommand of identity", async () => {
		const run = await agx("identity", "nwe");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown command 'nwe'\n(Did you mean new?)\n");
	});

	it("still names an unknown long option and suggests the nearest one", async () => {
		const run = await agx("--jsno");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--jsno'\n(Did you mean --json?)\n");
	});

	it("still names an unknown short option", async () => {
		const run = await agx("-x");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '-x'\n");
	});

	it("still names an unknown command that is hex but shorter than a key (a commit id)", async () => {
		const commit = PEER.slice(0, 40);
		const run = await agx(commit);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(`error: unknown command '${commit}'\n`);
	});

	it("still names a 64-character unknown command that is not hex", async () => {
		const word = "g".repeat(64);
		const run = await agx(word);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(`error: unknown command '${word}'\n`);
	});

	it("keeps the nsec1 text for an nsec1 key, also next to a hex key", async () => {
		for (const args of [[NSEC], [`${NSEC}${SECRET}`], [`--${SECRET}${NSEC}`]]) {
			const run = await agx(...args);
			expect(summarize(run, SECRET, REPLACED_NSEC)).toEqual({
				code: 1,
				stdout: "",
				stderr: "(the fixed replacement)",
				leaked: false,
			});
		}
	});

	it("still prints the help and exits 0", async () => {
		const run = await agx("--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Usage: agx");
		expect(run.stderr).toBe("");
	});

	it("still prints the version and exits 0", async () => {
		const run = await agx("--version");
		expect(run.code).toBe(0);
		expect(run.stdout).toMatch(/^\d+\.\d+\.\d+/);
		expect(run.stderr).toBe("");
	});
});
