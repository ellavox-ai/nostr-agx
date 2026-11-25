import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, saveProfile } from "../lib/config.js";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// A profile name is printed back by almost every command and becomes a folder
// name under AGX_HOME. A secret key pasted there by mistake must be refused
// before anything is printed or written.

let box: ReturnType<typeof sandbox>;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));

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

/** Every file and folder name under `home`, and the text of every file, as one string per entry. */
function everythingUnder(home: string): string[] {
	const found: string[] = [];
	for (const relative of readdirSync(home, { recursive: true, encoding: "utf8" })) {
		found.push(relative);
		const path = join(home, relative);
		if (statSync(path).isFile()) {
			found.push(readFileSync(path, "utf8"));
		}
	}
	return found;
}

function expectRefusedAndSilent(run: { code: number; stdout: string; stderr: string }, key = NSEC): void {
	expect(run.code).toBe(2);
	expect(run.stderr).toMatch(/secret key/i);
	for (const out of [run.stdout, run.stderr]) {
		expect(out).not.toContain(key);
		expect(leakedPart(out, key)).toBeNull();
	}
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("a secret key given as the profile name with -p", () => {
	it.each([
		["identity new", ["identity", "new"]],
		["identity allow --list", ["identity", "allow", "--list"]],
		["config show", ["config", "show"]],
		["config set", ["config", "set", "orgSlug", "acme"]],
		["logout", ["logout"]],
		["whoami", ["whoami"]],
		["doctor", ["doctor"]],
	])("agx %s refuses it, prints none of it and writes nothing", async (_name, args) => {
		const run = await agx("-p", NSEC, ...args);
		expectRefusedAndSilent(run);
		expect(run.stderr).toContain("-p/--profile");
		expect(run.stderr).toContain("agx -p work");
		expect(existsSync(join(box.home, "profiles"))).toBe(false);
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["after other text", `key=${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		const run = await agx("-p", value, "identity", "new");
		expectRefusedAndSilent(run);
		expect(existsSync(join(box.home, "profiles"))).toBe(false);
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("-p", NSEC, "config", "show", "--json");
		expect(run.code).toBe(2);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});

describe("a secret key given as the profile name in AGX_PROFILE", () => {
	it.each([
		["identity new", ["identity", "new"]],
		["config show", ["config", "show"]],
		["config set", ["config", "set", "orgSlug", "acme"]],
	])("agx %s refuses it, prints none of it and writes nothing", async (_name, args) => {
		process.env.AGX_PROFILE = NSEC;
		const run = await agx(...args);
		expectRefusedAndSilent(run);
		expect(run.stderr).toContain("AGX_PROFILE");
		expect(run.stderr).toContain("unset AGX_PROFILE");
		expect(run.stderr).not.toContain("-p/--profile");
		expect(existsSync(join(box.home, "profiles"))).toBe(false);
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});
});

describe("a secret key given to `agx config use`", () => {
	it("refuses it and stores nothing, so it never becomes the active profile", async () => {
		const run = await agx("config", "use", NSEC);
		expectRefusedAndSilent(run);
		expect(run.stderr).toContain("agx config use");
		expect(run.stderr).toContain("agx config use work");
		expect(run.stderr).not.toContain("-p/--profile");
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});

	it("refuses a key after nostr: too", async () => {
		expectRefusedAndSilent(await agx("config", "use", `nostr:${NSEC}`));
	});
});

describe("which name is checked", () => {
	it("checks the name that is used: -p work wins over a key in AGX_PROFILE, so nothing is refused or shown", async () => {
		process.env.AGX_PROFILE = NSEC;
		const run = await agx("-p", "work", "identity", "new");
		expect(run.code).toBe(0);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(existsSync(join(box.home, "profiles", "work", "identity.json"))).toBe(true);
	});

	it("does not check a profile name already stored by an older agx, so `config use` can still replace it", async () => {
		saveProfile(NSEC, getProfile(NSEC));
		// `threads` resolves the stored active profile and does not print its name.
		expect((await agx("threads")).code).toBe(0);
		const use = await agx("config", "use", "work");
		expect(use.code).toBe(0);
		const show = await agx("config", "show");
		expect(show.code).toBe(0);
		expect(show.stdout).toContain('"work"');
		expect(leakedPart(show.stdout + show.stderr, NSEC)).toBeNull();
	});
});

describe("an ordinary profile name", () => {
	it("still works with -p", async () => {
		const run = await agx("-p", "work", "identity", "new");
		expect(run.code).toBe(0);
		expect(existsSync(join(box.home, "profiles", "work", "identity.json"))).toBe(true);
	});

	it("still works in AGX_PROFILE", async () => {
		process.env.AGX_PROFILE = "work";
		const run = await agx("identity", "new");
		expect(run.code).toBe(0);
		expect(existsSync(join(box.home, "profiles", "work", "identity.json"))).toBe(true);
	});

	it("still works with `agx config use`", async () => {
		const run = await agx("config", "use", "work");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain('"work"');
	});

	it("is not refused for containing the letters nsec without the 1", async () => {
		const run = await agx("-p", "nsec-test", "identity", "new");
		expect(run.code).toBe(0);
	});
});
