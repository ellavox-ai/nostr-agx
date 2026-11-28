import { hexToBytes } from "@nostr-agx/nostr";
import type { Command } from "commander";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgxCliError, EXIT, HumanActionRequiredError } from "../lib/errors.js";
import { renderInboundLines } from "../lib/inbound-lines.js";
import { createIdentity, loadIdentityFile } from "../lib/identity.js";
import { say, setJsonMode, writeErr, writeOut } from "../lib/output.js";
import { makeLogger } from "../lib/transport.js";
import { announceActionRequired } from "../lib/wait.js";
import { buildProgram, reportCliError } from "../program.js";
import { agx, capture, sandbox } from "./helpers.js";

// The check at the slot (lib/input-boundary.ts) now refuses a key typed into the slots these tests use
// (a profile name, a port, a config key) before anything runs; test/input-boundary.test.ts covers that.
// These tests are about the net behind it, for a slot nobody thought of, so the check is switched off here.
vi.mock("../lib/input-boundary.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/input-boundary.js")>()),
	checkInputs: () => undefined,
}));

// One test below switches off the parser's own hex branch (the run of hex digits that replaces a
// parser error), to show the net behind it still holds. The flag is off for every other test.
const parserHexBranch = vi.hoisted(() => ({ off: false }));
vi.mock("@nostr-agx/nostr", async (importOriginal) => {
	const real = await importOriginal<typeof import("@nostr-agx/nostr")>();
	return { ...real, holdsHexRun: (text: string, digits: number) => !parserHexBranch.off && real.holdsHexRun(text, digits) };
});

/**
 * The last net: a secret key that no check at the slot looked for must still not come out of the
 * CLI, on either stream, in human or `--json` mode. These run the real program in this process, with
 * a key pasted where nothing looks for it (a profile name, a port, a config key), and the helpers
 * the other output points use (the logger, the wait notice, the error reporter).
 *
 * Every key here is made when the test runs, from a throwaway key: none is real and none is
 * printed in full.
 */

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	parserHexBranch.off = false;
	setJsonMode(false);
	box.restore();
});

const KEY = hexToBytes(createIdentity().secretKeyHex);
const NSEC = nip19.nsecEncode(KEY);
const NCRYPTSEC = encrypt(KEY, "throwaway-password", 4);
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

/** The forms the canary plants, as text; `key` says which key to look for in the output. */
const FORMS: Array<[string, string, string, number]> = [
	["an nsec1…", NSEC, NSEC, 5],
	["an nsec1… in capitals", NSEC.toUpperCase(), NSEC, 5],
	["an nsec1… behind nostr:", `nostr:${NSEC}`, NSEC, 5],
	["an ncryptsec1…", NCRYPTSEC, NCRYPTSEC, 10],
	["an nsec1… written as %xx escapes", escapeAll(NSEC), NSEC, 5],
	["an nsec1… in a sentence", `my key is ${NSEC} and please keep it safe`, NSEC, 5],
];

describe("a secret key pasted where no check looks for it does not come back", () => {
	// Slots that print the value they were given, with no check for a key in them.
	const PROBES: Array<[string, (value: string) => string[], number]> = [
		["config show --profile (stdout)", (value) => ["config", "show", "--profile", value], EXIT.ok],
		["gateway --port (stderr)", (value) => ["gateway", "--port", value], EXIT.usage],
		["config set <key> (stderr)", (value) => ["config", "set", value, "x"], EXIT.usage],
	];

	for (const [probe, argsFor, code] of PROBES) {
		for (const json of [false, true]) {
			it.each(FORMS)(`${probe}${json ? " --json" : ""}: %s`, async (_form, value, key, prefix) => {
				const run = await agx(...(json ? ["--json"] : []), ...argsFor(value));
				expect(run.code).toBe(code);
				expect(leakedPart(`${run.stdout}${run.stderr}`, key, prefix)).toBeNull();
				expect(`${run.stdout}${run.stderr}`).toContain(MARK);
			});
		}
	}

	it("--json prints one JSON document with the key replaced inside it", async () => {
		const run = await agx("--json", "config", "show", "--profile", NSEC);
		expect(JSON.parse(run.stdout).profile).toBe(MARK);
		const sentence = await agx("--json", "config", "show", "--profile", `my key is ${NSEC} and please keep it safe`);
		expect(JSON.parse(sentence.stdout).profile).toBe(`my key is ${MARK} and please keep it safe`);
	});

	it("the message around the replaced key is the message it always was", async () => {
		const port = await agx("gateway", "--port", NSEC);
		expect(port.stderr).toContain(`--port must be a port number, not "${MARK}".`);
		const key = await agx("config", "set", NSEC, "x");
		expect(key.stderr).toContain(`Unknown config key "${MARK}".`);
	});
});

describe("ordinary messages, help and exit codes do not change", () => {
	it("a mistyped command still gets its suggestion, word for word", async () => {
		const command = await agx("idnetity");
		expect(command.code).toBe(1);
		expect(command.stderr).toBe("error: unknown command 'idnetity'\n(Did you mean identity?)\n");
		const sub = await agx("identity", "nwe");
		expect(sub.code).toBe(1);
		expect(sub.stderr).toBe("error: unknown command 'nwe'\n(Did you mean new?)\n");
	});

	it("an ordinary bad value is still quoted back to the person who typed it", async () => {
		const run = await agx("gateway", "--port", "abc");
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain('--port must be a port number, not "abc".');
		const key = await agx("config", "set", "nokey", "x");
		expect(key.code).toBe(EXIT.usage);
		expect(key.stderr).toContain('Unknown config key "nokey".');
	});

	it("a secret key typed as a command is still replaced by the parser's own message, whole", async () => {
		const run = await agx(NSEC);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n",
		);
	});

	it("a parser error that quotes the key of a profile the process has already read does not show it", async () => {
		// Only a long-lived process can know the key before it parses a command line, so the test reads the identity first.
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		expect((await agx("identity", "export", "--yes")).code).toBe(EXIT.ok);
		const run = await agx(own.secretKeyHex);
		expect(run.code).toBe(1);
		expect(run.stderr.toLowerCase()).not.toContain(own.secretKeyHex);
		// Any run of 56 or more hex digits in a parser error is replaced, so the net is not reached.
		expect(run.stderr).toBe(
			"error: the command line may contain a secret key (a run of 56 or more hex digits), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n",
		);
	});

	it("with the parser's hex branch switched off, the net still scrubs a parser error that quotes the key of a profile already read", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		expect((await agx("identity", "export", "--yes")).code).toBe(EXIT.ok);
		parserHexBranch.off = true;
		for (const args of [[own.secretKeyHex], [own.secretKeyHex.toUpperCase()], ["identity", own.secretKeyHex]]) {
			const run = await agx(...args);
			expect(run.code).toBe(1);
			// The error is the parser's own (so the hex branch was the one switched off), with the key taken out of it.
			expect(run.stderr).toMatch(/^error: unknown command '.*'/);
			expect(run.stderr).toContain(MARK);
			expect(decoded(run.stderr).toLowerCase()).not.toContain(own.secretKeyHex);
		}
	});

	it("every command of the program writes through the scrubbing writers, so no command can print around them", () => {
		const unscrubbed: string[] = [];
		const walk = (command: Command, path: string): void => {
			const writers = command.configureOutput();
			if (writers.writeOut !== writeOut || writers.writeErr !== writeErr) {
				unscrubbed.push(path);
			}
			for (const sub of command.commands) {
				walk(sub, `${path} ${sub.name()}`);
			}
		};
		walk(buildProgram(), "agx");
		expect(unscrubbed).toEqual([]);
	});

	it("the help of every command is untouched by the scrub, and agx --help prints it", async () => {
		const helps: string[] = [];
		const walk = (command: Command): void => {
			helps.push(command.helpInformation());
			for (const sub of command.commands) {
				walk(sub);
			}
		};
		walk(buildProgram());
		expect(helps.length).toBeGreaterThan(40);
		// Loaded here, not at the top, so the other tests of this file can run where the module does not exist.
		const { scrubOutput } = await import("../lib/scrub.js");
		for (const help of helps) {
			expect(scrubOutput(help)).toBe(help);
		}
		const run = await agx("--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(buildProgram().helpInformation());
		// No help holds a key-shaped word any more (a key on the command line is not advertised), so the one that
		// takes a key is checked by its own option: the words come out as the help wrote them.
		const identityImport = await agx("identity", "import", "--help");
		expect(identityImport.stdout).toContain("--from-env <name>");
	});

	it("a public key, a pubkey as hex and the file path come out as they were", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		const shown = await agx("identity", "show");
		expect(shown.stdout).toContain(own.npub);
		expect(shown.stdout).toContain(own.publicKey);
		const asJson = await agx("--json", "identity", "show");
		expect(JSON.parse(asJson.stdout)).toMatchObject({ npub: own.npub, pubkey: own.publicKey });
	});
});

describe("agx identity export prints the key on purpose; the same text from any other command is scrubbed", () => {
	it("prints the key, in nsec1… and in hex, with and without --json", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		const nsec = nip19.nsecEncode(hexToBytes(own.secretKeyHex));
		const plain = await agx("identity", "export", "--yes");
		expect({ code: plain.code, stdout: plain.stdout, stderr: plain.stderr }).toEqual({ code: 0, stdout: `${nsec}\n`, stderr: "" });
		const hex = await agx("identity", "export", "--yes", "--hex");
		expect({ code: hex.code, stdout: hex.stdout, stderr: hex.stderr }).toEqual({ code: 0, stdout: `${own.secretKeyHex}\n`, stderr: "" });
		const asJson = await agx("--json", "identity", "export", "--yes");
		expect(asJson.stdout).toBe(`${nsec}\n`);
	});

	it("does not print it on a terminal without --yes: the refusal it always gave", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			const run = await agx("identity", "export");
			expect(run.code).toBe(EXIT.usage);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("Refusing to print a secret key to a terminal without confirmation.");
			expect(run.stderr).not.toContain(own.secretKeyHex);
		} finally {
			if (original) {
				Object.defineProperty(process.stdout, "isTTY", original);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("any other command that prints the same text prints the marker instead", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const own = loadIdentityFile("default");
		const nsec = nip19.nsecEncode(hexToBytes(own.secretKeyHex));
		// The export has just read the identity file, so the profile's own key is known now.
		expect((await agx("identity", "export", "--yes")).stdout).toBe(`${nsec}\n`);
		for (const form of [own.secretKeyHex, own.secretKeyHex.toUpperCase(), nsec, nsec.toUpperCase(), `nostr:${nsec}`]) {
			const run = await agx("config", "show", "--profile", form);
			expect(run.stdout).not.toContain(own.secretKeyHex);
			expect(run.stdout.toLowerCase()).not.toContain(own.secretKeyHex);
			expect(leakedPart(run.stdout, nsec, 5)).toBeNull();
			expect(run.stdout).toContain(MARK);
		}
		const { stdout } = await capture(async () => say(`the key is ${own.secretKeyHex}`));
		expect(stdout).toBe(`the key is ${MARK}\n`);
	});
});

describe("the other output points", () => {
	it("the verbose logger scrubs a key in its message and in what it is given, and says nothing when not verbose", async () => {
		expect(makeLogger(false)).toBeUndefined();
		const logger = makeLogger(true);
		if (!logger) {
			throw new Error("a verbose logger was expected");
		}
		const { stdout, stderr } = await capture(async () => {
			logger.debug?.(`cannot read ${NSEC}`);
			logger.info?.("seen", NSEC);
			logger.warn?.("bad", { key: NSEC, list: [NCRYPTSEC] });
			logger.error?.(`x ${escapeAll(NSEC)} y`, `nostr:${NSEC.toUpperCase()}`);
		});
		expect(stdout).toBe("");
		expect(leakedPart(stderr, NSEC, 5)).toBeNull();
		expect(leakedPart(stderr, NCRYPTSEC, 10)).toBeNull();
		expect(stderr.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(6);
		expect(stderr).toContain("[agx:debug] cannot read [redacted] \n");
		expect(stderr).toContain("[agx:info] seen [redacted]\n");
	});

	it("the verbose logger prints an ordinary line as it did", async () => {
		const logger = makeLogger(true);
		const { stderr } = await capture(async () => {
			logger?.info?.("connected", "ws://127.0.0.1:9");
			logger?.warn?.("slow");
		});
		expect(stderr).toBe("[agx:info] connected ws://127.0.0.1:9\n[agx:warn] slow \n");
	});

	it("the wait notice scrubs a key in its url, human and --json", async () => {
		const action = {
			reason: "LOGIN_APPROVAL_REQUIRED" as const,
			url: `https://example.com/approve?k=${NSEC}`,
			userCode: "ABCD-EFGH",
			expiresIn: 600,
		};
		const human = await capture(async () => announceActionRequired(action, `Approve this login (${NSEC})`));
		expect(leakedPart(human.stderr, NSEC, 5)).toBeNull();
		expect(human.stderr).toContain("Waiting");
		expect(human.stdout).toBe("");
		setJsonMode(true);
		const machine = await capture(async () => announceActionRequired(action, "Approve this login"));
		expect(leakedPart(machine.stderr, NSEC, 5)).toBeNull();
		expect(JSON.parse(machine.stderr).actionRequired.url).toBe(`https://example.com/approve?k=${MARK}`);
	});

	it("the error reporter scrubs a key in the message, the hint, an unexpected error and the login prompt, and returns the same exit codes", async () => {
		const cases: Array<[unknown, number]> = [
			[new AgxCliError(`bad ${NSEC}`, { exitCode: EXIT.config, remediation: `try ${NSEC}` }), EXIT.config],
			[new Error(`something failed for ${NSEC}`), EXIT.generic],
			[`a thrown string ${NSEC}`, EXIT.generic],
			[
				new HumanActionRequiredError(`approve at ${NSEC}`, { reason: "LOGIN_APPROVAL_REQUIRED", url: `https://example.com/${NSEC}`, userCode: "ABCD-EFGH", expiresIn: 600 }, `remedy ${NSEC}`),
				EXIT.humanAction,
			],
		];
		for (const [error, code] of cases) {
			const { stdout, stderr } = await capture(async () => {
				expect(reportCliError(error)).toBe(code);
			});
			expect(leakedPart(`${stdout}${stderr}`, NSEC, 5)).toBeNull();
			expect(stderr).toContain(MARK);
		}
		setJsonMode(true);
		const { stdout, stderr } = await capture(async () => {
			expect(
				reportCliError(new HumanActionRequiredError("approve", { reason: "LOGIN_APPROVAL_REQUIRED", url: `https://example.com/${NSEC}`, userCode: null, expiresIn: null })),
			).toBe(EXIT.humanAction);
		});
		expect(JSON.parse(stdout).actionRequired.url).toBe(`https://example.com/${MARK}`);
		expect(stderr).toBe("");
	});

	it("the lines `agx serve` prints for a message that holds a key do not show it", async () => {
		const { stdout } = await capture(async () => {
			for (const line of renderInboundLines({
				fromNpub: nip19.npubEncode("ab".repeat(32)),
				allowed: true,
				subject: `about ${NSEC}`,
				contextId: null,
				text: `here is my key:\n${NSEC}\nand a second one ${NCRYPTSEC}`,
				allowedOnly: false,
				fullIds: false,
			})) {
				say(line);
			}
		});
		expect(leakedPart(stdout, NSEC, 5)).toBeNull();
		expect(leakedPart(stdout, NCRYPTSEC, 10)).toBeNull();
		expect(stdout).toContain("RECV");
		expect(stdout).toContain("here is my key:");
		expect(stdout.match(/\[redacted\]/g)?.length).toBe(3);
	});
});
