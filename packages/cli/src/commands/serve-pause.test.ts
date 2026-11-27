import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgxClient, DEFAULT_CONTENT_TYPE, DEFAULT_POLL_OVERLAP_SEC } from "@nostr-agx/core";
import { hexToBytes, localSigner, MAX_WRAP_BACKDATE_SEC, NostrTransport } from "@nostr-agx/nostr";
import kleur from "kleur";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, type IdentityFile, saveIdentity } from "../lib/identity.js";
import { profileDir, seenPath } from "../lib/paths.js";
import { FileSeenStore, loadState, updateState } from "../lib/state.js";
import { HELD_FILE, MAX_NEW_SENDERS_PER_HOUR, MessageStore } from "../lib/store/message-store.js";
import { runCli } from "../program.js";
import { type RelayOptions, type RunningRelay, startRelay } from "../relay/server.js";
import { agx, sandbox } from "../test/helpers.js";

// While the saved allowlist cannot be read, `agx serve` authorises nobody and pauses: it asks the
// relays for nothing, so nothing is stored, held, marked seen, answered or run, and its place in the
// inbox stays where it was. What arrived meanwhile is read once the list reads cleanly again.
// Real `serve --once` runs over an in-process relay on a free port, with throwaway identities. A serve
// that is left running (a poll every 50 ms) is run in this process too, and stopped by calling the
// SIGINT listener it added, so that its pause, its repair and its first poll afterwards are tested
// where the unit tests run, not only by the built-CLI test.

/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
/** What the fixed warning says about the pause. */
const PAUSED = "polling is paused";
const RESUMED = "The allowlist can be read again";
const WARNING = "The allowlist cannot be read";
/** NIP-59 gift wrap: what a serve or wait loop asks a relay for, once per poll. */
const GIFT_WRAP_KIND = 1059;
/** The last poll was an hour ago. A poll that runs moves this to now; a pause leaves it. */
const STALE_CURSOR = Math.floor(Date.now() / 1000) - 3600;
/** How far before its place in the inbox a poll asks: the overlap, plus the most a gift wrap's time may be set back. */
const LOOKBACK_SEC = DEFAULT_POLL_OVERLAP_SEC + MAX_WRAP_BACKDATE_SEC;

type Filters = Parameters<NonNullable<RelayOptions["onRequest"]>>[0];

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let receiver: IdentityFile;
let ally: IdentityFile;
let stranger: IdentityFile;
const requests: Filters[] = [];

const relayUrl = () => `ws://127.0.0.1:${relay.port}`;
/** Serves a test started and has not stopped yet. */
const running: Array<{ stop: () => Promise<void> }> = [];

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(async () => {
	box = sandbox();
	requests.length = 0;
	relay = await startRelay({
		port: 0,
		onRequest: (filters) => {
			requests.push(filters);
		},
	});
	receiver = createIdentity();
	ally = createIdentity();
	stranger = createIdentity();
	saveIdentity("default", receiver);
	updateProfile("default", { relays: [relayUrl()], allow: [ally.publicKey] });
	updateState("default", { cursor: STALE_CURSOR });
});

afterEach(async () => {
	await Promise.all(running.splice(0).map((serve) => serve.stop()));
	await relay.close();
	box.restore();
});

/** The requests that read the receiver's inbox since the last serve run began: a poll makes one, or two when it finds mail. */
const inboxPolls = (): Filters[] =>
	requests.filter((filters) =>
		filters.some((f) => f.kinds?.includes(GIFT_WRAP_KIND) && (f["#p"] as string[] | undefined)?.includes(receiver.publicKey)),
	);

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

/**
 * A task request from `from` for the receiver's built-in `invoice.review`, left on the relay.
 * `answer()` polls for what the receiver sends back and gives up after `ms`; `stop()` ends the sender.
 */
async function sendTaskRequest(from: IdentityFile) {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	const client = new AgxClient({ transport, startCursor: Math.floor(Date.now() / 1000) - 60 });
	const before = relay.events().length;
	let outcome: { value?: unknown; error?: unknown } | undefined;
	client.request(receiver.npub, "invoice.review", { amount: 100 }, { timeoutMs: 30_000 }).then(
		(value) => {
			outcome = { value };
		},
		(error) => {
			outcome = { error };
		},
	);
	const published = Date.now() + 10_000;
	while (relay.events().length === before) {
		if (Date.now() > published) {
			throw new Error("the task request never reached the relay");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return {
		async answer(ms = 8_000): Promise<unknown> {
			const deadline = Date.now() + ms;
			while (outcome === undefined && Date.now() < deadline) {
				await client.pump();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (outcome === undefined) {
				throw new Error("the sender got no answer");
			}
			if ("error" in outcome) {
				throw outcome.error;
			}
			return outcome.value;
		},
		async stop(): Promise<void> {
			await client.stop().catch(() => undefined);
			await transport.stop();
		},
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

/** One poll of a serve whose saved allowlist becomes `allow` right before it. */
async function serveOnceEditing(allow: string[], ...flags: string[]) {
	requests.length = 0;
	const run = await agx("serve", "--once", "--no-reply", "--handler", allowlistEditedAtLoad(allow), ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

/** One poll of a serve that starts with the allowlist as it is saved now. */
async function serveOnce(...flags: string[]) {
	requests.length = 0;
	const run = await agx("serve", "--once", "--no-reply", ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

/** What a running serve has printed so far, and how to stop it. */
interface RunningServe {
	output: () => string;
	stop: () => Promise<void>;
	/** Rejects, with what serve printed, if `condition` does not hold within `ms`, or if serve ends first. */
	until: (what: string, condition: () => boolean, ms?: number) => Promise<void>;
}

/**
 * `agx serve` with no `--once`, running in this process: it polls every 50 ms until `stop()`. Its output
 * is readable while it runs. Ctrl-C is the SIGINT listener serve adds, called by hand (`process.emit`
 * would reach every listener the test runner has as well), and `process.exit`, which that handler ends
 * with, is held back so that the run can finish and the test go on.
 */
function startServe(...flags: string[]): RunningServe {
	const lines: string[] = [];
	const record = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	const spies = [vi.spyOn(console, "log").mockImplementation(record), vi.spyOn(console, "error").mockImplementation(record)];
	let exited: () => void = () => undefined;
	const exit = new Promise<void>((resolve) => {
		exited = resolve;
	});
	spies.push(
		vi.spyOn(process, "exit").mockImplementation((() => {
			exited();
		}) as never),
	);
	const before = process.listeners("SIGINT");
	let finished = false;
	const done = runCli(["serve", "--no-reply", "--poll-interval", "50", ...flags]).then(() => {
		finished = true;
	});
	const output = () => lines.join("\n");
	const tail = () => output().split("\n").slice(-25).join("\n");
	let stopping: Promise<void> | undefined;
	const serve: RunningServe = {
		output,
		stop: () => {
			stopping ??= (async () => {
				if (!finished) {
					for (const listener of process.listeners("SIGINT")) {
						if (!before.includes(listener)) {
							listener("SIGINT");
						}
					}
					await exit;
				}
				await done;
				for (const spy of spies) {
					spy.mockRestore();
				}
			})();
			return stopping;
		},
		until: async (what, condition, ms = 15_000) => {
			const deadline = Date.now() + ms;
			while (!condition()) {
				if (finished) {
					throw new Error(`serve ended before ${what}. Its output:\n${tail()}`);
				}
				if (Date.now() > deadline) {
					throw new Error(`gave up waiting for ${what}. serve's output:\n${tail()}`);
				}
				await sleepFor(20);
			}
		},
	};
	running.push(serve);
	return serve;
}

const sleepFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stored = () => new MessageStore(profileDir("default"));
const inboxTexts = () => stored().listMessages({ direction: "in" }).map((m) => m.text);
const heldFrom = (sender: IdentityFile) => stored().listHeld().find((h) => h.npub === sender.npub);
/**
 * The senders in held.jsonl on disk, written by the running serve. A `new MessageStore` also applies in
 * memory what is still queued for the lock holder, so it cannot tell a queue that was applied from one
 * that was not.
 */
const sendersOnDisk = (): string[] => {
	const file = join(profileDir("default"), HELD_FILE);
	if (!existsSync(file)) {
		return [];
	}
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				return [(JSON.parse(line) as { npub: string }).npub];
			} catch {
				return [];
			}
		});
};
const times = (text: string, part: string): number => text.split(part).length - 1;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));

describe("agx serve while the saved allowlist cannot be read", () => {
	it("asks the relays for nothing", async () => {
		await sendMessage(ally, "waits on the relay");

		await serveOnceEditing([JUNK]);

		expect(inboxPolls()).toHaveLength(0);
	});

	it("stores nothing and holds nothing: what arrived is still on the relay for later", async () => {
		await sendMessage(ally, "from a listed peer");
		await sendMessage(stranger, "from a stranger");

		await serveOnceEditing([JUNK]);

		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(stored().listHeld()).toEqual([]);
	});

	it("marks nothing as seen", async () => {
		await sendMessage(ally, "from a listed peer");

		await serveOnceEditing([JUNK]);

		expect(existsSync(seenPath("default"))).toBe(false);
	});

	it("leaves the place in the inbox where it was, and records no poll", async () => {
		await sendMessage(ally, "from a listed peer");

		await serveOnceEditing([JUNK]);

		expect.soft(loadState("default").cursor).toBe(STALE_CURSOR);
		expect.soft(loadState("default").lastPumpAt).toBeNull();
	});

	it("does not answer a task request: no DENY, no ALLOW, nothing runs", async () => {
		const sender = await sendTaskRequest(ally);

		const out = await serveOnceEditing([JUNK]);
		await sender.stop();

		expect.soft(out).not.toMatch(/DENY\s+task/);
		expect.soft(out).not.toMatch(/ALLOW\s+task/);
		expect.soft(out).not.toMatch(/TASK\s+invoice\.review/);
	});

	it("shows nothing as received, whether or not --allowed-only is set", async () => {
		await sendMessage(ally, "from a listed peer");
		await sendMessage(stranger, "from a stranger");

		const plain = await serveOnceEditing([JUNK]);
		const guarded = await serveOnceEditing([JUNK], "--allowed-only");

		for (const out of [plain, guarded]) {
			expect.soft(out).not.toMatch(/RECV/);
			expect.soft(out).not.toMatch(/HOLD/);
			expect.soft(out).not.toContain("from a listed peer");
			expect.soft(out).not.toContain("from a stranger");
		}
	});

	it("says once that nobody is authorised and polling is paused, without printing the entry", async () => {
		const out = await serveOnceEditing([JUNK]);

		expect.soft(times(out, "The allowlist cannot be read")).toBe(1);
		expect.soft(out).toContain("nobody is authorised");
		expect.soft(out).toContain(PAUSED);
		// The relays decide how long mail waits there; the warning must not promise more than they do.
		expect.soft(out).toContain("stays on the relays for as long as they keep it");
		expect.soft(out).toContain("agx doctor --local");
		// Nothing was held, so there is nothing to release: no `agx held allow` step to point at.
		expect.soft(out).not.toContain("held allow");
		expect.soft(out).not.toContain(JUNK);
	});

	it("never prints a secret key left in the list", async () => {
		const out = await serveOnceEditing([NSEC]);

		expect(out).toContain("The allowlist cannot be read");
		const secret = NSEC.slice(5);
		for (let i = 0; i + 10 <= secret.length; i += 5) {
			expect(out.toLowerCase()).not.toContain(secret.slice(i, i + 10));
		}
	});

	it("is paused all the same when the list is already unreadable at start-up: one warning, no poll", async () => {
		await sendMessage(ally, "waits on the relay");
		updateProfile("default", { allow: [JUNK] });

		const out = await serveOnce();

		expect.soft(times(out, "The allowlist cannot be read")).toBe(1);
		expect.soft(out).toContain(PAUSED);
		// "Empty" would be the wrong thing to say, and `agx identity allow` cannot fix an unreadable list.
		expect.soft(out).not.toContain("The allowlist is empty");
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(stored().listHeld()).toEqual([]);
		expect.soft(loadState("default").cursor).toBe(STALE_CURSOR);
	});

	it("is paused under --no-tasks too", async () => {
		await sendMessage(ally, "waits on the relay");
		updateProfile("default", { allow: [JUNK] });

		const out = await serveOnce("--no-tasks");

		expect.soft(out).toContain(PAUSED);
		expect.soft(out).not.toMatch(/RECV/);
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(stored().listHeld()).toEqual([]);
	});

	it("answers a task request sent during the outage once the list reads cleanly again", async () => {
		const sender = await sendTaskRequest(ally);

		await serveOnceEditing([JUNK]);
		updateProfile("default", { allow: [ally.publicKey] });
		const resumed = await serveOnce();

		expect.soft(resumed).toMatch(/ALLOW\s+task invoice\.review/);
		expect.soft(resumed).toMatch(/TASK\s+invoice\.review/);
		await expect(sender.answer()).resolves.toMatchObject({ ok: true, capability: "invoice.review" });
		await sender.stop();
	});

	it("reads what waited on the relay once the list reads cleanly again: each message once and none twice", async () => {
		await sendMessage(ally, "first, sent while paused");
		await sendMessage(ally, "second, sent while paused");
		await serveOnceEditing([JUNK], "--allowed-only");
		expect(inboxPolls()).toHaveLength(0);

		updateProfile("default", { allow: [ally.publicKey] });
		await serveOnce();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(inboxTexts().sort()).toEqual(["first, sent while paused", "second, sent while paused"]);
		expect(stored().listHeld()).toEqual([]);
		expect(loadState("default").cursor).toBeGreaterThan(STALE_CURSOR);

		// Nothing is delivered a second time, whether the next poll comes at once or after a new message.
		const again = await serveOnce();
		expect(again).not.toMatch(/RECV/);
		await sendMessage(ally, "third, sent after");
		const later = await serveOnce();
		expect(later.match(/RECV/g)).toHaveLength(1);
		expect(inboxTexts().sort()).toEqual(["first, sent while paused", "second, sent while paused", "third, sent after"]);
	});

	it("applies the list as repaired, not as it was: a peer taken off while it could not be read is held afterwards", async () => {
		await sendMessage(ally, "sent by a peer taken off the list");
		updateProfile("default", { allow: [ally.publicKey, JUNK] });

		await serveOnce("--allowed-only");
		expect(inboxPolls()).toHaveLength(0);

		updateProfile("default", { allow: [] });
		const out = await serveOnce("--allowed-only");

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/HOLD\s+from .*not on the allowlist/);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)?.messages.map((m) => m.text)).toEqual(["sent by a peer taken off the list"]);
	});

	it("reads a message from a peer that was blocked once and allowed again, instead of dropping it", async () => {
		// A decision made long ago: blocking records the sender, and allowing the peer again does not clear it.
		expect((await agx("held", "block", stranger.npub)).code).toBe(0);
		expect((await agx("identity", "allow", stranger.npub)).code).toBe(0);
		expect(getProfile("default").allow).toContain(stranger.publicKey);
		await sendMessage(stranger, "sent while paused");
		const both = [ally.publicKey, stranger.publicKey];

		await serveOnceEditing([...both, JUNK]);
		updateProfile("default", { allow: both });
		await serveOnce();

		expect(inboxTexts()).toEqual(["sent while paused"]);
	});

	it("loses no mail from listed senders to the limit on new held senders", async () => {
		const senders = Array.from({ length: MAX_NEW_SENDERS_PER_HOUR + 1 }, () => createIdentity());
		const keys = senders.map((sender) => sender.publicKey);
		updateProfile("default", { allow: keys });
		for (const [i, sender] of senders.entries()) {
			await sendMessage(sender, `from sender ${i}`);
		}

		await serveOnceEditing([...keys, JUNK]);
		updateProfile("default", { allow: keys });
		await serveOnce();

		expect(inboxTexts().sort()).toEqual(senders.map((_, i) => `from sender ${i}`).sort());
	});
});

describe("a running agx serve whose saved allowlist breaks and is repaired", () => {
	it("reads what waited once the list is repaired, in the same process, and says so once", async () => {
		const serve = startServe();
		await serve.until("serve to start", () => serve.output().includes("watching for messages"));

		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the pause", () => serve.output().includes(PAUSED));
		await sendMessage(ally, "sent while paused");
		updateProfile("default", { allow: [ally.publicKey] });
		await serve.until("the message that waited", () => inboxTexts().includes("sent while paused"));
		// It goes on polling afterwards: a message sent after the repair arrives too.
		await sendMessage(ally, "sent after the repair");
		await serve.until("the message sent after the repair", () => inboxTexts().includes("sent after the repair"));
		await serve.stop();

		expect.soft(inboxTexts().sort()).toEqual(["sent after the repair", "sent while paused"]);
		expect.soft(times(serve.output(), WARNING)).toBe(1);
		expect.soft(times(serve.output(), RESUMED)).toBe(1);
		expect.soft(stored().listHeld()).toEqual([]);
	});

	it("judges what waited by the list as repaired, not as it was: a peer taken off meanwhile is held, not delivered", async () => {
		const serve = startServe();
		await serve.until("serve to start", () => serve.output().includes("watching for messages"));

		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the pause", () => serve.output().includes(PAUSED));
		await sendMessage(ally, "sent by a peer taken off the list");
		// Repaired, but the ally is no longer on it.
		updateProfile("default", { allow: [stranger.publicKey] });
		await serve.until("the message to be held or delivered", () => heldFrom(ally) !== undefined || inboxTexts().length > 0);
		await serve.stop();

		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(heldFrom(ally)?.messages.map((m) => m.text)).toEqual(["sent by a peer taken off the list"]);
		expect.soft(times(serve.output(), RESUMED)).toBe(1);
	});

	it("does not release what was held before the break for a peer the repaired list now names", async () => {
		const serve = startServe();
		await serve.until("serve to start", () => serve.output().includes("watching for messages"));
		await sendMessage(stranger, "held before the break");
		await serve.until("the stranger's message to be held", () => heldFrom(stranger) !== undefined);

		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the pause", () => serve.output().includes(PAUSED));
		updateProfile("default", { allow: [ally.publicKey, stranger.publicKey] });
		await serve.until("serve to read the list again", () => serve.output().includes(RESUMED));
		// From here the stranger is on the list: what they send now goes to the inbox.
		await sendMessage(stranger, "sent after the repair");
		await serve.until("the message sent after the repair", () => inboxTexts().length > 0);
		await serve.stop();

		// What was held stays held until `agx held allow` releases it.
		expect.soft(inboxTexts()).toEqual(["sent after the repair"]);
		expect.soft(heldFrom(stranger)?.messages.map((m) => m.text)).toEqual(["held before the break"]);
	});

	it("does not read again what it had read when its place in the inbox is days behind", async () => {
		// A relay that did not answer for ten days leaves the place ten days back, while the polls that did
		// get through recorded what they saw. Seen ids are kept for three days counted from that place, so
		// a pause must not count them from "now": a message read four days ago would come a second time.
		const day = 86400;
		const now = Math.floor(Date.now() / 1000);
		// The message was sent five days ago: the clock is set back for the sender only.
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
		vi.setSystemTime((now - 5 * day) * 1000);
		try {
			await sendMessage(ally, "read before, five days ago");
		} finally {
			vi.useRealTimers();
		}
		const wrap = relay
			.events()
			.find((event) => event.kind === GIFT_WRAP_KIND && event.tags.some((tag) => tag[0] === "p" && tag[1] === receiver.publicKey));
		expect(wrap?.id).toBeTruthy();
		updateState("default", { cursor: now - 10 * day });
		writeFileSync(
			seenPath("default"),
			`${JSON.stringify({ version: 2, entries: [{ id: wrap?.id, seenAt: now - 4 * day }], failures: {} })}\n`,
		);
		// The setup is what it claims: the message counts as seen, and a poll from the place reaches its wrap.
		expect(new FileSeenStore("default").has(wrap?.id ?? "")).toBe(true);
		expect(wrap?.created_at).toBeGreaterThan(now - 12 * day);
		// Paused from the first loop, so the place is still ten days back when the list is repaired.
		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		const serve = startServe();
		await serve.until("the pause", () => serve.output().includes(PAUSED));
		await sleepFor(300);

		updateProfile("default", { allow: [ally.publicKey] });
		await serve.until("the first poll after the repair", () => loadState("default").cursor > now - 9 * day);
		await sendMessage(ally, "sent after the repair");
		await serve.until("the message sent after the repair", () => inboxTexts().includes("sent after the repair"));
		await serve.stop();

		expect(inboxTexts()).toEqual(["sent after the repair"]);
		// A serve that started paused asks from the place it saved, not from the time it started.
		expect(inboxPolls()[0]?.[0]?.since).toBe(now - 10 * day - LOOKBACK_SEC);
	});

	it("says so again, and only once more, when the list breaks again after it was repaired", async () => {
		const serve = startServe();
		await serve.until("serve to start", () => serve.output().includes("watching for messages"));

		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the first warning", () => times(serve.output(), WARNING) === 1);
		updateProfile("default", { allow: [ally.publicKey] });
		await serve.until("the repair", () => serve.output().includes(RESUMED));
		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the second warning", () => times(serve.output(), WARNING) === 2);
		await sleepFor(300);
		await serve.stop();

		expect.soft(times(serve.output(), WARNING)).toBe(2);
		expect.soft(times(serve.output(), RESUMED)).toBe(1);
	});

	it("still applies what other commands queued while the list cannot be read", async () => {
		const decided = createIdentity().npub;
		const serve = startServe();
		await serve.until("serve to start", () => serve.output().includes("watching for messages"));

		updateProfile("default", { allow: [ally.publicKey, JUNK] });
		await serve.until("the pause", () => serve.output().includes(PAUSED));
		// What `agx held ignore` leaves for the process that holds the profile lock, which is this serve.
		MessageStore.spool(profileDir("default"), { kind: "decision", action: "ignore", npub: decided });
		await serve.until("the queued decision to be written", () => sendersOnDisk().includes(decided));
		await serve.stop();

		// The list was never repaired: the decision was applied and written while paused.
		expect(times(serve.output(), RESUMED)).toBe(0);
	});
});

describe("agx serve when the saved allowlist reads cleanly", () => {
	it("polls and authorises a peer the list names", async () => {
		await sendMessage(ally, "from a listed peer");
		const sender = await sendTaskRequest(ally);

		const out = await serveOnceEditing([ally.publicKey], "--allowed-only");
		await sender.stop();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/ALLOW\s+task invoice\.review/);
		expect(out).toMatch(/TASK\s+invoice\.review/);
		expect(inboxTexts()).toContain("from a listed peer");
		expect(out).not.toContain(PAUSED);
		expect(loadState("default").cursor).toBeGreaterThan(STALE_CURSOR);
		expect(loadState("default").lastPumpAt).not.toBeNull();
	});

	it("polls when the list is empty, and holds a stranger: an empty list is a list", async () => {
		await sendMessage(stranger, "from a stranger");

		const out = await serveOnceEditing([], "--allowed-only");

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/HOLD\s+from .*not on the allowlist/);
		expect(out).not.toContain(PAUSED);
		expect(heldFrom(stranger)?.messages.map((m) => m.text)).toEqual(["from a stranger"]);
	});
});

describe("agx serve --allow-all while the saved allowlist cannot be read", () => {
	// `--allow-all` accepts task requests from anyone whatever the list says, so an unreadable list
	// takes nothing away from it. The poll goes on; no sender is on the list, so every sender is held.
	it("keeps polling: a task request from a stranger still runs, and a message is held", async () => {
		await sendMessage(stranger, "from a stranger");
		const sender = await sendTaskRequest(stranger);

		const out = await serveOnceEditing([JUNK], "--allow-all", "--allowed-only");
		await sender.stop();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/TASK\s+invoice\.review/);
		expect(out).toContain("The allowlist cannot be read");
		expect(out).not.toContain(PAUSED);
		expect(out).not.toContain(JUNK);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(stranger)?.messages.map((m) => m.text)).toContain("from a stranger");
	});

	it("holds a peer given with --allow too: it is dropped with the list while the list cannot be read", async () => {
		// Plain `serve` no longer polls, so this is the one place a peer given with --allow can still be
		// let in while the list cannot be read. It must not be: the list's silence authorises nobody.
		await sendMessage(stranger, "from a peer given with --allow");

		await serveOnceEditing([JUNK], "--allow-all", "--allowed-only", "--allow", stranger.npub);

		expect.soft(inboxPolls().length).toBeGreaterThan(0);
		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(heldFrom(stranger)?.messages.map((m) => m.text)).toEqual(["from a peer given with --allow"]);
	});

	it("still holds a message from a peer the unreadable list names: it authorises nobody either", async () => {
		// The saved list names the ally when serve starts; the edit that breaks it comes after.
		await sendMessage(ally, "from a listed peer");

		const out = await serveOnceEditing([ally.publicKey, JUNK], "--allow-all", "--allowed-only");

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).not.toContain(PAUSED);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)?.messages.map((m) => m.text)).toEqual(["from a listed peer"]);
	});
});
