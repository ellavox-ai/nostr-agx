import {
	CARD_KIND,
	generateKeypair,
	localSigner,
	publishToRelays,
	RELAY_LIST_KIND,
	toNpub,
} from "@nostr-agx/nostr";
import kleur from "kleur";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, sandbox } from "../test/helpers.js";

// Node 20 has no global WebSocket; Node 22 and later do. Take it away before any
// module loads, so that `agx card` is tested the way Node 20 runs it on every
// Node version: it has to bring its own WebSocket class to the relay lookup.
const globalWebSocket = vi.hoisted(() => {
	const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
	delete (globalThis as { WebSocket?: unknown }).WebSocket;
	return saved;
});

// The cards here are published to an in-process relay on a free port by
// throwaway identities made here; nothing reaches beyond this machine.

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

beforeAll(() => {
	kleur.enabled = false;
});

afterAll(() => {
	if (globalWebSocket !== undefined) {
		(globalThis as { WebSocket?: unknown }).WebSocket = globalWebSocket;
	}
});

beforeEach(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	updateProfile("default", { relays: [relayUrl()] });
});

afterEach(async () => {
	await relay.close();
	box.restore();
});

const CARD = {
	v: 1,
	org: "Websocket Test Org",
	nip05: null,
	relays: ["wss://relay.example.com"],
	capabilities: ["invoice.review"],
	payloadTypes: ["text/plain"],
	encryption: ["nip44"],
	version: "1.0.0",
};

/** Publish a card, and a relay list when `advertised` is given, under a new identity. */
async function publishCard(advertised?: string[]): Promise<string> {
	const keys = generateKeypair();
	const signer = localSigner(keys.secretKey);
	const now = Math.floor(Date.now() / 1000);
	const events = [
		await signer.signEvent({
			kind: CARD_KIND,
			created_at: now,
			tags: [],
			content: JSON.stringify(CARD),
		}),
	];
	if (advertised) {
		events.push(
			await signer.signEvent({
				kind: RELAY_LIST_KIND,
				created_at: now,
				tags: advertised.map((url) => ["r", url]),
				content: "",
			}),
		);
	}
	for (const event of events) {
		const result = await publishToRelays([relayUrl()], event, undefined, WebSocket);
		expect(result.ok).toBe(true);
	}
	return toNpub(keys.publicKey);
}

describe("agx card with no global WebSocket", () => {
	it("starts from a runtime that really has none", () => {
		expect((globalThis as { WebSocket?: unknown }).WebSocket).toBeUndefined();
	});

	it("prints the card and the relay list a relay holds", async () => {
		const npub = await publishCard(["wss://peer.example.com"]);

		const run = await agx("card", npub, "--relay", relayUrl());

		expect(run.stderr).not.toMatch(/No Agent Card found/);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Websocket Test Org");
		expect(run.stdout).toContain("invoice.review");
		expect(run.stdout).toContain("Relay list (NIP-65)");
		expect(run.stdout).toContain("wss://peer.example.com");
	});

	it("uses the relays of the profile when none is given", async () => {
		const npub = await publishCard();

		const run = await agx("card", npub);

		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Websocket Test Org");
	});

	it("still says so when the relay holds no card", async () => {
		const run = await agx("card", toNpub(generateKeypair().publicKey), "--relay", relayUrl());

		expect(run.code).toBe(EXIT.remote);
		expect(run.stderr).toMatch(/No Agent Card found/);
	});
});
