import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, saveProfile } from "../lib/config.js";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// A profile name becomes a folder under `AGX_HOME/profiles/`, and that folder
// holds the identity file with the secret key. A name that is not one plain
// folder name (empty, `.`, `..`, or with a `/` or `\` in it) puts the files
// somewhere else: next to config.json, outside AGX_HOME, or in a nested folder.

let box: ReturnType<typeof sandbox>;
/** AGX_HOME, one level inside the sandbox folder, so `..` stays inside the sandbox even when the bug is present. */
let home: string;

beforeEach(() => {
	box = sandbox();
	home = join(box.home, "agx-home");
	mkdirSync(home);
	process.env.AGX_HOME = home;
});

afterEach(() => {
	box.restore();
});

/** Every file and folder under the sandbox folder that is outside AGX_HOME. */
const outsideHome = (): string[] =>
	readdirSync(box.home, { recursive: true, encoding: "utf8" }).filter(
		(entry) => entry !== "agx-home" && !entry.startsWith("agx-home/"),
	);

function expectRefusedAndNothingWritten(run: { code: number; stdout: string; stderr: string }): void {
	expect(run.code).toBe(2);
	expect(run.stderr).toMatch(/single folder name/i);
	expect(outsideHome()).toEqual([]);
	expect(readdirSync(home)).toEqual([]);
}

const PATH_LIKE: Array<[string, string]> = [
	["a parent folder", ".."],
	["the current folder", "."],
	["a path out of profiles/", "../escape"],
	["a path out of AGX_HOME", "../../x"],
	["a nested path", "a/b"],
	["a path with a parent in the middle", "a/../b"],
	["an absolute path", "/abs/x"],
	["a path with a backslash", "a\\b"],
	["nothing at all", ""],
];

describe("a profile name that is not one folder name, given with -p", () => {
	it.each(PATH_LIKE)("agx identity new refuses %s and writes nothing", async (_what, name) => {
		const run = await agx("-p", name, "identity", "new");
		expectRefusedAndNothingWritten(run);
		expect(run.stderr).toContain("-p/--profile");
		expect(run.stderr).toContain("agx -p work");
	});

	it.each([
		["config show", ["config", "show"]],
		["config set", ["config", "set", "orgSlug", "acme"]],
		["identity allow --list", ["identity", "allow", "--list"]],
		["whoami", ["whoami"]],
		["logout", ["logout"]],
	])("agx %s refuses a path out of profiles/ and writes nothing", async (_name, args) => {
		expectRefusedAndNothingWritten(await agx("-p", "../escape", ...args));
	});

	it("does not repeat the name it refused", async () => {
		const run = await agx("-p", "../escape-me", "identity", "new");
		expect(run.code).toBe(2);
		expect(run.stdout + run.stderr).not.toContain("escape-me");
	});

	it("gives the -p advice, not the AGX_PROFILE advice, when AGX_PROFILE is set to a good name too", async () => {
		process.env.AGX_PROFILE = "work";
		const run = await agx("-p", "../escape", "identity", "new");
		expectRefusedAndNothingWritten(run);
		expect(run.stderr).toContain("-p/--profile");
		expect(run.stderr).toContain("agx -p work");
		expect(run.stderr).not.toContain("unset AGX_PROFILE");
	});

	it("also refuses it in JSON mode", async () => {
		const run = await agx("-p", "../escape", "config", "show", "--json");
		expect(run.code).toBe(2);
		expect(outsideHome()).toEqual([]);
	});
});

describe("the refusal never repeats the name, whichever way it was given", () => {
	it("AGX_PROFILE", async () => {
		process.env.AGX_PROFILE = "../escape-me";
		const run = await agx("identity", "new");
		expect(run.code).toBe(2);
		expect(run.stdout + run.stderr).not.toContain("escape-me");
	});

	it("agx config use", async () => {
		const run = await agx("config", "use", "../escape-me");
		expect(run.code).toBe(2);
		expect(run.stdout + run.stderr).not.toContain("escape-me");
		expect(existsSync(join(home, "config.json"))).toBe(false);
	});
});

describe("a profile name that is not one folder name, given in AGX_PROFILE", () => {
	it.each(PATH_LIKE)("agx identity new refuses %s and writes nothing", async (_what, name) => {
		process.env.AGX_PROFILE = name;
		const run = await agx("identity", "new");
		expectRefusedAndNothingWritten(run);
		expect(run.stderr).toContain("AGX_PROFILE");
		expect(run.stderr).toContain("unset AGX_PROFILE");
		expect(run.stderr).not.toContain("-p/--profile");
	});
});

describe("a profile name that is not one folder name, given to `agx config use`", () => {
	it.each(PATH_LIKE)("refuses %s and stores nothing", async (_what, name) => {
		const run = await agx("config", "use", name);
		expectRefusedAndNothingWritten(run);
		expect(run.stderr).toContain("agx config use work");
		expect(existsSync(join(home, "config.json"))).toBe(false);
	});
});

describe("which name is checked", () => {
	it("-p work wins over a path in AGX_PROFILE, so nothing is refused", async () => {
		process.env.AGX_PROFILE = "../escape";
		const run = await agx("-p", "work", "identity", "new");
		expect(run.code).toBe(0);
		expect(existsSync(join(home, "profiles", "work", "identity.json"))).toBe(true);
		expect(outsideHome()).toEqual([]);
	});

	it("a secret key inside a path is refused as a secret key, without showing it", async () => {
		const nsec = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
		const run = await agx("-p", `../${nsec}`, "identity", "new");
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		expect(run.stdout + run.stderr).not.toContain(nsec.slice(5, 25));
		expect(outsideHome()).toEqual([]);
	});

	it("does not check a profile name already stored by an older agx, so `config use` can still replace it", async () => {
		saveProfile("../escape", getProfile("../escape"));
		expect((await agx("threads")).code).toBe(0);
		const use = await agx("config", "use", "work");
		expect(use.code).toBe(0);
		const show = await agx("config", "show");
		expect(show.code).toBe(0);
		expect(show.stdout).toContain('"work"');
	});
});

describe("an ordinary profile name", () => {
	it.each([
		["a plain name", "work"],
		["digits, dot, dash and underscore", "v1.2_x-y"],
		["a leading dot", ".hidden"],
		["three dots", "..."],
		["a name with a space", "my agent"],
		["a name that only looks like a path", "a..b"],
		["two dots and a space", ".. "],
	])("%s still works with -p", async (_what, name) => {
		const run = await agx("-p", name, "identity", "new");
		expect(run.code).toBe(0);
		expect(existsSync(join(home, "profiles", name, "identity.json"))).toBe(true);
	});

	it("still works in AGX_PROFILE", async () => {
		process.env.AGX_PROFILE = "work";
		expect((await agx("identity", "new")).code).toBe(0);
		expect(existsSync(join(home, "profiles", "work", "identity.json"))).toBe(true);
	});

	it("still works with `agx config use`", async () => {
		const run = await agx("config", "use", "work");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain('"work"');
	});
});
