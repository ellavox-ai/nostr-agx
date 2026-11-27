import { describe, expect, it } from "vitest";
import { normalizePubkey, shortIdentity, toNpub } from "./address";
import { generateKeypair } from "./keys";

describe("normalizePubkey", () => {
	const { publicKey: hex } = generateKeypair();
	const npub = toNpub(hex);

	it("accepts a 64-char hex pubkey (lowercased)", () => {
		expect(normalizePubkey(hex.toUpperCase())).toBe(hex);
		expect(normalizePubkey(`  ${hex}  `)).toBe(hex);
	});

	it("decodes an npub back to hex", () => {
		expect(normalizePubkey(npub)).toBe(hex);
	});

	it("rejects non-identities", () => {
		expect(normalizePubkey("acme/support")).toBeNull();
		expect(normalizePubkey("https://evil.com/card.json")).toBeNull();
		expect(normalizePubkey("npub1notvalid")).toBeNull();
		expect(normalizePubkey("")).toBeNull();
	});
});

describe("normalizePubkey and an npub of the wrong length", () => {
	// nostr-tools encodes and decodes an npub that carries any number of bytes, so each of these is
	// a well-formed bech32 string. A public key is exactly 32 bytes.
	it.each([0, 20, 31, 33, 64])("rejects an npub that carries %i bytes", (bytes) => {
		const npub = toNpub("ab".repeat(bytes));
		expect(npub.startsWith("npub1")).toBe(true);
		expect(normalizePubkey(npub)).toBeNull();
	});

	it("rejects an npub that carries 32 bytes with one flipped character (bad checksum)", () => {
		const npub = toNpub("ab".repeat(32));
		const last = npub.endsWith("q") ? "p" : "q";
		expect(normalizePubkey(`${npub.slice(0, -1)}${last}`)).toBeNull();
	});

	it("still rejects hex of the wrong length", () => {
		expect(normalizePubkey("ab".repeat(31))).toBeNull();
		expect(normalizePubkey(`${"ab".repeat(32)}0`)).toBeNull();
	});

	it("accepts an npub that carries 32 bytes, and returns exactly those 64 hex characters", () => {
		const hex = "ab".repeat(32);
		expect(normalizePubkey(toNpub(hex))).toBe(hex);
	});
});

describe("shortIdentity", () => {
	it("prefers NIP-05 when present", () => {
		const { publicKey } = generateKeypair();
		expect(shortIdentity(publicKey, "alice@partner.com")).toBe(
			"alice@partner.com",
		);
	});

	it("falls back to a truncated npub", () => {
		const { publicKey } = generateKeypair();
		const label = shortIdentity(publicKey, null);
		expect(label.startsWith("npub1")).toBe(true);
		expect(label).toContain("…");
	});
});
