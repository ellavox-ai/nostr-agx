import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withConfigLock, withFileLock } from "../config-lock.js";
import { AgxCliError, EXIT } from "../errors.js";
import { profileDir, tailscaleSecretsPath } from "../paths.js";
import { setStdinForTests } from "../stdin.js";
import { type HeldConfigLock, holdLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../../test/config-lock-helpers.js";
import { agx, jsonDocuments, sandbox } from "../../test/helpers.js";
import { forgetTailscaleSecret, loadTailscaleSecret, saveTailscaleSecret } from "./credentials.js";

// The Tailscale secrets file of a profile is read, changed and written back whole. Two agx commands
// that overlap each read the same old file, and the later write drops the earlier one's key, with both
// exiting 0. These tests cover the lock that stops that.
//
// Only `fsyncSync` and `unlinkSync` are wrapped (each does the real thing unless a test says otherwise).
// A file is written to a temp file, flushed, and then renamed into place, so the flush is the point where
// a test can let "another command" have its turn, between a save's read and its write. A forget removes the
// file with `unlinkSync`, so that call is where a test can look at whether the lock is held.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), unlinkSync: vi.fn(actual.unlinkSync) };
});

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const OTHER_KEY = "tskey-auth-k0000000000CNTRL-zyxwvutsrqponmlk";
const CLIENT_SECRET = "oauth-client-secret-value";
const FROZEN = "2026-11-27T05:00:00.000Z";

let box: ReturnType<typeof sandbox>;
let realFsync: (fd: number) => void;
let realUnlink: (path: fs.PathLike) => void;
const children: ChildProcess[] = [];
let held: HeldConfigLock | undefined;

beforeEach(async () => {
	box = sandbox();
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	realFsync = actual.fsyncSync;
	realUnlink = actual.unlinkSync;
});

afterEach(() => {
	vi.mocked(fs.fsyncSync).mockReset();
	vi.mocked(fs.fsyncSync).mockImplementation(realFsync);
	vi.mocked(fs.unlinkSync).mockReset();
	vi.mocked(fs.unlinkSync).mockImplementation(realUnlink);
	held?.child.kill("SIGKILL");
	held = undefined;
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
	}
	box.restore();
});

const secretsFile = (profile = "default"): string => tailscaleSecretsPath(profile);
/** Written out here so a test does not depend on the lock module. */
const lockFile = (profile = "default"): string => `${tailscaleSecretsPath(profile)}.lock`;

function stored(profile = "default"): Record<string, unknown> {
	return JSON.parse(readFileSync(secretsFile(profile), "utf8"));
}

function profileFiles(profile = "default"): string[] {
	return readdirSync(profileDir(profile)).sort();
}

function makeProfileDir(profile = "default"): void {
	mkdirSync(profileDir(profile), { recursive: true, mode: 0o700 });
}

/** A process that stays alive for the test, so its pid is a real, live holder. */
function liveProcess(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) {
		throw new Error("could not start a helper process");
	}
	return child.pid;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
	const run = spawnSync(process.execPath, ["-e", ""]);
	if (run.pid === undefined) {
		throw new Error("could not start a helper process");
	}
	return run.pid;
}

/** Another agx command holds the lock: a record with a live process's pid. */
function plantLiveLock(profile = "default"): void {
	makeProfileDir(profile);
	writeFileSync(
		lockFile(profile),
		`${JSON.stringify({ pid: liveProcess(), host: hostname(), token: "other-writer" })}\n`,
	);
}

/** Run `meanwhile` when the next file write is flushed: after its temp file is written, before it is renamed into place. */
function whileStopped(meanwhile: () => void): void {
	vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
		meanwhile();
		realFsync(fd);
	});
}

function errorOf(run: () => unknown): unknown {
	try {
		run();
	} catch (caught) {
		return caught;
	}
	return undefined;
}

/**
 * Run `run` on a clock the test moves: every pause of the lock moves the clock by as much, so a wait of
 * 5 seconds takes no real time. Returns what it threw and how long, on that clock, it waited.
 */
async function onMovedClock<T>(run: () => Promise<T> | T): Promise<{ value?: T; error?: unknown; waited: number }> {
	vi.useFakeTimers({ toFake: ["Date"] });
	const pause = vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, ms) => {
		vi.advanceTimersByTime(ms ?? 0);
		return "timed-out";
	});
	const outcome: { value?: T; error?: unknown; waited: number } = { waited: 0 };
	try {
		const started = Date.now();
		try {
			outcome.value = await run();
		} catch (caught) {
			outcome.error = caught;
		}
		outcome.waited = Date.now() - started;
	} finally {
		pause.mockRestore();
		vi.useRealTimers();
	}
	return outcome;
}

/**
 * After a writer has returned: whether the other process saw it waiting. A writer that waited returns only
 * once the other process has let go, which leaves that process a moment to finish exiting; a writer that
 * never waited leaves it looking for one until its own limit. So it is given a few seconds to exit, then stopped.
 */
async function holderSawWaiter(holder: HeldConfigLock): Promise<boolean> {
	const stop = setTimeout(() => holder.child.kill("SIGKILL"), 5_000);
	try {
		return await holder.sawWaiter;
	} finally {
		clearTimeout(stop);
	}
}

async function withStdin<T>(input: string | null, fn: () => Promise<T>): Promise<T> {
	const restore = setStdinForTests(input);
	try {
		return await fn();
	} finally {
		restore();
	}
}

describe("saving a Tailscale secret with no other writer", () => {
	it("writes exactly what it wrote before: the same bytes, private, and nothing else left in the folder", () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(FROZEN) });
		try {
			const saved = saveTailscaleSecret("default", { authKey: KEY });
			expect(saved).toEqual({ version: 1, authKey: KEY, oauthClientSecret: null, updatedAt: FROZEN });
		} finally {
			vi.useRealTimers();
		}
		const expected = `${JSON.stringify({ version: 1, authKey: KEY, oauthClientSecret: null, updatedAt: FROZEN }, null, 2)}\n`;
		expect(readFileSync(secretsFile(), "utf8")).toBe(expected);
		expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("keeps the keys of an earlier save when a later one adds another, and keeps the file private", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET });
		expect(stored()).toMatchObject({ version: 1, authKey: KEY, oauthClientSecret: CLIENT_SECRET });
		saveTailscaleSecret("default", { authKey: OTHER_KEY });
		expect(stored()).toMatchObject({ authKey: OTHER_KEY, oauthClientSecret: CLIENT_SECRET });
		expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("stores a value with quotes, a line break and characters outside ASCII exactly as it was given", () => {
		const odd = `tskey-é-日本-${String.fromCharCode(0x2028)}-"quoted"\n-end`;
		saveTailscaleSecret("default", { authKey: odd });
		expect(loadTailscaleSecret("default").authKey).toBe(odd);
		expect(stored().authKey).toBe(odd);
	});

	it("keeps a different profile's file apart: each profile has its own file and its own lock", () => {
		saveTailscaleSecret("one", { authKey: KEY });
		saveTailscaleSecret("two", { authKey: OTHER_KEY });
		expect(stored("one").authKey).toBe(KEY);
		expect(stored("two").authKey).toBe(OTHER_KEY);
		expect(profileFiles("one")).toEqual(["tailscale.json"]);
		expect(profileFiles("two")).toEqual(["tailscale.json"]);
	});

	it("is not stopped by another command's lock on a different profile", () => {
		plantLiveLock("work");
		const started = Date.now();
		saveTailscaleSecret("default", { authKey: KEY });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(stored().authKey).toBe(KEY);
	});

	it("reads without the lock: another command's lock does not stop a read", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		plantLiveLock();
		const started = Date.now();
		expect(loadTailscaleSecret("default").authKey).toBe(KEY);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe("saving a Tailscale secret while another process is saving", () => {
	it("waits for it, then builds its change from the file as that process left it, so neither key is lost", async () => {
		saveTailscaleSecret("default", { authKey: KEY });
		// The other process holds the lock until this save is waiting for it, adds a client secret and lets go.
		held = await holdLockUntilSomeoneWaits(
			lockFile(),
			secretsFile(),
			`c.oauthClientSecret = ${JSON.stringify(CLIENT_SECRET)};`,
		);

		const saved = saveTailscaleSecret("default", { authKey: OTHER_KEY });

		expect(await holderSawWaiter(held)).toBe(true);
		expect(saved).toMatchObject({ authKey: OTHER_KEY, oauthClientSecret: CLIENT_SECRET });
		expect(stored()).toMatchObject({ version: 1, authKey: OTHER_KEY, oauthClientSecret: CLIENT_SECRET });
		expect(profileFiles()).toEqual(["tailscale.json"]);
	}, PATIENT_TEST_MS);

	it("holds the lock for its whole read, change and write; the lock record names this process and holds no secret", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		let atWrite: { record: Record<string, unknown> | null; raw: string; mode: number } | undefined;
		whileStopped(() => {
			const raw = existsSync(lockFile()) ? readFileSync(lockFile(), "utf8") : "";
			atWrite = {
				record: raw ? JSON.parse(raw) : null,
				raw,
				mode: existsSync(lockFile()) ? statSync(lockFile()).mode & 0o777 : 0,
			};
		});

		saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET });

		expect(atWrite?.record).not.toBeNull();
		expect(Object.keys(atWrite?.record ?? {}).sort()).toEqual(["host", "pid", "token"]);
		expect(atWrite?.record).toMatchObject({ pid: process.pid, host: hostname() });
		expect(atWrite?.raw).not.toContain(KEY);
		expect(atWrite?.raw).not.toContain(CLIENT_SECRET);
		// Private, like every file in the folder.
		expect((atWrite?.mode ?? 0o777) & 0o077).toBe(0);
		// Let go once it is done, with no temp file left.
		expect(existsSync(lockFile())).toBe(false);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("lets go of the lock when the save fails", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		whileStopped(() => {
			throw new Error("disk is full");
		});
		expect(() => saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET })).toThrow("disk is full");
		expect(existsSync(lockFile())).toBe(false);
		expect(stored()).toMatchObject({ authKey: KEY, oauthClientSecret: null });
		expect(profileFiles()).toEqual(["tailscale.json"]);
		saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET });
		expect(stored()).toMatchObject({ authKey: KEY, oauthClientSecret: CLIENT_SECRET });
	});
});

describe("saving a Tailscale secret while another process holds the lock for longer than it will wait", () => {
	it("gives up after 5 seconds with a plain error that holds no secret, and writes nothing", async () => {
		saveTailscaleSecret("default", { authKey: KEY });
		const before = readFileSync(secretsFile(), "utf8");
		plantLiveLock();
		const theirs = readFileSync(lockFile(), "utf8");

		const run = await onMovedClock(() => saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET }));

		expect(run.error).toBeInstanceOf(AgxCliError);
		const error = run.error as AgxCliError;
		expect(error.exitCode).toBe(EXIT.config);
		expect(error.message).toContain("Tailscale secrets lock");
		expect(error.message).toContain("for more than 5 seconds");
		expect(error.message).toContain(secretsFile());
		expect(error.remediation).toContain(lockFile());
		for (const secret of [KEY, CLIENT_SECRET]) {
			expect(error.message).not.toContain(secret);
			expect(error.remediation).not.toContain(secret);
		}
		expect(run.waited).toBeGreaterThanOrEqual(5_000);
		expect(run.waited).toBeLessThan(6_000);
		// Nothing was written, and the other process's lock is as it was.
		expect(readFileSync(secretsFile(), "utf8")).toBe(before);
		expect(readFileSync(lockFile(), "utf8")).toBe(theirs);
		expect(profileFiles()).toEqual(["tailscale.json", "tailscale.json.lock"]);
	});

	it("does not take a lock away from a running process just because the lock is some seconds old", async () => {
		plantLiveLock();
		const past = new Date(Date.now() - 10_000);
		utimesSync(lockFile(), past, past);
		const run = await onMovedClock(() => saveTailscaleSecret("default", { authKey: KEY }));
		expect(run.error).toBeInstanceOf(AgxCliError);
		expect(existsSync(secretsFile())).toBe(false);
	});
});

describe("a lock nobody is holding", () => {
	it("is taken over when its process has exited, and the save goes through", () => {
		makeProfileDir();
		writeFileSync(lockFile(), `${JSON.stringify({ pid: deadPid(), host: hostname(), token: "gone" })}\n`);
		saveTailscaleSecret("default", { authKey: KEY });
		expect(stored().authKey).toBe(KEY);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("is taken over when it is older than the stale age, whatever its pid", () => {
		plantLiveLock();
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockFile(), past, past);
		saveTailscaleSecret("default", { authKey: KEY });
		expect(stored().authKey).toBe(KEY);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});
});

describe("the lock of one file", () => {
	it("is re-entrant for that file: a save made while its lock is held takes no second lock and does not wait for itself", () => {
		makeProfileDir();
		const started = Date.now();
		withFileLock(secretsFile(), "Tailscale secrets", () => {
			const before = readFileSync(lockFile(), "utf8");
			saveTailscaleSecret("default", { authKey: KEY });
			// Still the outer call's own lock, not a new one the nested call made.
			expect(readFileSync(lockFile(), "utf8")).toBe(before);
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(stored().authKey).toBe(KEY);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("refuses a function that returns a promise, names the lock it was asked for, and lets go of it", () => {
		makeProfileDir();
		const later = (async () => 1) as any;
		const run = (): unknown => withFileLock(secretsFile(), "Tailscale secrets", later);
		expect(run).toThrow(/must be synchronous/);
		expect(run).toThrow(/Tailscale secrets/);
		expect(run).not.toThrow(/withConfigLock/);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("keeps the wording it has always had when the function given to the config lock returns a promise", () => {
		const later = (async () => 1) as any;
		expect(() => withConfigLock(later)).toThrow(
			new Error(
				"withConfigLock: the function must be synchronous. The lock is let go when it returns, so whatever a promise does later would run without the lock.",
			),
		);
	});

	it("is not the lock of another file: holding one does not stand in for the other", () => {
		makeProfileDir();
		const other = join(box.home, "other.json");
		let lockedAtWrite = false;
		withFileLock(other, "other", () => {
			expect(existsSync(`${other}.lock`)).toBe(true);
			whileStopped(() => {
				lockedAtWrite = existsSync(lockFile());
			});
			saveTailscaleSecret("default", { authKey: KEY });
		});
		// The save took the lock of its own file, and both are let go.
		expect(lockedAtWrite).toBe(true);
		expect(existsSync(`${other}.lock`)).toBe(false);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});
});

describe("a save whose lock was taken over while it was stopped", () => {
	it("writes nothing and says the change was not saved, when the other command took the lock, saved and let go", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		whileStopped(() => {
			fs.rmSync(lockFile(), { force: true });
			writeFileSync(
				secretsFile(),
				`${JSON.stringify({ version: 1, authKey: OTHER_KEY, oauthClientSecret: null, updatedAt: FROZEN })}\n`,
			);
		});

		const error = errorOf(() => saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET }));

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect((error as AgxCliError).message).toMatch(/took over the Tailscale secrets lock/);
		expect((error as AgxCliError).message).not.toContain(CLIENT_SECRET);
		// The file is as the other command saved it, and no temp file is left.
		expect(stored()).toMatchObject({ authKey: OTHER_KEY, oauthClientSecret: null });
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});

	it("does the same, and leaves the other command's lock alone, when that command still holds it", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		whileStopped(() => {
			fs.rmSync(lockFile(), { force: true });
			writeFileSync(lockFile(), `${JSON.stringify({ pid: process.pid, host: hostname(), token: "the-other-command" })}\n`);
			writeFileSync(
				secretsFile(),
				`${JSON.stringify({ version: 1, authKey: OTHER_KEY, oauthClientSecret: null, updatedAt: FROZEN })}\n`,
			);
		});

		const error = errorOf(() => saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET }));

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(stored()).toMatchObject({ authKey: OTHER_KEY, oauthClientSecret: null });
		// A lock that is not ours is never removed.
		expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("the-other-command");
		expect(profileFiles()).toEqual(["tailscale.json", "tailscale.json.lock"]);
	});

	it("saves as before when nothing happened while it was flushing", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		whileStopped(() => undefined);
		saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET });
		expect(stored()).toMatchObject({ authKey: KEY, oauthClientSecret: CLIENT_SECRET });
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});
});

describe("a secrets file that cannot be used: what the save says does not change", () => {
	function expectRefused(error: unknown, pattern: RegExp, before: string): void {
		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toMatch(pattern);
		// The parse error of a file that holds secrets is never echoed.
		expect((error as AgxCliError).message).not.toContain("tskey");
		expect((error as AgxCliError).message).not.toContain("Unexpected");
		expect(readFileSync(secretsFile(), "utf8")).toBe(before);
		// No lock and no temp file left behind.
		expect(profileFiles()).toEqual(["tailscale.json"]);
	}

	it("is not valid JSON: refuses, keeps the file as it is, never quotes it", () => {
		makeProfileDir();
		const broken = '{"version":1,"authKey":"tskey-half-written-secret';
		writeFileSync(secretsFile(), broken, { mode: 0o600 });
		expectRefused(errorOf(() => saveTailscaleSecret("default", { authKey: KEY })), /is not valid JSON/, broken);
	});

	it("does not have the expected shape: refuses and keeps the file as it is", () => {
		makeProfileDir();
		const wrong = `${JSON.stringify({ version: 2, authKey: "tskey-other-shape" })}\n`;
		writeFileSync(secretsFile(), wrong, { mode: 0o600 });
		expectRefused(
			errorOf(() => saveTailscaleSecret("default", { authKey: KEY })),
			/does not match the expected shape/,
			wrong,
		);
	});

	it("is readable by other users: refuses and keeps the file as it is", () => {
		makeProfileDir();
		const open = `${JSON.stringify({ version: 1, authKey: "tskey-open", oauthClientSecret: null, updatedAt: FROZEN })}\n`;
		writeFileSync(secretsFile(), open, { mode: 0o600 });
		chmodSync(secretsFile(), 0o644);
		expectRefused(errorOf(() => saveTailscaleSecret("default", { authKey: KEY })), /readable by other users/, open);
	});

	it("is a link to a file elsewhere: reads through the link, and a save replaces the link with a private file, as before", () => {
		makeProfileDir();
		const target = join(box.home, "elsewhere.json");
		const original = `${JSON.stringify({ version: 1, authKey: KEY, oauthClientSecret: null, updatedAt: FROZEN })}\n`;
		writeFileSync(target, original, { mode: 0o600 });
		symlinkSync(target, secretsFile());

		saveTailscaleSecret("default", { oauthClientSecret: CLIENT_SECRET });

		expect(lstatSync(secretsFile()).isSymbolicLink()).toBe(false);
		expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
		expect(stored()).toMatchObject({ authKey: KEY, oauthClientSecret: CLIENT_SECRET });
		// The file the link pointed at is not touched, and the lock sits in the profile folder, not beside the target.
		expect(readFileSync(target, "utf8")).toBe(original);
		expect(readdirSync(box.home).sort()).toEqual(["elsewhere.json", "profiles"]);
		expect(profileFiles()).toEqual(["tailscale.json"]);
	});
});

describe("forgetting the Tailscale secrets", () => {
	it("removes the file and says so, and says no when there was none", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		expect(forgetTailscaleSecret("default")).toBe(true);
		expect(existsSync(secretsFile())).toBe(false);
		expect(forgetTailscaleSecret("default")).toBe(false);
		expect(profileFiles()).toEqual([]);
	});

	it("removes the file while this process holds the lock, so a save cannot put the old key back", () => {
		saveTailscaleSecret("default", { authKey: KEY });
		// The pid in the lock file at the moment the secrets file is removed: null when there is no lock file.
		const lockHolderAtRemoval: Array<number | null> = [];
		vi.mocked(fs.unlinkSync).mockImplementation((path) => {
			if (path === secretsFile()) {
				lockHolderAtRemoval.push(existsSync(lockFile()) ? JSON.parse(readFileSync(lockFile(), "utf8")).pid : null);
			}
			realUnlink(path);
		});

		expect(forgetTailscaleSecret("default")).toBe(true);

		expect(lockHolderAtRemoval).toEqual([process.pid]);
		expect(existsSync(secretsFile())).toBe(false);
		expect(profileFiles()).toEqual([]);
	});

	it("makes no folder for a profile that has none", () => {
		expect(forgetTailscaleSecret("nobody")).toBe(false);
		expect(existsSync(profileDir("nobody"))).toBe(false);
		expect(existsSync(join(box.home, "profiles"))).toBe(false);
	});

	it("waits for a save that is in progress, then removes what that save left", async () => {
		saveTailscaleSecret("default", { authKey: KEY });
		held = await holdLockUntilSomeoneWaits(lockFile(), secretsFile(), `c.oauthClientSecret = ${JSON.stringify(CLIENT_SECRET)};`);

		const forgot = forgetTailscaleSecret("default");

		expect(await holderSawWaiter(held)).toBe(true);
		expect(forgot).toBe(true);
		expect(existsSync(secretsFile())).toBe(false);
		expect(profileFiles()).toEqual([]);
	}, PATIENT_TEST_MS);

	it("gives up after 5 seconds with a plain error when another process holds the lock, and removes nothing", async () => {
		saveTailscaleSecret("default", { authKey: KEY });
		const before = readFileSync(secretsFile(), "utf8");
		plantLiveLock();

		const run = await onMovedClock(() => forgetTailscaleSecret("default"));

		expect(run.error).toBeInstanceOf(AgxCliError);
		expect((run.error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((run.error as AgxCliError).message).toContain("Tailscale secrets lock");
		expect((run.error as AgxCliError).message).not.toContain(KEY);
		expect(readFileSync(secretsFile(), "utf8")).toBe(before);
	});
});

describe("agx tailscale commands", () => {
	it("enable, status and disable work as before, and leave no lock or temp file behind", async () => {
		const enabled = await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin", "--no-up"));
		expect(enabled.code, enabled.stderr).toBe(0);
		expect(profileFiles()).toEqual(["tailscale.json"]);
		expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
		expect(stored()).toMatchObject({ authKey: KEY, oauthClientSecret: null });

		const status = await agx("tailscale", "status", "--json");
		expect(status.code, status.stderr).toBe(0);
		expect(jsonDocuments(status.stdout).at(-1)).toMatchObject({ enabled: true, authReady: true, storedAuthKey: true });
		expect(`${status.stdout}${status.stderr}`).not.toContain(KEY);

		const disabled = await agx("tailscale", "disable", "--forget", "--json");
		expect(disabled.code, disabled.stderr).toBe(0);
		expect(jsonDocuments(disabled.stdout).at(-1)).toMatchObject({ profile: "default", enabled: false, forgot: true });
		expect(existsSync(secretsFile())).toBe(false);
		expect(profileFiles()).toEqual([]);
	});

	it("status works while another command holds the secrets lock", async () => {
		await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin", "--no-up"));
		plantLiveLock();
		const status = await agx("tailscale", "status", "--json");
		expect(status.code, status.stderr).toBe(0);
		expect(jsonDocuments(status.stdout).at(-1)).toMatchObject({ enabled: true, authReady: true });
	});

	it("enable exits 3 with a plain message, and stores no key, when another command holds the secrets lock", async () => {
		plantLiveLock();

		const run = await onMovedClock(() => withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin", "--no-up")));

		expect(run.error).toBeUndefined();
		expect(run.value?.code).toBe(EXIT.config);
		expect(run.value?.stderr).toContain("Tailscale secrets lock");
		expect(run.value?.stderr).toContain("rm ");
		expect(`${run.value?.stdout}${run.value?.stderr}`).not.toContain(KEY);
		expect(existsSync(secretsFile())).toBe(false);
	});

	it("disable --forget exits 3 with a plain message, and keeps the key, when another command holds the secrets lock", async () => {
		await withStdin(KEY, () => agx("tailscale", "enable", "--auth-key-stdin", "--no-up"));
		plantLiveLock();

		const run = await onMovedClock(() => agx("tailscale", "disable", "--forget"));

		expect(run.error).toBeUndefined();
		expect(run.value?.code).toBe(EXIT.config);
		expect(run.value?.stderr).toContain("Tailscale secrets lock");
		expect(`${run.value?.stdout}${run.value?.stderr}`).not.toContain(KEY);
		expect(stored().authKey).toBe(KEY);
	});
});
