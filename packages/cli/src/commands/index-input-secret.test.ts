import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx search <query>`, `agx peers accept|refuse|ignore|block --peer <id>` and
// `agx listing get|publish|set-visibility|delist|delete|set-policy <id>` hand a
// typed value to the remote index (and a listing id is also saved in state.json,
// from where `agx doctor` sends it again). A secret key typed there by mistake
// must be refused on this machine, before anything is sent or stored: once it is
// in a request it is on the network and in the server's logs.

let box: ReturnType<typeof sandbox>;
let server: Server;
let received: Array<{ method: string; url: string; body: string }>;
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

beforeEach(async () => {
	box = sandbox();
	saveIdentity("default", createIdentity());
	received = [];
	// A loopback stand-in for the index. It records every request and refuses it,
	// so no test depends on the shape of a real answer.
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({
				method: req.method ?? "",
				url: req.url ?? "",
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: "rejected", message: "rejected" } }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	process.env.AGX_API_URL = `http://127.0.0.1:${port}`;
	process.env.AGX_API_KEY = "throwaway-test-key";
	process.env.AGX_ORG = "acme";
});

afterEach(async () => {
	await new Promise<void>((done) => server.close(() => done()));
	box.restore();
});

/** Let a request that was started but not awaited reach the stand-in index before a test says "nothing was sent". */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 150));

/** Every file and folder name under AGX_HOME, and the text of every file, as one string per entry. */
function everythingUnder(home: string): string[] {
	const found: string[] = [];
	for (const relative of readdirSync(home, { recursive: true, encoding: "utf8" })) {
		found.push(relative);
		const path = join(home, relative);
		if (statSync(path).isFile()) {
			found.push(readFileSync(path, "utf8"));
		}
	}
	return found;
}

/** Everything the index saw, as one string. */
const sent = (): string => received.map((r) => `${r.method} ${r.url} ${r.body}`).join("\n");

async function expectRefusedAndSilent(run: { code: number; stdout: string; stderr: string }): Promise<void> {
	expect(run.code).toBe(2);
	expect(run.stderr).toMatch(/secret key/i);
	await settle();
	expect(received).toEqual([]);
	for (const out of [run.stdout, run.stderr]) {
		expect(out).not.toContain(NSEC);
		expect(leakedPart(out, NSEC)).toBeNull();
	}
}

const DECIDE = [
	["accept", []],
	["refuse", ["--reason", "not now"]],
	["ignore", []],
	["block", []],
] as const;

describe("a secret key given as the search text", () => {
	it("agx search refuses it, sends nothing and prints none of it", async () => {
		const run = await agx("search", NSEC);
		await expectRefusedAndSilent(run);
		expect(run.stderr).toContain("search");
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["with spaces around it", `  ${NSEC}  `],
		["after other words", `find me ${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		await expectRefusedAndSilent(await agx("search", value));
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("search", NSEC, "--json");
		expect(run.code).toBe(2);
		await settle();
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});

	it("refuses it before it looks for credentials", async () => {
		delete process.env.AGX_API_KEY;
		const run = await agx("search", NSEC);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		expect(leakedPart(run.stdout + run.stderr, NSEC)).toBeNull();
	});
});

describe("search text that is not a secret key", () => {
	it("still reaches the index, as typed", async () => {
		await agx("search", "payables agent");
		expect(received).toHaveLength(1);
		expect(decodeURIComponent(sent())).toContain("payables agent");
	});

	it("still reaches the index with no search text at all", async () => {
		await agx("search");
		expect(received).toHaveLength(1);
	});

	it("is not refused for containing the letters nsec without the 1", async () => {
		await agx("search", "nsec-reader");
		expect(received).toHaveLength(1);
	});
});

describe("a secret key given as the peer id of a peers decision", () => {
	it.each(DECIDE)("agx peers %s refuses it, sends nothing and prints none of it", async (action, extra) => {
		const run = await agx("peers", action, "--team", "t1", "--peer", NSEC, ...extra);
		await expectRefusedAndSilent(run);
		expect(run.stderr).toContain("peer id");
		expect(run.stderr).toContain("agx peers list --team <teamId>");
	});

	it("does not repeat --team as typed, so a key there is not shown either", async () => {
		const run = await agx("peers", "block", "--team", `x${NSEC}`, "--peer", NSEC);
		await expectRefusedAndSilent(run);
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["after other text", `peer=${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		for (const [action, extra] of DECIDE) {
			await expectRefusedAndSilent(await agx("peers", action, "--team", "t1", "--peer", value, ...extra));
		}
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("peers", "block", "--team", "t1", "--peer", NSEC, "--json");
		expect(run.code).toBe(2);
		await settle();
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});

describe("an ordinary peer id given to a peers decision", () => {
	it.each(DECIDE)("agx peers %s still reaches the index, with the id as typed", async (action, extra) => {
		await agx("peers", action, "--team", "t1", "--peer", "peer_123", ...extra);
		expect(received).toHaveLength(1);
		expect(sent()).toContain("peer_123");
	});
});

const LISTING_COMMANDS = [
	["listing get", (id: string) => ["listing", "get", id]],
	["listing publish", (id: string) => ["listing", "publish", id]],
	["listing set-visibility", (id: string) => ["listing", "set-visibility", "public", id]],
	["listing delist", (id: string) => ["listing", "delist", id]],
	["listing delete", (id: string) => ["listing", "delete", id, "--yes"]],
	["listing set-policy", (id: string) => ["listing", "set-policy", id]],
] as const;

describe("a secret key given as a listing id", () => {
	it.each(LISTING_COMMANDS)("agx %s refuses it, sends nothing and stores nothing", async (_name, args) => {
		const run = await agx(...args(NSEC));
		await expectRefusedAndSilent(run);
		expect(run.stderr).toContain("listing id");
		expect(run.stderr).toContain("agx listing list");
		// The id is remembered in state.json after a command that accepted it, and `agx doctor` sends it again.
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["after other text", `id=${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		for (const [, args] of LISTING_COMMANDS) {
			await expectRefusedAndSilent(await agx(...args(value)));
		}
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});

	it("agx listing delete refuses it without --yes too, and stores nothing (it stores the id before it asks for the confirmation)", async () => {
		const run = await agx("listing", "delete", NSEC);
		await expectRefusedAndSilent(run);
		expect(run.stderr).not.toContain("irreversible");
		for (const text of everythingUnder(box.home)) {
			expect(leakedPart(text, NSEC)).toBeNull();
		}
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("listing", "get", NSEC, "--json");
		expect(run.code).toBe(2);
		await settle();
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});

describe("an ordinary listing id", () => {
	it.each(LISTING_COMMANDS)("agx %s still reaches the index, with the id as typed", async (_name, args) => {
		await agx(...args("l_123"));
		expect(received).toHaveLength(1);
		expect(sent()).toContain("l_123");
	});

	it("is still remembered in state.json, as before", async () => {
		await agx("listing", "get", "l_123");
		const state = join(box.home, "profiles", "default", "state.json");
		expect(existsSync(state)).toBe(true);
		expect(readFileSync(state, "utf8")).toContain("l_123");
	});
});
