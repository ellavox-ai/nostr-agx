import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { ApiError } from "./http.js";
import { type OperationDeps, parseTaskRequest, readCard, sendMessage } from "./operations.js";
import { parseSubscriptionInput, SubscriptionError } from "./subscriptions.js";

// The gateway answers a bad peer with a 400 that says what was wrong. When the
// "peer" is a secret key, that answer must not carry the key back: it travels to
// the caller, into the caller's logs and, for an agent, into its context.

const NSEC = nip19.nsecEncode(generateKeypair().secretKey);
const PUBLIC = toNpub(generateKeypair().publicKey);
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

describe("a secret key given as the agent in a gateway request", () => {
	it.each([
		["POST /v1/tasks", () => parseTaskRequest({ peer: NSEC, capability: "invoice.review" })],
		["POST /v1/messages", () => sendMessage(noDeps, { peer: NSEC, text: "hello" })],
		["GET /v1/agents/:peer", () => readCard(noDeps, NSEC, new URLSearchParams())],
	])("%s answers 400 invalid_peer and does not repeat it", async (_name, call) => {
		const error = await refused(call);
		expect(error).toBeInstanceOf(ApiError);
		const refusal = error as ApiError;
		expect(refusal.status).toBe(400);
		expect(refusal.code).toBe("invalid_peer");
		expect(refusal.message).toMatch(/secret key/i);
		expect(refusal.message).not.toContain(NSEC);
		expect(leakedPart(refusal.message, NSEC)).toBeNull();
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["after other text", `key=${NSEC}`],
	])("does not repeat a key %s", async (_form, value) => {
		const error = await refused(() => parseTaskRequest({ peer: value, capability: "invoice.review" }));
		expect((error as ApiError).code).toBe("invalid_peer");
		expect(leakedPart((error as ApiError).message, NSEC)).toBeNull();
	});

	it("is not repeated in a webhook's allowed agents either", () => {
		let message = "";
		try {
			parseSubscriptionInput({
				url: "https://n8n.example.com/webhook/abc",
				events: ["task"],
				capabilities: ["invoice.review"],
				allowedPeers: [PUBLIC, NSEC],
			});
		} catch (error) {
			expect(error).toBeInstanceOf(SubscriptionError);
			message = (error as Error).message;
		}
		expect(message).toMatch(/secret key/i);
		expect(message).not.toContain(NSEC);
		expect(leakedPart(message, NSEC)).toBeNull();
	});
});

describe("a value that is not a key given as the agent in a gateway request", () => {
	it("is still named in the answer, which helps the caller find the typo", async () => {
		const error = await refused(() => parseTaskRequest({ peer: "npub1typo", capability: "invoice.review" }));
		expect((error as ApiError).code).toBe("invalid_peer");
		expect((error as ApiError).message).toContain("npub1typo");
	});

	it("is still named in a webhook's allowed agents", () => {
		expect(() =>
			parseSubscriptionInput({
				url: "https://n8n.example.com/webhook/abc",
				events: ["task"],
				capabilities: ["invoice.review"],
				allowedPeers: ["npub1typo"],
			}),
		).toThrow(/npub1typo/);
	});
});
