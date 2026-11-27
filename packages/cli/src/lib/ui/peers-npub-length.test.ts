import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiToNpub } from "../peer.js";
import { MessageStore } from "../store/message-store.js";
import { createAgxStore } from "./agx-store.js";
import type { ApiDeps } from "./api.js";
import { startUiServer, type UiServer } from "./server.js";

// The UI's route check for an npub is loose (any bech32 letters), and the real store then runs the strict
// `toHexPubkey`. A well-formed npub that does not carry 32 bytes must end as a clean 400, not as a thrown
// error that the server turns into a 500.

const GOOD = "cd".repeat(32);
const WRONG_LENGTH_NPUB = toNpub("ab".repeat(20));

let dir: string;
let ui: UiServer;
let disk: Set<string>;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "agx-ui-npub-length-"));
	disk = new Set([GOOD]);
	const allowed = new Set(disk);
	const api: ApiDeps = {
		store: createAgxStore({
			dir,
			store: new MessageStore(dir),
			allowed,
			loadAllow: () => [...disk],
			changeAllow: (hex, on) => {
				if (on) {
					disk.add(hex);
				} else {
					disk.delete(hex);
				}
			},
		}),
		draftsDir: dir,
		composeDraft: null,
		identity: () => ({ profile: "default", npub: toNpub(GOOD), relays: [], doctor: { status: "unknown", detail: null } }),
		send: async () => ({ ok: true, detail: null }),
		lookupAgent: async () => null,
		toNpub: uiToNpub,
	};
	ui = await startUiServer({
		api,
		assets: () => ({ html: '<meta name="csrf" content="__CSRF__"><script src="/app.js"></script>', js: "//js", css: "/*css*/" }),
		idleMs: 0,
	});
});

afterEach(async () => {
	await ui.close();
	rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
	const launch = await fetch(ui.url, { redirect: "manual" });
	const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const page = await fetch(`http://127.0.0.1:${ui.port}/`, { headers: { cookie } });
	const csrf = /name="csrf" content="([^"]+)"/.exec(await page.text())?.[1] as string;
	const response = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
		method,
		headers: { cookie, "x-agx-csrf": csrf, origin: `http://127.0.0.1:${ui.port}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => null) };
}

describe("an npub that does not carry 32 bytes, through the UI", () => {
	it("DELETE /api/peers/<it> answers 400 bad_npub and changes nothing", async () => {
		const res = await call("DELETE", `/api/peers/${WRONG_LENGTH_NPUB}`);
		expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 400, code: "bad_npub" });
		expect([...disk]).toEqual([GOOD]);
	});

	it("POST /api/peers with it answers 400 bad_npub (control)", async () => {
		const res = await call("POST", "/api/peers", { npub: WRONG_LENGTH_NPUB, status: "allowed" });
		expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 400, code: "bad_npub" });
		expect([...disk]).toEqual([GOOD]);
	});

	it("DELETE /api/peers/<a valid npub> still removes that peer (control)", async () => {
		const res = await call("DELETE", `/api/peers/${toNpub(GOOD)}`);
		expect(res.status).toBe(200);
		expect([...disk]).toEqual([]);
	});
});
