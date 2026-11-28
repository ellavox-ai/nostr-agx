import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the BUILT CLI (`pnpm build` first, then
// `E2E=1 pnpm exec vitest run src/test/credentials-lock.e2e.test.ts` in packages/cli): the lost update
// this guards against is two real processes writing the one file that holds the login key of every profile.
// Nothing here connects anywhere: the keys are stored (never sent), the relay is one that refuses, and a
// key of an earlier agx is cleared by `logout` without asking any server.

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	output: string;
}

let home: string;
let work: string;
const helpers: ChildProcess[] = [];

const newKey = (): string => `ela_${randomBytes(18).toString("hex")}`;
const credentialsFile = (): string => join(home, "credentials.json");
const lockFile = (): string => `${credentialsFile()}.lock`;

/**
 * One `agx` command that can be started now and awaited later, with extra environment variables for it
 * alone. Anything it is given to read (a key) goes in through its standard input, never its arguments.
 */
function startAgx(extraEnv: Record<string, string>, input: string | null, ...args: string[]): { child: ChildProcess; done: Promise<Run> } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	// Nothing here connects anywhere; a relay that refuses is set anyway.
	env.AGX_RELAY = "ws://127.0.0.1:9";
	Object.assign(env, extraEnv);
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stdin?.end(input ?? "");
	const done = new Promise<Run>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	});
	return { child, done };
}

function agx(input: string | null, ...args: string[]): Promise<Run> {
	return startAgx({}, input, ...args).done;
}

/** `printf %s "$KEY" | agx config set apiKey --stdin --profile <name>` */
const setKey = (name: string): string[] => ["config", "set", "apiKey", "--stdin", "--profile", name];

function stored(): Record<string, { apiKey: string; source: string }> {
	return JSON.parse(readFileSync(credentialsFile(), "utf8")).profiles;
}

/** Everything in the home folder that is a lock or a temp file. */
function leftovers(): string[] {
	return readdirSync(home).filter((name) => name.includes(".lock") || name.endsWith(".tmp"));
}

/**
 * A preload that stands in for a slow disk: it holds a command back for a moment right after it has read
 * credentials.json, so that every command has read the old file before any one writes. `PAUSE_ONLY_READ`
 * limits that to one read (the first, the second ...), `MARK_FILE` is touched once the pause starts, so a
 * test knows the command has read.
 */
function writePreload(): string {
	const preload = join(work, "pause-after-credentials-read.mjs");
	writeFileSync(
		preload,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const real = fs.readFileSync;",
			"let reads = 0;",
			"fs.readFileSync = function (path, ...rest) {",
			"  const out = real.call(this, path, ...rest);",
			'  if (String(path).endsWith("credentials.json")) {',
			"    reads += 1;",
			"    if (!process.env.PAUSE_ONLY_READ || Number(process.env.PAUSE_ONLY_READ) === reads) {",
			"      if (process.env.MARK_FILE) { fs.writeFileSync(process.env.MARK_FILE, String(reads)); }",
			"      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PAUSE_AFTER_READ_MS));",
			"    }",
			"  }",
			"  return out;",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
	);
	return preload;
}

const slow = (preload: string, ms: number, only?: number, mark?: string): Record<string, string> => ({
	NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
	PAUSE_AFTER_READ_MS: String(ms),
	...(only === undefined ? {} : { PAUSE_ONLY_READ: String(only) }),
	...(mark === undefined ? {} : { MARK_FILE: mark }),
});

async function until(what: string, check: () => boolean): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error(`gave up waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Put an entry of an earlier agx in the file, which `logout` clears without asking any server. */
function plantOldEntry(name: string, apiKey: string): void {
	const file = existsSync(credentialsFile())
		? JSON.parse(readFileSync(credentialsFile(), "utf8"))
		: { version: 1, profiles: {} };
	file.profiles[name] = {
		apiBaseUrl: "https://app.ellaworks.ai",
		apiKey,
		apiKeyId: null,
		source: "migrated",
		clientId: null,
		organization: null,
		user: null,
		scopes: null,
		expiresAt: null,
		createdAt: "2026-09-30T18:04:11.000Z",
	};
	writeFileSync(credentialsFile(), JSON.stringify(file), { mode: 0o600 });
}

describe.skipIf(!existsSync(AGX))("overlapping writes of credentials.json", () => {
	let preload: string;
	const keys = { seed: newKey(), a: newKey(), b: newKey() };

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-credentials-"));
		work = mkdtempSync(join(tmpdir(), "agx-e2e-credentials-work-"));
		preload = writePreload();
		// A file must exist for there to be a read to pause after.
		expect((await agx(keys.seed, ...setKey("seed"))).code).toBe(0);
	});

	afterEach(() => {
		for (const helper of helpers.splice(0)) {
			helper.kill("SIGKILL");
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	// Both commands are held back for 1.2 seconds right after they read the file, so both have read the old
	// file before either writes. Without a lock the later write drops the earlier command's entry, whatever
	// the machine's speed.
	it("keeps both entries when two commands that store a key for different profiles have both read the file before either writes", async () => {
		const first = startAgx(slow(preload, 1200), keys.a, ...setKey("a"));
		const second = startAgx(slow(preload, 1200), keys.b, ...setKey("b"));
		const runs = await Promise.all([first.done, second.done]);

		expect(runs.map((run) => run.code), runs.map((run) => run.output).join("\n")).toEqual([0, 0]);
		expect(Object.keys(stored()).sort()).toEqual(["a", "b", "seed"]);
		expect(stored().a?.apiKey).toBe(keys.a);
		expect(stored().b?.apiKey).toBe(keys.b);
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(leftovers()).toEqual([]);
		for (const run of runs) {
			for (const key of Object.values(keys)) {
				expect(run.output).not.toContain(key);
			}
		}
	}, 60_000);

	it("a logout that finishes first is not undone by a key store that read the file before it", async () => {
		plantOldEntry("a", keys.a);
		const login = startAgx(slow(preload, 1500), keys.b, ...setKey("b"));
		const logout = startAgx(slow(preload, 100), null, "logout", "--profile", "a");
		const runs = await Promise.all([login.done, logout.done]);

		expect(runs.map((run) => run.code), runs.map((run) => run.output).join("\n")).toEqual([0, 0]);
		// a stays logged out; it does not come back.
		expect(Object.keys(stored()).sort()).toEqual(["b", "seed"]);
		expect(leftovers()).toEqual([]);
	}, 60_000);

	it("a key store that finishes first is not lost by a logout that read the file before it", async () => {
		plantOldEntry("a", keys.a);
		// The logout reads the file twice (to see what is stored, then to remove it): it is held after the second.
		const logout = startAgx(slow(preload, 1500, 2), null, "logout", "--profile", "a");
		const login = startAgx(slow(preload, 100), keys.b, ...setKey("b"));
		const runs = await Promise.all([logout.done, login.done]);

		expect(runs.map((run) => run.code), runs.map((run) => run.output).join("\n")).toEqual([0, 0]);
		expect(Object.keys(stored()).sort()).toEqual(["b", "seed"]);
		expect(stored().b?.apiKey).toBe(keys.b);
		expect(leftovers()).toEqual([]);
	}, 60_000);

	it("a command that starts while another is between its read and its write waits for it, and both entries are kept", async () => {
		const mark = join(work, "first-has-read");
		const first = startAgx(slow(preload, 1500, undefined, mark), keys.a, ...setKey("a"));
		await until("the first command to read the file", () => existsSync(mark));
		// The second starts now, with no pause of its own: it reads and writes as soon as it may.
		const second = startAgx({}, keys.b, ...setKey("b"));
		const runs = await Promise.all([first.done, second.done]);

		expect(runs.map((run) => run.code), runs.map((run) => run.output).join("\n")).toEqual([0, 0]);
		expect(Object.keys(stored()).sort()).toEqual(["a", "b", "seed"]);
		expect(leftovers()).toEqual([]);
	}, 60_000);

	// No pause here: the commands overlap as they happen to on this machine, 40 times.
	it("keeps both entries when two commands that store a key overlap as they happen to, 40 times over", async () => {
		const result = { lost: 0, nonzeroExits: 0 };
		for (let round = 0; round < 40; round += 1) {
			rmSync(credentialsFile(), { force: true });
			const runs = await Promise.all([agx(keys.a, ...setKey("a")), agx(keys.b, ...setKey("b"))]);
			result.nonzeroExits += runs.filter((run) => run.code !== 0).length;
			const profiles = Object.keys(stored()).sort();
			if (profiles.join() !== "a,b") {
				result.lost += 1;
			}
		}
		expect(result).toEqual({ lost: 0, nonzeroExits: 0 });
		expect(leftovers()).toEqual([]);
	}, 300_000);

	it("a single key store and logout write what they always wrote: a private file, nothing else left", async () => {
		expect((await agx(keys.a, ...setKey("a"))).code).toBe(0);
		expect(Object.keys(stored()).sort()).toEqual(["a", "seed"]);
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(statSync(home).mode & 0o777).toBe(0o700);
		expect(leftovers()).toEqual([]);

		plantOldEntry("old", keys.b);
		const out = await agx(null, "logout", "--profile", "old");
		expect(out.code, out.output).toBe(0);
		expect(Object.keys(stored()).sort()).toEqual(["a", "seed"]);
		expect(leftovers()).toEqual([]);
	}, 60_000);

	it("takes over a lock left by a command that crashed, and does not leave it behind", async () => {
		// The pid of a process that has already exited.
		const gone = spawn(process.execPath, ["-e", ""]);
		const pid = gone.pid ?? 0;
		await new Promise((resolve) => gone.on("close", resolve));
		writeFileSync(lockFile(), `${JSON.stringify({ pid, host: hostname(), token: "crashed" })}\n`, { mode: 0o600 });

		const run = await agx(keys.a, ...setKey("a"));

		expect(run.code, run.output).toBe(0);
		expect(Object.keys(stored()).sort()).toEqual(["a", "seed"]);
		expect(leftovers()).toEqual([]);
	}, 60_000);

	describe("while another running command holds the lock", () => {
		beforeEach(() => {
			const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
			helpers.push(holder);
			writeFileSync(lockFile(), `${JSON.stringify({ pid: holder.pid, host: hostname(), token: "other-writer" })}\n`, {
				mode: 0o600,
			});
		});

		it("a key store stops after about 5 seconds with exit 3 and a plain message, and stores nothing", async () => {
			const before = readFileSync(credentialsFile(), "utf8");
			const started = Date.now();

			const run = await agx(keys.a, ...setKey("a"));

			expect(run.code, run.output).toBe(3);
			expect(run.output).toContain("Could not take the credentials lock");
			expect(run.output).toContain("for more than 5 seconds");
			expect(run.output).toContain(`rm ${lockFile()}`);
			for (const key of Object.values(keys)) {
				expect(run.output).not.toContain(key);
			}
			expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
			expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
			// The other command's lock is still there, and still theirs.
			expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("other-writer");
		}, 60_000);

		it("a logout stops the same way and keeps the entry", async () => {
			plantOldEntry("a", keys.a);

			const run = await agx(null, "logout", "--profile", "a");

			expect(run.code, run.output).toBe(3);
			expect(run.output).toContain("Could not take the credentials lock");
			expect(run.output).not.toContain(keys.a);
			expect(Object.keys(stored()).sort()).toEqual(["a", "seed"]);
		}, 60_000);

		it("config show reads without it and does not wait", async () => {
			const started = Date.now();
			const show = await agx(null, "config", "show", "--profile", "seed");
			expect(show.code, show.output).toBe(0);
			expect(show.output).toContain("credentials");
			expect(show.output).not.toContain(keys.seed);
			expect(Date.now() - started).toBeLessThan(4_000);
		}, 60_000);
	});
});
