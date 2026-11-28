import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../../relay/server.js";
import { agx, sandbox } from "../../test/helpers.js";
import { resolveProfileName } from "../config.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "../identity.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { ApiError, sendError, sendJson } from "./http.js";
import { createGatewayKey } from "./keys.js";

// Every body the gateway sends goes through `sendJson` (and `sendError`, which calls it), and a
// secret key in it is replaced by one fixed marker first: in a value, or as a name. The status, the
// headers and every body that holds no key are what they were.
//
// Every key here is made when the test runs, from a throwaway key.

const stranger = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(stranger.secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(stranger.secretKeyHex), "throwaway-password", 4);
const MARK = "[redacted]";

function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** `text` with every valid `%xx` sequence replaced by its character, as often as that changes it (at most 4 times). */
function decoded(text: string): string {
	let out = text;
	for (let round = 0; round < 4; round++) {
		const next = out.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		if (next === out) {
			break;
		}
		out = next;
	}
	return out;
}

/** True when `text`, as written or %xx-decoded, holds any 10-character stretch of the key's data part (not the constant prefix), in any case. */
function leaksKey(text: string, key: string, prefix: number): boolean {
	const data = key.toLowerCase().slice(prefix);
	const texts = [text.toLowerCase(), decoded(text).toLowerCase()];
	for (let i = 0; i + 10 <= data.length; i++) {
		if (texts.some((shown) => shown.includes(data.slice(i, i + 10)))) {
			return true;
		}
	}
	return false;
}

const servers: Server[] = [];

/** A server that answers every request by calling `answer`. */
async function answering(answer: (res: ServerResponse) => void): Promise<string> {
	const server = createServer((_req, res) => answer(res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("sendJson and sendError", () => {
	it("replace a key in a value, or used as a name, and the body stays valid JSON", async () => {
		const url = await answering((res) =>
			sendJson(res, 201, { label: NSEC, list: [NCRYPTSEC, `x ${escapeAll(NSEC)} y`, `nostr:${NSEC.toUpperCase()}`], [NSEC]: 1, keep: stranger.publicKey }),
		);
		const res = await fetch(url);
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(leaksKey(text, NSEC, 5)).toBe(false);
		expect(leaksKey(text, NCRYPTSEC, 10)).toBe(false);
		expect(JSON.parse(text)).toEqual({ label: MARK, list: [MARK, `x ${MARK} y`, `nostr:${MARK}`], [MARK]: 1, keep: stranger.publicKey });
	});

	it("sendError answers the code and the status it always did, with the key replaced in the message and the hint", async () => {
		const url = await answering((res) => sendError(res, new ApiError(400, "invalid_peer", `The peer "${NSEC}" is not a public key`, `Try ${NCRYPTSEC}`)));
		const res = await fetch(url);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: { code: "invalid_peer", message: `The peer "${MARK}" is not a public key`, description: `Try ${MARK}` } });
	});

	it("keep the status line and the headers they always set", async () => {
		const url = await answering((res) => sendJson(res, 202, { label: NSEC }));
		const res = await fetch(url);
		expect(res.status).toBe(202);
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("send an empty body for undefined, as before", async () => {
		const url = await answering((res) => sendJson(res, 204, undefined));
		const res = await fetch(url);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	});

	it("replace the profile's own key, once the gateway has read its identity file", async () => {
		const box = sandbox();
		try {
			const own = createIdentity();
			saveIdentity("default", own);
			loadIdentityFile("default");
			const url = await answering((res) => sendJson(res, 200, { label: own.secretKeyHex, upper: own.secretKeyHex.toUpperCase(), pubkey: own.publicKey }));
			expect(await (await fetch(url)).json()).toEqual({ label: MARK, upper: MARK, pubkey: own.publicKey });
		} finally {
			box.restore();
		}
	});

	it.each([
		["an object with a public key, an event id and a signature", { npub: stranger.npub, pubkey: stranger.publicKey, id: "ab".repeat(32), sig: "cd".repeat(64) }],
		["unicode and escapes", { text: "café — 😀 a\u2028b \u0007 100% %20 %zz", line: "a\nb\tc" }],
		["a list", { subscriptions: [{ id: "sub_1", url: "https://example.com/hook", events: ["task"], capabilities: ["invoice.review"] }] }],
		["a long text", { text: "The quick brown fox jumps over the lazy dog. ".repeat(20_000) }],
		["a string", "just text"],
		["null", null],
	])("send %s byte for byte as JSON.stringify writes it", async (_name, body) => {
		const url = await answering((res) => sendJson(res, 200, body));
		expect(await (await fetch(url)).text()).toBe(JSON.stringify(body));
	});
});

/** `levels` objects inside one another, each holding the one name `name`, with `leaf` at the bottom. */
function nested(levels: number, name: string, leaf: unknown): unknown {
	let doc = leaf;
	for (let i = 0; i < levels; i++) {
		doc = { [name]: doc };
	}
	return doc;
}

/** The names met going down a parsed `nested` document one level at a time, how many levels there were, and what is at the bottom. */
function descend(doc: unknown): { levels: number; names: Set<string>; leaf: unknown } {
	const names = new Set<string>();
	let levels = 0;
	let node = doc;
	while (typeof node === "object" && node !== null && !Array.isArray(node)) {
		const own = Object.keys(node);
		names.add(own[0] as string);
		node = (node as Record<string, unknown>)[own[0] as string];
		levels++;
	}
	return { levels, names, leaf: node };
}

// A peer controls the answer to its own task, and the gateway sends that answer through `sendJson`.
// A document 3000 levels deep is about 18 KB: `JSON.stringify` writes it, so the gateway does too.
// One that cannot be written at all must fail before the status line is sent, so the caller can still
// answer with an error instead of ending a "200" with nothing in it.
describe("sendJson on a very deep body", () => {
	it("sends 3000 levels with a key as the name at each, replaced, as valid JSON", async () => {
		const url = await answering((res) => sendJson(res, 200, nested(3000, NSEC, "end")));
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const text = await res.text();
		const { levels, names, leaf } = descend(JSON.parse(text));
		expect(levels).toBe(3000);
		expect([...names]).toEqual([MARK]);
		expect(leaf).toBe("end");
		expect(leaksKey(text, NSEC, 5)).toBe(false);
	});

	it("sends 3000 levels with ordinary names byte for byte as JSON.stringify writes them", async () => {
		const body = nested(3000, "a", { text: "plain" });
		const url = await answering((res) => sendJson(res, 200, body));
		expect(await (await fetch(url)).text()).toBe(JSON.stringify(body));
	});

	it.each([
		[
			"a circular body",
			() => {
				const circular: Record<string, unknown> = { label: NSEC };
				circular.again = circular;
				return circular;
			},
		],
		["a body too deep to be written at all", () => nested(20_000, NSEC, 1)],
		["a body that holds a BigInt", () => ({ label: NSEC, n: 10n })],
	])("throws before it sends anything for %s, so the caller can still answer with an error", async (_name, make) => {
		let sentBeforeThrow: boolean | undefined;
		const url = await answering((res) => {
			try {
				sendJson(res, 200, make());
			} catch {
				sentBeforeThrow = res.headersSent;
				sendError(res, new ApiError(500, "internal_error", "The gateway could not complete the request"));
			}
		});
		const res = await fetch(url);
		expect(sentBeforeThrow).toBe(false);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: { code: "internal_error", message: "The gateway could not complete the request" } });
	});
});

describe("the real gateway", () => {
	let relay: RunningRelay;
	let box: ReturnType<typeof sandbox>;
	let gateway: RunningGateway;
	let bearer: string;
	let own: ReturnType<typeof loadIdentityFile>;

	beforeAll(async () => {
		box = sandbox();
		relay = await startRelay({ port: 0 });
		expect((await agx("identity", "new")).code).toBe(0);
		expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
		const profile = resolveProfileName();
		bearer = createGatewayKey(profile, "test").key;
		own = loadIdentityFile(profile);
		gateway = await startGateway({ profile, port: 0, pollIntervalMs: 60_000 });
	}, 30_000);

	afterAll(async () => {
		await gateway?.close();
		await relay?.close();
		box?.restore();
	});

	function post(path: string, body: unknown) {
		return fetch(`${gateway.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
			body: JSON.stringify(body),
		});
	}

	const subscription = (extra: Record<string, unknown>) => ({
		url: "https://example.invalid/hook",
		events: ["task"],
		capabilities: ["invoice.review"],
		allowedPeers: [stranger.npub],
		...extra,
	});

	it.each([
		["an nsec1…", NSEC],
		["an nsec1… in capitals", NSEC.toUpperCase()],
		["an nsec1… behind nostr:", `nostr:${NSEC}`],
		["an ncryptsec1…", NCRYPTSEC],
		["an nsec1… written as %xx escapes", escapeAll(NSEC)],
		["an nsec1… in a sentence", `my key is ${NSEC} and please keep it safe`],
	])("a webhook's label that is %s is not repeated in the answer", async (_form, label) => {
		const res = await post("/v1/subscriptions", subscription({ label }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; label: string };
		expect(body.label).toContain(MARK);
		expect(leaksKey(JSON.stringify(body), NSEC, 5)).toBe(false);
		expect(leaksKey(JSON.stringify(body), NCRYPTSEC, 10)).toBe(false);
		const listed = await fetch(`${gateway.url}/v1/subscriptions`, { headers: { authorization: `Bearer ${bearer}` } });
		expect(leaksKey(await listed.text(), NSEC, 5)).toBe(false);
	});

	it("the profile's own key as hex, in a field the gateway repeats, is not repeated", async () => {
		const res = await post("/v1/subscriptions", subscription({ label: own.secretKeyHex, capabilities: [own.secretKeyHex.toUpperCase()] }));
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(text.toLowerCase()).not.toContain(own.secretKeyHex);
		expect(JSON.parse(text)).toMatchObject({ label: MARK, capabilities: [MARK] });
	});

	it("an ordinary answer is what it was: the webhook's secret, its agents and its fields", async () => {
		const res = await post("/v1/subscriptions", subscription({ label: "invoices" }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ label: "invoices", url: "https://example.invalid/hook", events: ["task"], capabilities: ["invoice.review"], acceptAll: false });
		expect(typeof body.secret).toBe("string");
		expect(body.allowedPeers).toEqual([stranger.publicKey]);
	});

	it("the status of a refusal does not change", async () => {
		const res = await fetch(`${gateway.url}/v1/subscriptions`);
		expect(res.status).toBe(401);
	});
});
