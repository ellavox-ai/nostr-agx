import { request } from "node:http";
import { generateKeypair } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../../relay/server.js";
import { agx, sandbox } from "../../test/helpers.js";
import { resolveProfileName } from "../config.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { createGatewayKey } from "./keys.js";

/**
 * A secret key in a request path must not come back in an answer or in the
 * gateway's log, even when a letter of it is written as a percent escape
 * (`%6e` for `n`): `new URL` keeps an escape as it was written, so the key's
 * name (`nsec1`, `ncryptsec1`) is not in the text the gateway checks, and the
 * rest of the key sits in it in plain.
 *
 * Every key here is made at run time from a throwaway key. A test that passes
 * before the fix is a control: it guards behaviour the fix must keep.
 */

const HIDDEN = "(a value with a secret key, not shown)";

const KEYS = [
	{ kind: "nsec1…", key: nip19.nsecEncode(generateKeypair().secretKey), prefix: "nsec1" },
	// A NIP-49 string from a throwaway key (scrypt cost 2^4: fast, and no more real than the key).
	{ kind: "ncryptsec1…", key: encrypt(generateKeypair().secretKey, "throwaway-password", 4), prefix: "ncryptsec1" },
];

let relay: RunningRelay;
let box: ReturnType<typeof sandbox>;
let gateway: RunningGateway;
let apiKey: string;
const lines: string[] = [];

interface Answer {
	status: number;
	body: string;
}

/** A request with the path exactly as given: `node:http` sends it unchanged, so an escape reaches the gateway as written. */
function send(path: string, options: { auth?: boolean; method?: string; body?: unknown } = {}): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: gateway.port,
				path,
				method: options.method ?? "GET",
				agent: false,
				headers: {
					...(options.auth === false ? {} : { authorization: `Bearer ${apiKey}` }),
					...(options.body === undefined ? {} : { "content-type": "application/json" }),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		// A gateway that never answers (a request that threw inside its own error handler) fails this test, instead of holding the run until its time limit.
		req.setTimeout(5_000, () => req.destroy(new Error("the gateway did not answer in 5 seconds")));
		req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
	});
}

/** `text` with every layer of percent escapes undone. A deeper loop than the gateway's, on purpose. */
function unescaped(text: string): string {
	let out = text;
	for (let round = 0; round < 40; round++) {
		const next = out.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		if (next === out) {
			break;
		}
		out = next;
	}
	return out;
}

/** True when `text` holds any 12-character stretch of the key's data part (not its constant name), in any case, as written or with its escapes undone. */
function leaksKey(text: string, key: string, prefix: string): boolean {
	const data = key.toLowerCase().slice(prefix.length);
	for (const form of [text, unescaped(text)]) {
		const lower = form.toLowerCase();
		for (let i = 0; i + 12 <= data.length; i++) {
			if (lower.includes(data.slice(i, i + 12))) {
				return true;
			}
		}
	}
	return false;
}

/** `text`, or a note in its place when it repeats the key: a failing check must not print the key it is about. */
function safe(text: string, key: string, prefix: string): string {
	return leaksKey(text, key, prefix) ? "(repeats the key)" : text;
}

/** A letter written as an escape. `layers` 2 is the escape escaped (`%256e`), 3 once more; `upper` writes the hex digits in capitals. */
function escape(ch: string, options: { layers?: number; upper?: boolean } = {}): string {
	const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
	return `%${"25".repeat((options.layers ?? 1) - 1)}${options.upper ? hex.toUpperCase() : hex}`;
}

/** The key with the character at `index` written as an escape. */
function escapedAt(key: string, index: number, options: { layers?: number; upper?: boolean } = {}): string {
	return key.slice(0, index) + escape(key[index], options) + key.slice(index + 1);
}

interface Form {
	name: string;
	/** What goes into the path for this key. */
	of: (key: string, prefix: string) => string;
}

const FORMS: Form[] = [
	{ name: "the first letter as %6e", of: (k) => escapedAt(k, 0) },
	{ name: "the first letter as %6E (capital hex digit)", of: (k) => escapedAt(k, 0, { upper: true }) },
	{ name: "the first letter as %4E (a capital N)", of: (k) => escape(k[0].toUpperCase(), { upper: true }) + k.slice(1) },
	{ name: "the second letter of the name as an escape", of: (k) => escapedAt(k, 1) },
	{ name: "the last letter of the name as an escape", of: (k, p) => escapedAt(k, p.length - 2) },
	{ name: "the 1 after the name as %31", of: (k, p) => escapedAt(k, p.length - 1) },
	{ name: "every character as an escape", of: (k) => [...k].map((ch) => escape(ch)).join("") },
	{ name: "after nostr%3A, with the first letter as an escape", of: (k) => `nostr%3A${escapedAt(k, 0)}` },
	{ name: "inside a longer segment", of: (k) => `token-${escapedAt(k, 0)}` },
	{ name: "the first letter escaped twice (%256e)", of: (k) => escapedAt(k, 0, { layers: 2 }) },
	{ name: "the first letter escaped three times", of: (k) => escapedAt(k, 0, { layers: 3 }) },
	{ name: "the first letter escaped twelve times", of: (k) => escapedAt(k, 0, { layers: 12 }) },
	// Controls: the key's name is in the path in plain, which the gateway already hides.
	{ name: "a letter in the data part as an escape (control)", of: (k, p) => escapedAt(k, p.length + 3) },
	{ name: "after nostr%3A, in plain (control)", of: (k) => `nostr%3A${k}` },
	{ name: "in plain, in capitals (control)", of: (k) => k.toUpperCase() },
	{ name: "in plain (control)", of: (k) => k },
];

beforeAll(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	expect((await agx("identity", "new")).code).toBe(0);
	expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	const profile = resolveProfileName();
	apiKey = createGatewayKey(profile, "test").key;
	gateway = await startGateway({ profile, port: 0, pollIntervalMs: 500, log: (line: string) => lines.push(line) });
	// Healthy once a poll has finished.
	const deadline = Date.now() + 30_000;
	while ((await send("/v1/health", { auth: false })).status !== 200) {
		if (Date.now() > deadline) {
			throw new Error("the gateway did not become healthy");
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}, 60_000);

afterAll(async () => {
	await gateway?.close();
	await relay?.close();
	box?.restore();
});

beforeEach(() => {
	lines.length = 0;
});

describe.each(KEYS)("a secret key ($kind) in a request path", ({ key, prefix }) => {
	describe("on a path outside /v1/, answered before any key is checked", () => {
		it.each(FORMS)("is not repeated when written with $name", async (form) => {
			const res = await send(`/x/${form.of(key, prefix)}`, { auth: false });
			expect(res.status).toBe(404);
			expect(safe(JSON.parse(res.body).error.message, key, prefix)).toBe(`No route for GET ${HIDDEN}`);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});
	});

	describe("on an unknown path under /v1/, with a valid gateway key", () => {
		it.each(FORMS)("is not repeated when written with $name", async (form) => {
			const res = await send(`/v1/agentz/${form.of(key, prefix)}`);
			expect(res.status).toBe(404);
			expect(safe(JSON.parse(res.body).error.message, key, prefix)).toBe(`No route for GET ${HIDDEN}`);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});
	});

	describe("on a route that decodes the path and throws on a bad escape (%zz), where the gateway logs the request", () => {
		it.each(FORMS)("is not repeated in the log line when written with $name", async (form) => {
			const res = await send(`/v1/agents/${form.of(key, prefix)}%zz`);
			expect(res.status).toBe(500);
			expect(res.body).toContain("internal_error");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			// The log sink is live: this answer is written to it.
			const logged = lines.filter((line) => line.startsWith("API error on GET "));
			expect(logged).toHaveLength(1);
			expect(safe(logged[0], key, prefix)).toBe(`API error on GET ${HIDDEN}: URI malformed`);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});

		it.each([
			["GET /v1/subscriptions/:id", "/v1/subscriptions/"],
			["GET /v1/tasks/:id", "/v1/tasks/"],
		])("%s does not repeat it in the log line either", async (_route, base) => {
			for (const written of [escapedAt(key, 0), escapedAt(key, 0, { layers: 2 })]) {
				lines.length = 0;
				const res = await send(`${base}${written}%zz`);
				expect(res.status).toBe(500);
				expect(leaksKey(res.body, key, prefix)).toBe(false);
				expect(lines.filter((line) => line.startsWith("API error on GET "))).toHaveLength(1);
				expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
			}
		});
	});

	describe("in the query string", () => {
		it.each([
			["written with the first letter as an escape", escapedAt(key, 0)],
			["escaped twice", escapedAt(key, 0, { layers: 2 })],
			["in plain", key],
		])("is not repeated in the log line when %s", async (_form, written) => {
			// The log line quotes the whole request target, query string included.
			const res = await send(`/v1/agents/%zz?token=${written}`);
			expect(res.status).toBe(500);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			const logged = lines.filter((line) => line.startsWith("API error on GET "));
			expect(logged).toHaveLength(1);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});

		it("is not part of the 404 answer (control: the answer quotes the path only)", async () => {
			const res = await send(`/x/ok?token=${escapedAt(key, 0)}`, { auth: false });
			expect(res.status).toBe(404);
			expect(safe(JSON.parse(res.body).error.message, key, prefix)).toBe("No route for GET /x/ok");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
		});
	});

	describe("as the id of a subscription", () => {
		it.each([
			["GET", "GET"],
			["DELETE", "DELETE"],
		])("is not repeated by %s when the id is escaped twice (the route decodes once, and what is left is still an escape)", async (_name, method) => {
			const res = await send(`/v1/subscriptions/${escapedAt(key, 0, { layers: 2 })}`, { method });
			expect(res.status).toBe(404);
			expect(safe(JSON.parse(res.body).error.message, key, prefix)).toBe(`No subscription ${HIDDEN}`);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});

		it.each([
			["GET", "GET"],
			["DELETE", "DELETE"],
		])("is not repeated by %s when the id is escaped once (control: the route decodes it first)", async (_name, method) => {
			const res = await send(`/v1/subscriptions/${escapedAt(key, 0)}`, { method });
			expect(res.status).toBe(404);
			expect(safe(JSON.parse(res.body).error.message, key, prefix)).toBe(`No subscription ${HIDDEN}`);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
		});
	});

	describe("as the agent in GET /v1/agents/:peer", () => {
		it("answers 400 invalid_peer and does not repeat it when written once as an escape (control: the route decodes it first)", async () => {
			const res = await send(`/v1/agents/${escapedAt(key, 0)}`);
			expect(res.status).toBe(400);
			expect(res.body).toContain("invalid_peer");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});

		it.each([
			["escaped twice", 2],
			["escaped three times", 3],
			["escaped twelve times", 12],
		])("answers 400 invalid_peer and does not repeat it when the first letter is %s (the route decodes once, and what is left is still an escape)", async (_name, layers) => {
			const res = await send(`/v1/agents/${escapedAt(key, 0, { layers })}`);
			expect(res.status).toBe(400);
			expect(res.body).toContain("invalid_peer");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});
	});

	describe("as the agent in a request body, with a letter written as an escape", () => {
		it.each([
			["POST /v1/tasks", "/v1/tasks", { capability: "x.y" }],
			["POST /v1/messages", "/v1/messages", { text: "hello" }],
		])("%s answers 400 invalid_peer and does not repeat it", async (_route, path, rest) => {
			const res = await send(path, { method: "POST", body: { peer: escapedAt(key, 0), ...rest } });
			expect(res.status).toBe(400);
			expect(res.body).toContain("invalid_peer");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
		});
	});

	describe("as an allowed agent in POST /v1/subscriptions, with a letter written as an escape", () => {
		it.each([
			["once", (k: string) => escapedAt(k, 0)],
			["twice", (k: string) => escapedAt(k, 0, { layers: 2 })],
			["in capitals", (k: string) => escapedAt(k, 0, { upper: true })],
		])("answers 400 invalid_subscription and does not repeat it when the letter is escaped %s", async (_how, form) => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: "http://127.0.0.1:9/hook", events: ["message"], allowedPeers: [form(key)] },
			});
			expect(res.status).toBe(400);
			expect(res.body).toContain("invalid_subscription");
			expect(leaksKey(res.body, key, prefix)).toBe(false);
		});
	});
});

describe("ordinary paths (controls: the fix must not hide them)", () => {
	it.each([
		["an unknown path under /v1/ with an ordinary escape", "/v1/nothing/a%20b", true],
		["an unknown path outside /v1/ with an ordinary escape", "/x/a%20b", false],
		["a path with an escape for a letter that is not part of a key", "/x/%6Eice", false],
		["a path with an escape for a percent sign", "/x/100%25", false],
		["a path with a bad escape", "/x/%zz", false],
		["a path with an escape and the letters nsec but no 1", "/x/%6Esec-notes", false],
		["a path with an ordinary escape written four layers deep, as deep as the gateway looks", "/x/a%25252520b", false],
		["a path with six ordinary escapes side by side (each round of the decode must undo all of them)", "/x/a%20b%20c%20d%20e%20f%20g", false],
	])("answers %s with the path as it was written", async (_name, path, auth) => {
		const res = await send(path, { auth });
		expect(res.status).toBe(404);
		expect(JSON.parse(res.body).error.message).toBe(`No route for GET ${path}`);
	});

	it("still answers /v1/health", async () => {
		const res = await send("/v1/health", { auth: false });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
	});

	it("still logs an ordinary request that makes the router throw, as it was written", async () => {
		const res = await send("/v1/agents/a%20b%zz");
		expect(res.status).toBe(500);
		expect(lines.filter((line) => line === "API error on GET /v1/agents/a%20b%zz: URI malformed")).toHaveLength(1);
	});
});
