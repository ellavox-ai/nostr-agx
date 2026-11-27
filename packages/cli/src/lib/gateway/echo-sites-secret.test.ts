import { request } from "node:http";
import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../../relay/server.js";
import { agx, sandbox } from "../../test/helpers.js";
import { resolveProfileName } from "../config.js";
import { type RunningGateway, startGateway } from "./gateway.js";
import { createGatewayKey } from "./keys.js";

/**
 * A secret key typed where a capability, a webhook address or a number belongs
 * must not be sent, kept or repeated. A capability is a name such as
 * `invoice.review`: it goes to the other agent inside the request and onto the
 * public Agent Card, so a key in it is a key given away, not only repeated.
 *
 * Every key here is made at run time from a throwaway key. A test that passes
 * before the fix is a control: it guards behaviour the fix must keep.
 */

const KEYS = [
	{ kind: "nsec1…", key: nip19.nsecEncode(generateKeypair().secretKey), prefix: "nsec1" },
	// A NIP-49 string from a throwaway key (scrypt cost 2^4: fast, and no more real than the key).
	{ kind: "ncryptsec1…", key: encrypt(generateKeypair().secretKey, "throwaway-password", 4), prefix: "ncryptsec1" },
];

const PEER = toNpub(generateKeypair().publicKey);

let relay: RunningRelay;
let box: ReturnType<typeof sandbox>;
let gateway: RunningGateway;
let apiKey: string;
const lines: string[] = [];

interface Answer {
	status: number;
	body: string;
}

function send(path: string, options: { method?: string; body?: unknown } = {}): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: gateway.port,
				path,
				method: options.method ?? "GET",
				agent: false,
				headers: {
					authorization: `Bearer ${apiKey}`,
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
		req.setTimeout(10_000, () => req.destroy(new Error("the gateway did not answer in 10 seconds")));
		req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
	});
}

/** True when `text` holds any 12-character stretch of the key's data part (not its constant name), in any case. */
function leaksKey(text: string, key: string, prefix: string): boolean {
	const data = key.toLowerCase().slice(prefix.length);
	const lower = text.toLowerCase();
	for (let i = 0; i + 12 <= data.length; i++) {
		if (lower.includes(data.slice(i, i + 12))) {
			return true;
		}
	}
	return false;
}

/** The key's first letter as an escape (`%6e`): the key's name is no longer in the text as written. */
function escaped(key: string): string {
	return `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`;
}

const FORMS = [
	{ name: "in plain", of: (key: string) => key },
	{ name: "with its first letter written as %6e", of: (key: string) => escaped(key) },
];

/** What a failing check may print: a note in place of any text that repeats the key. */
function safe(text: string, key: string, prefix: string): string {
	return leaksKey(text, key, prefix) ? "(repeats the key)" : text;
}

beforeAll(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	expect((await agx("identity", "new")).code).toBe(0);
	expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	const profile = resolveProfileName();
	apiKey = createGatewayKey(profile, "test").key;
	gateway = await startGateway({ profile, port: 0, pollIntervalMs: 500, log: (line: string) => lines.push(line) });
	const deadline = Date.now() + 30_000;
	while ((await send("/v1/health")).status !== 200) {
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

/** The answer must refuse (400), say the key is not shown, and neither it nor the log may repeat the key. */
function expectRefused(res: Answer, key: string, prefix: string): void {
	expect(res.status).toBe(400);
	expect(safe(res.body, key, prefix)).toContain("not shown");
	expect(leaksKey(res.body, key, prefix)).toBe(false);
	expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
}

describe.each(KEYS)("a secret key ($kind) typed into a field that is not a peer", ({ key, prefix }) => {
	describe.each(FORMS)("$name", (form) => {
		it("is refused as the capability of a task request, and nothing is sent", async () => {
			const res = await send("/v1/tasks", {
				method: "POST",
				body: { peer: PEER, capability: form.of(key), timeoutSec: 1 },
			});
			expectRefused(res, key, prefix);
		});

		it("is refused as the capability asked about on an agent's card", async () => {
			const res = await send(`/v1/agents/${PEER}?capability=${form.of(key)}`);
			expectRefused(res, key, prefix);
		});

		it("is refused as a capability a webhook serves", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: "http://127.0.0.1:9/hook", events: ["task"], capabilities: [form.of(key)], acceptAll: true },
			});
			expectRefused(res, key, prefix);
		});

		it("is refused as a capability with a wildcard, which the webhook check would otherwise quote", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: "http://127.0.0.1:9/hook", events: ["task"], capabilities: [`${form.of(key)}*`], acceptAll: true },
			});
			expectRefused(res, key, prefix);
		});

		it("is not repeated when it is typed as the webhook address", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: `not a url ${form.of(key)}`, events: ["message"], acceptAll: true },
			});
			expect(res.status).toBe(400);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});

		it("is not repeated when it is typed as a number", async () => {
			const res = await send("/v1/tasks", {
				method: "POST",
				body: { peer: PEER, capability: "invoice.review", timeoutSec: form.of(key) },
			});
			expect(res.status).toBe(400);
			expect(leaksKey(res.body, key, prefix)).toBe(false);
			expect(leaksKey(lines.join("\n"), key, prefix)).toBe(false);
		});
	});
});

describe("ordinary values are still quoted and accepted", () => {
	it("quotes a bad number as written", async () => {
		const res = await send("/v1/tasks", {
			method: "POST",
			body: { peer: PEER, capability: "invoice.review", timeoutSec: "soon" },
		});
		expect(res.status).toBe(400);
		expect(res.body).toContain('not \\"soon\\"');
	});

	it("quotes a bad webhook address as written", async () => {
		const res = await send("/v1/subscriptions", {
			method: "POST",
			body: { url: "not a url at all", events: ["message"], acceptAll: true },
		});
		expect(res.status).toBe(400);
		expect(res.body).toContain("not a url at all");
	});

	it("answers a card question for an ordinary capability name", async () => {
		const res = await send(`/v1/agents/${PEER}?capability=invoice.review`);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).capability).toBe("invoice.review");
	});

	it("accepts an ordinary capability for a webhook", async () => {
		const res = await send("/v1/subscriptions", {
			method: "POST",
			body: { url: "http://127.0.0.1:9/hook", events: ["task"], capabilities: ["invoice.review"], acceptAll: true },
		});
		expect(res.status).toBe(201);
	});
});

describe.each(KEYS)("a secret key ($kind) typed into a second field, a list, an address or an id", ({ key, prefix }) => {
	describe.each(FORMS)("$name", (form) => {
		it("is refused as the capability of a task request that checks the card first", async () => {
			// The card check answers 404 for an agent without a card: the refusal must come before it,
			// or the 422 text "does not advertise ..." would quote the capability.
			const res = await send("/v1/tasks", {
				method: "POST",
				body: { peer: PEER, capability: form.of(key), checkCard: true, timeoutSec: 1 },
			});
			expectRefused(res, key, prefix);
		});

		it("is refused as the second capability of a webhook list that is put on the Agent Card", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: {
					url: "http://127.0.0.1:9/hook",
					events: ["task"],
					capabilities: ["invoice.review", form.of(key)],
					advertise: true,
					acceptAll: true,
				},
			});
			expectRefused(res, key, prefix);
			const listed = await send("/v1/subscriptions");
			expect(leaksKey(listed.body, key, prefix)).toBe(false);
		});

		it("is refused inside a webhook address that is otherwise a URL, so it is not kept or logged", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: `http://127.0.0.1:9/hook?k=${form.of(key)}`, events: ["message"], acceptAll: true },
			});
			expectRefused(res, key, prefix);
			expect((await send("/v1/subscriptions")).body).not.toContain("127.0.0.1:9/hook?k=");
		});

		it("is refused as a webhook label, so it is not kept or shown back", async () => {
			const res = await send("/v1/subscriptions", {
				method: "POST",
				body: { url: "http://127.0.0.1:9/hook", events: ["message"], acceptAll: true, label: form.of(key) },
			});
			expectRefused(res, key, prefix);
		});

		it("is refused as a conversation id, which is sent and shown back", async () => {
			const res = await send("/v1/messages", {
				method: "POST",
				body: { peer: PEER, text: "hello", contextId: form.of(key) },
			});
			expectRefused(res, key, prefix);
		});
	});
});

describe("an ordinary webhook address with a query, an ordinary label and an ordinary conversation id are still accepted", () => {
	it("keeps a webhook address with a token in its query and a label", async () => {
		const res = await send("/v1/subscriptions", {
			method: "POST",
			body: { url: "http://127.0.0.1:9/hook?token=abc123", events: ["message"], acceptAll: true, label: "invoices" },
		});
		expect(res.status).toBe(201);
		expect(JSON.parse(res.body).label).toBe("invoices");
	});
});
