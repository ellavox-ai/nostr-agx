import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveProfile, getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { identityPath } from "../lib/paths.js";
import { isOwnSecretKey, refuseOwnSecretKey } from "../lib/peer.js";
import { agx, sandbox } from "../test/helpers.js";

// A secret key is also 64 hex characters, so `agx` cannot tell one from a public key by its shape. The one
// secret key it compares is the active profile's own, from that profile's identity file. Given as a peer, that
// key must be refused without being shown, or it is stored in config.json or held.jsonl, printed back as an npub
// that decodes to the same bytes, sent as the recipient of a message, or put in a request to a relay.

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	publishMessage: vi.fn(),
	fetchByAuthor: vi.fn(),
	stop: vi.fn(async () => undefined),
}));

vi.mock("../lib/transport.js", () => ({
	createTransport: mocks.createTransport,
	makeLogger: () => undefined,
}));

vi.mock("@nostr-agx/nostr", async (importOriginal) => ({
	...(await importOriginal<typeof import("@nostr-agx/nostr")>()),
	fetchByAuthor: mocks.fetchByAuthor,
}));

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const friend = createIdentity();
const other = createIdentity();

/** Every way the secret key could be written down: its hex, and the npub and nsec that carry the same bytes. */
function formsOf(secretHex: string): string[] {
	const bytes = hexToBytes(secretHex);
	return [secretHex, nip19.npubEncode(secretHex), nip19.nsecEncode(bytes)];
}

/** The first 10-character stretch of the key (data part only, in any case, in any written form) found in `shown`; null if none. */
function leakedPart(shown: string, secretHex: string): string | null {
	const text = shown.toLowerCase();
	for (const form of formsOf(secretHex)) {
		const key = form.toLowerCase();
		const from = form === secretHex ? 0 : 5;
		for (let i = from; i + 10 <= key.length; i++) {
			if (text.includes(key.slice(i, i + 10))) {
				return key.slice(i, i + 10);
			}
		}
	}
	return null;
}

/** The first 10-character stretch of the key found in any file under `dir` except the identity files; null if none. */
function leakedOnDisk(dir: string, secretHex: string): string | null {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const found = leakedOnDisk(path, secretHex);
			if (found !== null) {
				return found;
			}
		} else if (entry.name !== "identity.json") {
			const found = leakedPart(readFileSync(path, "utf8"), secretHex);
			if (found !== null) {
				return found;
			}
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
	vi.clearAllMocks();
	mocks.createTransport.mockImplementation(async () => ({
		publishMessage: mocks.publishMessage,
		stop: mocks.stop,
	}));
	mocks.publishMessage.mockResolvedValue({
		ok: true,
		eventId: "evt1",
		contextId: "ctx1",
		accepted: 1,
		total: 1,
		rejected: [],
		errors: [],
	});
	mocks.fetchByAuthor.mockResolvedValue([]);
	saveIdentity("default", mine);
	saveIdentity("other", other);
	updateProfile("default", { allow: [friend.publicKey] });
});

afterEach(() => {
	process.exitCode = undefined;
	box.restore();
});

describe("this profile's own secret key given where a peer belongs", () => {
	it.each([
		["agx identity allow", (key: string) => ["identity", "allow", key]],
		["agx held allow", (key: string) => ["held", "allow", key]],
		["agx held ignore", (key: string) => ["held", "ignore", key]],
		["agx held block", (key: string) => ["held", "block", key]],
		["agx send", (key: string) => ["send", key, "hello"]],
		["agx request", (key: string) => ["request", key, "agx.ping", "--timeout", "1000"]],
		["agx card", (key: string) => ["card", key]],
	])("%s refuses it, prints none of it, and reaches no relay", async (_name, argsFor) => {
		const run = await agx(...argsFor(mine.secretKeyHex));
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
		expect(mocks.createTransport).not.toHaveBeenCalled();
		expect(mocks.publishMessage).not.toHaveBeenCalled();
		expect(mocks.fetchByAuthor).not.toHaveBeenCalled();
		expect(leakedOnDisk(box.home, mine.secretKeyHex)).toBeNull();
	});

	it("is refused however it is written: upper case, padded, or as the npub that carries the same bytes", async () => {
		for (const form of [
			mine.secretKeyHex.toUpperCase(),
			`  ${mine.secretKeyHex}  `,
			nip19.npubEncode(mine.secretKeyHex),
		]) {
			const run = await agx("identity", "allow", form);
			expect(run.code, form).toBe(2);
			expect(run.stderr).toMatch(/own secret key/i);
			for (const out of [run.stdout, run.stderr]) {
				expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
			}
		}
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("stores nothing: not the key, and not a valid peer given with it", async () => {
		await agx("identity", "allow", mine.secretKeyHex);
		await agx("identity", "allow", createIdentity().publicKey, mine.secretKeyHex);
		await agx("held", "allow", mine.secretKeyHex);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("prints no part of it in JSON mode either", async () => {
		const run = await agx("identity", "allow", mine.secretKeyHex, "--json");
		expect(run.code).toBe(2);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
	});

	it("is refused when the identity file is readable by others, the one case `loadIdentity` itself refuses", async () => {
		chmodSync(identityPath("default"), 0o644);
		const run = await agx("identity", "allow", mine.secretKeyHex);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		expect(run.stderr).not.toMatch(/readable by other users/);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("is refused when the identity file was edited by hand and holds the key in upper case", async () => {
		const file = JSON.parse(readFileSync(identityPath("default"), "utf8")) as Record<string, unknown>;
		file.secretKeyHex = mine.secretKeyHex.toUpperCase();
		writeFileSync(identityPath("default"), JSON.stringify(file), { mode: 0o600 });
		const run = await agx("identity", "allow", mine.secretKeyHex);
		expect(run.code).toBe(2);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("is the key of the profile named with --profile that is refused", async () => {
		const run = await agx("--profile", "other", "identity", "allow", other.secretKeyHex);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		expect(effectiveProfile("other").allow).toEqual([]);
	});
});

// An entry for this key may have been stored by an earlier agx, and `identity deny` is how it is taken out.
// It must do that without printing the key back, which is what an npub of it would be.
describe("identity deny with this profile's own secret key", () => {
	it("takes the entry out and prints none of the key, however it is written", async () => {
		for (const form of [
			mine.secretKeyHex,
			mine.secretKeyHex.toUpperCase(),
			`  ${mine.secretKeyHex}  `,
			nip19.npubEncode(mine.secretKeyHex),
		]) {
			updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
			const run = await agx("identity", "deny", form);
			expect(run.code, form).toBe(0);
			for (const out of [run.stdout, run.stderr]) {
				expect(leakedPart(out, mine.secretKeyHex), form).toBeNull();
			}
			expect(getProfile("default").allow, form).toEqual([friend.publicKey]);
		}
	});

	it("prints none of the key when it was never on the list, and leaves the list as it was", async () => {
		const run = await agx("identity", "deny", mine.secretKeyHex);
		expect(run.code).toBe(0);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("prints none of the key in JSON mode either", async () => {
		updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
		const run = await agx("identity", "deny", mine.secretKeyHex, "--json");
		expect(run.code).toBe(0);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
	});

	it("names a valid peer as before, and this profile's own public key too", async () => {
		updateProfile("default", { allow: [friend.publicKey, mine.publicKey] });
		const denied = await agx("identity", "deny", friend.npub, mine.npub);
		expect(denied.code).toBe(0);
		expect(denied.stdout).toContain(`Removed ${friend.npub} from the allowlist.`);
		expect(denied.stdout).toContain(`Removed ${mine.npub} from the allowlist.`);
		expect(getProfile("default").allow).toEqual([]);
	});

	it("held block does not do this job: it refuses, and the stored entry stays until identity deny takes it out", async () => {
		updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
		const run = await agx("held", "block", mine.secretKeyHex);
		expect(run.code).toBe(2);
		expect(getProfile("default").allow).toEqual([friend.publicKey, mine.secretKeyHex]);
		expect((await agx("identity", "deny", mine.secretKeyHex)).code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});
});

// What this step does not change: ordinary input, and the keys it cannot tell from a public key.
describe("input that is still accepted", () => {
	it("a valid npub and a valid hex pubkey are allowed as before", async () => {
		const a = createIdentity();
		const b = createIdentity();
		const run = await agx("identity", "allow", a.npub, b.publicKey);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey, a.publicKey, b.publicKey]);
	});

	it("a recipient and an agent that are not this profile's secret key are still used", async () => {
		const sent = await agx("send", friend.npub, "hello");
		expect(sent.code).toBe(0);
		expect(mocks.publishMessage).toHaveBeenCalledWith(friend.publicKey, expect.anything());
		await agx("card", friend.npub);
		expect(mocks.fetchByAuthor).toHaveBeenCalled();
	});

	it("this profile's own public key is not refused by this change", async () => {
		const run = await agx("identity", "allow", mine.npub);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toContain(mine.publicKey);
	});

	it("the secret key of another profile is not recognised, so it is used like a public key: only the active profile's own is compared", async () => {
		const run = await agx("identity", "allow", other.secretKeyHex);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toContain(other.secretKeyHex);
		const inTheOther = await agx("--profile", "other", "identity", "allow", mine.secretKeyHex);
		expect(inTheOther.code).toBe(0);
	});

	it("identity deny still takes such an entry out, which an earlier agx may have stored", async () => {
		updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
		expect((await agx("identity", "deny", mine.secretKeyHex)).code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("held ignore and held block still work for a valid peer", async () => {
		const ignored = await agx("held", "ignore", friend.npub);
		expect(ignored.code).toBe(0);
		expect(ignored.stdout).toContain(`Ignored ${friend.npub}`);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
		const blocked = await agx("held", "block", friend.npub);
		expect(blocked.code).toBe(0);
		expect(blocked.stdout).toContain(`Blocked ${friend.npub}`);
		expect(getProfile("default").allow).toEqual([]);
	});

	it("a profile with no identity yet can still allow a peer", async () => {
		const run = await agx("--profile", "fresh", "identity", "allow", friend.publicKey);
		expect(run.code).toBe(0);
		expect(effectiveProfile("fresh").allow).toEqual([friend.publicKey]);
	});

	it("an identity file that cannot be read does not stop identity allow", async () => {
		mkdirSync(dirname(identityPath("broken")), { recursive: true });
		writeFileSync(identityPath("broken"), "not json", { mode: 0o600 });
		const run = await agx("--profile", "broken", "identity", "allow", friend.publicKey);
		expect(run.code).toBe(0);
		expect(effectiveProfile("broken").allow).toEqual([friend.publicKey]);
	});
});

describe("refuseOwnSecretKey", () => {
	it("throws a usage error that does not contain the key, in any written form", () => {
		for (const form of formsOf(mine.secretKeyHex)) {
			if (form.startsWith("nsec1")) {
				continue;
			}
			let message = "";
			try {
				refuseOwnSecretKey(form, "default", "peer");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message, form).toMatch(/^The peer you gave is this profile's own secret key/);
			expect(leakedPart(message, mine.secretKeyHex)).toBeNull();
		}
	});

	it("takes its wording from the label it is given", () => {
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "default", "recipient")).toThrow(/^The recipient you gave/);
	});

	it("returns for anything that is not this profile's secret key", () => {
		for (const input of [friend.publicKey, friend.npub, mine.publicKey, mine.npub, "hello", "", "nostr:npub1abc"]) {
			expect(() => refuseOwnSecretKey(input, "default")).not.toThrow();
		}
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "other")).not.toThrow();
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "profile-without-identity")).not.toThrow();
	});
});

describe("isOwnSecretKey", () => {
	it("is true for this profile's secret key however it is written", () => {
		for (const form of [
			mine.secretKeyHex,
			mine.secretKeyHex.toUpperCase(),
			`  ${mine.secretKeyHex}  `,
			nip19.npubEncode(mine.secretKeyHex),
		]) {
			expect(isOwnSecretKey(form, "default"), form).toBe(true);
		}
	});

	it("is false for anything else, and where there is no identity to compare with", () => {
		for (const input of [friend.publicKey, friend.npub, mine.publicKey, mine.npub, other.secretKeyHex, "hello", "", "nostr:npub1abc"]) {
			expect(isOwnSecretKey(input, "default"), input).toBe(false);
		}
		expect(isOwnSecretKey(mine.secretKeyHex, "other")).toBe(false);
		expect(isOwnSecretKey(mine.secretKeyHex, "profile-without-identity")).toBe(false);
		mkdirSync(dirname(identityPath("broken")), { recursive: true });
		writeFileSync(identityPath("broken"), "not json", { mode: 0o600 });
		expect(isOwnSecretKey(mine.secretKeyHex, "broken")).toBe(false);
	});
});
