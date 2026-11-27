import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { generateKeypair, localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../../relay/server.js";
import { agx, sandbox } from "../../test/helpers.js";
import { resolveProfileName, updateProfile } from "../config.js";
import { profileDir } from "../paths.js";
import { loadState } from "../state.js";
import { MessageStore } from "../store/message-store.js";
import { type RunningGateway, startGateway } from "./gateway.js";

/**
 * A running gateway reads the saved allowlist again on every poll. It decides which messages
 * go into the profile's history and which are held for a decision. When that read fails (an
 * entry that is not a key, after a hand edit), nobody is allowed until it reads cleanly again.
 */

/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
const POLL_MS = 100;

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let gateway: RunningGateway;
let profile: string;
const logged: string[] = [];

interface Sender {
	secretKey: Uint8Array;
	publicKey: string;
	npub: string;
}

function newSender(): Sender {
	const { secretKey, publicKey } = generateKeypair();
	return { secretKey, publicKey, npub: toNpub(publicKey) };
}

async function sendTo(sender: Sender, text: string): Promise<void> {
	const transport = await NostrTransport.create({
		signer: localSigner(sender.secretKey),
		relays: [`ws://127.0.0.1:${relay.port}`],
		ws: WebSocket,
	});
	try {
		const sent = await transport.publishMessage(gateway.npub, {
			text,
			subject: null,
			contextId: null,
			contentType: DEFAULT_CONTENT_TYPE,
		});
		expect(sent.ok).toBe(true);
	} finally {
		await transport.stop();
	}
}

const stored = () => new MessageStore(profileDir(profile));
const inboxTexts = () => stored().listMessages({ direction: "in" }).map((m) => m.text);
const heldTexts = (sender: Sender) => stored().listHeld().find((h) => h.npub === sender.npub)?.messages.map((m) => m.text) ?? [];
const warnings = () => logged.filter((line) => line.includes("The allowlist cannot be read"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the gateway has finished `n` more polls. A poll reads the allowlist first and writes
 * `lastPumpAt` last. So after two polls, one that began after an edit made just before the call has
 * read the edit: no fixed pause, so no guess about how slow the machine is.
 */
async function polls(n = 2): Promise<void> {
	const deadline = Date.now() + 30_000;
	let last = loadState(profile).lastPumpAt;
	let done = 0;
	while (done < n) {
		if (Date.now() > deadline) {
			throw new Error("the gateway did not finish a poll in time");
		}
		await pause(25);
		const now = loadState(profile).lastPumpAt;
		if (now !== last) {
			last = now;
			done += 1;
		}
	}
}

async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error("waitFor: condition not met in time");
		}
		await pause(50);
	}
}

/** The message is in the history or held: the gateway has sorted it, one way or the other. */
const sorted = (sender: Sender, text: string) => () => inboxTexts().includes(text) || heldTexts(sender).includes(text);

beforeAll(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	expect((await agx("identity", "new")).code).toBe(0);
	expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	profile = resolveProfileName();
	gateway = await startGateway({ profile, port: 0, pollIntervalMs: POLL_MS, log: (line) => logged.push(line) });
}, 30_000);

afterAll(async () => {
	await gateway?.close();
	await relay?.close();
	box?.restore();
});

describe("agx gateway and the saved allowlist", () => {
	it("keeps the history of a peer the list names, when the list reads cleanly", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();

		await sendTo(peer, "from a listed peer");

		await waitFor(sorted(peer, "from a listed peer"));
		expect(inboxTexts()).toContain("from a listed peer");
		expect(heldTexts(peer)).toEqual([]);
	}, 30_000);

	it("still holds a peer the list does not name", async () => {
		const listed = newSender();
		const stranger = newSender();
		updateProfile(profile, { allow: [listed.publicKey] });
		await polls();

		await sendTo(stranger, "from a stranger");

		await waitFor(sorted(stranger, "from a stranger"));
		expect(inboxTexts()).not.toContain("from a stranger");
		expect(heldTexts(stranger)).toEqual(["from a stranger"]);
	}, 30_000);

	it("holds a peer denied while it runs, when the list that replaces it reads cleanly", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();
		expect((await agx("identity", "deny", peer.npub)).code).toBe(0);
		await polls();

		await sendTo(peer, "from a peer just denied");

		await waitFor(sorted(peer, "from a peer just denied"));
		expect(inboxTexts()).not.toContain("from a peer just denied");
		expect(heldTexts(peer)).toEqual(["from a peer just denied"]);
		expect(warnings()).toEqual([]);
	}, 30_000);

	it("holds a peer denied while the list cannot be read, and says so once without printing the entry", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();
		// The hand edit, then the denial: the file now holds only the entry that is not a key.
		updateProfile(profile, { allow: [peer.publicKey, JUNK] });
		expect((await agx("identity", "deny", peer.npub)).code).toBe(0);
		await polls();

		await sendTo(peer, "from a peer denied under a broken list");
		await waitFor(sorted(peer, "from a peer denied under a broken list"));
		await polls();

		expect(inboxTexts()).not.toContain("from a peer denied under a broken list");
		expect(heldTexts(peer)).toEqual(["from a peer denied under a broken list"]);
		expect(warnings()).toHaveLength(1);
		expect(warnings()[0]).toContain("nobody is authorised");
		expect(logged.join("\n")).not.toContain(JUNK);
	}, 30_000);

	it("holds a peer the unreadable list still names", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();
		updateProfile(profile, { allow: [peer.publicKey, JUNK] });
		await polls();

		await sendTo(peer, "from a listed peer under a broken list");

		await waitFor(sorted(peer, "from a listed peer under a broken list"));
		expect(inboxTexts()).not.toContain("from a listed peer under a broken list");
		expect(heldTexts(peer)).toEqual(["from a listed peer under a broken list"]);
	}, 30_000);

	it("says how to release what was held: it stays held until the peer is allowed", async () => {
		updateProfile(profile, { allow: [] });
		await polls();
		const before = warnings().length;
		updateProfile(profile, { allow: [JUNK] });
		await polls();

		expect(warnings()).toHaveLength(before + 1);
		expect(warnings().at(-1)).toContain("agx held allow <npub>");
		expect(logged.join("\n")).not.toContain(JUNK);
	}, 30_000);

	it("allows the list's peers again as soon as it reads cleanly", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey, JUNK] });
		await polls();

		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();
		await sendTo(peer, "after the list was fixed");

		await waitFor(sorted(peer, "after the list was fixed"));
		expect(inboxTexts()).toContain("after the list was fixed");
		expect(heldTexts(peer)).toEqual([]);
	}, 30_000);

	it("says so again when the list breaks again after it was fixed", async () => {
		updateProfile(profile, { allow: [JUNK] });
		await polls();
		const first = warnings().length;
		expect(first).toBeGreaterThan(0);

		updateProfile(profile, { allow: [] });
		await polls();
		updateProfile(profile, { allow: [JUNK] });
		await polls();

		expect(warnings()).toHaveLength(first + 1);
	}, 30_000);

	it("keeps what it held, so the peer can be allowed afterwards and the message read", async () => {
		const peer = newSender();
		updateProfile(profile, { allow: [peer.publicKey] });
		await polls();
		updateProfile(profile, { allow: [JUNK] });
		await polls();
		await sendTo(peer, "sent while the list was broken");
		await waitFor(sorted(peer, "sent while the list was broken"));
		expect(inboxTexts()).not.toContain("sent while the list was broken");

		updateProfile(profile, { allow: [peer.publicKey] });
		const released = await agx("held", "allow", peer.npub);

		// The gateway holds the profile lock, so the release is queued and the gateway applies it within a poll.
		expect(released.code, released.stderr).toBe(0);
		await waitFor(() => inboxTexts().includes("sent while the list was broken"));
		expect(heldTexts(peer)).toEqual([]);
	}, 30_000);
});
