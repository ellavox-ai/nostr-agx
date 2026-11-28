import { bytesToHex, generateKeypair, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { describe, expect, it } from "vitest";
import { identityFromCredentials, parseSecretKey } from "../nodes/shared/identity";

// The credential's secret key is read by the same rule as the CLI's
// `agx identity import`: an `nsec1…` in any case, with or without `nostr:`, or 64 hex
// digits. A key that is refused is never quoted in the message: it lands in the n8n
// editor and in the execution log.
//
// Every key here is made when the test runs, from a throwaway key.

const { secretKey, publicKey } = generateKeypair();
const HEX = bytesToHex(secretKey);
const NSEC = nip19.nsecEncode(secretKey);
const NCRYPTSEC = encrypt(secretKey, "throwaway-password", 4);

/** Every character as `%xx`. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** The first 10-character stretch of the key's data part (not the constant prefix) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string, prefix: number): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = prefix; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("it did not throw");
}

describe("the secret key of the credential", () => {
	it.each([
		["an nsec1…", NSEC],
		["an nsec1… with white space around it", `  ${NSEC}\n`],
		["an nsec1… in capitals", NSEC.toUpperCase()],
		["an nsec1… behind nostr:", `nostr:${NSEC}`],
		["an nsec1… in capitals behind nostr:", `nostr:${NSEC.toUpperCase()}`],
		["an nsec1… behind NOSTR:", `NOSTR:${NSEC}`],
		["64 hex digits", HEX],
		["64 hex digits in capitals", HEX.toUpperCase()],
		["64 hex digits with white space around them", ` \t${HEX}\n`],
	])("is read from %s", (_name, text) => {
		expect(parseSecretKey(text)).toEqual(secretKey);
	});

	it("gives the agent the same identity from any of those", () => {
		for (const text of [NSEC, NSEC.toUpperCase(), `nostr:${NSEC}`, HEX, HEX.toUpperCase()]) {
			const identity = identityFromCredentials({ secretKey: text, relays: "wss://a.example" });
			expect(identity.publicKey).toBe(publicKey);
			expect(identity.npub).toBe(toNpub(publicKey));
		}
	});
});

describe("a secret key the credential refuses", () => {
	it("says an nsec1… that does not decode is not valid, and does not quote it", () => {
		for (const text of [`${NSEC}q`, NSEC.slice(0, 40), `${NSEC.slice(0, 30)}${NSEC[30] === "q" ? "p" : "q"}${NSEC.slice(31)}`]) {
			const message = messageOf(() => parseSecretKey(text));
			expect(message).toBe("The secret key is not a valid nsec1… key.");
			expect(leakedPart(message, NSEC, 5)).toBeNull();
		}
	});

	it("says the same of one in capitals or behind nostr:", () => {
		for (const text of [`${NSEC.toUpperCase()}Q`, `nostr:${NSEC}q`, `nostr:${NSEC.slice(0, 40)}`, `NOSTR:${NSEC.toUpperCase().slice(0, 40)}`]) {
			const message = messageOf(() => parseSecretKey(text));
			expect(message).toBe("The secret key is not a valid nsec1… key.");
			expect(leakedPart(message, NSEC, 5)).toBeNull();
		}
	});

	it("names a public key as the wrong key", () => {
		expect(messageOf(() => parseSecretKey(toNpub(publicKey)))).toMatch(/That is a public key \(npub1…\)/);
	});

	it.each([
		["nothing", ""],
		["a word", "nope"],
		["an encrypted key (ncryptsec1…)", NCRYPTSEC],
		["an nsec1… with every character %xx-escaped", escapeAll(NSEC)],
		["an nsec1… in a sentence", `my key is ${NSEC}`],
		["63 hex digits", HEX.slice(1)],
		["65 hex digits", `${HEX}a`],
		["hex behind nostr:", `nostr:${HEX}`],
	])("says what a key looks like, for %s, and does not quote it", (_name, text) => {
		const message = messageOf(() => parseSecretKey(text));
		expect(message).toBe("The secret key must be an nsec1… key or 64 hexadecimal characters.");
		expect(leakedPart(message, NSEC, 5)).toBeNull();
		expect(leakedPart(message, NCRYPTSEC, 10)).toBeNull();
		expect(message).not.toContain(HEX);
	});
});
