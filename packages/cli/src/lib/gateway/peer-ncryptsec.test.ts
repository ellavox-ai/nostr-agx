import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import { encrypt } from "nostr-tools/nip49";
import { describe, expect, it } from "vitest";
import { ApiError } from "./http.js";
import { type OperationDeps, parseTaskRequest, readCard, sendMessage } from "./operations.js";
import { parseSubscriptionInput, SubscriptionError } from "./subscriptions.js";

// A password-protected secret key (NIP-49, `ncryptsec1…`) is a secret key of the same
// class as an `nsec1…` (see peer-secret.test.ts). Given as the "peer" of a gateway
// request, the 400 must not carry it back to the caller, into the caller's logs or,
// for an agent, into its context.

/** A real NIP-49 string, made here from a throwaway key (scrypt cost 2^4: fast, and no more real than the key). */
const NCRYPTSEC = encrypt(generateKeypair().secretKey, "throwaway-password", 4);
const PUBLIC = toNpub(generateKeypair().publicKey);
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

/** peerOf runs before any dependency is used, so none is needed. */
const noDeps = {} as OperationDeps;

async function refused(call: () => unknown): Promise<unknown> {
	try {
		await call();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused");
}

describe("an encrypted secret key (ncryptsec1…) given as the agent in a gateway request", () => {
	it("is a real NIP-49 string", () => {
		expect(NCRYPTSEC.startsWith("ncryptsec1")).toBe(true);
		expect(NCRYPTSEC.length).toBeGreaterThan(100);
	});

	it.each([
		["POST /v1/tasks", () => parseTaskRequest({ peer: NCRYPTSEC, capability: "invoice.review" })],
		["POST /v1/messages", () => sendMessage(noDeps, { peer: NCRYPTSEC, text: "hello" })],
		["GET /v1/agents/:peer", () => readCard(noDeps, NCRYPTSEC, new URLSearchParams())],
	])("%s answers 400 invalid_peer and does not repeat it", async (_name, call) => {
		const error = await refused(call);
		expect(error).toBeInstanceOf(ApiError);
		const refusal = error as ApiError;
		expect(refusal.status).toBe(400);
		expect(refusal.code).toBe("invalid_peer");
		expect(refusal.message).toMatch(/secret key/i);
		expect(refusal.message).not.toContain(NCRYPTSEC);
		expect(leakedPart(refusal.message, NCRYPTSEC)).toBeNull();
	});

	it.each([
		["in capitals", NCRYPTSEC.toUpperCase()],
		["after nostr:", `nostr:${NCRYPTSEC}`],
		["after other text", `key=${NCRYPTSEC}`],
		["cut short", NCRYPTSEC.slice(0, 60)],
	])("does not repeat a key %s", async (_form, value) => {
		const error = await refused(() => parseTaskRequest({ peer: value, capability: "invoice.review" }));
		expect((error as ApiError).code).toBe("invalid_peer");
		expect((error as ApiError).message).toMatch(/secret key/i);
		expect(leakedPart((error as ApiError).message, NCRYPTSEC)).toBeNull();
	});

	it("is not repeated in a webhook's allowed agents either", () => {
		let message = "";
		try {
			parseSubscriptionInput({
				url: "https://n8n.example.com/webhook/abc",
				events: ["task"],
				capabilities: ["invoice.review"],
				allowedPeers: [PUBLIC, NCRYPTSEC],
			});
		} catch (error) {
			expect(error).toBeInstanceOf(SubscriptionError);
			message = (error as Error).message;
		}
		expect(message).toMatch(/secret key/i);
		expect(message).not.toContain(NCRYPTSEC);
		expect(leakedPart(message, NCRYPTSEC)).toBeNull();
	});
});
