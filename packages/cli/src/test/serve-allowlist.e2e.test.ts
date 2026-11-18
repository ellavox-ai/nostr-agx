import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The BUILT CLI (`dist/agx.js`) as a real `agx serve` process, left running while its saved
 * allowlist breaks, is repaired, and breaks again. A running serve cannot be stopped from inside
 * a unit test (its Ctrl-C handler exits the process), so this one needs the real thing.
 *
 *   pnpm build && E2E=1 pnpm --filter @nostr-agx/cli exec vitest run src/test/serve-allowlist.e2e.test.ts
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));
const PROFILE = "responder";
/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
const WARNING = "The allowlist cannot be read";

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let relay: RunningRelay;

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

function lastPumpAt(): string | null {
	try {
		const state = JSON.parse(readFileSync(join(home, "profiles", PROFILE, "state.json"), "utf8")) as {
			lastPumpAt: string | null;
		};
		return state.lastPumpAt;
	} catch {
		return null;
	}
}

/**
 * Waits until serve has finished `n` more polls. A poll reads the allowlist first and writes
 * `lastPumpAt` last. So after two polls, one that began after an edit made just before the call has
 * read the edit: no fixed pause, so no guess about how slow the machine is.
 */
async function polls(n = 2): Promise<void> {
	let last = lastPumpAt();
	let done = 0;
	const deadline = Date.now() + 30_000;
	while (done < n) {
		if (Date.now() > deadline) {
			throw new Error("serve did not finish a poll in time");
		}
		await sleep(25);
		const now = lastPumpAt();
		if (now !== last) {
			last = now;
			done += 1;
		}
	}
}

const times = (text: string, part: string): number => text.split(part).length - 1;

describe.skipIf(!existsSync(AGX))("serve while its saved allowlist breaks and is repaired", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-allowlist-"));
		relay = await startRelay({ port: 0 });
	});

	afterAll(async () => {
		await relay?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("says so again when the list breaks again after it was fixed", async () => {
		expect((await agx("--profile", PROFILE, "identity", "new")).code).toBe(0);
		expect((await agx("--profile", PROFILE, "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);

		const serve = start("--profile", PROFILE, "serve", "--no-reply", "--no-tasks", "--poll-interval", "200");
		await until(() => serve.output().includes("watching for messages"), 15_000);
		await polls();

		setAllowlist([JUNK]);
		await until(() => times(serve.output(), WARNING) === 1, 15_000);

		setAllowlist([]);
		await polls();

		setAllowlist([JUNK]);
		await until(() => times(serve.output(), WARNING) === 2, 15_000);
		await polls();

		serve.child.kill("SIGINT");
		const run = await serve.done;

		expect(run.code, run.stderr).toBe(0);
		expect(times(run.stdout, WARNING)).toBe(2);
		expect(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
	}, 60_000);
});
