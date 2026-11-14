import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed:
// `unknown command '<arg>'`, `too many arguments for 'send' …: <all args>`.
// A secret key typed where a command or argument belongs must not come back in
// them: stderr lives on in terminal scrollback, logs and an agent's context.

let box: ReturnType<typeof sandbox>;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const OTHER_NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
/** The whole of what is printed instead: pinned exactly, so the message cannot be edited into one that shows part of the key. */
const REPLACED =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** The first 10-character stretch of the key's data part (not the constant `nsec1`) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = 5; i + 10 <= secret.length; i++) {
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

describe("a secret key on a command line the parser rejects", () => {
	it.each([
		["an unquoted message after a peer (too many arguments)", ["send", NSEC, "hello", "world"]],
		["an unknown command", [NSEC]],
		["an unknown command, in capitals", [NSEC.toUpperCase()]],
		["an unknown command behind nostr:", [`nostr:${NSEC}`]],
		["an unknown subcommand", ["identity", NSEC]],
		["an unknown option", [`--${NSEC}`]],
		["an unknown option of a subcommand", ["send", `--${NSEC}`, "someone", "hello"]],
		["--json mode", ["--json", "send", NSEC, "hello", "world"]],
		["a key cut short", [NSEC.slice(0, 25)]],
		["a key cut very short", [NSEC.slice(0, 12)]],
		["a key with a typo in it", [`${NSEC.slice(0, 30)}${NSEC[30] === "q" ? "p" : "q"}${NSEC.slice(31)}`]],
		["a key with one character too many", [`${NSEC}q`]],
		["two keys on one line", ["send", NSEC, "hello", OTHER_NSEC]],
	])("%s: says why and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(REPLACED);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NSEC);
			expect(leakedPart(out, NSEC)).toBeNull();
			expect(leakedPart(out, OTHER_NSEC)).toBeNull();
		}
	});
});

describe("every other parser error is unchanged", () => {
	it("still names the arguments of an ordinary 'too many arguments'", async () => {
		const run = await agx("send", "npub1abc", "hello", "world");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("too many arguments for 'send'");
		expect(run.stderr).toContain("npub1abc, hello, world");
	});

	it("still names an unknown command and suggests the nearest one", async () => {
		const run = await agx("sned");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'sned'");
		expect(run.stderr).toContain("Did you mean send?");
	});

	it("still names a missing argument", async () => {
		const run = await agx("send");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("missing required argument 'peer'");
	});

	it("does not hide text that only looks like the start of a secret key", async () => {
		const run = await agx("nsec-notes");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'nsec-notes'");
	});
});
