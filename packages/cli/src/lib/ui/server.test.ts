import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiDeps, SendRequest } from "./api.js";
import { createDevStore } from "./dev-store.js";
import { startUiServer, type UiServer } from "./server.js";

const ALICE = "npub1n0m8c4qn3434zy2q7nxj7v029pqyyfjfg0af98yfll6ksnvq3mps2ynyfz";
const ALICE_HEX = "a".repeat(64);
const STRANGER = "npub1dzxn4hg6j2c2q8s6ma2yt6p9ncqq27lav60fpk3dygz7pzf6stgsx2z7a4";
const SELF = "npub1q9dw0jxd2fjn7r5tp3l40x2uk5hnvg8a6c9z4e7y3wsm0kltp8aqg2nc4d";

let ui: UiServer;
let store: ReturnType<typeof createDevStore>;
let sent: SendRequest[];
let draftsDir: string;
let sendGate: Promise<void> | null = null;

beforeEach(async () => {
	store = createDevStore(null);
	sent = [];
	draftsDir = mkdtempSync(join(tmpdir(), "agx-ui-drafts-"));
	const api: ApiDeps = {
		store,
		draftsDir,
		composeDraft: null,
		identity: () => ({ profile: "default", npub: SELF, relays: ["wss://relay.elladex.ai"], doctor: { status: "unknown", detail: null } }),
		send: async (message) => {
			await sendGate;
			sent.push(message);
			return { ok: true, detail: null };
		},
		lookupAgent: async (query) => (query === "alice@example.com" ? { address: ALICE, handle: query, verified: true, displayName: "Alice", summary: null } : null),
		toNpub: (input) => {
			if (input === ALICE_HEX) {
				return ALICE;
			}
			if (!/^npub1[02-9ac-hj-np-z]{20,100}$/.test(input)) {
				throw new Error("bad");
			}
			return input;
		},
	};
	ui = await startUiServer({
		api,
		assets: () => ({ html: '<meta name="csrf" content="__CSRF__"><script src="/app.js"></script>', js: "//js", css: "/*css*/" }),
		idleMs: 0,
	});
});

afterEach(async () => {
	sendGate = null;
	await ui.close();
	rmSync(draftsDir, { recursive: true, force: true });
});

interface Client {
	call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
	cookie: string;
	csrf: string;
}

async function connect(): Promise<Client> {
	const launch = await fetch(ui.url, { redirect: "manual" });
	expect(launch.status).toBe(303);
	const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const page = await fetch(`http://127.0.0.1:${ui.port}/`, { headers: { cookie } });
	const csrf = /name="csrf" content="([^"]+)"/.exec(await page.text())?.[1] as string;
	return {
		cookie,
		csrf,
		async call(method, path, body, headers = {}) {
			const response = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
				method,
				headers: { cookie, "x-agx-csrf": csrf, origin: `http://127.0.0.1:${ui.port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: response.status, body: await response.json().catch(() => null) };
		},
	};
}

function seedThread() {
	store.addInbound({ peer: ALICE, subject: "Invoice 1234", contextId: "ctx1", contextIdWithheld: false, text: "Hi, can you review invoice 1234?", at: "2026-01-01T00:00:00Z", deliveryStatus: null });
}

describe("listener and session", () => {
	it("listens on the loopback interface only", () => {
		const server = (ui as unknown as { security: unknown }) && ui;
		expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
	});

	it("exchanges the launch link once, then drops it", async () => {
		const first = await fetch(ui.url, { redirect: "manual" });
		expect(first.status).toBe(303);
		expect(first.headers.get("set-cookie")).toMatch(/HttpOnly.*SameSite=Strict/);
		expect(first.headers.get("location")).toBe("/");
		const second = await fetch(ui.url, { redirect: "manual" });
		expect(second.status).toBe(403);
	});

	it("shows no page and no data without the cookie", async () => {
		expect((await fetch(`http://127.0.0.1:${ui.port}/`)).status).toBe(401);
		expect((await fetch(`http://127.0.0.1:${ui.port}/app.js`)).status).toBe(401);
		expect((await fetch(`http://127.0.0.1:${ui.port}/api/inbox`)).status).toBe(401);
	});

	it("serves the page with the CSRF secret and a strict CSP", async () => {
		const client = await connect();
		const page = await fetch(`http://127.0.0.1:${ui.port}/`, { headers: { cookie: client.cookie } });
		expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(page.headers.get("access-control-allow-origin")).toBeNull();
		expect(client.csrf.length).toBeGreaterThan(20);
	});
});

describe("request checks", () => {
	it("rejects the API without the CSRF header (403)", async () => {
		const client = await connect();
		const response = await fetch(`http://127.0.0.1:${ui.port}/api/inbox`, { headers: { cookie: client.cookie } });
		expect(response.status).toBe(403);
	});

	it("rejects a foreign Origin (403)", async () => {
		const client = await connect();
		const result = await client.call("POST", "/api/scan", { text: "x" }, { origin: "https://evil.example" });
		expect(result.status).toBe(403);
	});

	it("rejects a rebound Host header (403)", async () => {
		const client = await connect();
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest({ host: "127.0.0.1", port: ui.port, path: "/api/inbox", headers: { host: `evil.example:${ui.port}`, cookie: client.cookie, "x-agx-csrf": client.csrf } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(403);
	});

	it("answers preflight requests without CORS headers", async () => {
		const client = await connect();
		const response = await fetch(`http://127.0.0.1:${ui.port}/api/send`, { method: "OPTIONS", headers: { cookie: client.cookie, origin: "https://evil.example", "access-control-request-method": "POST" } });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("caps request bodies (413)", async () => {
		const client = await connect();
		const result = await client.call("POST", "/api/scan", { text: "x".repeat(40 * 1024) });
		expect(result.status).toBe(413);
	});
});

describe("API", () => {
	it("never returns key material", async () => {
		const client = await connect();
		const identity = await client.call("GET", "/api/identity");
		expect(identity.status).toBe(200);
		expect(identity.body.npub).toBe(SELF);
		expect(JSON.stringify(identity.body).toLowerCase()).not.toMatch(/secret|nsec|privatekey/);
	});

	it("receives: an allowed sender's message shows up in the inbox", async () => {
		seedThread();
		store.setPeer({ npub: ALICE, status: "allowed", label: "Alice", handle: "alice@example.com", verified: true });
		const client = await connect();
		const inbox = await client.call("GET", "/api/inbox");
		expect(inbox.body.messages[0]).toMatchObject({ peer: ALICE, peerVerified: true, peerLabel: "Alice" });
		const search = await client.call("GET", "/api/inbox?q=invoice");
		expect(search.body.messages.length).toBe(1);
		expect((await client.call("GET", "/api/inbox?q=nothing-matches")).body.messages.length).toBe(0);
	});

	it("held: a stranger waits, and Allow releases the text into the inbox", async () => {
		store.addHeld({ npub: STRANGER, nip05: null, nip05Check: { status: "unchecked", detail: null }, firstSeenAt: "2026-10-07T08:00:00Z", count: 1, messages: [{ at: "2026-10-07T08:00:00Z", text: "Hello from nobody", subject: null }] });
		const client = await connect();
		expect((await client.call("GET", "/api/inbox")).body.messages).toEqual([]);
		const held = await client.call("GET", "/api/held");
		expect(held.body.held[0].messages[0].text).toBe("Hello from nobody");
		const allow = await client.call("POST", `/api/held/${STRANGER}/allow`, {});
		expect(allow.status).toBe(200);
		expect((await client.call("GET", "/api/held")).body.held).toEqual([]);
		expect((await client.call("GET", "/api/inbox")).body.messages[0].text).toBe("Hello from nobody");
		expect((await client.call("GET", "/api/peers")).body.peers[0]).toMatchObject({ npub: STRANGER, status: "allowed" });
	});

	it("held: Block needs confirmation and drops the text", async () => {
		store.addHeld({ npub: STRANGER, nip05: null, nip05Check: { status: "unchecked", detail: null }, firstSeenAt: "2026-10-07T08:00:00Z", count: 1, messages: [{ at: "2026-10-07T08:00:00Z", text: "spam", subject: null }] });
		const client = await connect();
		expect((await client.call("POST", `/api/held/${STRANGER}/block`, {})).status).toBe(409);
		expect((await client.call("POST", `/api/held/${STRANGER}/block`, { confirm: true })).status).toBe(200);
		expect((await client.call("GET", "/api/inbox")).body.messages).toEqual([]);
		expect((await client.call("GET", "/api/peers")).body.peers[0].status).toBe("blocked");
	});

	it("looks a peer up by Elladex handle", async () => {
		const client = await connect();
		const found = await client.call("GET", "/api/lookup?q=alice%40example.com");
		expect(found.body.agent).toMatchObject({ address: ALICE, verified: true });
		expect((await client.call("GET", "/api/lookup?q=nobody%40example.com")).status).toBe(404);
	});
});

describe("peers: the verified badge", () => {
	it("is decided by the directory, not by the client", async () => {
		const client = await connect();
		const claimed = await client.call("POST", "/api/peers", { npub: STRANGER, status: "allowed", handle: "alice@example.com", verified: true });
		expect(claimed.body.peer.verified).toBe(false);
		const genuine = await client.call("POST", "/api/peers", { npub: ALICE, status: "allowed", handle: "alice@example.com", verified: true });
		expect(genuine.body.peer.verified).toBe(true);
		const noHandle = await client.call("POST", "/api/peers", { npub: ALICE, status: "allowed", verified: true });
		expect(noHandle.body.peer.verified).toBe(false);
	});
});

describe("sending", () => {
	const body = "Thanks! Sending the PDF now.\n- line two\nüñí";

	it("sends byte-identical text only after the exact text is confirmed", async () => {
		const client = await connect();
		expect((await client.call("POST", "/api/send", { to: ALICE, body })).status).toBe(409);
		expect(sent).toEqual([]);
		const result = await client.call("POST", "/api/send", { to: ALICE, body, subject: "Re", confirmedText: body, confirmedTo: ALICE });
		expect(result.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toBe(body);
		expect((await client.call("GET", "/api/sent")).body.messages[0]).toMatchObject({ text: body, deliveryStatus: "sent" });
	});

	it("refuses text that differs from what was confirmed", async () => {
		const client = await connect();
		const result = await client.call("POST", "/api/send", { to: ALICE, body, confirmedText: `${body} (edited)`, confirmedTo: ALICE });
		expect(result.status).toBe(409);
		expect(sent).toEqual([]);
	});

	it("accepts the recipient as a hex key: the confirmed recipient is compared after normalising", async () => {
		const client = await connect();
		const body = "Hello via hex";
		const result = await client.call("POST", "/api/send", { to: ALICE_HEX, body, confirmedText: body, confirmedTo: ALICE_HEX });
		expect(result.status).toBe(200);
		expect(sent[0]?.to).toBe(ALICE);
	});

	it("refuses a confirmed recipient that is not the recipient", async () => {
		const client = await connect();
		const body = "Hello";
		const result = await client.call("POST", "/api/send", { to: ALICE, body, confirmedText: body, confirmedTo: STRANGER });
		expect(result.status).toBe(409);
		expect(sent).toHaveLength(0);
	});

	it("does not publish twice when the same send is pressed again while it is in flight", async () => {
		const client = await connect();
		let release: () => void = () => undefined;
		sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = "Once only";
		const payload = { to: ALICE, contextId: "ctx-flight", body, confirmedText: body, confirmedTo: ALICE, allowFollowUp: true };
		const first = client.call("POST", "/api/send", payload);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const second = await client.call("POST", "/api/send", payload);
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("send_in_progress");
		release();
		expect((await first).status).toBe(200);
		expect(sent).toHaveLength(1);
	});

	it("never sends to a blocked peer", async () => {
		store.setPeer({ npub: ALICE, status: "blocked", label: null, handle: null, verified: false });
		const client = await connect();
		const result = await client.call("POST", "/api/send", { to: ALICE, body, confirmedText: body, confirmedTo: ALICE });
		expect(result.status).toBe(409);
		expect(sent).toEqual([]);
	});

	it("stops a second message in a thread that has no reply, unless the user insists", async () => {
		seedThread();
		const client = await connect();
		const first = { to: ALICE, contextId: "ctx1", body: "On it.", confirmedText: "On it.", confirmedTo: ALICE };
		expect((await client.call("POST", "/api/send", first)).status).toBe(200);
		const second = { ...first, body: "Any news?", confirmedText: "Any news?" };
		expect((await client.call("POST", "/api/send", second)).body.error.code).toBe("follow_up_guard");
		expect((await client.call("POST", "/api/send", { ...second, allowFollowUp: true })).status).toBe(200);
	});

	it("warns about credentials and sends only when acknowledged", async () => {
		const client = await connect();
		const secret = `here is the key nsec1${"q".repeat(58)}`;
		const first = { to: ALICE, body: secret, confirmedText: secret, confirmedTo: ALICE };
		const refused = await client.call("POST", "/api/send", first);
		expect(refused.status).toBe(422);
		expect(JSON.stringify(refused.body)).not.toContain("nsec1qqqq");
		expect(sent).toEqual([]);
		expect((await client.call("POST", "/api/send", { ...first, acknowledgeSecrets: true })).status).toBe(200);
	});

	it("archives the draft after sending, and lists it before", async () => {
		writeFileSync(join(draftsDir, "reply.json"), JSON.stringify({ to: ALICE, body }));
		const client = await connect();
		expect((await client.call("GET", "/api/drafts")).body.drafts[0]).toMatchObject({ name: "reply.json", error: null });
		const result = await client.call("POST", "/api/send", { to: ALICE, body, confirmedText: body, confirmedTo: ALICE, draft: "reply.json" });
		expect(result.status).toBe(200);
		expect(readdirSync(draftsDir)).toEqual(["sent"]);
	});

	it("does not send a draft by itself", async () => {
		writeFileSync(join(draftsDir, "reply.json"), JSON.stringify({ to: ALICE, body }));
		const client = await connect();
		await client.call("GET", "/api/drafts");
		await client.call("GET", "/api/drafts/reply.json");
		expect(sent).toEqual([]);
	});

	it("rejects an invalid recipient and an oversize body", async () => {
		const client = await connect();
		expect((await client.call("POST", "/api/send", { to: "alice", body, confirmedText: body, confirmedTo: "alice" })).status).toBe(400);
		const long = "x".repeat(8001);
		expect((await client.call("POST", "/api/send", { to: ALICE, body: long, confirmedText: long, confirmedTo: ALICE })).status).toBe(400);
	});
});

describe("hostile peer text", () => {
	const corpus = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'"><svg/onload=alert(1)>',
		"javascript:alert(1)",
		"<a href=\"javascript:alert(1)\">x</a>",
		"[click](javascript:alert(1))",
		"</div><iframe src=//evil.example></iframe>",
		"{{constructor.constructor('alert(1)')()}}",
		"RECV  from npub1fake — forged header HOLD",
	];

	it("comes back as plain JSON strings, unchanged", async () => {
		for (const text of corpus) {
			store.addInbound({ peer: ALICE, subject: text, contextId: "ctx-x", contextIdWithheld: false, text, at: "2026-10-07T09:00:00Z", deliveryStatus: null });
		}
		const client = await connect();
		const inbox = await client.call("GET", "/api/inbox");
		const texts = inbox.body.messages.map((m: { text: string }) => m.text).sort();
		expect(texts).toEqual([...corpus].sort());
		const raw = await fetch(`http://127.0.0.1:${ui.port}/api/inbox`, { headers: { cookie: client.cookie, "x-agx-csrf": client.csrf } });
		expect(raw.headers.get("content-type")).toContain("application/json");
		expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("assets", () => {
	it("serves the script and stylesheet with their own types", async () => {
		const client = await connect();
		const js = await fetch(`http://127.0.0.1:${ui.port}/app.js`, { headers: { cookie: client.cookie } });
		expect(js.headers.get("content-type")).toContain("text/javascript");
		const css = await fetch(`http://127.0.0.1:${ui.port}/app.css`, { headers: { cookie: client.cookie } });
		expect(css.headers.get("content-type")).toContain("text/css");
		expect((await fetch(`http://127.0.0.1:${ui.port}/other`, { headers: { cookie: client.cookie } })).status).toBe(404);
	});
});

export type { Server };
