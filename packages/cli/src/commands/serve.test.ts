import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgxClient, DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { hexToBytes, localSigner, NostrTransport } from "@nostr-agx/nostr";
import kleur from "kleur";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, type IdentityFile, saveIdentity } from "../lib/identity.js";
import { configPath, profileDir } from "../lib/paths.js";
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

// A running serve reads the saved allowlist again before every poll. When that read fails (an entry
// that is not a key, say, after a hand edit), nobody is authorised until it reads cleanly again.

/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";

/** A message from `from` to the receiver, left on the relay for the next poll. */
async function sendMessage(from: IdentityFile, text: string): Promise<void> {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	try {
		const sent = await transport.publishMessage(receiver.npub, {
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

/** A task request from `from` for the receiver's built-in `agx.ping`, left on the relay. Returns what stops the sender. */
async function sendPingRequest(from: IdentityFile): Promise<() => Promise<void>> {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	const client = new AgxClient({ transport, startCursor: Math.floor(Date.now() / 1000) - 60 });
	const before = relay.events().length;
	// It never settles here: nobody polls for the answer. Only its publication matters.
	client.request(receiver.npub, "agx.ping", {}, { timeoutMs: 20_000 }).catch(() => undefined);
	const deadline = Date.now() + 10_000;
	while (relay.events().length === before) {
		if (Date.now() > deadline) {
			throw new Error("the task request never reached the relay");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return async () => {
		await client.stop().catch(() => undefined);
		await transport.stop();
	};
}

/**
 * A `--handler` module that rewrites the saved allowlist when serve loads it. That is after serve
 * has read the list at start-up and before its first poll: where a hand edit lands in a running serve.
 */
function allowlistEditedAtLoad(allow: string[]): string {
	const path = join(box.home, "edit-allowlist.mjs");
	writeFileSync(
		path,
		[
			'import { readFileSync, writeFileSync } from "node:fs";',
			"const file = `${process.env.AGX_HOME}/config.json`;",
			'const config = JSON.parse(readFileSync(file, "utf8"));',
			`config.profiles.default.allow = ${JSON.stringify(allow)};`,
			"writeFileSync(file, JSON.stringify(config));",
			"export default {};",
		].join("\n"),
	);
	return path;
}

/**
 * A `--handler` module that damages config.json itself when serve loads it: `left` is a JS
 * expression for what is left of the saved text (`text`). Same moment as `allowlistEditedAtLoad`.
 */
function configDamagedAtLoad(left: string): string {
	const path = join(box.home, "damage-config.mjs");
	writeFileSync(
		path,
		[
			'import { readFileSync, writeFileSync } from "node:fs";',
			"const file = `${process.env.AGX_HOME}/config.json`;",
			'const text = readFileSync(file, "utf8");',
			`writeFileSync(file, ${left});`,
			"export default {};",
		].join("\n"),
	);
	return path;
}

/** One poll of a serve whose saved allowlist becomes `allow` right before it. */
async function serveOnceEditing(allow: string[], ...flags: string[]) {
	const run = await agx("serve", "--once", "--no-reply", "--handler", allowlistEditedAtLoad(allow), ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

const stored = () => new MessageStore(profileDir("default"));
const inboxTexts = () => stored().listMessages({ direction: "in" }).map((m) => m.text);
const heldFrom = (sender: IdentityFile) => stored().listHeld().find((h) => h.npub === sender.npub);
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));

describe("agx serve while the saved allowlist changes under it", () => {
	it("still authorises a peer the list names, when the list reads cleanly", async () => {
		await sendMessage(ally, "from a listed peer");
		const stop = await sendPingRequest(ally);

		const out = await serveOnceEditing([ally.publicKey], "--allowed-only");
		await stop();

		expect(out).toMatch(/ALLOW\s+task agx\.ping/);
		expect(inboxTexts()).toContain("from a listed peer");
		expect(heldFrom(ally)).toBeUndefined();
	});

	it("still holds a peer the list does not name", async () => {
		await sendMessage(stranger, "from a stranger");

		const out = await serveOnceEditing([ally.publicKey], "--allowed-only");

		expect(out).toMatch(/HOLD\s+from .*not on the allowlist/);
		expect(out).not.toContain("from a stranger");
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(stranger)?.messages.map((m) => m.text)).toEqual(["from a stranger"]);
	});

	it("takes a peer off at once when the list that replaces it reads cleanly", async () => {
		await sendMessage(ally, "from a peer just denied");
		const stop = await sendPingRequest(ally);

		const out = await serveOnceEditing([], "--allowed-only");
		await stop();

		expect(out).toMatch(/DENY\s+task agx\.ping/);
		expect(out).not.toMatch(/ALLOW\s+task/);
		expect(inboxTexts()).toEqual([]);
		// A denied task request falls through to the plain message path, so its envelope is held too.
		expect(heldFrom(ally)?.messages.map((m) => m.text)).toContain("from a peer just denied");
	});
});

describe("agx serve when the saved allowlist can no longer be read", () => {
	it("takes no message from a peer the list no longer names, and holds nothing", async () => {
		await sendMessage(ally, "from a peer just denied");

		const out = await serveOnceEditing([JUNK], "--allowed-only");

		expect(out).not.toMatch(/HOLD/);
		expect(out).not.toContain("from a peer just denied");
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)).toBeUndefined();
	});

	it("takes no message from a peer the list still names either: a list that cannot be read authorises nobody", async () => {
		await sendMessage(ally, "from a listed peer");

		const out = await serveOnceEditing([ally.publicKey, JUNK], "--allowed-only");

		expect(out).not.toMatch(/HOLD/);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)).toBeUndefined();
	});

	it("does not answer a task request, and does not run it", async () => {
		const stop = await sendPingRequest(ally);

		const out = await serveOnceEditing([JUNK]);
		await stop();

		expect(out).not.toMatch(/DENY\s+task agx\.ping/);
		expect(out).not.toMatch(/ALLOW\s+task/);
		expect(out).not.toMatch(/TASK\s+agx\.ping/);
	});

	it("takes no message from a peer given with --allow for this session either", async () => {
		await sendMessage(stranger, "from a session peer");

		const out = await serveOnceEditing([JUNK], "--allowed-only", "--allow", stranger.npub);

		expect(out).not.toMatch(/HOLD/);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(stranger)).toBeUndefined();
	});

	it("says that nobody is authorised, without printing the entry", async () => {
		const out = await serveOnceEditing([JUNK]);

		expect(out).toContain("The allowlist cannot be read");
		expect(out).toContain("nobody is authorised");
		expect(out).not.toContain(JUNK);
	});

	it("does not point at `agx held allow`: nothing was held, so there is nothing to release", async () => {
		const out = await serveOnceEditing([JUNK]);

		expect(out).not.toContain("held allow");
		expect(out).not.toContain(JUNK);
	});

	it("never prints a secret key left in the list", async () => {
		const out = await serveOnceEditing([NSEC]);

		const secret = NSEC.slice(5);
		for (let i = 0; i + 10 <= secret.length; i += 5) {
			expect(out.toLowerCase()).not.toContain(secret.slice(i, i + 10));
		}
	});

	it("leaves the message on the relay, so it is read once the list is repaired, with no release step", async () => {
		await sendMessage(ally, "sent while the list was broken");
		await serveOnceEditing([JUNK], "--allowed-only");
		expect(inboxTexts()).toEqual([]);

		updateProfile("default", { allow: [ally.publicKey] });
		expect(getProfile("default").allow).toEqual([ally.publicKey]);
		const again = await agx("serve", "--once", "--no-reply", "--no-tasks");

		expect(again.code, again.stderr).toBe(0);
		expect(inboxTexts()).toEqual(["sent while the list was broken"]);
		expect(heldFrom(ally)).toBeUndefined();
	});
});

describe("agx serve when config.json itself is damaged", () => {
	// A hand edit that leaves the file empty, or cut off in the middle, is not a bad entry: the
	// whole file stops reading. The peer the list named a moment ago must not stay authorised.
	it.each([
		["empty", "''"],
		["cut off", "text.slice(0, 60)"],
	])("takes nothing while the file is %s, and reads what waited once the file is repaired", async (_how, left) => {
		const good = readFileSync(configPath(), "utf8");
		await sendMessage(ally, "sent while the file was damaged");
		const stop = await sendPingRequest(ally);

		const run = await agx("serve", "--once", "--no-reply", "--allowed-only", "--handler", configDamagedAtLoad(left));
		await stop();

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toMatch(/DENY\s+task agx\.ping/);
		expect(run.stdout).not.toMatch(/HOLD/);
		expect(run.stdout).toContain("nobody is authorised");
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)).toBeUndefined();

		writeFileSync(configPath(), good);
		await sendMessage(ally, "sent after the repair");
		const again = await agx("serve", "--once", "--no-reply");

		expect(again.code, again.stderr).toBe(0);
		// The task request that waited is accepted now, and both messages are read, none twice.
		expect(again.stdout).toMatch(/ALLOW\s+task agx\.ping/);
		expect(inboxTexts().sort()).toEqual(["sent after the repair", "sent while the file was damaged"]);
	});
});
