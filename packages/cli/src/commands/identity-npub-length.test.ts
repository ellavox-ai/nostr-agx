import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProfile, updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { setJsonMode } from "../lib/output.js";
import { agx, sandbox } from "../test/helpers.js";

// An npub is bech32 for exactly 32 bytes. nostr-tools encodes and decodes one of any length, so
// `agx` has to check the length itself, or a junk entry lands in the allowlist and `send` fails later.

let box: ReturnType<typeof sandbox>;

beforeEach(async () => {
	box = sandbox();
	await agx("identity", "new");
});

afterEach(() => {
	setJsonMode(false);
	process.exitCode = undefined;
	box.restore();
});

describe("a peer given as an npub that does not carry 32 bytes", () => {
	it.each([20, 33])("identity allow refuses an npub that carries %i bytes and stores nothing", async (bytes) => {
		const run = await agx("identity", "allow", toNpub("ab".repeat(bytes)));
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("is not a valid peer");
		expect(effectiveProfile("default").allow).toEqual([]);
	});

	it("identity allow stores nothing from a list when one entry is the wrong length", async () => {
		const run = await agx("identity", "allow", toNpub("cd".repeat(32)), toNpub("ab".repeat(20)));
		expect(run.code).toBe(EXIT.usage);
		expect(effectiveProfile("default").allow).toEqual([]);
	});

	it("identity deny refuses it too", async () => {
		const run = await agx("identity", "deny", toNpub("ab".repeat(20)));
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("is not a valid peer");
	});

	it("an npub that carries 32 bytes is still allowed", async () => {
		const run = await agx("identity", "allow", toNpub("cd".repeat(32)));
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual(["cd".repeat(32)]);
	});
});

// An older agx accepted an npub that does not carry 32 bytes and stored the hex of what came out.
// That entry matches no sender, `identity allow --list` shows it as hex, and `agx inbox` refuses to
// start while it is there. Refusing new ones is not enough: `identity deny` has to take an old one out.
describe("an allowlist entry stored by an older agx for an npub of the wrong length", () => {
	const GOOD = "cd".repeat(32);
	const JUNK = "ab".repeat(20);

	beforeEach(() => {
		updateProfile("default", { allow: [GOOD, JUNK] });
	});

	it("identity deny takes it out when it is given as listed", async () => {
		const run = await agx("identity", "deny", JUNK);
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual([GOOD]);
	});

	it("identity deny of a valid peer still removes only that peer", async () => {
		const run = await agx("identity", "deny", toNpub(GOOD));
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual([JUNK]);
	});

	it("identity deny matches the listed entry whatever its case", async () => {
		const run = await agx("identity", "deny", JUNK.toUpperCase());
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual([GOOD]);
	});

	it("identity deny never matches part of an entry", async () => {
		for (const part of [JUNK.slice(0, -1), JUNK.slice(0, 4), JUNK.slice(1)]) {
			const run = await agx("identity", "deny", part);
			expect(run.code).toBe(EXIT.usage);
		}
		expect(effectiveProfile("default").allow).toEqual([GOOD, JUNK]);
	});

	it("identity deny of a valid peer never takes out an entry that only contains it", async () => {
		const longer = "ab".repeat(32);
		updateProfile("default", { allow: [JUNK, longer] });
		const run = await agx("identity", "deny", longer);
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual([JUNK]);
	});

	it("identity deny still refuses hex of the wrong length that is not on the list", async () => {
		const run = await agx("identity", "deny", "12".repeat(20));
		expect(run.code).toBe(EXIT.usage);
		expect(effectiveProfile("default").allow).toEqual([GOOD, JUNK]);
	});

	it("identity deny still refuses text that is neither hex nor an npub", async () => {
		const run = await agx("identity", "deny", "not-a-peer");
		expect(run.code).toBe(EXIT.usage);
		expect(effectiveProfile("default").allow).toEqual([GOOD, JUNK]);
	});

	it("identity allow still refuses it as a new entry", async () => {
		const run = await agx("identity", "allow", "12".repeat(20));
		expect(run.code).toBe(EXIT.usage);
		expect(effectiveProfile("default").allow).toEqual([GOOD, JUNK]);
	});
});
