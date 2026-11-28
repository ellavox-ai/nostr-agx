import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";
import { startRelay } from "../relay/server.js";

// Drives the BUILT CLI (`pnpm build` first, then `pnpm test:e2e:config`): the
// lost update this guards against is two real processes writing config.json.

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
}

let home: string;

function agx(...args: string[]): Promise<Run> {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
}

/** `agx serve` on a relay of the test's own (a free port), never the default one. It runs until stopped. */
function startServe(relayPort: number, ...args: string[]): { child: ChildProcess; done: Promise<Run>; output: () => string } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	env.AGX_RELAY = `ws://127.0.0.1:${relayPort}`;
	const child = spawn(process.execPath, [AGX, "serve", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	const done = new Promise<Run>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
	return { child, done, output: () => stdout };
}

/** One `agx` command that can be started now and awaited later, with extra environment variables for it alone. */
function startAgx(extraEnv: Record<string, string>, ...args: string[]): { child: ChildProcess; done: Promise<Run> } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	Object.assign(env, extraEnv);
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	const done = new Promise<Run>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
	return { child, done };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function allowed(): Promise<Set<string>> {
	const { stdout } = await agx("-p", "default", "identity", "allow", "--list");
	return new Set(stdout.match(/npub1[a-z0-9]{58}/g) ?? []);
}

describe.skipIf(!existsSync(AGX))("overlapping config writes", () => {
	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-config-"));
		await agx("identity", "new");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("keeps every npub when two identity allow commands overlap", async () => {
		const asked: string[] = [];
		for (let round = 0; round < 50; round += 1) {
			const a = createIdentity().npub;
			const b = createIdentity().npub;
			asked.push(a, b);
			const runs = await Promise.all([agx("identity", "allow", a), agx("identity", "allow", b)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
		}
		const have = await allowed();
		expect(asked.filter((npub) => !have.has(npub))).toEqual([]);
	}, 300_000);

	it("a peer that identity deny removed stays removed when an allow overlaps it", async () => {
		const result = { stillAllowed: [] as number[], newPeerLost: [] as number[] };
		for (let round = 0; round < 50; round += 1) {
			const x = createIdentity().npub;
			const y = createIdentity().npub;
			await agx("identity", "allow", x);
			const runs = await Promise.all([agx("identity", "deny", x), agx("identity", "allow", y)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
			const have = await allowed();
			if (have.has(x)) {
				result.stillAllowed.push(round);
			}
			if (!have.has(y)) {
				result.newPeerLost.push(round);
			}
		}
		expect(result).toEqual({ stillAllowed: [], newPeerLost: [] });
	}, 300_000);

	it("keeps both changes when held allow and identity allow overlap", async () => {
		const asked: string[] = [];
		for (let round = 0; round < 15; round += 1) {
			const a = createIdentity().npub;
			const b = createIdentity().npub;
			asked.push(a, b);
			const runs = await Promise.all([agx("held", "allow", a), agx("identity", "allow", b)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
		}
		const have = await allowed();
		expect(asked.filter((npub) => !have.has(npub))).toEqual([]);
	}, 120_000);

	it("a peer that held block removed stays removed when an allow overlaps it", async () => {
		const result = { stillAllowed: [] as number[], newPeerLost: [] as number[] };
		for (let round = 0; round < 25; round += 1) {
			const x = createIdentity().npub;
			const y = createIdentity().npub;
			await agx("identity", "allow", x);
			const runs = await Promise.all([agx("held", "block", x), agx("identity", "allow", y)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
			const have = await allowed();
			if (have.has(x)) {
				result.stillAllowed.push(round);
			}
			if (!have.has(y)) {
				result.newPeerLost.push(round);
			}
		}
		expect(result).toEqual({ stillAllowed: [], newPeerLost: [] });
	}, 120_000);

	// Two writers are not enough to see every way the lock can fail: with many at once, a writer that
	// judges the lock abandoned can clear the lock a faster writer has just taken.
	it("keeps every change when eight denies and eight allows all overlap", async () => {
		const result = { denyUndone: 0, allowLost: 0, nonzeroExits: 0 };
		for (let round = 0; round < 30; round += 1) {
			const denied = Array.from({ length: 8 }, () => createIdentity().npub);
			const added = Array.from({ length: 8 }, () => createIdentity().npub);
			await agx("identity", "allow", ...denied);
			const runs = await Promise.all([
				...denied.map((npub) => agx("identity", "deny", npub)),
				...added.map((npub) => agx("identity", "allow", npub)),
			]);
			result.nonzeroExits += runs.filter((run) => run.code !== 0).length;
			const have = await allowed();
			result.denyUndone += denied.filter((npub) => have.has(npub)).length;
			result.allowLost += added.filter((npub) => !have.has(npub)).length;
		}
		expect(result).toEqual({ denyUndone: 0, allowLost: 0, nonzeroExits: 0 });
	}, 600_000);

	it("keeps every npub when many writers wait on a lock whose owner is killed", async () => {
		const result = { lost: 0, nonzeroExits: 0 };
		const asked: string[] = [];
		for (let round = 0; round < 25; round += 1) {
			const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
			writeFileSync(
				join(home, "config.json.lock"),
				`${JSON.stringify({ pid: owner.pid, host: hostname(), token: "planted" })}\n`,
			);
			const npubs = Array.from({ length: 16 }, () => createIdentity().npub);
			asked.push(...npubs);
			const runs = Promise.all(npubs.map((npub) => agx("identity", "allow", npub)));
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			owner.kill("SIGKILL");
			result.nonzeroExits += (await runs).filter((run) => run.code !== 0).length;
		}
		const have = await allowed();
		result.lost = asked.filter((npub) => !have.has(npub)).length;
		expect(result).toEqual({ lost: 0, nonzeroExits: 0 });
	}, 600_000);

	it("keeps both changes when config use and identity allow overlap", async () => {
		const asked: string[] = [];
		for (let round = 0; round < 15; round += 1) {
			const npub = createIdentity().npub;
			asked.push(npub);
			const runs = await Promise.all([
				agx("config", "use", `other${round}`),
				agx("-p", "default", "identity", "allow", npub),
			]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
		}
		const have = await allowed();
		const profiles = (await agx("-p", "default", "config", "list")).stdout;
		expect({
			missingNpubs: asked.filter((npub) => !have.has(npub)).length,
			missingProfiles: Array.from({ length: 15 }, (_, i) => `other${i}`).filter((name) => !new RegExp(`\\b${name}\\b`).test(profiles)),
		}).toEqual({ missingNpubs: 0, missingProfiles: [] });
	}, 120_000);

	// `serve` holds the profile lock for as long as it runs. The config lock is a different, short one, so
	// changing the allowlist must not have to wait for `serve` to stop.
	it("identity allow and identity deny work while agx serve holds the profile lock", async () => {
		const relay = await startRelay({ port: 0 });
		const serve = startServe(relay.port, "--no-reply", "--no-tasks");
		try {
			await until(() => serve.output().includes("watching for messages"), 30_000);
			// Control: the profile lock really is held, so a second serve is refused.
			const refused = await startServe(relay.port, "--no-reply", "--no-tasks").done;
			expect(refused.code).not.toBe(0);
			expect(refused.stdout).toContain("already running");

			const kept = createIdentity().npub;
			const dropped = createIdentity().npub;
			const allow = await agx("identity", "allow", kept, dropped);
			expect(allow.code, allow.stdout).toBe(0);
			const deny = await agx("identity", "deny", dropped);
			expect(deny.code, deny.stdout).toBe(0);
			const have = await allowed();
			expect({ kept: have.has(kept), dropped: have.has(dropped) }).toEqual({ kept: true, dropped: false });
		} finally {
			serve.child.kill("SIGINT");
			await serve.done;
			await relay.close();
		}
	}, 120_000);

	// A command stopped for longer than the lock's age limit (30 seconds) has its lock taken by the next
	// one. A preload stands in for the stop: it holds the first command back when it flushes its new
	// file (after it is written, before it is renamed into place), and the test makes the lock look old,
	// so nothing waits for 30 real seconds.
	//
	// No clock decides how the test goes. The held command waits for the test's go file for as long as
	// the test that started it is alive, and the test waits for the held command's marker file, or for
	// the command to end, whichever comes first. Whatever happens, the held command is killed at the end,
	// so a failing test leaves nothing running.
	it("a command whose lock was taken over while it was stopped saves nothing, says so, and keeps the other command's change", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "agx-e2e-stopped-"));
		let stopped: { child: ChildProcess; done: Promise<Run> } | undefined;
		try {
			const mark = join(scratch, "stopped");
			const go = join(scratch, "go");
			const preload = join(scratch, "stop-at-flush.mjs");
			writeFileSync(
				preload,
				[
					'import fs from "node:fs";',
					'import { syncBuiltinESMExports } from "node:module";',
					"const real = fs.fsyncSync;",
					"let stopped = false;",
					"fs.fsyncSync = function (fd) {",
					"  if (!stopped) {",
					"    stopped = true;",
					"    fs.writeFileSync(process.env.STOP_MARK, String(process.pid));",
					"    const sleeper = new Int32Array(new SharedArrayBuffer(4));",
					"    const parent = Number(process.env.STOP_PARENT);",
					"    while (!fs.existsSync(process.env.STOP_GO) && process.ppid === parent) Atomics.wait(sleeper, 0, 0, 20);",
					"  }",
					"  return real.call(this, fd);",
					"};",
					"syncBuiltinESMExports();",
					"",
				].join("\n"),
			);
			const x = createIdentity().npub;
			const y = createIdentity().npub;

			stopped = startAgx(
				{ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, STOP_MARK: mark, STOP_GO: go, STOP_PARENT: String(process.pid) },
				"identity",
				"allow",
				x,
			);
			let ended: Run | null = null;
			void stopped.done.then((run) => {
				ended = run;
			});
			await until(() => existsSync(mark) || ended !== null, 250_000);
			expect(ended, `the command ended before it was held: ${JSON.stringify(ended)}`).toBeNull();
			// It holds the lock and has not saved. Make the lock old, as if it had been stopped for a minute.
			const past = new Date(Date.now() - 60_000);
			utimesSync(join(home, "config.json.lock"), past, past);

			const other = await agx("identity", "allow", y);
			expect(other.code, other.stdout).toBe(0);

			writeFileSync(go, "");
			const first = await stopped.done;
			expect(first.code, first.stdout).not.toBe(0);
			expect(first.stdout).toMatch(/was not saved/);

			const have = await allowed();
			expect({ stopped: have.has(x), other: have.has(y) }).toEqual({ stopped: false, other: true });
			expect(readdirSync(home).filter((name) => name.endsWith(".tmp") || name.startsWith("config.json.lock"))).toEqual([]);
		} finally {
			// Kill the one command this test started (a no-op when it has already ended), then wait for it.
			if (stopped !== undefined) {
				try {
					stopped.child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
				await stopped.done.catch(() => undefined);
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 300_000);
});
