import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// Every command that takes a peer reads it through toHexPubkey. A secret key
// pasted into that slot must be refused without being printed in full to a
// terminal, a log or an agent's context.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const friend = createIdentity();
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

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
	updateProfile("default", { allow: [friend.publicKey] });
});

afterEach(() => {
	box.restore();
});

describe("a secret key given where a peer belongs", () => {
	it.each([
		["agx send", ["send", NSEC, "hello"]],
		["agx identity allow", ["identity", "allow", NSEC]],
		["agx identity deny", ["identity", "deny", NSEC]],
		["agx held allow", ["held", "allow", NSEC]],
		["agx held block", ["held", "block", NSEC]],
		["agx card", ["card", NSEC]],
	])("%s refuses it and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NSEC);
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});

	it("leaves the allowlist as it was", async () => {
		await agx("identity", "allow", NSEC);
		await agx("identity", "deny", NSEC);
		await agx("held", "allow", NSEC);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("identity", "allow", NSEC, "--json");
		expect(run.code).toBe(2);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});
