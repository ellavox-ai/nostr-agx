import { CARD_KIND, configureWebSocket, generateKeypair, localSigner, type NostrEvent, RELAY_LIST_KIND, toNpub } from "@nostr-agx/nostr";
import kleur from "kleur";
import { verifyEvent } from "nostr-tools";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProfile } from "../lib/config.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

// What `agx card` prints about a card another party published. A card is JSON its
// publisher signed, so every field is text that publisher chose. The cards here are
// published to an in-process relay on a free port by throwaway identities made here.

// The NIP-05 lookup normally reaches a public host; here the answer is chosen by the test,
// and no test reaches the network. `parsed`, when set, replaces the parser's answer, so a test
// can hand the command a name and a domain that the real parser would refuse.
const lookup = vi.hoisted(() => ({
	answer: null as string | null,
	parsed: null as { name: string; domain: string } | null,
}));
vi.mock("@nostr-agx/nostr", async (importOriginal) => {
	const original = await importOriginal<typeof import("@nostr-agx/nostr")>();
	return {
		...original,
		fetchNip05Pubkey: () => Promise.resolve(lookup.answer),
		parseNip05: (identifier: string) => lookup.parsed ?? original.parseNip05(identifier),
	};
});

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const VT = String.fromCharCode(0x0b);
const FF = String.fromCharCode(0x0c);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85);
const CSI = String.fromCharCode(0x9b);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const TAB = String.fromCharCode(0x09);
/** Characters that are not control characters and must reach the terminal as they were published. */
const ZWJ = String.fromCharCode(0x200d);
const VS16 = String.fromCharCode(0xfe0f);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
/** What each control character is printed as. */
const R = String.fromCharCode(0xfffd);

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

beforeAll(() => {
	kleur.enabled = false;
	// Node 20 has no global WebSocket; the relay client needs one handed to it,
	// as `createTransport` does for the commands that make a transport.
	configureWebSocket(WebSocket);
});

beforeEach(async () => {
	box = sandbox();
	lookup.answer = null;
	lookup.parsed = null;
	relay = await startRelay({ port: 0 });
	updateProfile("default", { relays: [relayUrl()] });
});

afterEach(async () => {
	await relay.close();
	box.restore();
});

/** Every character a terminal or a line-oriented reader may act on, other than the newline that ends a line. */
function strayControls(text: string): string[] {
	const found: string[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
		}
	}
	return found;
}

/** What a `label   value` line of the human output shows after its label, or undefined when there is no such line. */
function field(stdout: string, label: string): string | undefined {
	const prefix = `  ${label}`;
	const line = stdout.split("\n").find((l) => l.startsWith(prefix) && l[prefix.length] === " ");
	return line?.slice(prefix.length).replace(/^ +/, "");
}

async function sendToRelay(event: NostrEvent): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = new WebSocket(relayUrl());
		socket.on("open", () => socket.send(JSON.stringify(["EVENT", event])));
		socket.on("message", (data) => {
			const [type, , accepted, reason] = JSON.parse(String(data));
			socket.close();
			if (type === "OK" && accepted) {
				resolve();
			} else {
				reject(new Error(String(reason)));
			}
		});
		socket.on("error", reject);
	});
}

/** Publishes a card whose content is exactly `content` (with `tags`, when given), and an address list when `addresses` is given. */
async function publishCard(
	content: Record<string, unknown>,
	addresses?: string[],
	tags: string[][] = [],
): Promise<{ npub: string; event: NostrEvent }> {
	const keys = generateKeypair();
	const signer = localSigner(keys.secretKey);
	const now = Math.floor(Date.now() / 1000);
	const event = await signer.signEvent({ kind: CARD_KIND, created_at: now, tags, content: JSON.stringify(content) });
	await sendToRelay(event);
	if (addresses) {
		await sendToRelay(
			await signer.signEvent({
				kind: RELAY_LIST_KIND,
				created_at: now,
				tags: addresses.map((address) => ["r", address]),
				content: "",
			}),
		);
	}
	return { npub: toNpub(keys.publicKey), event };
}

const PLAIN_CARD = {
	v: 1,
	org: "Plain Org",
	nip05: null,
	relays: ["wss://relay.example.com"],
	capabilities: ["invoice.parse"],
	payloadTypes: ["text/plain"],
	encryption: ["nip44"],
	version: "1.0.0",
};

// One entry per printed card field: where the text sits, what is published, what should be shown.
const FIELDS = [
	["capabilities", "capabilities", [`invoice.parse${ESC}[1;31m`, `pay${CR}PAID`], `invoice.parse${R}[1;31m, pay${R}PAID`],
	["nip05", "nip05 (claimed)", `ceo${ESC}[1A${ESC}[2K@evil.example`, `ceo${R}[1A${R}[2K@evil.example`],
	["relays", "relays", [`wss://relay.example${ESC}[2J`], `wss://relay.example${R}[2J`],
	["payloadTypes", "payload types", [`text/plain${CSI}31m`], `text/plain${R}31m`],
	["encryption", "encryption", [`nip44${DEL}`], `nip44${R}`],
	["version", "card version", `1.0.0${LS}second-line`, `1.0.0${R}second-line`],
] as const;

describe("agx card, when the card holds control characters", () => {
	it("prints the organization on one heading line, with each control character replaced", async () => {
		const { npub } = await publishCard({
			...PLAIN_CARD,
			org: `Acme${ESC}[31m RED${ESC}[0m${LF}Agent Card -- forged heading`,
		});

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(`Agent Card — Acme${R}[31m RED${R}[0m${R}Agent Card -- forged heading`);
		expect(lines.filter((l) => l.startsWith("Agent Card"))).toHaveLength(1);
	});

	it.each(FIELDS)("prints the card's %s with control characters replaced", async (key, label, typed, shown) => {
		const { npub } = await publishCard({ ...PLAIN_CARD, [key]: typed });

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(field(run.stdout, label)).toBe(shown);
	});

	it("prints an address from the card's relay list with control characters replaced", async () => {
		const { npub } = await publishCard(PLAIN_CARD, [
			"wss://good.example",
			`wss://evil.example${ESC}]0;title${BEL}`,
			`wss://other.example${LF}  wss://forged.example`,
		]);

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const lines = run.stdout.split("\n");
		expect(lines).toContain("  wss://good.example");
		expect(lines).toContain(`  wss://evil.example${R}]0;title${R}`);
		expect(lines).toContain(`  wss://other.example${R}  wss://forged.example`);
	});

	it.each([
		["an escape", ESC],
		["a null", NUL],
		["a bell", BEL],
		["a vertical tab", VT],
		["a form feed", FF],
		["a carriage return", CR],
		["a line feed", LF],
		["a delete character", DEL],
		["a next-line control (C1)", NEL],
		["a control sequence introducer (C1)", CSI],
		["a line separator", LS],
		["a paragraph separator", PS],
	])("replaces %s in a capability and keeps it on its line", async (_name, character) => {
		const { npub } = await publishCard({ ...PLAIN_CARD, capabilities: [`a${character}b`] });

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(field(run.stdout, "capabilities")).toBe(`a${R}b`);
	});

	it("prints a claimed NIP-05 handle that is not an identifier with control characters replaced when it is checked", async () => {
		const { npub } = await publishCard({ ...PLAIN_CARD, nip05: `ceo${ESC}[1A${ESC}[2K@evil.example` });

		const run = await agx("card", npub, "--verify");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain(
			`  IMPOSTOR  "ceo${R}[1A${R}[2K@evil.example" is not a valid name@domain identifier`,
		);
	});

	it("prints the key a domain publishes for the handle with control characters replaced when it is checked", async () => {
		const { npub } = await publishCard({ ...PLAIN_CARD, nip05: "bob@example.com" });
		lookup.answer = `ab${ESC}[2J${"c".repeat(30)}`;

		const run = await agx("card", npub, "--verify");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout).toContain(`example.com publishes ab${R}[2Jcccccccccc… for "bob" — a DIFFERENT key`);
	});

});

// The raw event is what a reader copies to check the signature, so it must stay the event that was
// signed: a character that is replaced in it makes the copy a different event.
describe("agx card --raw, when the card holds control characters", () => {
	const HOSTILE_CARD = {
		...PLAIN_CARD,
		org: `Acme${ESC}[31m${LF}forged`,
		capabilities: [`a${NUL}b`, `c${BEL}d`],
		payloadTypes: [`text/plain${CSI}31m`],
		encryption: [`nip44${DEL}`, `x${NEL}y`],
		version: `1.0.0${LS}second-line${PS}`,
	};
	const HOSTILE_TAGS = [["client", `tool${CSI}1;31m${LS}`]];

	/** The JSON printed under the "Raw event" heading: from its opening brace to the closing brace on a line of its own. */
	function rawBlock(stdout: string): string {
		const heading = "Raw event\n";
		const start = stdout.indexOf(heading);
		expect(start, "the Raw event heading").toBeGreaterThanOrEqual(0);
		const after = stdout.slice(start + heading.length);
		return after.slice(0, after.indexOf("\n}\n") + 2);
	}

	it("prints an event that parses back to the one that was published, and whose signature still verifies", async () => {
		const { npub, event } = await publishCard(HOSTILE_CARD, undefined, HOSTILE_TAGS);
		expect(verifyEvent(event)).toBe(true);

		const run = await agx("card", npub, "--raw");

		expect(run.code, run.stderr).toBe(0);
		const printed = JSON.parse(rawBlock(run.stdout));
		expect(printed).toEqual(JSON.parse(JSON.stringify(event)));
		expect(verifyEvent(printed)).toBe(true);
	});

	it("writes no raw control character, replaces nothing inside the event, and keeps its lines", async () => {
		const { npub } = await publishCard(HOSTILE_CARD, undefined, HOSTILE_TAGS);

		const run = await agx("card", npub, "--raw");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		// The lines above the heading show the card's text with control characters replaced; the event does not.
		const fromHeading = run.stdout.slice(run.stdout.indexOf("Raw event"));
		expect(fromHeading).not.toContain(R);
		// The raw event is the one field that is meant to span lines.
		expect(fromHeading).toContain('Raw event\n{\n  "kind": 11337,\n  "created_at": ');
	});
});

describe("agx card --json, when the card holds control characters", () => {
	const CARD_WITH_CONTROLS = {
		v: 1,
		org: `Acme${ESC}[31m RED${LF}Agent Card -- forged heading`,
		nip05: `ceo${ESC}[1A@evil.example`,
		relays: [`wss://relay.example${ESC}[2J`],
		capabilities: [`invoice.parse${ESC}[1;31m`, `pay${CR}PAID`, `x${NEL}${LS}${PS}${DEL}${CSI}y`],
		payloadTypes: [`text/plain${CSI}31m`],
		encryption: [`nip44${DEL}`],
		version: `1.0.0${LS}second-line`,
	};

	it("keeps every value exactly as published and writes no raw control character", async () => {
		const { npub, event } = await publishCard(CARD_WITH_CONTROLS);

		const run = await agx("card", npub, "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const [doc] = jsonDocuments(run.stdout) as [{ card: unknown; event: NostrEvent; signatureValid: boolean }];
		expect(doc.card).toEqual(CARD_WITH_CONTROLS);
		expect(doc.event).toEqual(JSON.parse(JSON.stringify(event)));
		expect(doc.signatureValid).toBe(true);
	});
});

describe("agx card, with ordinary text", () => {
	const LONG_ORG = "Café Ünïcode 日本語 🙂 ".padEnd(200, "x");

	it("prints accents, other scripts, emoji and a 200-character name exactly as published", async () => {
		expect(LONG_ORG).toHaveLength(200);
		const { npub } = await publishCard(
			{
				...PLAIN_CARD,
				org: LONG_ORG,
				nip05: "alice@example.com",
				capabilities: ["invoice.parse", "ñandú.résumé", "日本語.翻訳"],
				relays: ["wss://relay.example.com", "wss://リレー.example.com"],
				payloadTypes: ["text/plain", "application/json"],
				version: "1.0.0-café",
			},
			["wss://good.example", "wss://café.example"],
		);

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(`Agent Card — ${LONG_ORG}`);
		expect(field(run.stdout, "capabilities")).toBe("invoice.parse, ñandú.résumé, 日本語.翻訳");
		expect(field(run.stdout, "nip05 (claimed)")).toBe("alice@example.com");
		expect(field(run.stdout, "relays")).toBe("wss://relay.example.com, wss://リレー.example.com");
		expect(field(run.stdout, "payload types")).toBe("text/plain, application/json");
		expect(field(run.stdout, "encryption")).toBe("nip44");
		expect(field(run.stdout, "card version")).toBe("1.0.0-café");
		expect(lines).toContain("  wss://good.example");
		expect(lines).toContain("  wss://café.example");
	});

	it("prints a card with no organization and no handle as before", async () => {
		const { npub } = await publishCard({ v: 1, capabilities: [], relays: [], payloadTypes: [], encryption: [] });

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout.split("\n")).toContain("Agent Card");
		expect(field(run.stdout, "capabilities")).toBe("—");
		expect(field(run.stdout, "nip05 (claimed)")).toBe("—");
		expect(field(run.stdout, "card version")).toBe("—");
	});

	it("prints a version that is a number as it did before", async () => {
		const { npub } = await publishCard({ ...PLAIN_CARD, org: 7, version: 2 });

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout.split("\n")).toContain("Agent Card — 7");
		expect(field(run.stdout, "card version")).toBe("2");
	});

	// A zero or a false is a value the card holds, not a missing one: it is printed, as it was before.
	it.each([
		["version", 0, "card version", "0"],
		["version", false, "card version", "false"],
		["nip05", 0, "nip05 (claimed)", "0"],
		["nip05", false, "nip05 (claimed)", "false"],
		["nip05", "", "nip05 (claimed)", "—"],
	])("prints a card's %s of %j as it did before", async (key, typed, label, shown) => {
		const { npub } = await publishCard({ ...PLAIN_CARD, [key]: typed });

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(field(run.stdout, label)).toBe(shown);
	});

	it("prints a tab, joiners, variation selectors, right-to-left text and combining marks exactly as published", async () => {
		const text = `tab${TAB}here 👩${ZWJ}💻 heart❤${VS16} שלום مرحبا e${COMBINING_ACUTE}`;
		const { npub } = await publishCard(
			{ ...PLAIN_CARD, org: text, capabilities: [text, "x"], version: text },
			[`wss://${text}.example`],
		);

		const run = await agx("card", npub);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(`Agent Card — ${text}`);
		expect(field(run.stdout, "capabilities")).toBe(`${text}, x`);
		expect(field(run.stdout, "card version")).toBe(text);
		expect(lines).toContain(`  wss://${text}.example`);
	});

	it("prints the raw event as JSON, unchanged", async () => {
		const { npub, event } = await publishCard(PLAIN_CARD);

		const run = await agx("card", npub, "--raw");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(`Raw event\n${JSON.stringify(event, null, 2)}\n`);
	});
});

// At a terminal the labels and the dash are dimmed. The dash that stands for an empty list is plain
// text, the one that stands for no handle or no version is dimmed, and both stay as they were.
describe("agx card, with colour on", () => {
	it("prints the dash for an empty list as plain text and the dash for no handle and no version dimmed", async () => {
		const { npub } = await publishCard({ v: 1, capabilities: [], relays: [], payloadTypes: [], encryption: [] });
		const colourWas = kleur.enabled;
		kleur.enabled = true;
		try {
			const run = await agx("card", npub);

			expect(run.code, run.stderr).toBe(0);
			const lines = run.stdout.split("\n");
			for (const label of ["capabilities", "relays", "payload types", "encryption"]) {
				expect(lines, label).toContain(`  ${kleur.dim(label.padEnd(16))} —`);
			}
			for (const label of ["nip05 (claimed)", "card version"]) {
				expect(lines, label).toContain(`  ${kleur.dim(label.padEnd(16))} ${kleur.dim("—")}`);
			}
		} finally {
			kleur.enabled = colourWas;
		}
	});
});

// The verdict words are coloured at a terminal. Only the card's own text is cleaned, so the colour
// codes around the words must come through untouched.
describe("agx card --verify, with colour on", () => {
	const VERDICTS = [
		{
			name: "verified",
			card: { nip05: "bob@example.com" },
			answer: (author: string): string | null => author,
			line: () => `  ${kleur.green("VERIFIED")}  bob@example.com  —  example.com vouches for this key`,
		},
		{
			name: "not a valid identifier",
			card: { nip05: `ceo${ESC}[1A${ESC}[2K@evil.example` },
			answer: (): string | null => null,
			line: () => `  ${kleur.red("IMPOSTOR")}  "ceo${R}[1A${R}[2K@evil.example" is not a valid name@domain identifier`,
		},
		{
			name: "unreachable",
			card: { nip05: "bob@example.com" },
			answer: (): string | null => null,
			line: () => `  ${kleur.yellow("UNVERIFIED")}  example.com did not serve a usable mapping for "bob"`,
		},
		{
			name: "no handle",
			card: { nip05: null },
			answer: (): string | null => null,
			line: () => `  ${kleur.dim("—")}  the card claims no NIP-05 handle`,
		},
	];

	it.each(VERDICTS)("prints the $name verdict line with its colour codes", async ({ card, answer, line }) => {
		const { npub, event } = await publishCard({ ...PLAIN_CARD, ...card });
		lookup.answer = answer(event.pubkey);
		const colourWas = kleur.enabled;
		kleur.enabled = true;
		try {
			const run = await agx("card", npub, "--verify");

			expect(run.code, run.stderr).toBe(0);
			expect(run.stdout.split("\n")).toContain(line());
		} finally {
			kleur.enabled = colourWas;
		}
	});
});

// The real parser accepts only letters, digits and a few marks in a name and a domain, so a name or a
// domain with a control character cannot reach these lines today. The answers here come from a stand-in
// for the parser, so the lines are checked on their own and do not depend on it staying that strict.
describe("agx card --verify, when the parsed name and domain hold control characters", () => {
	it("prints the UNVERIFIED line with control characters replaced", async () => {
		const { npub } = await publishCard({ ...PLAIN_CARD, nip05: "bob@example.com" });
		lookup.parsed = { name: `bo${ESC}[2Jb`, domain: `exa${ESC}]0;x${BEL}mple.com` };

		const run = await agx("card", npub, "--verify");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain(
			`  UNVERIFIED  exa${R}]0;x${R}mple.com did not serve a usable mapping for "bo${R}[2Jb"`,
		);
	});

	it("prints the VERIFIED line with control characters replaced", async () => {
		const { npub, event } = await publishCard({ ...PLAIN_CARD, nip05: `bob@exa${ESC}[2Jmple.com` });
		lookup.parsed = { name: "bob", domain: `exa${ESC}[2Jmple.com` };
		lookup.answer = event.pubkey;

		const run = await agx("card", npub, "--verify");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain(`  VERIFIED  bob@exa${R}[2Jmple.com  —  exa${R}[2Jmple.com vouches for this key`);
	});
});
