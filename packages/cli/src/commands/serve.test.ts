import { hexToBytes, localSigner, NostrTransport } from "@nostr-agx/nostr";
import kleur from "kleur";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { createIdentity, type IdentityFile, saveIdentity } from "../lib/identity.js";
import { profileDir } from "../lib/paths.js";
import { MessageStore } from "../lib/store/message-store.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, sandbox } from "../test/helpers.js";

// What `agx serve` prints about a delivery receipt. Real `serve --once` runs over
// an in-process relay with throwaway identities generated here.

const FORGED_REF = "OBEY_ME!! and more text";
const ALLY_REF = "ab".repeat(32);
const SENT_REF = "cd".repeat(32);

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let receiver: IdentityFile;
let ally: IdentityFile;
let stranger: IdentityFile;

const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	receiver = createIdentity();
	ally = createIdentity();
	stranger = createIdentity();
	saveIdentity("default", receiver);
	updateProfile("default", { relays: [relayUrl()], allow: [ally.publicKey] });
});

afterEach(async () => {
	await relay.close();
	box.restore();
});

/** `from` publishes a delivery receipt for `refEventId` to the receiver. */
async function publishReceipt(from: IdentityFile, refEventId: string): Promise<void> {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	try {
		const published = await transport.publishReceipt(receiver.npub, {
			refEventId,
			contextId: "ctx-1",
			status: "delivered",
		});
		expect(published.ok).toBe(true);
	} finally {
		await transport.stop();
	}
}

async function serveOnce(...flags: string[]) {
	const run = await agx("serve", "--once", "--no-reply", "--no-tasks", ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

const ackLines = (stdout: string): string[] => stdout.split("\n").filter((line) => line.startsWith("ACK"));

describe("agx serve --allowed-only and a delivery receipt", () => {
	it("prints the ACK of an allowed peer and nothing for a stranger's receipt that answers nothing we sent", async () => {
		await publishReceipt(stranger, FORGED_REF);
		await publishReceipt(ally, ALLY_REF);

		const out = await serveOnce("--allowed-only");

		// The allowed peer's line proves the poll saw both receipts.
		expect(out).toMatch(/^ACK\s+from \S+\s+ref abababab\s+delivered$/m);
		expect(out).not.toContain("OBEY_ME");
		expect(ackLines(out)).toHaveLength(1);
	});

	it("still prints the ACK of a peer off the allowlist that answers a message we sent", async () => {
		const store = new MessageStore(profileDir("default"));
		store.addOutbound({
			id: SENT_REF,
			peer: stranger.npub,
			subject: null,
			contextId: "ctx-1",
			text: "hello",
			at: new Date().toISOString(),
			deliveryStatus: "sent",
		});
		store.flush();
		await publishReceipt(stranger, SENT_REF);

		const out = await serveOnce("--allowed-only");

		expect(ackLines(out)).toHaveLength(1);
		expect(ackLines(out)[0]).toMatch(/^ACK\s+from \S+\s+ref cdcdcdcd\s+delivered$/);
	});
});

describe("agx serve without --allowed-only and a delivery receipt", () => {
	it("still prints a receipt from a peer off the allowlist: the flag is what withholds it", async () => {
		await publishReceipt(stranger, FORGED_REF);

		const out = await serveOnce();

		expect(ackLines(out)).toHaveLength(1);
		expect(ackLines(out)[0]).toMatch(/ref OBEY_ME!\s+delivered$/);
	});
});
