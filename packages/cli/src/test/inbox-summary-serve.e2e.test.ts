import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The BUILT CLI (`dist/agx.js`) as real processes: a long-running `agx serve`
 * holds the profile lock while `agx inbox --summary` runs next to it, as a hook
 * would. The summary must exit 0 with the counts serve has stored, and follow
 * what serve stores, marks read or holds.
 *
 *   pnpm build && E2E=1 pnpm exec vitest run src/test/inbox-summary-serve.e2e.test.ts
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface Summary {
	schema: string;
	new: number;
	unread: number;
	held: number;
	relays: { ok: number; unreachable: number };
	pullHeldByAnotherProcess?: true;
}

let home: string;
let relay: RunningRelay;
let serve: { child: ChildProcess; done: Promise<Run>; output: () => string } | undefined;

function start(...args: string[]): { child: ChildProcess; done: Promise<Run>; output: () => string } {
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
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done, output: () => stdout };
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error(`not met in time: ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function summary(): Promise<{ run: Run; json: Summary }> {
	const run = await agx("--json", "--profile", "receiver", "inbox", "--summary");
	expect(run.code, run.stderr).toBe(0);
	return { run, json: JSON.parse(run.stdout) as Summary };
}

async function newProfile(name: string): Promise<string> {
	expect((await agx("--profile", name, "identity", "new")).code).toBe(0);
	expect((await agx("--profile", name, "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	const npub = /npub1[0-9a-z]+/.exec((await agx("--profile", name, "identity", "show")).stdout)?.[0];
	if (!npub) {
		throw new Error(`no npub for ${name}`);
	}
	return npub;
}

describe.skipIf(!existsSync(AGX))("agx inbox --summary next to a running agx serve", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-summary-"));
		relay = await startRelay({ port: 0 });
	});

	afterAll(async () => {
		// Only the process this file started.
		if (serve && serve.child.exitCode === null) {
			serve.child.kill("SIGKILL");
		}
		await relay?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("exits 0 with the counts serve stores, follows new mail, held senders and mark-read, and works again once serve stops", async () => {
		const sender = await newProfile("sender");
		const receiver = await newProfile("receiver");
		const stranger = await newProfile("stranger");
		expect((await agx("--profile", "receiver", "identity", "allow", sender)).code).toBe(0);

		serve = start("--profile", "receiver", "serve", "--no-reply", "--no-tasks", "--allowed-only", "--poll-interval", "300");
		await eventually(async () => serve?.output().includes("watching for messages") === true, "serve to start watching");

		// Nothing stored yet: the summary still works and says who holds the pull.
		const quiet = await summary();
		expect(quiet.run.code).toBe(0);
		expect(quiet.json).toEqual({
			schema: "agx.inbox.summary/1",
			new: 0,
			unread: 0,
			held: 0,
			relays: { ok: 0, unreachable: 0 },
			pullHeldByAnotherProcess: true,
		});

		// Mail that arrives while serve runs shows up in the next summary.
		expect((await agx("--profile", "sender", "send", "--context-id", "thread-a", "--", receiver, "first request")).code).toBe(0);
		expect((await agx("--profile", "sender", "send", "--context-id", "thread-b", "--", receiver, "second request")).code).toBe(0);
		await eventually(async () => (await summary()).json.unread === 2, "two unread messages in the summary");

		// A sender off the allowlist is counted as held, and no text comes out.
		expect((await agx("--profile", "stranger", "send", "--", receiver, "STRANGER-TEXT-9917")).code).toBe(0);
		await eventually(async () => (await summary()).json.held === 1, "one held sender in the summary");
		const withHeld = await summary();
		expect(withHeld.run.code).toBe(0);
		expect(withHeld.json).toMatchObject({ new: 0, unread: 2, held: 1, pullHeldByAnotherProcess: true });
		expect(`${withHeld.run.stdout}${withHeld.run.stderr}`).not.toMatch(/STRANGER-TEXT-9917|npub1|request/);
		expect(stranger).toMatch(/^npub1/);

		// Marking a thread read while serve runs is queued; serve applies it within a poll.
		expect((await agx("--profile", "receiver", "thread", "thread-a", "--mark-read")).code).toBe(0);
		await eventually(async () => (await summary()).json.unread === 1, "one unread message after mark-read");

		// Several hooks at once do not fail each other.
		const together = await Promise.all([summary(), summary(), summary(), summary()]);
		for (const one of together) {
			expect(one.run.code).toBe(0);
			expect(one.json).toMatchObject({ unread: 1, held: 1, pullHeldByAnotherProcess: true });
		}

		// Serve stops and releases the lock; the next summary pulls as before.
		serve.child.kill("SIGINT");
		const stopped = await serve.done;
		expect(stopped.code).toBe(0);
		expect(existsSync(join(home, "profiles", "receiver", "serve.lock"))).toBe(false);
		const after = await summary();
		expect(after.run.code).toBe(0);
		expect(after.json).toEqual({ schema: "agx.inbox.summary/1", new: 0, unread: 1, held: 1, relays: { ok: 1, unreachable: 0 } });
	}, 90_000);
});
