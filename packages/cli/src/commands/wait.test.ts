import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProfile, updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { INBOX_SCHEMA, INBOX_SUMMARY_SCHEMA, type InboxReport, type InboxSummary } from "../lib/inbox.js";
import { setJsonMode } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toHexPubkey } from "../lib/peer.js";
import { loadState } from "../lib/state.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, capture, jsonDocuments, sandbox } from "../test/helpers.js";
import { waitCommand } from "./wait.js";

const HELD_SECRET = "held sender text must never reach summary output";
/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let controllers: AbortController[];
let pendingWaits: Promise<unknown>[];

beforeEach(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	controllers = [];
	pendingWaits = [];
});

afterEach(async () => {
	for (const controller of controllers) {
		controller.abort();
	}
	await Promise.allSettled(pendingWaits);
	setJsonMode(false);
	process.exitCode = undefined;
	await relay.close();
	box.restore();
});

function relayUrl(): string {
	return `ws://127.0.0.1:${relay.port}`;
}

async function newProfile(name: string): Promise<string> {
	expect((await agx("--profile", name, "identity", "new")).code).toBe(EXIT.ok);
	expect((await agx("--profile", name, "config", "set", "relays", relayUrl())).code).toBe(EXIT.ok);
	const shown = await agx("--profile", name, "identity", "show");
	const npub = /npub1[0-9a-z]+/.exec(shown.stdout)?.[0];
	if (!npub) {
		throw new Error(`no npub for ${name}`);
	}
	return npub;
}

async function allowedPair(): Promise<{ sender: string; receiver: string }> {
	const sender = await newProfile("sender");
	const receiver = await newProfile("receiver");
	expect((await agx("--profile", "receiver", "identity", "allow", sender)).code).toBe(EXIT.ok);
	return { sender, receiver };
}

async function publish(fromProfile: string, to: string, text: string): Promise<string> {
	const profile = effectiveProfile(fromProfile);
	const identity = loadIdentity(fromProfile);
	const transport = await createTransport(profile, identity, makeLogger(false));
	try {
		const result = await transport.publishMessage(toHexPubkey(to, "test recipient"), {
			text,
			subject: null,
			contextId: null,
			contentType: DEFAULT_CONTENT_TYPE,
		});
		if (!result.ok) {
			throw new Error("test publish failed");
		}
		return result.contextId;
	} finally {
		await transport.stop?.();
	}
}

async function publishReceipt(fromProfile: string, to: string, refEventId: string, contextId: string): Promise<void> {
	const profile = effectiveProfile(fromProfile);
	const identity = loadIdentity(fromProfile);
	const transport = await createTransport(profile, identity, makeLogger(false));
	try {
		const result = await transport.publishReceipt(toHexPubkey(to, "test recipient"), {
			refEventId,
			contextId,
			status: "delivered",
		});
		if (!result.ok) {
			throw new Error("test receipt publish failed");
		}
	} finally {
		await transport.stop?.();
	}
}

function startWait(options: { profile: string; timeout: string; summary?: boolean }) {
	const controller = new AbortController();
	controllers.push(controller);
	setJsonMode(true);
	const done = capture(() => waitCommand({ ...options, signal: controller.signal })).then((result) => {
		const code = Number(process.exitCode ?? EXIT.ok);
		process.exitCode = undefined;
		return { ...result, code };
	});
	pendingWaits.push(done);
	return { controller, done };
}

function report(run: { stdout: string }): InboxReport & { timedOut: boolean } {
	return jsonDocuments(run.stdout).at(-1) as InboxReport & { timedOut: boolean };
}

function summary(run: { stdout: string }): InboxSummary & { timedOut: boolean } {
	return jsonDocuments(run.stdout).at(-1) as InboxSummary & { timedOut: boolean };
}

/**
 * Waits until the wait loop has finished `n` more turns. A turn reads the allowlist first and writes
 * `lastPumpAt` last. So after two turns, one that began after an edit made just before the call has
 * read the edit: no fixed pause, so no guess about how slow the machine is.
 */
async function turns(profile: string, n: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	let last = loadState(profile).lastPumpAt;
	let done = 0;
	while (done < n) {
		if (Date.now() > deadline) {
			throw new Error("the wait loop did not finish a turn in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		const now = loadState(profile).lastPumpAt;
		if (now !== last) {
			last = now;
			done += 1;
		}
	}
}

const WARNING = "The allowlist cannot be read";
const times = (text: string, part: string): number => text.split(part).length - 1;

describe("agx wait", () => {
	it("returns existing unread mail before waiting for new activity", async () => {
		const pair = await allowedPair();
		const contextId = await publish("sender", pair.receiver, "already stored");
		expect((await agx("--profile", "receiver", "inbox", "--wait", "5")).code).toBe(EXIT.ok);

		const first = await startWait({ profile: "receiver", timeout: "5" }).done;
		expect(first.code).toBe(EXIT.ok);
		expect(report(first)).toMatchObject({ schema: INBOX_SCHEMA, timedOut: false, truncated: false });
		expect(report(first).messages).toHaveLength(1);
		expect(report(first).messages[0]).toMatchObject({ text: "already stored", contextId });

		expect((await agx("--profile", "receiver", "thread", contextId, "--mark-read")).code).toBe(EXIT.ok);
		const second = await startWait({ profile: "receiver", timeout: "1" }).done;
		expect(second.code).toBe(EXIT.ok);
		expect(report(second)).toMatchObject({ timedOut: true, messages: [], receipts: [] });
	});

	it("stores and returns one live allowed message, then exits", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "5" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await publish("sender", pair.receiver, "live arrival");

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(report(run)).toMatchObject({ timedOut: false, truncated: false });
		expect(report(run).messages.map((message) => message.text)).toEqual(["live arrival"]);
		expect(new MessageStore(profileDir("receiver")).listMessages().map((message) => message.text)).toEqual(["live arrival"]);
	});

	it("wakes for a receipt matched to a sent message", async () => {
		const pair = await allowedPair();
		const sent = await agx("--json", "--profile", "sender", "send", "--", pair.receiver, "ack me");
		expect(sent.code).toBe(EXIT.ok);
		const outbound = jsonDocuments(sent.stdout).at(-1) as { eventId: string; contextId: string };
		const waiting = startWait({ profile: "sender", timeout: "5" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await publishReceipt("receiver", pair.sender, outbound.eventId, outbound.contextId);

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(report(run)).toMatchObject({ timedOut: false });
		expect(report(run).receipts).toHaveLength(1);
		expect(report(run).receipts[0]).toMatchObject({ ref: outbound.eventId, status: "delivered" });
	});

	it("wakes for held activity without exposing held text or addresses in summary", async () => {
		const sender = await newProfile("sender");
		const receiver = await newProfile("receiver");
		const waiting = startWait({ profile: "receiver", timeout: "5", summary: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await publish("sender", receiver, HELD_SECRET);

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(summary(run)).toMatchObject({ schema: INBOX_SUMMARY_SCHEMA, new: 0, held: 1, timedOut: false });
		expect(run.stdout).not.toContain(HELD_SECRET);
		expect(run.stdout).not.toContain(sender);
	});

	it("honors a sender revoked while waiting", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "5", summary: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		updateProfile("receiver", { allow: [] });
		await publish("sender", pair.receiver, HELD_SECRET);

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(summary(run)).toMatchObject({ new: 0, held: 1, timedOut: false });
		expect(run.stdout).not.toContain(HELD_SECRET);
		expect(run.stdout).not.toContain(pair.sender);
	});

	it("holds a sender when the allowlist can no longer be read, and says so without printing the entry", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "10", summary: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		// A hand edit gone wrong: the sender is off the list and one entry is not a key.
		updateProfile("receiver", { allow: [JUNK] });
		// Past the next read of the list, so the message cannot be fetched by a poll that began before the edit.
		await turns("receiver", 2);
		await publish("sender", pair.receiver, HELD_SECRET);

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(summary(run)).toMatchObject({ new: 0, held: 1, timedOut: false });
		expect(run.stdout).not.toContain(HELD_SECRET);
		expect(run.stderr).toContain("The allowlist cannot be read");
		expect(run.stderr).toContain("nobody is authorised");
		expect(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
		expect(new MessageStore(profileDir("receiver")).listMessages()).toEqual([]);
	}, 20_000);

	it("also holds a sender the unreadable list still names", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "10", summary: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		updateProfile("receiver", { allow: [toHexPubkey(pair.sender, "test sender"), JUNK] });
		await turns("receiver", 2);
		await publish("sender", pair.receiver, HELD_SECRET);

		const run = await waiting.done;
		expect(summary(run)).toMatchObject({ new: 0, held: 1, timedOut: false });
		expect(new MessageStore(profileDir("receiver")).listMessages()).toEqual([]);
	}, 20_000);

	it("says how to release what was held: it stays held until the sender is allowed", async () => {
		await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60", summary: true });
		await turns("receiver", 2);
		updateProfile("receiver", { allow: [JUNK] });
		await turns("receiver", 2);
		waiting.controller.abort();

		const run = await waiting.done;
		expect(run.stderr).toContain("agx held allow <npub>");
		expect(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
	}, 40_000);

	it("says so again when the list breaks again after it was fixed", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60", summary: true });
		await turns("receiver", 2);

		updateProfile("receiver", { allow: [JUNK] });
		await turns("receiver", 2);
		updateProfile("receiver", { allow: [pair.sender] });
		await turns("receiver", 2);
		updateProfile("receiver", { allow: [JUNK] });
		await turns("receiver", 2);
		waiting.controller.abort();

		const run = await waiting.done;
		expect(times(run.stderr, WARNING)).toBe(2);
		expect(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
	}, 40_000);

	it("stops before pulling anything when the allowlist cannot be read at the start", async () => {
		const pair = await allowedPair();
		updateProfile("receiver", { allow: [JUNK] });
		await publish("sender", pair.receiver, HELD_SECRET);

		const run = await agx("--profile", "receiver", "inbox", "--wait", "1");

		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("is not a valid allowlist entry");
		expect(new MessageStore(profileDir("receiver")).listMessages()).toEqual([]);
		expect(new MessageStore(profileDir("receiver")).listHeld()).toEqual([]);
	});

	it("returns an empty successful result after a quiet healthy timeout", async () => {
		await allowedPair();
		const run = await startWait({ profile: "receiver", timeout: "1" }).done;
		expect(run.code).toBe(EXIT.ok);
		expect(report(run)).toMatchObject({ timedOut: true, messages: [], receipts: [], truncated: false });
	});

	it("exits 5 when no relay answered during the wait", async () => {
		await newProfile("receiver");
		expect((await agx("--profile", "receiver", "config", "set", "relays", "ws://127.0.0.1:1")).code).toBe(EXIT.ok);
		const run = await startWait({ profile: "receiver", timeout: "1" }).done;
		expect(run.code).toBe(EXIT.network);
		expect(report(run)).toMatchObject({ timedOut: true, messages: [], relays: [{ url: "ws://127.0.0.1:1", status: "unreachable" }] });
		expect(loadState("receiver").cursor).toBe(0);
	});

	it("recovers when the relay starts during the wait", async () => {
		const pair = await allowedPair();
		const port = relay.port;
		await relay.close();
		const waiting = startWait({ profile: "receiver", timeout: "5" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		relay = await startRelay({ port });
		await publish("sender", pair.receiver, "after recovery");

		const run = await waiting.done;
		expect(run.code).toBe(EXIT.ok);
		expect(report(run).messages.map((message) => message.text)).toEqual(["after recovery"]);
	});

	it("releases the profile lock when aborted", async () => {
		await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "30" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		waiting.controller.abort();
		const run = await waiting.done;
		expect(run.code).toBe(EXIT.interrupted);
		expect((await agx("--profile", "receiver", "inbox", "--wait", "1")).code).toBe(EXIT.ok);
	});

	it.each(["0", "-1", "abc", "3601"])("rejects invalid timeout %s", async (timeout) => {
		const run = await agx("wait", "--timeout", timeout);
		expect(run.code).toBe(EXIT.usage);
	});
});
