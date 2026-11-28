import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed
// (`too many arguments for 'import' …: <all args>`, `unknown option '--<arg>'`).
// Anywhere else a 64-hex string is indistinguishable from a public key, so the
// parser cannot tell it from one; but the argument of `agx identity import` can
// only ever be a secret. Whatever its format (nsec1…, ncryptsec1…, hex, any
// text), no parser error of that command may show its arguments.

let box: ReturnType<typeof sandbox>;
const HEX = createIdentity().secretKeyHex;
const OTHER_HEX = createIdentity().secretKeyHex;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
const TEXT = "correct-horse-battery-staple-1234";
/** The whole of what is printed instead: pinned exactly, so it cannot be edited into one that shows part of an argument. */
const REPLACED =
	"error: `agx identity import` could not read its arguments, so they are not shown (they may hold a secret key). Usage: agx identity import --stdin [--force] or agx identity import --from-env <name> [--force]; see `agx identity import --help`.\n";

/** The first 10-character stretch of `key` found in `shown`, in any case, starting `from` characters in (past a constant prefix); null if none. */
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

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("a parser error of identity import", () => {
	it.each([
		["too many arguments: a hex key and a word", ["identity", "import", HEX, "extra"]],
		["too many arguments: a hex key in capitals and a word", ["identity", "import", HEX.toUpperCase(), "extra"]],
		["too many arguments: a word and a hex key", ["identity", "import", "extra", HEX]],
		["too many arguments: two hex keys", ["identity", "import", HEX, OTHER_HEX]],
		["too many arguments: an nsec1… and a word", ["identity", "import", NSEC, "extra"]],
		["too many arguments: an ncryptsec1… and a word", ["identity", "import", NCRYPTSEC, "extra"]],
		["too many arguments: any other text and a word", ["identity", "import", TEXT, "extra"]],
		["too many arguments: a profile named before the command", ["-p", "other", "identity", "import", HEX, "extra"]],
		["too many arguments: a profile named after it", ["identity", "import", "-p", "other", HEX, "extra"]],
		["too many arguments: a flag after them", ["identity", "import", HEX, "extra", "--force"]],
		["too many arguments: --json mode", ["--json", "identity", "import", HEX, "extra"]],
		["an unknown option after the key", ["identity", "import", HEX, "--bogus"]],
		["an unknown option and no key", ["identity", "import", "--bogus"]],
		["the key written as an option", ["identity", "import", `--${HEX}`]],
		["the key given to --force", ["identity", "import", `--force=${HEX}`]],
		["the key given to --stdin", ["identity", "import", `--stdin=${HEX}`]],
		["any other text written as an option", ["identity", "import", `--${TEXT}`]],
		["--from-env without a name", ["identity", "import", "--from-env"]],
		["--from-env without a name, and a key before it", ["identity", "import", HEX, "--from-env"]],
		["--from-env and two words after it", ["identity", "import", "--from-env", "SOME_VARIABLE", HEX, "extra"]],
		["the key given to --from-env as an option of its own", ["identity", "import", `--from-env=${HEX}`, "extra", "more"]],
	])("%s: says why and prints none of the arguments", async (_name, args) => {
		const run = await agx(...args);
		for (const out of [run.stdout, run.stderr]) {
			for (const key of [HEX, OTHER_HEX]) {
				expect(leakedPart(out, key)).toBeNull();
			}
			expect(leakedPart(out, NSEC, 5)).toBeNull();
			expect(leakedPart(out, NCRYPTSEC, 10)).toBeNull();
			expect(out).not.toContain(TEXT);
		}
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(REPLACED);
	});
});

describe("every other parser error is unchanged", () => {
	it("still names the arguments of 'too many arguments' for a sibling command", async () => {
		const run = await agx("identity", "new", "extra");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("too many arguments for 'new'");
		expect(run.stderr).toContain("extra");
	});

	it("still names the arguments of 'too many arguments' for another command", async () => {
		const run = await agx("send", "npub1abc", "hello", "world");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("npub1abc, hello, world");
	});

	it("still names a missing argument of a sibling command", async () => {
		const run = await agx("identity", "sign");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("missing required argument 'nonce'");
	});

	it("still names an unknown command and suggests the nearest one", async () => {
		const run = await agx("sned");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'sned'");
		expect(run.stderr).toContain("Did you mean send?");
	});

	it("still names a mistyped peer for identity allow", async () => {
		saveIdentity("default", createIdentity());
		const run = await agx("identity", "allow", "npub1notakey");
		expect(run.code).toBe(2);
		expect(run.stderr).toContain('"npub1notakey" is not a valid peer');
	});

	it("still prints the help of identity import", async () => {
		const run = await agx("identity", "import", "--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Usage: agx identity import");
		expect(run.stderr).toBe("");
	});
});
