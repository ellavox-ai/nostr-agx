import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// A password-protected secret key (NIP-49, `ncryptsec1…`) is a secret key of the
// same class as an `nsec1…` (see ncryptsec-secret.test.ts). `peers allowlist --npub`
// and `listing create --pubkey` hand their value to the remote index, so one given
// there must be refused on this machine before anything is sent, just as an nsec1 is
// (see peer-secret-index.test.ts).

let box: ReturnType<typeof sandbox>;
let server: Server;
let received: Array<{ method: string; url: string; body: string }>;
const mine = createIdentity();
/** A real NIP-49 string, made here from a throwaway key (scrypt cost 2^4: fast, and no more real than the key). */
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
/** The first 10-character stretch of the key's data part (not the constant `ncryptsec1`) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = "ncryptsec1".length; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(async () => {
	box = sandbox();
	saveIdentity("default", mine);
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

const LISTING = ["--slug", "payables", "--display-name", "Payables"];

function indexCommands(value: string): string[][] {
	return [
		["peers", "allowlist", "--team", "t1", "--npub", value],
		["listing", "create", ...LISTING, "--pubkey", value],
	];
}

describe("an encrypted secret key (ncryptsec1…) given as the peer to look up at the index", () => {
	it("is a real NIP-49 string", () => {
		expect(NCRYPTSEC.startsWith("ncryptsec1")).toBe(true);
		expect(NCRYPTSEC.length).toBeGreaterThan(100);
	});

	it.each([
		["agx peers allowlist --npub", indexCommands(NCRYPTSEC)[0]],
		["agx listing create --pubkey", indexCommands(NCRYPTSEC)[1]],
	])("%s refuses it, sends nothing and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toMatch(/secret key/i);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NCRYPTSEC);
			expect(leakedPart(out, NCRYPTSEC)).toBeNull();
		}
	});

	// The refusal looks for `ncryptsec1` anywhere in the value, in any case, so a
	// pasted key is caught however it is wrapped. Each form runs through both commands.
	it.each([
		["in capitals", NCRYPTSEC.toUpperCase()],
		["after nostr:", `nostr:${NCRYPTSEC}`],
		["with spaces around it", `  ${NCRYPTSEC}  `],
		["after other text", `key=${NCRYPTSEC}`],
		["cut short", NCRYPTSEC.slice(0, 60)],
	])("refuses a key %s and sends nothing", async (_form, value) => {
		for (const args of indexCommands(value)) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.usage);
			for (const out of [run.stdout, run.stderr]) {
				expect(leakedPart(out, NCRYPTSEC)).toBeNull();
			}
		}
		expect(received).toEqual([]);
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("peers", "allowlist", "--team", "t1", "--npub", NCRYPTSEC, "--json");
		expect(run.code).toBe(EXIT.usage);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NCRYPTSEC)).toBeNull();
		}
	});

	it("is answered the same way as an nsec1…", async () => {
		for (const [encrypted, plain] of [
			[indexCommands(NCRYPTSEC)[0], indexCommands(NSEC)[0]],
			[indexCommands(NCRYPTSEC)[1], indexCommands(NSEC)[1]],
		]) {
			const a = await agx(...encrypted);
			const b = await agx(...plain);
			expect(a.stderr).toBe(b.stderr);
			expect(a.code).toBe(b.code);
		}
		expect(received).toEqual([]);
	});
});
