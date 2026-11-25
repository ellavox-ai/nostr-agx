import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agx, sandbox } from "../test/helpers.js";
import { relayMetaPath } from "../relay/cert.js";
import { AgxCliError, EXIT } from "./errors.js";
import {
	agxHome,
	configPath,
	credentialsPath,
	gatewayKeysPath,
	gatewaySubscriptionsPath,
	gatewayTaskOperationsPath,
	identityPath,
	lockPath,
	pendingLoginLockPath,
	pendingLoginPath,
	profileDir,
	seenPath,
	statePath,
} from "./paths.js";

// AGX_HOME names the one folder that holds config.json, credentials.json and
// every identity. Set but empty (or only whitespace) it names no folder, and
// joining "config.json" onto it gives a path in whatever folder agx was started
// from. That must stop with a plain message instead, and never fall back to
// ~/.agx either: a script that meant a private folder should not land on the
// real one.

let box: ReturnType<typeof sandbox>;
let startedIn: string;
let here: string;
let fakeHome: string;

beforeEach(() => {
	box = sandbox();
	// Start in an empty folder of our own, so a file written "here" is seen and is
	// never written into the repository; and point ~ at an empty folder so a
	// fall back to ~/.agx is seen too.
	startedIn = process.cwd();
	here = mkdtempSync(join(tmpdir(), "agx-paths-here-"));
	fakeHome = mkdtempSync(join(tmpdir(), "agx-paths-user-"));
	process.chdir(here);
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
	process.chdir(startedIn);
	box.restore();
	rmSync(here, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
});

function thrown(fn: () => unknown): AgxCliError {
	try {
		fn();
	} catch (error) {
		return error as AgxCliError;
	}
	throw new Error("expected the call to throw");
}

const BLANK = [
	["empty", ""],
	["spaces", "   "],
	["a tab", "\t"],
	["a newline between spaces", " \n "],
] as const;

describe("agxHome", () => {
	it("uses ~/.agx when AGX_HOME is not set", () => {
		delete process.env.AGX_HOME;
		expect(agxHome()).toBe(join(fakeHome, ".agx"));
		expect(configPath()).toBe(join(fakeHome, ".agx", "config.json"));
	});

	it("uses an absolute AGX_HOME as it is", () => {
		process.env.AGX_HOME = box.home;
		expect(agxHome()).toBe(box.home);
		expect(configPath()).toBe(join(box.home, "config.json"));
		expect(credentialsPath()).toBe(join(box.home, "credentials.json"));
		expect(identityPath("p")).toBe(join(box.home, "profiles", "p", "identity.json"));
	});

	it("does not trim an AGX_HOME that has text in it", () => {
		process.env.AGX_HOME = " sp ";
		expect(agxHome()).toBe(" sp ");
	});

	it("keeps a relative AGX_HOME relative", () => {
		process.env.AGX_HOME = "relative-home";
		expect(agxHome()).toBe("relative-home");
		expect(configPath()).toBe(join("relative-home", "config.json"));
	});

	it.each(BLANK)("refuses an AGX_HOME that is %s, and says what to do", (_label, value) => {
		process.env.AGX_HOME = value;
		const error = thrown(() => agxHome());
		expect(error).toBeInstanceOf(AgxCliError);
		expect(error.exitCode).toBe(EXIT.config);
		expect(error.message).toMatch(/^AGX_HOME is set but empty/);
		expect(error.remediation).toMatch(/unset AGX_HOME/);
	});

	it("says whitespace, and does not suggest the real ~/.agx folder as the example", () => {
		process.env.AGX_HOME = "\t";
		const error = thrown(() => agxHome());
		expect(error.message).toContain("(or only whitespace)");
		expect(error.remediation).toContain("export AGX_HOME=/path/to/a/folder");
		expect(error.remediation).not.toContain("export AGX_HOME=$HOME/.agx");
	});

	it.each([
		["configPath", () => configPath()],
		["credentialsPath", () => credentialsPath()],
		["profileDir", () => profileDir("p")],
		["identityPath", () => identityPath("p")],
		["statePath", () => statePath("p")],
		["seenPath", () => seenPath("p")],
		["lockPath", () => lockPath("p")],
		["pendingLoginPath", () => pendingLoginPath("p")],
		["pendingLoginLockPath", () => pendingLoginLockPath("p")],
		["gatewayKeysPath", () => gatewayKeysPath("p")],
		["gatewaySubscriptionsPath", () => gatewaySubscriptionsPath("p")],
		["gatewayTaskOperationsPath", () => gatewayTaskOperationsPath("p")],
		["relayMetaPath (the relay folder)", () => relayMetaPath()],
	])("%s gives no path while AGX_HOME is empty", (_name, path) => {
		process.env.AGX_HOME = "";
		expect(thrown(path).exitCode).toBe(EXIT.config);
	});
});

describe("agx with an empty AGX_HOME", () => {
	it.each([
		["identity new", ["identity", "new"]],
		["identity show", ["identity", "show"]],
		["config use", ["config", "use", "demo"]],
		["config path", ["config", "path"]],
		["config show", ["config", "show"]],
	])("%s stops with a message and writes nothing", async (_name, args) => {
		process.env.AGX_HOME = "";

		const run = await agx(...args);

		expect(run.code).toBe(EXIT.config);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("AGX_HOME is set but empty");
		expect(readdirSync(here)).toEqual([]);
		expect(existsSync(join(fakeHome, ".agx"))).toBe(false);
	});

	it("stops the same way when AGX_HOME is only spaces", async () => {
		process.env.AGX_HOME = "   ";

		const run = await agx("identity", "new");

		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toContain("AGX_HOME is set but empty");
		expect(readdirSync(here)).toEqual([]);
		expect(existsSync(join(fakeHome, ".agx"))).toBe(false);
	});

	it("still stores the identity under ~/.agx when AGX_HOME is not set", async () => {
		delete process.env.AGX_HOME;

		const run = await agx("identity", "new");

		expect(run.code).toBe(EXIT.ok);
		expect(existsSync(join(fakeHome, ".agx", "profiles", "default", "identity.json"))).toBe(true);
		expect(readdirSync(here)).toEqual([]);
	});

	it("still stores the identity under an absolute AGX_HOME", async () => {
		process.env.AGX_HOME = box.home;

		const run = await agx("identity", "new");

		expect(run.code).toBe(EXIT.ok);
		expect(existsSync(join(box.home, "profiles", "default", "identity.json"))).toBe(true);
		expect(readdirSync(here)).toEqual([]);
		expect(existsSync(join(fakeHome, ".agx"))).toBe(false);
	});

	it("still stores the identity under a relative AGX_HOME, inside the current folder", async () => {
		process.env.AGX_HOME = "relative-home";

		const run = await agx("identity", "new");

		expect(run.code).toBe(EXIT.ok);
		expect(existsSync(join(here, "relative-home", "profiles", "default", "identity.json"))).toBe(true);
		expect(readdirSync(here)).toEqual(["relative-home"]);
	});
});
