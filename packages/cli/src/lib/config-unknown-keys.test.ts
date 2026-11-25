import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agx, sandbox } from "../test/helpers.js";
import { configSchema, getProfile, profileSchema, saveConfig, updateProfile } from "./config.js";
import { AgxCliError, EXIT } from "./errors.js";

/**
 * `config.json` can carry keys this version does not know (a newer version
 * wrote them, or someone added them by hand). Saving config must write back
 * what it read plus its own change, so those keys are still there afterwards.
 */

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
});
afterEach(() => box.restore());

const file = () => join(box.home, "config.json");
const text = () => readFileSync(file(), "utf8");
const readConfig = () => JSON.parse(text());

function writeConfig(value: unknown, mode = 0o600): void {
	writeRaw(`${JSON.stringify(value, null, 2)}\n`, mode);
}

function writeRaw(content: string, mode = 0o600): void {
	writeFileSync(file(), content, { mode });
	chmodSync(file(), mode);
}

const FUTURE_TOP = { theme: "dark", nested: { list: [1, "two", null, true] }, n: 7 };
const FUTURE_ALPHA = { color: "red", list: [1, 2], empty: null, flag: false };

/** What a newer version, or a person, might have left in the file. */
function handMade() {
	return {
		version: 1,
		currentProfile: "alpha",
		futureTopLevel: FUTURE_TOP,
		profiles: {
			alpha: {
				apiBaseUrl: "http://localhost:3000",
				orgSlug: "acme",
				relays: ["ws://127.0.0.1:9"],
				// The second entry is neither an npub nor a hex key.
				allow: ["aa", "not-a-key"],
				futureAlpha: "keep-alpha",
				nick: FUTURE_ALPHA,
			},
			beta: { orgSlug: "beta-org", futureBeta: false },
		},
	};
}

describe("saving config keeps the keys this version does not know", () => {
	it("keeps an unknown top-level key, value for value", () => {
		writeConfig(handMade());
		updateProfile("alpha", { nip05: "bot@acme.com" });
		expect(readConfig().futureTopLevel).toEqual(FUTURE_TOP);
	});

	it("keeps the unknown keys of the profile that is saved", () => {
		writeConfig(handMade());
		updateProfile("alpha", { nip05: "bot@acme.com" });
		const { alpha } = readConfig().profiles;
		expect(alpha.futureAlpha).toBe("keep-alpha");
		expect(alpha.nick).toEqual(FUTURE_ALPHA);
	});

	it("keeps the unknown keys of every other profile, each on its own profile", () => {
		writeConfig(handMade());
		updateProfile("alpha", { nip05: "bot@acme.com" });
		const { alpha, beta } = readConfig().profiles;
		expect(beta.futureBeta).toBe(false);
		expect(beta).not.toHaveProperty("futureAlpha");
		expect(alpha).not.toHaveProperty("futureBeta");
	});

	it("keeps them through the real commands: config set and config use", async () => {
		writeConfig(handMade());

		expect((await agx("config", "set", "relays", "ws://127.0.0.1:9")).code).toBe(EXIT.ok);
		expect((await agx("config", "use", "beta")).code).toBe(EXIT.ok);

		const saved = readConfig();
		expect(saved.currentProfile).toBe("beta");
		expect(saved.futureTopLevel).toEqual(FUTURE_TOP);
		expect(saved.profiles.alpha.futureAlpha).toBe("keep-alpha");
		expect(saved.profiles.alpha.nick).toEqual(FUTURE_ALPHA);
		expect(saved.profiles.beta.futureBeta).toBe(false);
	});

	it("keeps an unknown key named __proto__ as a plain key and changes no prototype", () => {
		writeRaw(
			'{"version":1,"currentProfile":"alpha","__proto__":{"polluted":true},"profiles":{"alpha":{"__proto__":{"polluted":true}}}}\n',
		);
		updateProfile("alpha", { nip05: "bot@acme.com" });
		const saved = readConfig();
		expect(Object.keys(saved)).toContain("__proto__");
		expect(Object.keys(saved.profiles.alpha)).toContain("__proto__");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("a second save changes nothing: same bytes, unknown keys after the known ones", () => {
		writeConfig(handMade());
		updateProfile("alpha", { nip05: "bot@acme.com" });
		const first = text();
		updateProfile("alpha", { nip05: "bot@acme.com" });
		expect(text()).toBe(first);

		const saved = readConfig();
		expect(Object.keys(saved)).toEqual([...Object.keys(configSchema.shape), "futureTopLevel"]);
		expect(Object.keys(saved.profiles.alpha)).toEqual([
			...Object.keys(profileSchema.shape),
			"futureAlpha",
			"nick",
		]);
	});
});

describe("saving config, what must not change", () => {
	it("the changed value is changed; the other profile's known values stay as they were", () => {
		writeConfig(handMade());
		const betaBefore = getProfile("beta");

		updateProfile("alpha", { relays: ["ws://127.0.0.1:11"] });

		expect(readConfig().profiles.alpha.relays).toEqual(["ws://127.0.0.1:11"]);
		expect(getProfile("alpha").relays).toEqual(["ws://127.0.0.1:11"]);
		expect(getProfile("beta")).toEqual(betaBefore);
	});

	it("the active profile is the one the save named, not one left in the file", async () => {
		writeConfig({ ...handMade(), currentProfile: "alpha" });
		expect((await agx("config", "use", "beta")).code).toBe(EXIT.ok);
		expect(readConfig().currentProfile).toBe("beta");
	});

	it("an allow entry that is not an npub or a hex key is kept as read, in place", () => {
		writeConfig(handMade());
		updateProfile("alpha", { nip05: "bot@acme.com" });
		expect(readConfig().profiles.alpha.allow).toEqual(["aa", "not-a-key"]);
	});

	it("a config with only known keys is rewritten exactly as before", () => {
		writeRaw(
			'{"currentProfile":"alpha","profiles":{"alpha":{"orgSlug":"acme","relays":["ws://127.0.0.1:9"]},"beta":{}},"version":1}',
		);
		updateProfile("alpha", { nip05: "bot@acme.com" });
		const defaults = profileSchema.parse({});
		expect(text()).toBe(
			`${JSON.stringify(
				{
					version: 1,
					currentProfile: "alpha",
					profiles: {
						alpha: { ...defaults, orgSlug: "acme", relays: ["ws://127.0.0.1:9"], nip05: "bot@acme.com" },
						beta: defaults,
					},
				},
				null,
				2,
			)}\n`,
		);
	});

	it.each([
		["a file that is not JSON", "{ not json"],
		["a file that is an array", "[1,2]"],
		["a file that is null", "null"],
		["a file with another version number", '{"version":2,"futureTopLevel":1,"profiles":{}}'],
		[
			"an allow entry that is not text",
			'{"version":1,"currentProfile":"alpha","futureTopLevel":1,"profiles":{"alpha":{"allow":["aa",7,{"npub":"x"}]}}}',
		],
	])("%s is refused (exit 3) and left byte for byte", async (_label, content) => {
		writeRaw(content);
		const run = await agx("config", "set", "relays", "ws://127.0.0.1:9");
		expect(run.code).toBe(EXIT.config);
		expect(text()).toBe(content);
	});

	it("config.json stays private (0600), also when it was wider before", () => {
		writeConfig(handMade(), 0o644);
		updateProfile("alpha", { nip05: "bot@acme.com" });
		expect(statSync(file()).mode & 0o777).toBe(0o600);

		updateProfile("alpha", { nip05: "bot@acme.com" });
		expect(statSync(file()).mode & 0o777).toBe(0o600);
	});
});

describe("saveConfig when the file on disk is not what was read", () => {
	const known = (relays: string[]) =>
		configSchema.parse({ profiles: { alpha: { relays } } });
	const expected = (relays: string[]) =>
		`${JSON.stringify(known(relays), null, 2)}\n`;

	it("a profile the caller left out is not written back; the ones it kept keep their unknown keys", () => {
		writeConfig(handMade());
		saveConfig(known(["ws://127.0.0.1:9"]));
		const saved = readConfig();
		expect(Object.keys(saved.profiles)).toEqual(["alpha"]);
		expect(saved.profiles.alpha.futureAlpha).toBe("keep-alpha");
	});

	it("unknown profile keys go to the profile of the same name, not the one in the same position", () => {
		writeConfig({
			version: 1,
			currentProfile: "alpha",
			profiles: { alpha: { futureAlpha: "a" }, beta: { futureBeta: "b" } },
		});
		saveConfig(configSchema.parse({ profiles: { beta: { relays: ["ws://127.0.0.1:9"] } } }));
		const { profiles } = readConfig();
		expect(Object.keys(profiles)).toEqual(["beta"]);
		expect(profiles.beta.futureBeta).toBe("b");
		expect(profiles.beta).not.toHaveProperty("futureAlpha");
	});

	it("a file that is an array adds no keys of its own (no 0, 1, ...)", () => {
		writeRaw('["a","b"]');
		saveConfig(known(["ws://127.0.0.1:9"]));
		expect(text()).toBe(expected(["ws://127.0.0.1:9"]));
	});

	it("a profile entry that is not an object adds no keys either", () => {
		for (const stored of ["oops", null, ["x"], 5]) {
			writeConfig({ version: 1, profiles: { alpha: stored } });
			saveConfig(known(["ws://127.0.0.1:9"]));
			expect(text()).toBe(expected(["ws://127.0.0.1:9"]));
		}
	});

	it("with no config.json yet, the save creates it as before", () => {
		saveConfig(known(["ws://127.0.0.1:9"]));
		expect(text()).toBe(expected(["ws://127.0.0.1:9"]));
	});

	it("a file that is not JSON is written over as before, with no error from reading it", () => {
		writeRaw("{ not json");
		saveConfig(known(["ws://127.0.0.1:9"]));
		expect(text()).toBe(expected(["ws://127.0.0.1:9"]));
	});
});

describe("a value nested too deeply to write back", () => {
	/** A valid file whose unknown `deep` value is `depth` arrays inside each other. */
	const deepFile = (depth: number) =>
		`{"version":1,"currentProfile":"alpha","deep":${"[".repeat(depth)}${"]".repeat(depth)},"profiles":{"alpha":{"orgSlug":"acme"}}}\n`;

	it("is refused with exit 3, the message does not show it, and the file is left as it was", async () => {
		const content = deepFile(100_000);
		writeRaw(content);
		const run = await agx("config", "set", "relays", "ws://127.0.0.1:9");
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toMatch(/nested too deeply/);
		expect(run.stderr).not.toMatch(/call stack/i);
		expect(run.stderr).not.toContain("[[[[");
		expect(text()).toBe(content);
	});

	it("a command that does not save still works on that file", async () => {
		writeRaw(deepFile(100_000));
		expect((await agx("config", "show")).code).toBe(EXIT.ok);
	});

	it("a value 1000 levels deep is still kept", async () => {
		writeRaw(deepFile(1000));
		expect((await agx("config", "set", "relays", "ws://127.0.0.1:9")).code).toBe(EXIT.ok);
		expect(JSON.stringify(readConfig().deep)).toBe(`${"[".repeat(1000)}${"]".repeat(1000)}`);
	});

	it("a write failure that is not about depth is not reworded", () => {
		mkdirSync(file());
		let thrown: unknown;
		try {
			saveConfig(configSchema.parse({}));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(AgxCliError);
	});
});
