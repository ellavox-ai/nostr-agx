import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hexToBytes, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// `peers allowlist --npub` and `listing create --pubkey` hand their value to the
// remote index. A secret key typed there must be refused on this machine, before
// anything is sent: once it is in a request body it is on the network and in the
// server's logs.

let box: ReturnType<typeof sandbox>;
let server: Server;
let received: Array<{ method: string; url: string; body: string }>;
const mine = createIdentity();
const friend = createIdentity();
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

describe("a secret key given as the peer to look up at the index", () => {
	it.each([
		["agx peers allowlist --npub", ["peers", "allowlist", "--team", "t1", "--npub", NSEC]],
		["agx listing create --pubkey", ["listing", "create", ...LISTING, "--pubkey", NSEC]],
	])("%s refuses it, sends nothing and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NSEC);
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});

	// The refusal looks for `nsec1` anywhere in the value, in any case, so a pasted
	// key is caught however it is wrapped. Each form runs through both commands.
	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["with spaces around it", `  ${NSEC}  `],
		["after other text", `key=${NSEC}`],
	])("refuses a key %s and sends nothing", async (_form, value) => {
		for (const args of [
			["peers", "allowlist", "--team", "t1", "--npub", value],
			["listing", "create", ...LISTING, "--pubkey", value],
		]) {
			const run = await agx(...args);
			expect(run.code).toBe(2);
			for (const out of [run.stdout, run.stderr]) {
				expect(leakedPart(out, NSEC)).toBeNull();
			}
		}
		expect(received).toEqual([]);
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("peers", "allowlist", "--team", "t1", "--npub", NSEC, "--json");
		expect(run.code).toBe(2);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});

describe("a value that is not a secret key given as the peer to look up at the index", () => {
	// The index's own contract is not visible from here (its `identity` field may
	// take more than an npub, for example a NIP-05 address), so only a secret key
	// is refused locally. Anything else goes to the index as typed, as before.
	it.each([
		["agx peers allowlist --npub", ["peers", "allowlist", "--team", "t1", "--npub", "alice@example.com"]],
		["agx listing create --pubkey", ["listing", "create", ...LISTING, "--pubkey", "alice@example.com"]],
	])("%s still reaches the index, as typed", async (_name, args) => {
		await agx(...args);
		expect(received).toHaveLength(1);
		expect(received[0]?.body).toContain("alice@example.com");
	});
});

describe("a public key given as the peer to look up at the index", () => {
	const npub = toNpub(friend.publicKey);

	it.each([
		["agx peers allowlist --npub", ["peers", "allowlist", "--team", "t1", "--npub", npub]],
		["agx listing create --pubkey", ["listing", "create", ...LISTING, "--pubkey", npub, "--relay", "wss://relay.example.com"]],
	])("%s still reaches the index, with the key as typed", async (_name, args) => {
		await agx(...args);
		expect(received).toHaveLength(1);
		expect(received[0]?.body).toContain(npub);
	});
});
