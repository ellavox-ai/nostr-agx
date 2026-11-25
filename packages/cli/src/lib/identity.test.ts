import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "./identity.js";
import { identityPath } from "./paths.js";

// saveIdentity writes the one file that holds an agent's secret key. Two
// processes that save an identity for the same profile at the same moment must
// not both succeed: the file is created only if nothing is there, and the key
// that is already there stays. Replacing a key is still possible, but only when
// the caller asks for it. No check below compares two keys with toBe: a failing
// assertion prints both sides, and a secret key must not end up in a test log.

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => box.restore());

const stored = () => loadIdentityFile("default");
const files = () => readdirSync(dirname(identityPath("default"))).sort();
const mode = (path: string) => statSync(path).mode & 0o777;

describe("saving the identity of a profile that has none", () => {
	it("writes the identity as JSON that loads back unchanged", () => {
		const first = createIdentity();
		saveIdentity("default", first);
		expect(readFileSync(identityPath("default"), "utf8") === `${JSON.stringify(first, null, 2)}\n`).toBe(true);
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(true);
		expect(stored().publicKey).toBe(first.publicKey);
		expect(stored().npub).toBe(first.npub);
		expect(stored().source).toBe("generated");
	});

	it("makes the file private (0600) in a private folder (0700) and leaves no temporary file", () => {
		saveIdentity("default", createIdentity());
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(mode(dirname(identityPath("default")))).toBe(0o700);
		expect(files()).toEqual(["identity.json"]);
	});

	it("keeps the file private whatever the process umask is", () => {
		const before = process.umask(0o000);
		try {
			saveIdentity("default", createIdentity());
		} finally {
			process.umask(before);
		}
		expect(mode(identityPath("default"))).toBe(0o600);
	});

	it("can be asked to replace, and then still just writes", () => {
		const first = createIdentity();
		saveIdentity("default", first, { replace: true });
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(true);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});
});

describe("saving the identity of a profile that already has one", () => {
	it("refuses, and the key that is there stays exactly as it was", () => {
		const first = createIdentity();
		const second = createIdentity();
		saveIdentity("default", first);
		const before = readFileSync(identityPath("default"));
		expect(() => saveIdentity("default", second)).toThrow();
		expect(readFileSync(identityPath("default")).equals(before)).toBe(true);
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(true);
		expect(mode(identityPath("default"))).toBe(0o600);
	});

	it("leaves no temporary file behind when it refuses", () => {
		saveIdentity("default", createIdentity());
		expect(() => saveIdentity("default", createIdentity())).toThrow();
		expect(files()).toEqual(["identity.json"]);
	});

	it("keeps the first of several saves, and refuses every later one", () => {
		const first = createIdentity();
		saveIdentity("default", first);
		for (let i = 0; i < 3; i++) {
			expect(() => saveIdentity("default", createIdentity())).toThrow();
		}
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(true);
		expect(files()).toEqual(["identity.json"]);
	});

	it("refuses even when the file that is there cannot be read as an identity", () => {
		saveIdentity("default", createIdentity());
		// A half-written or damaged file is still somebody's file: it is not overwritten silently.
		writeFileSync(identityPath("default"), "{ not json", { mode: 0o600 });
		expect(() => saveIdentity("default", createIdentity())).toThrow();
		expect(readFileSync(identityPath("default"), "utf8")).toBe("{ not json");
	});

	it("says nothing about either key when it refuses", () => {
		const first = createIdentity();
		const second = createIdentity();
		saveIdentity("default", first);
		const attempt = () => saveIdentity("default", second);
		expect(attempt).toThrow();
		let message = "";
		try {
			attempt();
		} catch (error) {
			message = String((error as Error).stack ?? error);
		}
		expect(message.includes(first.secretKeyHex)).toBe(false);
		expect(message.includes(second.secretKeyHex)).toBe(false);
	});

	it("replaces it when asked to, and the new file is private too", () => {
		const first = createIdentity();
		const second = createIdentity();
		saveIdentity("default", first);
		saveIdentity("default", second, { replace: true });
		expect(stored().secretKeyHex === second.secretKeyHex).toBe(true);
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(false);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});

	it("treats replace: false like no option at all: it refuses", () => {
		const first = createIdentity();
		saveIdentity("default", first);
		const before = readFileSync(identityPath("default"));
		expect(() => saveIdentity("default", createIdentity(), { replace: false })).toThrow();
		expect(() => saveIdentity("default", createIdentity(), {})).toThrow();
		expect(readFileSync(identityPath("default")).equals(before)).toBe(true);
	});

	it("replaces a file that is too open with a private one when asked to", () => {
		saveIdentity("default", createIdentity());
		chmodSync(identityPath("default"), 0o644);
		const second = createIdentity();
		saveIdentity("default", second, { replace: true });
		expect(stored().secretKeyHex === second.secretKeyHex).toBe(true);
		expect(mode(identityPath("default"))).toBe(0o600);
	});
});

describe("saving identities for different profiles", () => {
	it("does not let one profile's identity get in the way of another's", () => {
		const a = createIdentity();
		const b = createIdentity();
		saveIdentity("alpha", a);
		saveIdentity("beta", b);
		expect(loadIdentityFile("alpha").secretKeyHex === a.secretKeyHex).toBe(true);
		expect(loadIdentityFile("beta").secretKeyHex === b.secretKeyHex).toBe(true);
	});
});
