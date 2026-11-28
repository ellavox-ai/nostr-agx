import { bytesToHex, generateKeypair } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { describe, expect, it } from "vitest";
import { scanForSecrets } from "./secrets-scan.js";

describe("scanForSecrets", () => {
	it.each([
		["Nostr secret key", `nsec1${"q".repeat(58)}`],
		["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
		["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"],
		["Ellaworks API key", "ela_abcdefghijklmnop0123456789"],
		["OpenAI-style API key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
		["GitHub token", `ghp_${"a".repeat(36)}`],
		["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
		["Slack token", "xoxb-1234567890-abcdefghij"],
		["secret assigned in text", "password = hunter2hunter2hunter2"],
	])("flags a %s", (_name, text) => {
		expect(scanForSecrets(text).length).toBeGreaterThan(0);
	});

	it("leaves ordinary messages alone", () => {
		for (const text of [
			"Hi Alice, can you review invoice 1234?",
			"Our npub is npub1n0m8c4qn3434zy2q7nxj7v029pqyyfjfg0af98yfll6ksnvq3mps2ynyfz",
			"The deploy token expires tomorrow, please renew it.",
			"See https://example.com/docs for the API.",
		]) {
			expect(scanForSecrets(text)).toEqual([]);
		}
	});

	it("reports the line, never the secret", () => {
		const findings = scanForSecrets(`hello\nela_abcdefghijklmnop0123456789\nbye`);
		expect(findings).toEqual([{ kind: "Ellaworks API key (ela_…)", line: 2 }]);
		expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnop");
	});
});

// ---------------------------------------------------------------------------
// The scan reads a Nostr secret key by the rule the CLI and the n8n nodes share:
// `nsec1…` and `ncryptsec1…` in any case, behind `nostr:`, with `%xx` escapes decoded.
// Every key is made when the test runs, from a throwaway key.

const pair = generateKeypair();
const NSEC = nip19.nsecEncode(pair.secretKey);
const NCRYPTSEC = encrypt(pair.secretKey, "throwaway-password", 4);
const HEX = bytesToHex(pair.secretKey);
const NSEC_KIND = "Nostr secret key (nsec1…)";
const NCRYPTSEC_KIND = "Password-protected Nostr secret key (ncryptsec1…)";
const HEX_KIND = "64-character hex secret";

/** Every character as `%xx`. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

describe("scanForSecrets and a Nostr secret key", () => {
	it.each([
		["in plain", NSEC],
		["behind nostr:", `nostr:${NSEC}`],
		["inside a sentence", `my key is ${NSEC} and please keep it safe`],
		["in capitals", NSEC.toUpperCase()],
		["in capitals, behind nostr:", `nostr:${NSEC.toUpperCase()}`],
		["with every character %xx-escaped", escapeAll(NSEC)],
		["with every character %xx-escaped, in lower-case digits", escapeAll(NSEC).toLowerCase()],
		// The key as written, followed by an escape that decodes to a word character: the scan found these
		// before keys were read by the shared rule, and it still must.
		["followed by an escaped underscore", `${NSEC}%5F`],
		["followed by an escaped letter", `${NSEC}%62`],
		["followed by an escaped digit", `${NSEC}%31`],
		["followed by an escaped percent sign and a letter", `${NSEC}%2562`],
		["in a URL, followed by an escaped underscore", `https://example.com/cb?key=${NSEC}%5Fbackup`],
	])("flags an nsec1… %s, on its line, without quoting it", (_name, text) => {
		const findings = scanForSecrets(`hello\n${text}\nbye`);
		expect(findings).toEqual([{ kind: NSEC_KIND, line: 2 }]);
		expect(JSON.stringify(findings)).not.toContain(NSEC.slice(8, 30));
	});

	it.each([
		["in plain", NCRYPTSEC],
		["in capitals", NCRYPTSEC.toUpperCase()],
		["behind nostr:", `nostr:${NCRYPTSEC}`],
		["with every character %xx-escaped", escapeAll(NCRYPTSEC)],
		["followed by an escaped letter", `${NCRYPTSEC}%62`],
	])("flags an encrypted key (ncryptsec1…) %s", (_name, text) => {
		expect(scanForSecrets(`one\n${text}`)).toEqual([{ kind: NCRYPTSEC_KIND, line: 2 }]);
	});

	it("flags both kinds on one line, the nsec1… first", () => {
		expect(scanForSecrets(`${NCRYPTSEC} and ${NSEC}`)).toEqual([
			{ kind: NSEC_KIND, line: 1 },
			{ kind: NCRYPTSEC_KIND, line: 1 },
		]);
	});

	it("leaves text that only talks about keys alone", () => {
		for (const text of [
			"paste your nsec1 here, or your ncryptsec1",
			`nsec1${"q".repeat(19)}`,
			`ncryptsec1${"q".repeat(19)}`,
			`Our npub is ${nip19.npubEncode(pair.publicKey)}`,
			"https://example.com/a%20b?q=%7Efoo%2Fbar",
		]) {
			expect(scanForSecrets(text)).toEqual([]);
		}
	});
});

describe("scanForSecrets and 64 hex digits", () => {
	it.each([
		["secret key: <hex>", `secret key: ${HEX}`],
		["Secret: <HEX>", `Secret: ${HEX.toUpperCase()}`],
		["private=<hex>", `private=${HEX}`],
		["the words 20 characters before it", `secret${" ".repeat(20)}${HEX}`],
		["on a later line than the words, nothing flagged there", `secret\n${HEX}`],
	])("%s", (name, text) => {
		const findings = scanForSecrets(text).filter((finding) => finding.kind === HEX_KIND);
		expect(findings.length).toBe(name.startsWith("on a later") ? 0 : 1);
	});

	it("leaves a run without the words alone: it is as likely a public key or an event id", () => {
		for (const text of [HEX, `Our pubkey is ${pair.publicKey}`, `event ${HEX}`, `secret${" ".repeat(21)}${HEX}`, `secret ${HEX}0`, `secret ${HEX.slice(1)}`, `secret x${HEX}`]) {
			expect(scanForSecrets(text).filter((finding) => finding.kind === HEX_KIND)).toEqual([]);
		}
	});
});

describe("scanForSecrets keeps its answers for text that is not an escaped or capitalised key", () => {
	// The two patterns this scan used before it read keys by the shared rule. Every text that can be made
	// from one piece of each slot below, in order, is run through the old pattern and through the new code,
	// and a line the old pattern flags must be flagged now and the other way round. Nothing is drawn at
	// random: a list of texts that repeats itself would show less than it seems to.
	const OLD_NSEC = /\bnsec1[02-9ac-hj-np-z]{20,}\b/;
	const OLD_HEX = /\b(?:secret|private)[^\n]{0,20}\b[0-9a-f]{64}\b/i;
	const NSEC_SLOTS = [
		["", "x", " ", "nostr:", "--", "_", "\n"],
		[NSEC, NSEC.slice(0, 30), NSEC.slice(0, 12), `nsec1${"q".repeat(19)}`, `nsec1${"q".repeat(20)}`, "nsec1", `${NSEC}q`, `${NSEC}b`, `${NSEC}1`, `nsec1${"q".repeat(10)}b${"q".repeat(30)}`],
		["", ".", " ok", "\nmore", "g", "_", "b", "q", "%5F", "%62", "%31", "%2562", "%20", "%7E"],
	];
	const HEX_SLOTS = [
		["secret", "private", "Secret", "PRIVATE", "key", "x"],
		["", " ", ": ", "=", " is ", "\n", " ".repeat(20), " ".repeat(21), "_", "x".repeat(15), "x".repeat(21)],
		[HEX, HEX.toUpperCase(), `${HEX.toUpperCase().slice(0, 32)}${HEX.slice(32)}`, HEX.slice(1), `${HEX}a`, `g${HEX}`, `${HEX}_`, `0${HEX}`],
		["", ".", " ok", "\nmore", "g", "_"],
	];

	/** Every text made of one piece from each slot, in order, each text once. */
	function everyText(slots: string[][]): string[] {
		const all = slots.reduce<string[]>((texts, slot) => texts.flatMap((text) => slot.map((piece) => text + piece)), [""]);
		return [...new Set(all)];
	}

	/** The texts in which the scan finds fewer lines of `kind` than `old` does, and the texts in which it finds more. */
	function differences(texts: string[], kind: string, old: RegExp): { fewer: string[]; more: string[]; flagged: number } {
		const fewer: string[] = [];
		const more: string[] = [];
		let flagged = 0;
		for (const text of texts) {
			const got = scanForSecrets(text).filter((finding) => finding.kind === kind).length;
			const lines = text.split(/\r\n|[\n\r]/).filter((line) => old.test(line)).length;
			if (got < lines) {
				fewer.push(text);
			} else if (got > lines) {
				more.push(text);
			}
			flagged += got;
		}
		return { fewer, more, flagged };
	}

	it("agrees with the old nsec1… pattern on all 959 distinct texts that its pieces make", () => {
		const texts = everyText(NSEC_SLOTS);
		expect(texts.length).toBe(959);
		const { fewer, more, flagged } = differences(texts, NSEC_KIND, OLD_NSEC);
		expect({ fewer, more }).toEqual({ fewer: [], more: [] });
		expect(flagged).toBeGreaterThan(100);
	});

	it("agrees with the old 64-hex pattern on all 3102 distinct texts that its pieces make, in either case", () => {
		const texts = everyText(HEX_SLOTS);
		expect(texts.length).toBe(3102);
		const { fewer, more, flagged } = differences(texts, HEX_KIND, OLD_HEX);
		expect({ fewer, more }).toEqual({ fewer: [], more: [] });
		expect(flagged).toBeGreaterThan(100);
	});
});
