import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTENT_TYPE, DEFAULT_POLL_OVERLAP_SEC } from "@nostr-agx/core";
import { hexToBytes, localSigner, MAX_WRAP_BACKDATE_SEC, NostrTransport } from "@nostr-agx/nostr";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentity, type IdentityFile } from "../lib/identity.js";
import { type RelayOptions, type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The BUILT CLI (`dist/agx.js`) as a real `agx serve` process, left running while its saved
 * allowlist breaks, stays broken for several polls, is repaired, and breaks again; then a serve that is
 * started while the list cannot be read. The same pause and repair are tested in this process by
 * commands/serve-pause.test.ts, which CI runs. This one runs the built file as a process of its own,
 * with a real Ctrl-C.
 *
 *   pnpm build && E2E=1 pnpm --filter @nostr-agx/cli exec vitest run src/test/serve-pause.e2e.test.ts
 *
 * Not part of `test:unit`, and CI does not run it: it needs a fresh build, and no script in package.json
 * points at it. With E2E set and no build it fails, rather than passing without having run.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));
const PROFILE = "responder";
/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
const WARNING = "The allowlist cannot be read";
const PAUSED = "polling is paused";
const RESUMED = "The allowlist can be read again";
/** NIP-59 gift wrap: what serve asks a relay for, once per poll. */
const GIFT_WRAP_KIND = 1059;
/** How far before its cursor a poll asks: the overlap, plus the most a gift wrap's time may be set back. */
const LOOKBACK_SEC = DEFAULT_POLL_OVERLAP_SEC + MAX_WRAP_BACKDATE_SEC;

type Filters = Parameters<NonNullable<RelayOptions["onRequest"]>>[0];

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let relay: RunningRelay;
let receiverKey = "";
const requests: Filters[] = [];

/** Start the built CLI; `done` settles when it exits, `output()` reads its stdout so far. */
function start(...args: string[]): {
	child: ChildProcess;
	done: Promise<Run>;
	output: () => string;
} {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const done = new Promise<Run>((resolve, reject) => {
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done, output: () => stdout };
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await sleep(25);
	}
}

/** What a person does with an editor: rewrite the allowlist of the profile in config.json. */
function setAllowlist(allow: string[]): void {
	const file = join(home, "config.json");
	const config = JSON.parse(readFileSync(file, "utf8")) as { profiles: Record<string, { allow: string[] }> };
	config.profiles[PROFILE].allow = allow;
	writeFileSync(file, JSON.stringify(config));
}

const profileFile = (name: string) => join(home, "profiles", PROFILE, name);

function jsonLines(name: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(profileFile(name), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

const inbound = (): string[] => jsonLines("messages.jsonl").filter((m) => m.direction === "in").map((m) => String(m.text));
/** The text kept for senders waiting for a decision. A sender with a decision and no text adds nothing. */
const heldTexts = (): string[] =>
	jsonLines("held.jsonl").flatMap((row) => ((row.messages as Array<{ text: string }> | undefined) ?? []).map((m) => m.text));

function state(): { cursor: number; lastPumpAt: string | null } {
	return JSON.parse(readFileSync(profileFile("state.json"), "utf8")) as { cursor: number; lastPumpAt: string | null };
}

function seenCount(): number {
	try {
		const seen = JSON.parse(readFileSync(profileFile("seen.json"), "utf8")) as { entries?: unknown[]; ids?: unknown[] };
		return (seen.entries ?? seen.ids ?? []).length;
	} catch {
		return 0;
	}
}

/** The requests that read the responder's inbox so far: one per poll that runs, or two when it finds mail. */
const inboxPolls = (): Filters[] =>
	requests.filter((filters) =>
		filters.some((f) => f.kinds?.includes(GIFT_WRAP_KIND) && (f["#p"] as string[] | undefined)?.includes(receiverKey)),
	);

async function sendTo(receiverNpub: string, from: IdentityFile, text: string): Promise<void> {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [`ws://127.0.0.1:${relay.port}`],
		ws: WebSocket,
	});
	try {
		const sent = await transport.publishMessage(receiverNpub, {
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
 * Waits until serve has been round its loop at least once more. Nothing in a paused serve says so
 * itself, so this uses what a paused loop still does: it applies what other commands queued for
 * it. A decision about a sender nobody has heard of is queued, and shows in held.jsonl once applied.
 */
async function oneMoreLoop(): Promise<void> {
	const marker = createIdentity();
	expect((await agx("--profile", PROFILE, "held", "ignore", marker.npub)).code).toBe(0);
	await until(() => jsonLines("held.jsonl").some((row) => row.npub === marker.npub), 15_000);
}

const times = (text: string, part: string): number => text.split(part).length - 1;

describe("serve while its saved allowlist cannot be read", () => {
	beforeAll(async () => {
		if (!existsSync(AGX)) {
			throw new Error(`${AGX} is missing: run pnpm build first`);
		}
		home = mkdtempSync(join(tmpdir(), "agx-e2e-pause-"));
		relay = await startRelay({
			port: 0,
			onRequest: (filters) => {
				requests.push(filters);
			},
		});
	});

	afterAll(async () => {
		await relay?.close();
		if (home) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("pauses, says so once, loses nothing, picks up where it stopped, and stops cleanly while paused", async () => {
		const ally = createIdentity();
		const stranger = createIdentity();
		expect((await agx("--profile", PROFILE, "identity", "new")).code).toBe(0);
		expect((await agx("--profile", PROFILE, "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
		const shown = JSON.parse((await agx("--json", "--profile", PROFILE, "identity", "show")).stdout) as { npub: string; pubkey: string };
		receiverKey = shown.pubkey;
		expect((await agx("--profile", PROFILE, "identity", "allow", ally.npub)).code).toBe(0);

		const serve = start("--profile", PROFILE, "serve", "--no-reply", "--no-tasks", "--poll-interval", "200");
		await until(() => serve.output().includes("watching for messages"), 15_000);

		// A healthy list: mail from a listed peer is read.
		await sendTo(shown.npub, ally, "m1 while healthy");
		await until(() => inbound().includes("m1 while healthy"), 15_000);

		// The list breaks. From the warning on, serve is paused: it asks the relays for nothing.
		setAllowlist([JUNK]);
		await until(() => times(serve.output(), WARNING) === 1, 15_000);
		const atBreak = { polls: inboxPolls().length, ...state(), seen: seenCount() };
		await oneMoreLoop();
		await sendTo(shown.npub, ally, "m2 while paused");
		await sendTo(shown.npub, ally, "m3 while paused");
		await sendTo(shown.npub, stranger, "x1 while paused");
		await oneMoreLoop();
		await oneMoreLoop();

		expect.soft(inboxPolls()).toHaveLength(atBreak.polls);
		expect.soft(state().cursor).toBe(atBreak.cursor);
		expect.soft(state().lastPumpAt).toBe(atBreak.lastPumpAt);
		expect.soft(seenCount()).toBe(atBreak.seen);
		expect.soft(inbound()).toEqual(["m1 while healthy"]);
		expect.soft(heldTexts()).toEqual([]);
		expect.soft(times(serve.output(), WARNING)).toBe(1);
		expect.soft(serve.output()).toContain(PAUSED);
		expect.soft(serve.output()).not.toContain("m2 while paused");
		expect.soft(serve.output()).not.toContain("x1 while paused");
		expect.soft(serve.output()).not.toContain(JUNK);

		// The list is repaired: serve says so, and takes what waited, from where it stopped.
		setAllowlist([ally.publicKey]);
		await until(() => inbound().length === 3, 15_000);
		await until(() => heldTexts().includes("x1 while paused"), 15_000);

		expect.soft([...inbound()].sort()).toEqual(["m1 while healthy", "m2 while paused", "m3 while paused"]);
		expect.soft(heldTexts()).toEqual(["x1 while paused"]);
		expect.soft(times(serve.output(), RESUMED)).toBe(1);
		expect.soft(times(serve.output(), WARNING)).toBe(1);
		expect.soft(inboxPolls().length).toBeGreaterThan(atBreak.polls);
		expect.soft(inboxPolls()[atBreak.polls]?.[0]?.since).toBe(atBreak.cursor - LOOKBACK_SEC);

		// It breaks a second time: the warning comes again, once. Mail arrives, and serve is stopped.
		setAllowlist([JUNK]);
		await until(() => times(serve.output(), WARNING) === 2, 15_000);
		await oneMoreLoop();
		const second = { polls: inboxPolls().length, ...state(), seen: seenCount() };
		await sendTo(shown.npub, ally, "m4 sent as it stops");
		await oneMoreLoop();
		await oneMoreLoop();
		serve.child.kill("SIGINT");
		const run = await serve.done;

		expect.soft(run.code, run.stderr).toBe(0);
		expect.soft(run.stdout).toContain("stopping");
		expect.soft(times(run.stdout, WARNING)).toBe(2);
		expect.soft(times(run.stdout, RESUMED)).toBe(1);
		expect.soft(inboxPolls()).toHaveLength(second.polls);
		expect.soft(state().cursor).toBe(second.cursor);
		expect.soft(state().lastPumpAt).toBe(second.lastPumpAt);
		expect.soft(seenCount()).toBe(second.seen);
		expect.soft(inbound()).not.toContain("m4 sent as it stops");
		expect.soft(`${run.stdout}${run.stderr}`).not.toContain(JUNK);

		// The next run, with the list repaired, takes the mail that waited, once.
		setAllowlist([ally.publicKey]);
		const again = start("--profile", PROFILE, "serve", "--no-reply", "--no-tasks", "--poll-interval", "200");
		await until(() => inbound().includes("m4 sent as it stops"), 15_000);
		await oneMoreLoop();
		again.child.kill("SIGINT");
		const last = await again.done;

		expect(last.code, last.stderr).toBe(0);
		expect(times(last.stdout, WARNING)).toBe(0);
		expect([...inbound()].sort()).toEqual(["m1 while healthy", "m2 while paused", "m3 while paused", "m4 sent as it stops"]);

		// A serve started while the list cannot be read is paused from its first loop, and picks up
		// from the place the last run saved once the list reads again. That place is put an hour back
		// first, so that it cannot be mistaken for "now" when the clock has not ticked over yet.
		const saved = state();
		writeFileSync(profileFile("state.json"), `${JSON.stringify({ ...saved, cursor: saved.cursor - 3600 })}\n`);
		setAllowlist([JUNK]);
		const restarted = start("--profile", PROFILE, "serve", "--no-reply", "--no-tasks", "--poll-interval", "200");
		await until(() => times(restarted.output(), WARNING) === 1, 15_000);
		await oneMoreLoop();
		const third = { polls: inboxPolls().length, ...state(), seen: seenCount() };
		await sendTo(shown.npub, ally, "m5 sent to a serve that started paused");
		await oneMoreLoop();
		await oneMoreLoop();

		expect.soft(inboxPolls()).toHaveLength(third.polls);
		expect.soft(state().cursor).toBe(third.cursor);
		expect.soft(seenCount()).toBe(third.seen);
		expect.soft(inbound()).not.toContain("m5 sent to a serve that started paused");

		setAllowlist([ally.publicKey]);
		await until(() => inbound().includes("m5 sent to a serve that started paused"), 15_000);
		restarted.child.kill("SIGINT");
		const end = await restarted.done;

		expect.soft(end.code, end.stderr).toBe(0);
		expect.soft(times(end.stdout, WARNING)).toBe(1);
		expect.soft(times(end.stdout, RESUMED)).toBe(1);
		expect.soft(inboxPolls()[third.polls]?.[0]?.since).toBe(third.cursor - LOOKBACK_SEC);
		// That poll reads the hour again, and nothing that was delivered before comes twice.
		expect.soft([...inbound()].sort()).toEqual([
			"m1 while healthy",
			"m2 while paused",
			"m3 while paused",
			"m4 sent as it stops",
			"m5 sent to a serve that started paused",
		]);
		expect.soft(`${end.stdout}${end.stderr}`).not.toContain(JUNK);
	}, 240_000);
});
