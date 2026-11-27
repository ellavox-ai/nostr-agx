import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { INBOX_SUMMARY_SCHEMA } from "../lib/inbox.js";
import { lockPath, profileDir } from "../lib/paths.js";
import { MessageStore, SPOOL_DIR } from "../lib/store/message-store.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

/**
 * `agx inbox --summary` is the output a hook may show to a model as is. While
 * `agx serve` holds the profile lock it used to exit 1, so a hook and a listener
 * could not run side by side. Now it reads the counts from the store and pulls
 * nothing. Every other way of reading the inbox keeps failing on a held lock.
 */

const PEER = toNpub("11".repeat(32));
const STRANGER = toNpub("22".repeat(32));
const BODY = "BODY-MARKER-4821 please review the invoice";
const SUBJECT = "SUBJECT-MARKER-4821";
const HELD_BODY = "HELD-MARKER-4821 text from a sender off the allowlist";
const LOCK_MESSAGE = "is already running for profile";

let box: ReturnType<typeof sandbox>;
let holder: ChildProcess | undefined;
let counter: { server: Server; port: number; connections: () => number } | undefined;
let relay: RunningRelay | undefined;

beforeEach(() => {
	box = sandbox();
});

afterEach(async () => {
	process.exitCode = undefined;
	// Only the process this test started.
	if (holder?.pid !== undefined && holder.exitCode === null) {
		holder.kill("SIGKILL");
	}
	holder = undefined;
	await new Promise<void>((done) => (counter ? counter.server.close(() => done()) : done()));
	counter = undefined;
	await relay?.close();
	relay = undefined;
	box.restore();
});

/** A listener that only counts connections: any relay contact shows up as a count. */
async function startCounter(): Promise<{ server: Server; port: number; connections: () => number }> {
	let connections = 0;
	const server = createServer((socket) => {
		connections += 1;
		socket.destroy();
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("no port for the counting listener");
	}
	return { server, port: address.port, connections: () => connections };
}

async function newProfile(relayUrl: string): Promise<void> {
	expect((await agx("identity", "new")).code).toBe(EXIT.ok);
	expect((await agx("config", "set", "relays", relayUrl)).code).toBe(EXIT.ok);
	expect((await agx("identity", "allow", PEER)).code).toBe(EXIT.ok);
}

/** Two unread and one read message from an allowed sender, one sent message, one held sender. */
function seedStore(): void {
	const store = new MessageStore(profileDir("default"));
	const at = new Date().toISOString();
	store.addInbound({ id: "in-1", peer: PEER, subject: SUBJECT, contextId: "thread-a", text: BODY, at });
	store.addInbound({ id: "in-2", peer: PEER, subject: SUBJECT, contextId: "thread-b", text: BODY, at });
	store.addInbound({ id: "in-3", peer: PEER, subject: SUBJECT, contextId: "thread-c", text: BODY, at });
	store.markRead({ ids: ["in-3"] });
	store.addOutbound({ id: "out-1", peer: PEER, subject: null, contextId: "thread-a", text: "my answer", at, deliveryStatus: "sent" });
	store.hold(STRANGER, { id: "held-1", peer: STRANGER, subject: null, contextId: null, text: HELD_BODY, at });
	store.flush();
}

/** A live process on this host that the lock file names, as a running `agx serve` would be. */
function holdLockWithLiveProcess(): void {
	holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	if (holder.pid === undefined) {
		throw new Error("the holder process did not start");
	}
	mkdirSync(profileDir("default"), { recursive: true });
	writeFileSync(lockPath("default"), `${JSON.stringify({ pid: holder.pid, host: hostname(), token: "held-by-test" })}\n`);
}

/** Every file under `dir` with its size, modified time and content hash. */
function listing(dir: string): string[] {
	const rows: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			const stat = statSync(path);
			rows.push(`${relative(dir, path)} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(dir);
	return rows;
}

describe("agx inbox --summary while another process holds the profile lock", () => {
	beforeEach(async () => {
		counter = await startCounter();
		await newProfile(`ws://127.0.0.1:${counter.port}`);
		seedStore();
		holdLockWithLiveProcess();
	});

	it("exits 0 and reports the stored counts, with a field saying another process holds the pull", async () => {
		const run = await agx("--json", "inbox", "--summary");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toEqual([
			{
				schema: INBOX_SUMMARY_SCHEMA,
				new: 0,
				unread: 2,
				held: 1,
				relays: { ok: 0, unreachable: 0 },
				pullHeldByAnotherProcess: true,
			},
		]);
	});

	it("prints the counts on one line, with the reason last", async () => {
		const run = await agx("inbox", "--summary");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toBe("0 new · 2 unread · 1 held · pull held by another process\n");
		expect(run.stderr).toBe("");
	});

	it("contacts no relay, writes no file and leaves the other process's lock alone", async () => {
		const before = listing(box.home);
		const run = await agx("--json", "inbox", "--summary");
		expect(run.code).toBe(EXIT.ok);
		expect(counter?.connections()).toBe(0);
		expect(listing(box.home)).toEqual(before);
		expect(JSON.parse(readFileSync(lockPath("default"), "utf8")).pid).toBe(holder?.pid);
	});

	it("shows no peer text, subject or address", async () => {
		for (const args of [["inbox", "--summary"], ["--json", "inbox", "--summary"]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.ok);
			const output = `${run.stdout}${run.stderr}`;
			for (const secret of [BODY, SUBJECT, HELD_BODY, "MARKER-4821", PEER, STRANGER, "npub1"]) {
				expect(output).not.toContain(secret);
			}
		}
	});

	it("counts a thread marked read while the other process runs, without applying the queued change", async () => {
		expect((await agx("thread", "thread-a", "--mark-read")).code).toBe(EXIT.ok);
		const queued = readdirSync(join(profileDir("default"), SPOOL_DIR));
		expect(queued).toHaveLength(1);

		const run = await agx("--json", "inbox", "--summary");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toMatchObject([{ new: 0, unread: 1, held: 1, pullHeldByAnotherProcess: true }]);
		expect(readdirSync(join(profileDir("default"), SPOOL_DIR))).toEqual(queued);
	});

	it("keeps the lock failure for a plain inbox pull (exit 1)", async () => {
		const run = await agx("inbox");
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr).toContain(LOCK_MESSAGE);
		expect(run.stdout).toBe("");
	});

	it("keeps the lock failure for wait, with or without --summary (exit 1)", async () => {
		for (const args of [["wait", "--timeout", "1"], ["wait", "--summary", "--timeout", "1"]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.generic);
			expect(run.stderr).toContain(LOCK_MESSAGE);
			expect(run.stdout).toBe("");
		}
	});

	it("still exits 3 for a profile that has no identity", async () => {
		expect((await agx("--profile", "nobody", "inbox", "--summary")).code).toBe(EXIT.config);
	});
});

describe("agx inbox --summary when no live process holds the lock", () => {
	beforeEach(async () => {
		relay = await startRelay({ port: 0 });
		await newProfile(`ws://127.0.0.1:${relay.port}`);
		seedStore();
	});

	it("pulls as before: the output has no extra field and shows the relay as reachable", async () => {
		const run = await agx("--json", "inbox", "--summary", "--wait", "5");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toEqual([
			{ schema: INBOX_SUMMARY_SCHEMA, new: 0, unread: 2, held: 1, relays: { ok: 1, unreachable: 0 } },
		]);
		const human = await agx("inbox", "--summary", "--wait", "5");
		expect(human.code).toBe(EXIT.ok);
		expect(human.stdout).toBe("0 new · 2 unread · 1 held\n");
		expect(existsSync(lockPath("default"))).toBe(false);
	});

	it("takes over a lock left by a process that is gone, and pulls", async () => {
		mkdirSync(profileDir("default"), { recursive: true });
		writeFileSync(lockPath("default"), `${JSON.stringify({ pid: 2147483646, host: hostname(), token: "left-behind" })}\n`);
		const run = await agx("--json", "inbox", "--summary", "--wait", "5");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toEqual([
			{ schema: INBOX_SUMMARY_SCHEMA, new: 0, unread: 2, held: 1, relays: { ok: 1, unreachable: 0 } },
		]);
	});

	it("still exits 5 when no relay answered", async () => {
		expect((await agx("config", "set", "relays", "ws://127.0.0.1:1")).code).toBe(EXIT.ok);
		const run = await agx("--json", "inbox", "--summary", "--wait", "2");
		expect(run.code).toBe(EXIT.network);
		expect(jsonDocuments(run.stdout)).toEqual([
			{ schema: INBOX_SUMMARY_SCHEMA, new: 0, unread: 2, held: 1, relays: { ok: 0, unreachable: 1 } },
		]);
	});
});
