import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@nostr-agx/nostr";
import { Command } from "commander";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import { capture, sandbox } from "../test/helpers.js";
import { walkProgram } from "../test/canary-kit.js";
import { getProfile, saveProfile } from "./config.js";
import { AgxCliError } from "./errors.js";
import { createIdentity, saveIdentity } from "./identity.js";
import { checkInputs, isValidProfileName, PROFILE_NAME_MAX } from "./input-boundary.js";
import { ENV_SLOTS, SLOTS, type SlotSpec, type SlotTable } from "./input-slots.js";
import { configPath, identityPath } from "./paths.js";

// The slot table says what kind of value each input of each command takes, and the check
// that runs after the parser and before any command refuses a secret key in a slot that
// is not a secret slot, without ever repeating the value. Every key here is made when the
// test runs and none is real.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const stranger = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(stranger.secretKeyHex));
const STRANGER_HEX = stranger.secretKeyHex;
const OWN_HEX = mine.secretKeyHex;

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
});

afterEach(() => {
	box.restore();
});

/** The slots that take the id of a thread, which a peer chooses and may make the 64 hex digits of an event id. */
const THREAD_ID_SLOTS: Array<[string, string]> = [
	["inbox", "--thread"],
	["send", "--context-id"],
	["thread", "<contextId>"],
];
/** The slots that take a path or a URL, where a content hash in a folder or file name is normal. */
const LOCATION_SLOTS: Array<[string, string]> = [
	["card", "--relay"],
	["listing create", "--relay"],
	["login", "--api-base-url"],
	["org create", "--api-base-url"],
	["serve", "--handler"],
	["tailscale enable", "--oauth-api-base-url"],
	["tailscale enable", "--oauth-url"],
	["tailscale enable", "--state-dir"],
	["tailscale up", "--state-dir"],
	["ui", "--compose"],
	["ui", "--dev-store"],
	["ui", "--drafts"],
];

// ------------------------------------------------------------------ the table is complete

describe("the slot table", () => {
	const nodes = walkProgram(buildProgram());
	/** A flag that takes no value but reads standard input: its stdin is a secret, so it is in the table. */
	const readsStdin = (name: string): boolean => /stdin$/.test(name);

	it("classifies every input of every command: each value, and each flag that reads standard input", () => {
		const problems: string[] = [];
		for (const node of nodes) {
			const entry = SLOTS[node.label] ?? {};
			for (const slot of node.slots) {
				const listed = entry[slot.name] !== undefined;
				const needed = slot.takesValue || readsStdin(slot.name);
				if (needed && !listed) {
					problems.push(`"${node.label}" ${slot.name} has no kind`);
				}
				if (!needed && listed) {
					problems.push(`"${node.label}" ${slot.name} takes no value and does not read standard input: take it out`);
				}
			}
			const names = new Set(node.slots.map((slot) => slot.name));
			for (const name of Object.keys(entry)) {
				if (!names.has(name)) {
					problems.push(`"${node.label}" ${name} is in the table and not in the program`);
				}
			}
		}
		const labels = new Set(nodes.map((node) => node.label));
		for (const label of Object.keys(SLOTS)) {
			if (!labels.has(label)) {
				problems.push(`command "${label}" is in the table and not in the program`);
			}
		}
		expect(problems).toEqual([]);
	});

	it("uses all four kinds", () => {
		const kinds = new Set<string>();
		for (const entry of Object.values(SLOTS)) {
			for (const spec of Object.values(entry)) {
				if (typeof spec === "function") {
					continue;
				}
				kinds.add(typeof spec === "string" ? spec : spec.kind);
			}
		}
		expect([...kinds].sort()).toEqual(["freeText", "identifier", "publicKey", "secret"]);
	});

	it("names the secret slots, and only these, as secret", () => {
		const secret: string[] = [];
		for (const [command, entry] of Object.entries(SLOTS)) {
			for (const [slot, spec] of Object.entries(entry)) {
				if (typeof spec === "function" || (typeof spec === "string" ? spec : spec.kind) === "secret") {
					secret.push(`${command} ${slot}`);
				}
			}
		}
		expect(secret.sort()).toEqual([
			"config set --stdin",
			"config set [value]",
			"identity import --stdin",
			"identity import [secret]",
			"tailscale enable --auth-key",
			"tailscale enable --auth-key-stdin",
			"tailscale enable --oauth-client-secret",
			"tailscale enable --oauth-client-secret-stdin",
			"tailscale up --auth-key",
			"tailscale up --auth-key-stdin",
		]);
	});

	it("lets four message-body slots through as typed, until it is decided whether they refuse a key", () => {
		const allowed: string[] = [];
		for (const [command, entry] of Object.entries(SLOTS)) {
			for (const [slot, spec] of Object.entries(entry)) {
				if (typeof spec !== "function" && typeof spec !== "string" && spec.kind !== "secret" && spec.policy === "allow") {
					allowed.push(`${command} ${slot}`);
				}
			}
		}
		expect(allowed.sort()).toEqual(["request --payload", "send --subject", "send <message>", "serve --reply-text"]);
	});

	it("lets a 64-digit run through only where a peer may choose the id (three thread-id slots) or the value is a path or a URL (twelve)", () => {
		const hexOk: string[] = [];
		for (const [command, entry] of Object.entries(SLOTS)) {
			for (const [slot, spec] of Object.entries(entry)) {
				if (typeof spec !== "function" && typeof spec !== "string" && spec.kind === "identifier" && spec.hexOk) {
					hexOk.push(`${command} ${slot}`);
				}
			}
		}
		expect(hexOk.sort()).toEqual(
			[
				...THREAD_ID_SLOTS.map(([command, slot]) => `${command} ${slot}`),
				...LOCATION_SLOTS.map(([command, slot]) => `${command} ${slot}`),
			].sort(),
		);
	});

	it("takes the three profile-name slots through the profile-name rule", () => {
		const names: string[] = [];
		for (const [command, entry] of Object.entries(SLOTS)) {
			for (const [slot, spec] of Object.entries(entry)) {
				if (typeof spec !== "function" && typeof spec !== "string" && spec.profileName) {
					names.push(`${command} ${slot}`);
				}
			}
		}
		for (const [name, spec] of Object.entries(ENV_SLOTS)) {
			if (typeof spec !== "function" && typeof spec !== "string" && spec.profileName) {
				names.push(`env ${name}`);
			}
		}
		expect(names.sort()).toEqual(["(program) --profile", "config use <profile>", "env AGX_PROFILE"]);
	});
});

describe("the environment table", () => {
	it("classifies every environment variable the CLI source mentions", () => {
		const root = fileURLToPath(new URL("..", import.meta.url));
		const found = new Set<string>();
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
				} else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !path.includes(`${join(root, "test")}/`)) {
					for (const match of readFileSync(path, "utf8").matchAll(/\b(AGX_[A-Z0-9_]+|TS_AUTHKEY)\b/g)) {
						found.add(match[1] as string);
					}
				}
			}
		};
		walk(root);
		// Names that start with AGX_ and are not environment variables: a constant, an OAuth client id, a scope.
		const notEnvironment = new Set(["AGX_CLI_VERSION", "AGX_CLIENT_ID", "AGX_SCOPES", "AGX_SCOPE_STRING"]);
		const missing = [...found].filter((name) => !notEnvironment.has(name) && !(name in ENV_SLOTS)).sort();
		expect(missing).toEqual([]);
	});

	it("keeps the secrets (API key, gateway key, Tailscale key and OAuth client secret) as secret slots", () => {
		const secret = Object.entries(ENV_SLOTS)
			.filter(([, spec]) => spec === "secret")
			.map(([name]) => name)
			.sort();
		expect(secret).toEqual(["AGX_API_KEY", "AGX_GATEWAY_KEY", "AGX_TAILSCALE_AUTH_KEY", "AGX_TAILSCALE_OAUTH_CLIENT_SECRET", "TS_AUTHKEY"]);
	});
});

// --------------------------------------------------------------- the check, on a small program

/** The label of the slot, as the message names it. */
const OPTION = "The value of `--where` (agx go)";
const ARGUMENT = "The `<thing>` argument (agx go)";
const SHAPE = ", so it was not used and is not shown here.";
const KEY_TEXT = (label: string): string => `${label} holds a secret key (nsec1… or ncryptsec1…)${SHAPE}`;
const HEX_TEXT = (label: string): string => `${label} holds a 64-character hex string, which may be a secret key${SHAPE}`;
const OWN_TEXT = (label: string): string => `${label} holds this profile's own secret key${SHAPE}`;

/** A two-command program with the check installed the way `buildProgram` installs it, and a table of our own. */
function scratch(table: SlotTable, env: NodeJS.ProcessEnv = {}, amountDefault = "5"): (args: string[]) => Promise<void> {
	return async (args) => {
		const program = new Command();
		program.exitOverride();
		program.option("--profile <name>");
		program
			.command("go <thing>")
			.option("--where <path>")
			.option("--tag <name...>")
			.option("--amount <n>", "a number", amountDefault)
			.action(() => undefined);
		program.hook("preAction", (_root, action) => checkInputs(action, { table, env }));
		await program.parseAsync(args, { from: "user" });
	};
}

async function refusal(promise: Promise<unknown>): Promise<{ message: string; exitCode: number } | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		if (error instanceof AgxCliError) {
			return { message: error.message, exitCode: error.exitCode };
		}
		throw error;
	}
}

describe("a value in a slot of each kind", () => {
	const table = (kind: "secret" | "publicKey" | "identifier" | "freeText"): SlotTable => ({
		go: { "<thing>": "freeText", "--where": kind },
	});
	const asArgs = (value: string): string[] => ["go", "fine", "--where", value];
	const forms: Array<[string, string]> = [
		["an nsec1 key", NSEC],
		["an nsec1 key in capitals", NSEC.toUpperCase()],
		["an nsec1 key behind nostr:", `nostr:${NSEC}`],
		["an nsec1 key written as %xx escapes", [...NSEC].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")],
		["an nsec1 key inside a sentence", `my key is ${NSEC} and please keep it safe`],
		["a key cut short", NSEC.slice(0, 12)],
		["the bare prefix, which the lenient shared rule also reads as a key", "nsec1"],
		["an ncryptsec1 key", `ncryptsec1${"q".repeat(40)}`],
	];

	it.each(forms)("refuses %s in a public key, identifier or free text slot, naming the slot and not the value", async (_name, value) => {
		for (const kind of ["publicKey", "identifier", "freeText"] as const) {
			const result = await refusal(scratch(table(kind))(asArgs(value)));
			expect(result, kind).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
		}
	});

	it.each(forms)("lets %s through a secret slot, which is what a secret slot is for", async (_name, value) => {
		expect(await refusal(scratch(table("secret"))(asArgs(value)))).toBeNull();
	});

	it("refuses a key in a positional slot and names the argument", async () => {
		const result = await refusal(scratch({ go: { "<thing>": "identifier", "--where": "identifier" } })(["go", NSEC]));
		expect(result).toEqual({ message: KEY_TEXT(ARGUMENT), exitCode: 2 });
	});

	it("refuses a key in any value of a repeated option", async () => {
		const result = await refusal(scratch({ go: { "<thing>": "identifier", "--tag": "identifier" } })(["go", "x", "--tag", "ok", NSEC]));
		expect(result).toEqual({ message: KEY_TEXT("The value of `--tag` (agx go)"), exitCode: 2 });
	});

	it("refuses 64 hex digits in an identifier slot, in either case, even inside a longer text", async () => {
		for (const value of [STRANGER_HEX, STRANGER_HEX.toUpperCase(), `/tmp/${STRANGER_HEX}/x`, `a${STRANGER_HEX}`, `${STRANGER_HEX}0`]) {
			const result = await refusal(scratch(table("identifier"))(asArgs(value)));
			expect(result, value.slice(0, 4)).toEqual({ message: HEX_TEXT(OPTION), exitCode: 2 });
		}
	});

	it("lets 64 hex digits through a public key slot and a free text slot: they are a public key, an event id or a hash", async () => {
		for (const kind of ["publicKey", "freeText"] as const) {
			expect(await refusal(scratch(table(kind))(asArgs(STRANGER_HEX)))).toBeNull();
			expect(await refusal(scratch(table(kind))(asArgs(STRANGER_HEX.toUpperCase())))).toBeNull();
		}
	});

	it("lets 64 hex digits through an identifier slot that takes event ids, and still refuses a key there", async () => {
		const hexOk: SlotTable = { go: { "<thing>": "freeText", "--where": { kind: "identifier", hexOk: true } } };
		expect(await refusal(scratch(hexOk)(asArgs(STRANGER_HEX)))).toBeNull();
		expect(await refusal(scratch(hexOk)(asArgs(NSEC)))).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
	});

	it("lets ordinary values through every kind", async () => {
		const ordinary = ["alice", "invoice.review", "https://example.com/a?b=c", "npub1abc", "nsec", "2026-11-27", `63 digits ${STRANGER_HEX.slice(0, 63)}`];
		for (const kind of ["publicKey", "identifier", "freeText"] as const) {
			for (const value of ordinary) {
				expect(await refusal(scratch(table(kind))(asArgs(value))), `${kind} ${value.slice(0, 12)}`).toBeNull();
			}
		}
	});

	it("does not look at a value that was not typed: a default is the program's own", async () => {
		const run = scratch({ go: { "<thing>": "identifier", "--amount": "identifier" } }, {}, NSEC);
		expect(await refusal(run(["go", "x"]))).toBeNull();
		expect(await refusal(run(["go", "x", "--amount", NSEC]))).toEqual({ message: KEY_TEXT("The value of `--amount` (agx go)"), exitCode: 2 });
	});

	it("treats a slot that is not in the table as free text: a key is refused, 64 hex digits are not", async () => {
		expect(await refusal(scratch({})(["go", NSEC]))).toEqual({ message: KEY_TEXT(ARGUMENT), exitCode: 2 });
		expect(await refusal(scratch({})(["go", STRANGER_HEX]))).toBeNull();
	});

	it("takes the kind of a slot from another slot when the table says so", async () => {
		const byKey: SlotTable = {
			go: { "<thing>": "identifier", "--where": (others) => (others["<thing>"] === "apiKey" ? "secret" : "identifier") },
		};
		expect(await refusal(scratch(byKey)(["go", "apiKey", "--where", NSEC]))).toBeNull();
		expect(await refusal(scratch(byKey)(["go", "org", "--where", NSEC]))).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
	});
});

describe("a path, a URL and an environment variable: a content hash is normal there", () => {
	/** The table entry of a real slot, put in the small program as `--where`. */
	const real = (command: string, slot: string): SlotTable => ({ go: { "<thing>": "freeText", "--where": (SLOTS[command] as Record<string, SlotSpec>)[slot] as SlotSpec } });
	const asArgs = (value: string): string[] => ["go", "fine", "--where", value];
	const places = (hex: string): string[] => [`/cache/${hex}/ts`, `./${hex}.mjs`, `wss://relay.example.com/${hex}`, `${hex}`, hex.toUpperCase()];

	it.each(LOCATION_SLOTS)("%s %s lets a run of 64 hex digits through, in a folder, a file name or a URL", async (command, slot) => {
		for (const value of places(STRANGER_HEX)) {
			expect(await refusal(scratch(real(command, slot))(asArgs(value))), value.slice(0, 12)).toBeNull();
		}
	});

	it.each(LOCATION_SLOTS)("%s %s still refuses a key, and the profile's own key written as 64 hex digits", async (command, slot) => {
		for (const value of [NSEC, `/cache/${NSEC}/ts`, `nostr:${NSEC}`, `ncryptsec1${"q".repeat(40)}`]) {
			expect(await refusal(scratch(real(command, slot))(asArgs(value))), value.slice(0, 12)).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
		}
		for (const value of [...places(OWN_HEX), `/tmp/%${OWN_HEX}`, `/cache/${OWN_HEX}${OWN_HEX}`]) {
			expect(await refusal(scratch(real(command, slot))(asArgs(value))), value.slice(0, 12)).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
		}
	});

	it("still refuses 64 hex digits in an identifier that is not a path or a URL: a name, an organization, a tag, a slug", async () => {
		for (const [command, slot] of [["org create", "--slug"], ["domain list", "--org"], ["listing create", "--tag"], ["gateway key revoke", "<id>"], ["tailscale up", "--hostname"]]) {
			const result = await refusal(scratch(real(command as string, slot as string))(asArgs(STRANGER_HEX)));
			expect(result, `${command} ${slot}`).toEqual({ message: HEX_TEXT(OPTION), exitCode: 2 });
		}
	});

	const variables = Object.entries(ENV_SLOTS).filter(([name, spec]) => spec !== "secret" && name !== "AGX_PROFILE");
	const isPlace = (spec: SlotSpec): boolean => typeof spec === "object" && spec.kind === "identifier" && spec.hexOk === true;
	const placeVariables = variables.filter(([, spec]) => isPlace(spec)).map(([name]) => name);
	const idVariables = variables.filter(([, spec]) => !isPlace(spec)).map(([name]) => name);

	it("lets a hash through only the environment variables that hold a folder, a file or a URL", () => {
		expect(placeVariables.sort()).toEqual([
			"AGX_API_URL",
			"AGX_ELLADEX_URL",
			"AGX_HOME",
			"AGX_RELAY",
			"AGX_TAILSCALE_BINARY",
			"AGX_TAILSCALE_OAUTH_API_BASE_URL",
			"AGX_TAILSCALE_OAUTH_URL",
			"AGX_TAILSCALE_STATE_DIR",
		]);
	});

	it("keeps the ids and the flags among the environment variables as identifiers: a name, an id or a switch, never a place", () => {
		expect(idVariables.sort()).toEqual([
			"AGX_DEBUG",
			"AGX_NO_BROWSER",
			"AGX_ORG",
			"AGX_TAILSCALE",
			"AGX_TAILSCALE_HOSTNAME",
			"AGX_TAILSCALE_OAUTH_CLIENT_ID",
			"AGX_TAILSCALE_OAUTH_SCOPE",
			"AGX_TAILSCALE_OAUTH_TOKEN_AUTH",
			"AGX_TAILSCALE_TAGS",
			"AGX_TAILSCALE_TAILNET",
			"AGX_UI_DEV_STORE",
		]);
		for (const [name, spec] of variables) {
			if (!placeVariables.includes(name)) {
				expect(spec === "identifier" || (typeof spec === "object" && spec.kind === "identifier" && !spec.hexOk), name).toBe(true);
			}
		}
	});

	it.each(placeVariables.map((name) => [name]))("%s: lets a run of 64 hex digits through on every command, and still refuses a key and the own key", async (name) => {
		const table: SlotTable = { go: { "<thing>": "freeText" } };
		for (const value of places(STRANGER_HEX)) {
			expect(await refusal(scratch(table, { [name]: value })(["go", "x"])), value.slice(0, 12)).toBeNull();
		}
		const label = `The environment variable ${name}`;
		expect(await refusal(scratch(table, { [name]: `/cache/${NSEC}` })(["go", "x"]))).toEqual({ message: KEY_TEXT(label), exitCode: 2 });
		expect(await refusal(scratch(table, { [name]: `/cache/${OWN_HEX}` })(["go", "x"]))).toEqual({ message: OWN_TEXT(label), exitCode: 2 });
	});

	it.each(idVariables.map((name) => [name]))("%s: refuses a run of 64 hex digits on every command, like the option of the same name, and refuses a key and the own key", async (name) => {
		const table: SlotTable = { go: { "<thing>": "freeText" } };
		const label = `The environment variable ${name}`;
		for (const value of [STRANGER_HEX, STRANGER_HEX.toUpperCase(), `a${STRANGER_HEX}`, `${STRANGER_HEX}0`]) {
			expect(await refusal(scratch(table, { [name]: value })(["go", "x"])), value.slice(0, 12)).toEqual({ message: HEX_TEXT(label), exitCode: 2 });
		}
		expect(await refusal(scratch(table, { [name]: NSEC })(["go", "x"]))).toEqual({ message: KEY_TEXT(label), exitCode: 2 });
		expect(await refusal(scratch(table, { [name]: OWN_HEX })(["go", "x"]))).toEqual({ message: HEX_TEXT(label), exitCode: 2 });
		expect(await refusal(scratch(table, { [name]: "short" })(["go", "x"]))).toBeNull();
	});

	it("still refuses 64 hex digits as a profile name: AGX_PROFILE is a name, not a place", async () => {
		const result = await refusal(scratch({ go: { "<thing>": "freeText" } }, { AGX_PROFILE: STRANGER_HEX })(["go", "x"]));
		expect(result).toEqual({ message: HEX_TEXT("The environment variable AGX_PROFILE"), exitCode: 2 });
	});
});

describe("the profile's own key", () => {
	const table = (kind: "publicKey" | "identifier" | "freeText"): SlotTable => ({ go: { "<thing>": "freeText", "--where": kind } });
	const asArgs = (value: string): string[] => ["go", "fine", "--where", value];
	const npubOfOwnBytes = nip19.npubEncode(OWN_HEX);

	it.each([
		["as 64 hex digits", OWN_HEX],
		["in capitals", OWN_HEX.toUpperCase()],
		["with spaces around it", `  ${OWN_HEX}  `],
	])("is refused in a public key slot %s, and a stranger's key is not", async (_name, value) => {
		expect(await refusal(scratch(table("publicKey"))(asArgs(value)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
		expect(await refusal(scratch(table("publicKey"))(asArgs(STRANGER_HEX)))).toBeNull();
	});

	it("is refused in a public key slot as the npub that carries the same 32 bytes", async () => {
		expect(await refusal(scratch(table("publicKey"))(asArgs(npubOfOwnBytes)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
	});

	it("does not refuse the profile's own public key", async () => {
		expect(await refusal(scratch(table("publicKey"))(asArgs(mine.npub)))).toBeNull();
		expect(await refusal(scratch(table("publicKey"))(asArgs(mine.publicKey)))).toBeNull();
	});

	it("is refused inside a free text slot, which lets other 64-digit runs through", async () => {
		expect(await refusal(scratch(table("freeText"))(asArgs(`my key is ${OWN_HEX} ok`)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
		expect(await refusal(scratch(table("freeText"))(asArgs(`a public key ${STRANGER_HEX} ok`)))).toBeNull();
	});

	it("is refused in an identifier slot that takes event ids", async () => {
		const hexOk: SlotTable = { go: { "<thing>": "freeText", "--where": { kind: "identifier", hexOk: true } } };
		expect(await refusal(scratch(hexOk)(asArgs(OWN_HEX)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
	});

	it("is not known when the profile has no identity file: the same 64 digits pass, and the check says nothing", async () => {
		box.restore();
		box = sandbox();
		expect(await refusal(scratch(table("publicKey"))(asArgs(OWN_HEX)))).toBeNull();
	});

	it("is not read from outside the profiles folder, when the name of the profile in use is not a folder name", async () => {
		const outside = createIdentity();
		saveIdentity("../escape", outside);
		process.env.AGX_PROFILE = "../escape";
		expect(existsSync(join(box.home, "escape", "identity.json"))).toBe(true);
		expect(await refusal(scratch(table("publicKey"))(asArgs(outside.secretKeyHex)))).toBeNull();
	});

	it("is refused as an npub that carries the same bytes even with spaces around it", async () => {
		expect(await refusal(scratch(table("publicKey"))(asArgs(`  ${npubOfOwnBytes}  `)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
		expect(await refusal(scratch(table("publicKey"))(asArgs(` ${mine.npub} `)))).toBeNull();
	});

	it("is found behind a percent sign that decoding would take for the start of an escape", async () => {
		expect(await refusal(scratch(table("freeText"))(asArgs(`%${OWN_HEX}`)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
		expect(await refusal(scratch(table("freeText"))(asArgs(`/tmp/%${OWN_HEX}`)))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
	});

	it("is not known, and the check says nothing, when identity.json cannot be read: the command reports its own error", async () => {
		writeFileSync(identityPath("default"), "{ this is not json");
		expect(await refusal(scratch(table("publicKey"))(asArgs(OWN_HEX)))).toBeNull();
		expect(await refusal(scratch(table("publicKey"))(asArgs(STRANGER_HEX)))).toBeNull();
	});

	it("is not known, and the check says nothing, when config.json cannot be read", async () => {
		writeFileSync(configPath(), "{ this is not json");
		expect(await refusal(scratch(table("publicKey"))(asArgs(OWN_HEX)))).toBeNull();
		expect(await refusal(scratch(table("identifier"))(asArgs(NSEC)))).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
	});

	it("is the key of the profile that the command would use: --profile first, then AGX_PROFILE, then the stored one", async () => {
		const other = createIdentity();
		saveIdentity("second", other);
		const run = scratch(table("publicKey"));
		const own = { message: OWN_TEXT(OPTION), exitCode: 2 };
		// Nothing says which profile: the stored one, "default".
		expect(await refusal(run(asArgs(OWN_HEX)))).toEqual(own);
		expect(await refusal(run(asArgs(other.secretKeyHex)))).toBeNull();
		// The flag.
		expect(await refusal(run(["--profile", "second", ...asArgs(other.secretKeyHex)]))).toEqual(own);
		expect(await refusal(run(["--profile", "second", ...asArgs(OWN_HEX)]))).toBeNull();
		// The environment, which the flag beats.
		process.env.AGX_PROFILE = "second";
		expect(await refusal(run(asArgs(other.secretKeyHex)))).toEqual(own);
		expect(await refusal(run(asArgs(OWN_HEX)))).toBeNull();
		expect(await refusal(run(["--profile", "default", ...asArgs(OWN_HEX)]))).toEqual(own);
	});
});

describe("refuse, warn or allow, slot by slot", () => {
	const table = (policy: "refuse" | "warn" | "allow"): SlotTable => ({ go: { "<thing>": "freeText", "--where": { kind: "freeText", policy } } });

	it("refuses by default and when the slot says so", async () => {
		expect(await refusal(scratch(table("refuse"))(["go", "x", "--where", NSEC]))).toEqual({ message: KEY_TEXT(OPTION), exitCode: 2 });
		expect(await refusal(scratch({ go: { "<thing>": "freeText", "--where": "freeText" } })(["go", "x", "--where", NSEC]))).toEqual({
			message: KEY_TEXT(OPTION),
			exitCode: 2,
		});
	});

	it("allows: the value goes through and nothing is printed", async () => {
		const shown = await capture(async () => refusal(scratch(table("allow"))(["go", "x", "--where", NSEC])));
		expect(shown.value).toBeNull();
		expect(shown.stdout + shown.stderr).toBe("");
	});

	it("warns: the value goes through, one line on standard error names the slot and not the value", async () => {
		const shown = await capture(async () => refusal(scratch(table("warn"))(["go", "x", "--where", NSEC])));
		expect(shown.value).toBeNull();
		expect(shown.stdout).toBe("");
		expect(shown.stderr).toBe(`! ${OPTION} holds a secret key (nsec1… or ncryptsec1…). It is used as typed and is not shown here.\n`);
	});

	it("warns and allows only for the slot that says so", async () => {
		const mixed: SlotTable = { go: { "<thing>": "freeText", "--where": { kind: "freeText", policy: "allow" }, "--tag": "freeText" } };
		expect(await refusal(scratch(mixed)(["go", "x", "--where", NSEC]))).toBeNull();
		expect(await refusal(scratch(mixed)(["go", "x", "--tag", NSEC]))).toEqual({ message: KEY_TEXT("The value of `--tag` (agx go)"), exitCode: 2 });
	});

	it("applies the rule of a slot to the own key too", async () => {
		expect(await refusal(scratch(table("allow"))(["go", "x", "--where", OWN_HEX]))).toBeNull();
		expect(await refusal(scratch(table("refuse"))(["go", "x", "--where", OWN_HEX]))).toEqual({ message: OWN_TEXT(OPTION), exitCode: 2 });
	});
});

describe("the environment", () => {
	const table: SlotTable = { go: { "<thing>": "freeText" } };

	it("refuses a key in an environment variable that is not a secret one, and names the variable", async () => {
		const result = await refusal(scratch(table, { AGX_ORG: NSEC })(["go", "x"]));
		expect(result).toEqual({ message: `The environment variable AGX_ORG holds a secret key (nsec1… or ncryptsec1…)${SHAPE}`, exitCode: 2 });
	});

	it("lets a key through an environment variable that is a secret one", async () => {
		expect(await refusal(scratch(table, { AGX_API_KEY: NSEC })(["go", "x"]))).toBeNull();
	});

	it("lets an empty variable through, apart from a profile name", async () => {
		expect(await refusal(scratch(table, { AGX_ORG: "" })(["go", "x"]))).toBeNull();
		expect(await refusal(scratch(table, {})(["go", "x"]))).toBeNull();
	});

	it("refuses an empty AGX_PROFILE as a profile name: an empty name is the folder that holds every profile", async () => {
		const result = await refusal(scratch(table, { AGX_PROFILE: "" })(["go", "x"]));
		expect(result).toEqual({
			message: 'The environment variable AGX_PROFILE is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.',
			exitCode: 2,
		});
	});

	it("applies the profile-name rule to AGX_PROFILE", async () => {
		const result = await refusal(scratch(table, { AGX_PROFILE: "a b" })(["go", "x"]));
		expect(result).toEqual({
			message: 'The environment variable AGX_PROFILE is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.',
			exitCode: 2,
		});
		expect(await refusal(scratch(table, { AGX_PROFILE: "work" })(["go", "x"]))).toBeNull();
	});

	const named: SlotTable = { "(program)": { "--profile": { kind: "identifier", profileName: true } }, go: { "<thing>": "freeText" } };

	it.each([
		["an empty text", ""],
		["a name with a space", "my profile"],
	])("does not apply the profile-name rule to AGX_PROFILE when --profile names the profile: %s is never used as a name then", async (_name, value) => {
		expect(await refusal(scratch(named, { AGX_PROFILE: value })(["--profile", "work", "go", "x"]))).toBeNull();
	});

	it.each([
		["a secret key", NSEC, KEY_TEXT("The environment variable AGX_PROFILE")],
		["64 hex digits", STRANGER_HEX, HEX_TEXT("The environment variable AGX_PROFILE")],
		["the own key as 64 hex digits", OWN_HEX, HEX_TEXT("The environment variable AGX_PROFILE")],
	])("still refuses %s in AGX_PROFILE when --profile names the profile: a key does not sit in the environment", async (_name, value, message) => {
		expect(await refusal(scratch(named, { AGX_PROFILE: value })(["--profile", "work", "go", "x"]))).toEqual({ message, exitCode: 2 });
	});

	it("still refuses AGX_PROFILE when no --profile is typed, and still refuses the flag itself", async () => {
		const notAName = (label: string): string =>
			`${label} is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.`;
		expect(await refusal(scratch(named, { AGX_PROFILE: "" })(["go", "x"]))).toEqual({ message: notAName("The environment variable AGX_PROFILE"), exitCode: 2 });
		expect(await refusal(scratch(named, { AGX_PROFILE: "work" })(["--profile", "a b", "go", "x"]))).toEqual({ message: notAName("The value of `--profile`"), exitCode: 2 });
	});
});

describe("a profile that is already stored", () => {
	const profileTable: SlotTable = {
		"(program)": { "--profile": { kind: "identifier", profileName: true } },
		go: { "<thing>": { kind: "identifier", profileName: true }, "--where": "publicKey" },
	};
	const notAName = (label: string): string =>
		`${label} is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.`;
	const FLAG = "The value of `--profile`";
	const POSITIONAL = "The `<thing>` argument (agx go)";

	it("can be named again, whatever its name holds, when it is a folder or a name in config.json that is one folder name", async () => {
		saveIdentity("my profile", createIdentity());
		saveIdentity("x".repeat(40), createIdentity());
		saveProfile("only in config.json", getProfile("only in config.json"));
		for (const name of ["my profile", "x".repeat(40), "only in config.json"]) {
			expect(await refusal(scratch(profileTable)(["--profile", name, "go", "x"])), name).toBeNull();
			expect(await refusal(scratch(profileTable)(["go", name])), name).toBeNull();
		}
		expect(await refusal(scratch(profileTable, { AGX_PROFILE: "my profile" })(["go", "x"]))).toBeNull();
	});

	it("does not let another name through: a new profile must have a name that is one short folder name", async () => {
		saveIdentity("my profile", createIdentity());
		for (const name of ["my profile 2", "my profile ", "my  profile", "my profile."]) {
			expect(await refusal(scratch(profileTable)(["--profile", name, "go", "x"])), name).toEqual({ message: notAName(FLAG), exitCode: 2 });
			expect(await refusal(scratch(profileTable)(["go", name])), name).toEqual({ message: notAName(POSITIONAL), exitCode: 2 });
		}
		expect(await refusal(scratch(profileTable, { AGX_PROFILE: "my profile 2" })(["go", "x"]))).toEqual({
			message: notAName("The environment variable AGX_PROFILE"),
			exitCode: 2,
		});
	});

	it("is not let through when its name holds a slash, a backslash, a dot name, a key or 64 hex digits", async () => {
		saveIdentity("a/b", createIdentity());
		saveIdentity("a\\b", createIdentity());
		saveIdentity(NSEC, createIdentity());
		saveIdentity(STRANGER_HEX, createIdentity());
		for (const [name, message] of [
			["a/b", notAName(FLAG)],
			["a\\b", notAName(FLAG)],
			["..", notAName(FLAG)],
			[".", notAName(FLAG)],
			["../escape", notAName(FLAG)],
			[NSEC, KEY_TEXT(FLAG)],
			[STRANGER_HEX, HEX_TEXT(FLAG)],
		] as const) {
			expect(await refusal(scratch(profileTable)(["--profile", name, "go", "x"])), name.slice(0, 6)).toEqual({ message, exitCode: 2 });
		}
	});

	it("has its own key refused where a public key belongs, as any profile's key is", async () => {
		const other = createIdentity();
		saveIdentity("my profile", other);
		const own = { message: OWN_TEXT(OPTION), exitCode: 2 };
		expect(await refusal(scratch(profileTable)(["--profile", "my profile", "go", "x", "--where", other.secretKeyHex]))).toEqual(own);
		expect(await refusal(scratch(profileTable)(["--profile", "my profile", "go", "x", "--where", OWN_HEX]))).toBeNull();
		expect(await refusal(scratch(profileTable)(["--profile", "my profile", "go", "x", "--where", other.publicKey]))).toBeNull();
	});
});

// ------------------------------------------------------------------------- profile names

describe("a profile name", () => {
	it("is 1 to 32 letters, digits, dash, underscore and dot, and not . or ..", () => {
		expect(PROFILE_NAME_MAX).toBe(32);
		const good = ["default", "work", "a", "A1", "n8n-demo", "demo_requester", "v1.2", "claude-company-memory", ".hidden", "a..b", "x".repeat(32), "_", "-", "..."];
		const bad: Array<[string, string]> = [
			["empty", ""],
			["a dot", "."],
			["two dots", ".."],
			["too long", "x".repeat(33)],
			["a slash", "a/b"],
			["a path up", "../x"],
			["a path down", "x/.."],
			["an absolute path", "/etc"],
			["a backslash", "a\\b"],
			["a space", "my profile"],
			["a trailing space", "work "],
			["an at sign", "work@acme"],
			["a colon", "a:b"],
			["a non-ASCII letter", "café"],
			["a line feed", "a\nb"],
			["a null character", "a\u0000b"],
			["a tilde", "~"],
			["a nsec1 key", NSEC],
			["64 hex digits", STRANGER_HEX],
		];
		for (const name of good) {
			expect(isValidProfileName(name), name).toBe(true);
		}
		for (const [why, name] of bad) {
			expect(isValidProfileName(name), why).toBe(false);
		}
	});

	it("is refused with one fixed message that holds no part of the name", async () => {
		const profileTable: SlotTable = { "(program)": { "--profile": { kind: "identifier", profileName: true } }, go: { "<thing>": "freeText" } };
		for (const name of ["../escape", "a/b", "my profile", "x".repeat(33), "..", "é"]) {
			const result = await refusal(scratch(profileTable)(["--profile", name, "go", "x"]));
			expect(result, name).toEqual({
				message: 'The value of `--profile` is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.',
				exitCode: 2,
			});
			if (name.length > 2) {
				expect(result?.message).not.toContain(name);
			}
		}
		expect(await refusal(scratch(profileTable)(["--profile", "work", "go", "x"]))).toBeNull();
	});
});
