import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HeldConfigLock, holdLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../test/config-lock-helpers.js";
import { agx, fakeClock, jsonDocuments, sandbox, useClock } from "../test/helpers.js";
import { type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";
import { updateProfile } from "./config.js";
import { withConfigLock, withFileLock } from "./config-lock.js";
import {
	type CredentialEntry,
	getCredential,
	listCredentials,
	removeCredential,
	setCredential,
} from "./credentials.js";
import { AgxCliError, EXIT } from "./errors.js";
import { configPath, credentialsPath } from "./paths.js";
import { setStdinForTests } from "./stdin.js";

// credentials.json holds the login key of EVERY profile in one file. A set or a remove reads it, changes one
// entry and writes the whole file back. Two agx commands that overlap each read the same old file, and the
// later write drops the earlier one's change, with both exiting 0. These tests cover the lock that stops that.
//
// Only `fsyncSync` is wrapped (it does the real thing unless a test says otherwise). A file is written to a
// temp file, flushed, and then renamed into place, so the flush is the point where a test can let "another
// command" have its turn, between a write's read and its rename.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

// Made when the tests start, so no key written here exists anywhere else.
const newKey = (): string => `ela_${randomBytes(18).toString("hex")}`;
const KEY = newKey();
const OTHER_KEY = newKey();
const THIRD_KEY = newKey();

let box: ReturnType<typeof sandbox>;
let realFsync: (fd: number) => void;
const children: ChildProcess[] = [];
let held: HeldConfigLock | undefined;

beforeEach(async () => {
	box = sandbox();
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	realFsync = actual.fsyncSync;
});

afterEach(() => {
	vi.mocked(fs.fsyncSync).mockReset();
	vi.mocked(fs.fsyncSync).mockImplementation(realFsync);
	held?.child.kill("SIGKILL");
	held = undefined;
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
	}
	box.restore();
});

const entry = (overrides: Partial<CredentialEntry> = {}): CredentialEntry => ({
	apiBaseUrl: "https://app.ellaworks.ai",
	apiKey: KEY,
	apiKeyId: "k_1",
	source: "login",
	clientId: "agx",
	organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
	user: { id: "u_1", email: "a***@acme.com" },
	scopes: ["listings:read", "listings:write"],
	expiresAt: "2026-12-29T18:04:11.000Z",
	createdAt: "2026-09-30T18:04:11.000Z",
	...overrides,
});

const credentialsFile = (): string => credentialsPath();
/** Written out here so a test does not depend on the lock module. */
const lockFile = (): string => `${credentialsPath()}.lock`;

function stored(): { version: number; profiles: Record<string, CredentialEntry> } {
	return JSON.parse(readFileSync(credentialsFile(), "utf8"));
}

function homeFiles(): string[] {
	return readdirSync(box.home).sort();
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
function plantLiveLock(path = lockFile()): void {
	writeFileSync(path, `${JSON.stringify({ pid: liveProcess(), host: hostname(), token: "other-writer" })}\n`);
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

/** What the other process does to the file while it holds the lock: it adds one profile. */
const addsProfile = (name: string, apiKey: string): string =>
	`c.profiles[${JSON.stringify(name)}] = ${JSON.stringify(entry({ apiKey, apiKeyId: `k_${name}` }))};`;

describe("writing credentials.json with no other writer", () => {
	it("writes exactly what it wrote before: the same bytes, private, and nothing else left in the folder", () => {
		setCredential("default", entry());
		const expected = `${JSON.stringify({ version: 1, profiles: { default: entry() } }, null, 2)}\n`;
		expect(readFileSync(credentialsFile(), "utf8")).toBe(expected);
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(statSync(box.home).mode & 0o777).toBe(0o700);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("keeps the entries of earlier writes, and a remove takes out only its own profile", () => {
		setCredential("a", entry({ apiKeyId: "k_a" }));
		setCredential("b", entry({ apiKeyId: "k_b", source: "manual", clientId: null }));
		expect(Object.keys(listCredentials())).toEqual(["a", "b"]);
		expect(removeCredential("a")).toBe(true);
		expect(removeCredential("a")).toBe(false);
		expect(stored().profiles).toEqual({ b: entry({ apiKeyId: "k_b", source: "manual", clientId: null }) });
		expect(getCredential("a")).toBeNull();
		expect(getCredential("b")?.apiKeyId).toBe("k_b");
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("rewrites a file that was readable by others as private", () => {
		setCredential("default", entry());
		chmodSync(credentialsFile(), 0o644);
		setCredential("other", entry({ apiKeyId: "k_o" }));
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		chmodSync(credentialsFile(), 0o644);
		expect(removeCredential("other")).toBe(true);
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
	});

	it("stores a value with quotes, a line break and characters outside ASCII exactly as it was given", () => {
		const odd = entry({
			organization: { id: "o_1", slug: "acme", name: `Acme "Robotics"\n日本 é ${String.fromCharCode(0x2028)} end` },
		});
		setCredential("default", odd);
		expect(getCredential("default")).toEqual(odd);
		expect(stored().profiles.default).toEqual(odd);
	});

	it("keeps a profile name that is odd as it is: a slash, dots, a space, accents, a lock-like suffix, a long name", () => {
		const names = ["a/b", "..", "with space", "ünï", "name.lock", `x${String.fromCharCode(0x2028)}y`, "z".repeat(300)];
		for (const [index, name] of names.entries()) {
			setCredential(name, entry({ apiKeyId: `k_${index}` }));
		}
		expect(Object.keys(listCredentials())).toEqual(names);
		for (const [index, name] of names.entries()) {
			expect(getCredential(name)?.apiKeyId).toBe(`k_${index}`);
		}
		for (const name of names) {
			expect(removeCredential(name)).toBe(true);
		}
		expect(stored().profiles).toEqual({});
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("refuses an entry that does not fit the shape as before, writes nothing and leaves no lock", () => {
		const bad = { ...entry(), apiKey: 42 } as unknown as CredentialEntry;
		const error = errorOf(() => setCredential("default", bad));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(KEY);
		expect(homeFiles()).toEqual([]);
		setCredential("default", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		expect(errorOf(() => setCredential("other", bad))).toBeInstanceOf(Error);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("reads without the lock: another command's lock does not stop a get or a list", () => {
		setCredential("default", entry());
		plantLiveLock();
		const started = Date.now();
		expect(getCredential("default")).toEqual(entry());
		expect(Object.keys(listCredentials())).toEqual(["default"]);
		expect(getCredential("nobody")).toBeNull();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("is not stopped by another command's lock on config.json, and does not stop a config.json write", () => {
		plantLiveLock(`${configPath()}.lock`);
		const started = Date.now();
		setCredential("default", entry());
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(stored().profiles.default?.apiKeyId).toBe("k_1");
		fs.rmSync(`${configPath()}.lock`);

		plantLiveLock();
		const again = Date.now();
		updateProfile("default", { orgSlug: "acme-robotics" });
		expect(Date.now() - again).toBeLessThan(2_000);
	});
});

describe("writing credentials.json while another process is writing it", () => {
	it("a set waits for it, then builds its change from the file as that process left it, so neither entry is lost", async () => {
		setCredential("default", entry());
		// The other process holds the lock until this write is waiting for it, adds a profile and lets go.
		held = await holdLockUntilSomeoneWaits(lockFile(), credentialsFile(), addsProfile("theirs", OTHER_KEY));

		setCredential("mine", entry({ apiKey: THIRD_KEY, apiKeyId: "k_mine" }));

		expect(await holderSawWaiter(held)).toBe(true);
		expect(Object.keys(stored().profiles).sort()).toEqual(["default", "mine", "theirs"]);
		expect(stored().profiles.theirs?.apiKey).toBe(OTHER_KEY);
		expect(stored().profiles.mine?.apiKey).toBe(THIRD_KEY);
		expect(homeFiles()).toEqual(["credentials.json"]);
	}, PATIENT_TEST_MS);

	it("a remove waits for it too, then takes out its profile and keeps what that process added", async () => {
		setCredential("default", entry());
		setCredential("keep", entry({ apiKeyId: "k_keep" }));
		held = await holdLockUntilSomeoneWaits(lockFile(), credentialsFile(), addsProfile("theirs", OTHER_KEY));

		expect(removeCredential("default")).toBe(true);

		expect(await holderSawWaiter(held)).toBe(true);
		expect(Object.keys(stored().profiles).sort()).toEqual(["keep", "theirs"]);
		expect(homeFiles()).toEqual(["credentials.json"]);
	}, PATIENT_TEST_MS);

	it("a remove that finds its profile already gone once the lock is held writes nothing", async () => {
		setCredential("default", entry());
		held = await holdLockUntilSomeoneWaits(lockFile(), credentialsFile(), "delete c.profiles.default;");

		expect(removeCredential("default")).toBe(false);

		expect(await holderSawWaiter(held)).toBe(true);
		expect(stored().profiles).toEqual({});
		expect(homeFiles()).toEqual(["credentials.json"]);
	}, PATIENT_TEST_MS);

	function recordAtWrite(): () => { record: Record<string, unknown> | null; raw: string; mode: number } | undefined {
		let atWrite: { record: Record<string, unknown> | null; raw: string; mode: number } | undefined;
		whileStopped(() => {
			const raw = existsSync(lockFile()) ? readFileSync(lockFile(), "utf8") : "";
			atWrite = {
				record: raw ? JSON.parse(raw) : null,
				raw,
				mode: existsSync(lockFile()) ? statSync(lockFile()).mode & 0o777 : 0,
			};
		});
		return () => atWrite;
	}

	function expectLockHeldAtWrite(
		atWrite: { record: Record<string, unknown> | null; raw: string; mode: number } | undefined,
	): void {
		expect(atWrite?.record).not.toBeNull();
		expect(Object.keys(atWrite?.record ?? {}).sort()).toEqual(["host", "pid", "token"]);
		expect(atWrite?.record).toMatchObject({ pid: process.pid, host: hostname() });
		for (const secret of [KEY, OTHER_KEY, THIRD_KEY]) {
			expect(atWrite?.raw).not.toContain(secret);
		}
		// Private, like every file in the folder.
		expect((atWrite?.mode ?? 0o777) & 0o077).toBe(0);
		// Let go once it is done, with no temp file left.
		expect(existsSync(lockFile())).toBe(false);
		expect(homeFiles()).toEqual(["credentials.json"]);
	}

	it("a set holds the lock for its whole read, change and write; the lock record names this process and holds no secret", () => {
		setCredential("default", entry());
		const atWrite = recordAtWrite();
		setCredential("other", entry({ apiKey: OTHER_KEY, apiKeyId: "k_other" }));
		expectLockHeldAtWrite(atWrite());
	});

	it("a remove holds the lock for its whole read, change and write, with the same record", () => {
		setCredential("default", entry());
		setCredential("other", entry({ apiKey: OTHER_KEY, apiKeyId: "k_other" }));
		const atWrite = recordAtWrite();
		expect(removeCredential("other")).toBe(true);
		expectLockHeldAtWrite(atWrite());
	});

	it("lets go of the lock when a write fails, and the file is as it was", () => {
		setCredential("default", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		whileStopped(() => {
			throw new Error("disk is full");
		});
		expect(() => setCredential("other", entry({ apiKeyId: "k_o" }))).toThrow("disk is full");
		expect(existsSync(lockFile())).toBe(false);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(homeFiles()).toEqual(["credentials.json"]);

		whileStopped(() => {
			throw new Error("disk is full");
		});
		expect(() => removeCredential("default")).toThrow("disk is full");
		expect(existsSync(lockFile())).toBe(false);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(homeFiles()).toEqual(["credentials.json"]);

		setCredential("other", entry({ apiKeyId: "k_o" }));
		expect(Object.keys(stored().profiles)).toEqual(["default", "other"]);
	});
});

describe("writing credentials.json while another process holds the lock for longer than it will wait", () => {
	function expectBusy(error: unknown, waited: number): void {
		expect(error).toBeInstanceOf(AgxCliError);
		const busy = error as AgxCliError;
		expect(busy.exitCode).toBe(EXIT.config);
		expect(busy.message).toContain("credentials lock");
		expect(busy.message).toContain("for more than 5 seconds");
		expect(busy.message).toContain(credentialsFile());
		expect(busy.remediation).toContain(`rm ${lockFile()}`);
		for (const secret of [KEY, OTHER_KEY, THIRD_KEY]) {
			expect(busy.message).not.toContain(secret);
			expect(busy.remediation ?? "").not.toContain(secret);
		}
		expect(waited).toBeGreaterThanOrEqual(5_000);
		expect(waited).toBeLessThan(6_000);
	}

	it("a set gives up after 5 seconds with a plain error that holds no secret, and writes nothing", async () => {
		setCredential("default", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		plantLiveLock();
		const theirs = readFileSync(lockFile(), "utf8");

		const run = await onMovedClock(() => setCredential("other", entry({ apiKey: OTHER_KEY })));

		expectBusy(run.error, run.waited);
		// Nothing was written, and the other process's lock is as it was.
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(readFileSync(lockFile(), "utf8")).toBe(theirs);
		expect(homeFiles()).toEqual(["credentials.json", "credentials.json.lock"]);
	});

	it("a remove gives up the same way and removes nothing", async () => {
		setCredential("default", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		plantLiveLock();

		const run = await onMovedClock(() => removeCredential("default"));

		expectBusy(run.error, run.waited);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(homeFiles()).toEqual(["credentials.json", "credentials.json.lock"]);
	});

	it("does not take a lock away from a running process just because the lock is some seconds old", async () => {
		plantLiveLock();
		const past = new Date(Date.now() - 10_000);
		utimesSync(lockFile(), past, past);
		const run = await onMovedClock(() => setCredential("default", entry()));
		expect(run.error).toBeInstanceOf(AgxCliError);
		expect(existsSync(credentialsFile())).toBe(false);
	});

	it("agx config set apiKey exits 3 with a plain message, and stores no key", async () => {
		plantLiveLock();

		const run = await onMovedClock(() => withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin")));

		expect(run.error).toBeUndefined();
		expect(run.value?.code).toBe(EXIT.config);
		expect(run.value?.stderr).toContain("credentials lock");
		expect(run.value?.stderr).toContain("rm ");
		expect(`${run.value?.stdout}${run.value?.stderr}`).not.toContain(KEY);
		expect(existsSync(credentialsFile())).toBe(false);
	});

	it("agx logout exits 3 with a plain message, and keeps the entry", async () => {
		setCredential("default", entry({ source: "migrated" }));
		const before = readFileSync(credentialsFile(), "utf8");
		plantLiveLock();

		const run = await onMovedClock(() => agx("logout"));

		expect(run.error).toBeUndefined();
		expect(run.value?.code).toBe(EXIT.config);
		expect(run.value?.stderr).toContain("credentials lock");
		expect(`${run.value?.stdout}${run.value?.stderr}`).not.toContain(KEY);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
	});

	it("a config.json write that has to move a 0.3 key stops with the same plain message and leaves config.json as it was", async () => {
		const legacy = `{"version":1,"currentProfile":"default","profiles":{"default":{"apiBaseUrl":"https://app.ellaworks.ai","apiKey":${JSON.stringify(KEY)},"orgSlug":"acme"}}}`;
		writeFileSync(configPath(), legacy, { mode: 0o600 });
		plantLiveLock();

		const run = await onMovedClock(() => updateProfile("default", { nip05: "bot@acme.com" }));

		expectBusyLike(run.error);
		expect(readFileSync(configPath(), "utf8")).toBe(legacy);
		// The config lock was let go, and the other process's credentials lock is still theirs.
		expect(existsSync(`${configPath()}.lock`)).toBe(false);
		expect(existsSync(lockFile())).toBe(true);
		expect(existsSync(credentialsFile())).toBe(false);
	});

	function expectBusyLike(error: unknown): void {
		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toContain("credentials lock");
		expect((error as AgxCliError).message).not.toContain(KEY);
	}
});

describe("a credentials lock nobody is holding", () => {
	it("is taken over when its process has exited, the write goes through and the lock is gone", () => {
		writeFileSync(lockFile(), `${JSON.stringify({ pid: deadPid(), host: hostname(), token: "gone" })}\n`);
		setCredential("default", entry());
		expect(stored().profiles.default?.apiKeyId).toBe("k_1");
		expect(homeFiles()).toEqual(["credentials.json"]);

		writeFileSync(lockFile(), `${JSON.stringify({ pid: deadPid(), host: hostname(), token: "gone" })}\n`);
		expect(removeCredential("default")).toBe(true);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("is taken over when it is older than the stale age, whatever its pid", () => {
		plantLiveLock();
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockFile(), past, past);
		setCredential("default", entry());
		expect(stored().profiles.default?.apiKeyId).toBe("k_1");
		expect(homeFiles()).toEqual(["credentials.json"]);
	});
});

describe("the credentials lock and the other locks", () => {
	it("is re-entrant for its file: a write made while its lock is held takes no second lock and does not wait for itself", () => {
		const started = Date.now();
		withFileLock(credentialsFile(), "credentials", () => {
			const before = readFileSync(lockFile(), "utf8");
			setCredential("default", entry());
			// Still the outer call's own lock, not a new one the nested call made.
			expect(readFileSync(lockFile(), "utf8")).toBe(before);
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(stored().profiles.default?.apiKeyId).toBe("k_1");
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("is not the config lock: holding the config lock does not stand in for it, and both are let go", () => {
		let lockedAtWrite = false;
		withConfigLock(() => {
			expect(existsSync(`${configPath()}.lock`)).toBe(true);
			whileStopped(() => {
				lockedAtWrite = existsSync(lockFile());
			});
			setCredential("default", entry());
		});
		expect(lockedAtWrite).toBe(true);
		expect(existsSync(`${configPath()}.lock`)).toBe(false);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("moving a 0.3 key out of config.json takes the credentials lock inside the config lock, and lets go of both", () => {
		writeFileSync(
			configPath(),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "https://app.ellaworks.ai", apiKey: KEY, orgSlug: "acme" } },
			}),
			{ mode: 0o600 },
		);
		// The credentials are written first (the key is then in both files, never in neither).
		let heldAtWrite: { config: boolean; credentials: boolean } | undefined;
		whileStopped(() => {
			heldAtWrite = { config: existsSync(`${configPath()}.lock`), credentials: existsSync(lockFile()) };
		});
		const notices = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			updateProfile("default", { nip05: "bot@acme.com" });
		} finally {
			notices.mockRestore();
		}
		expect(heldAtWrite).toEqual({ config: true, credentials: true });
		expect(readFileSync(configPath(), "utf8")).not.toContain(KEY);
		expect(stored().profiles.default).toMatchObject({ apiKey: KEY, source: "migrated" });
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(homeFiles()).toEqual(["config.json", "credentials.json"]);
	});
});

describe("a write whose lock was taken over while it was stopped", () => {
	it("a set writes nothing and says the change was not saved, when the other command took the lock, saved and let go", () => {
		setCredential("default", entry());
		whileStopped(() => {
			fs.rmSync(lockFile(), { force: true });
			const file = stored();
			file.profiles.theirs = entry({ apiKey: OTHER_KEY, apiKeyId: "k_theirs" });
			writeFileSync(credentialsFile(), JSON.stringify(file));
		});

		const error = errorOf(() => setCredential("mine", entry({ apiKey: THIRD_KEY })));

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect((error as AgxCliError).message).toMatch(/took over the credentials lock/);
		for (const secret of [KEY, OTHER_KEY, THIRD_KEY]) {
			expect((error as AgxCliError).message).not.toContain(secret);
		}
		// The file is as the other command saved it, and no temp file is left.
		expect(Object.keys(stored().profiles).sort()).toEqual(["default", "theirs"]);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("a remove does the same, and leaves the other command's lock alone, when that command still holds it", () => {
		setCredential("default", entry());
		setCredential("keep", entry({ apiKeyId: "k_keep" }));
		whileStopped(() => {
			fs.rmSync(lockFile(), { force: true });
			writeFileSync(lockFile(), `${JSON.stringify({ pid: process.pid, host: hostname(), token: "the-other-command" })}\n`);
			const file = stored();
			file.profiles.theirs = entry({ apiKey: OTHER_KEY, apiKeyId: "k_theirs" });
			writeFileSync(credentialsFile(), JSON.stringify(file));
		});

		const error = errorOf(() => removeCredential("default"));

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(Object.keys(stored().profiles).sort()).toEqual(["default", "keep", "theirs"]);
		// A lock that is not ours is never removed.
		expect(JSON.parse(readFileSync(lockFile(), "utf8")).token).toBe("the-other-command");
		expect(homeFiles()).toEqual(["credentials.json", "credentials.json.lock"]);
	});

	it("saves as before when nothing happened while it was flushing", () => {
		setCredential("default", entry());
		whileStopped(() => undefined);
		setCredential("other", entry({ apiKeyId: "k_o" }));
		whileStopped(() => undefined);
		expect(removeCredential("default")).toBe(true);
		expect(Object.keys(stored().profiles)).toEqual(["other"]);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});
});

describe("a credentials file that cannot be used: what a command says does not change", () => {
	/** The message and the way out a command gives for a file it cannot use. */
	function expectRefused(error: unknown, pattern: RegExp, before: string): void {
		expect(error).toBeInstanceOf(AgxCliError);
		const refused = error as AgxCliError;
		expect(refused.exitCode).toBe(EXIT.config);
		expect(refused.message).toMatch(pattern);
		expect(refused.remediation).toContain(`mv ${credentialsFile()} ${credentialsFile()}.broken && agx login`);
		// The parse error of a file that holds keys is never echoed.
		for (const text of [refused.message, refused.remediation ?? ""]) {
			expect(text).not.toContain("ela_");
			expect(text).not.toContain("LEAKME");
			expect(text).not.toContain("Unexpected");
		}
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		// No lock and no temp file left behind.
		expect(homeFiles()).toEqual(["credentials.json"]);
	}

	const everyCommand: Array<[string, () => unknown]> = [
		["get", () => getCredential("default")],
		["list", () => listCredentials()],
		["set", () => setCredential("x", entry())],
		["remove", () => removeCredential("default")],
	];

	it("is not valid JSON: every call refuses the same way, keeps the file as it is and never quotes it", () => {
		const broken = '{"version":1,"profiles":{"default":{"apiKey":"ela_LEAKME';
		writeFileSync(credentialsFile(), broken, { mode: 0o600 });
		for (const [, run] of everyCommand) {
			expectRefused(errorOf(run), /is not valid JSON/, broken);
		}
	});

	it("does not have the expected shape: every call refuses the same way and keeps the file as it is", () => {
		const wrong = `${JSON.stringify({ version: 2, profiles: { default: { apiKey: "ela_LEAKME" } } })}\n`;
		writeFileSync(credentialsFile(), wrong, { mode: 0o600 });
		for (const [, run] of everyCommand) {
			expectRefused(errorOf(run), /does not match the expected shape/, wrong);
		}
	});

	/** A file that is not valid JSON and one that has the wrong shape; neither names a profile called "nobody". */
	const unusableFiles: Array<[string, RegExp]> = [
		['{"version":1,"profiles":{"default":{"apiKey":"ela_LEAKME', /is not valid JSON/],
		[`${JSON.stringify({ version: 2, profiles: { default: { apiKey: "ela_LEAKME" } } })}\n`, /does not match the expected shape/],
	];

	it("a remove of a profile the file does not name still says the file cannot be used, takes no lock and keeps the file", () => {
		for (const [text, pattern] of unusableFiles) {
			writeFileSync(credentialsFile(), text, { mode: 0o600 });
			for (const name of ["nobody", "default"]) {
				expectRefused(errorOf(() => removeCredential(name)), pattern, text);
			}
		}
	});

	it("a set of an entry that does not fit the shape, on a file that cannot be used, says what is wrong with the file first", () => {
		const bad = { ...entry(), apiKey: 42 } as unknown as CredentialEntry;
		for (const [text, pattern] of unusableFiles) {
			writeFileSync(credentialsFile(), text, { mode: 0o600 });
			expectRefused(errorOf(() => setCredential("nobody", bad)), pattern, text);
		}
	});

	it("is not valid JSON while another process holds the lock: a get, a list or a remove still says so at once", async () => {
		const broken = '{"version":1,"profiles":{"default":{"apiKey":"ela_LEAKME';
		writeFileSync(credentialsFile(), broken, { mode: 0o600 });
		plantLiveLock();
		const run = await onMovedClock(() => {
			for (const [name, call] of everyCommand) {
				if (name === "set") {
					continue;
				}
				const error = errorOf(call);
				expect(error, name).toBeInstanceOf(AgxCliError);
				expect((error as AgxCliError).message, name).toMatch(/is not valid JSON/);
			}
		});
		expect(run.error).toBeUndefined();
		expect(run.waited).toBeLessThan(1_000);
		expect(readFileSync(credentialsFile(), "utf8")).toBe(broken);
	});

	it("is not valid JSON and the lock left by a process that has exited is in the way: a set says the same as without it", () => {
		const broken = '{"version":1,"profiles":{"default":{"apiKey":"ela_LEAKME';
		writeFileSync(credentialsFile(), broken, { mode: 0o600 });
		writeFileSync(lockFile(), `${JSON.stringify({ pid: deadPid(), host: hostname(), token: "gone" })}\n`);
		const error = errorOf(() => setCredential("x", entry()));
		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/is not valid JSON/);
		expect((error as AgxCliError).message).not.toContain("LEAKME");
		expect(readFileSync(credentialsFile(), "utf8")).toBe(broken);
	});

	it.skipIf(process.getuid?.() === 0)("cannot be read by this user: every call refuses and the file is left as it is", () => {
		setCredential("default", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		chmodSync(credentialsFile(), 0o000);
		try {
			for (const [, run] of everyCommand) {
				const error = errorOf(run);
				expect(error).toBeInstanceOf(AgxCliError);
				expect((error as AgxCliError).exitCode).toBe(EXIT.config);
				expect((error as AgxCliError).message).not.toContain(KEY);
			}
		} finally {
			chmodSync(credentialsFile(), 0o600);
		}
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("is a folder: every call refuses and the folder is left as it is", () => {
		mkdirSync(credentialsFile());
		for (const [, run] of everyCommand) {
			const error = errorOf(run);
			expect(error).toBeInstanceOf(AgxCliError);
			expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		}
		expect(lstatSync(credentialsFile()).isDirectory()).toBe(true);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("is a link to a file elsewhere: reads through the link, and a write replaces the link with a private file, as before", () => {
		const target = join(box.home, "elsewhere.json");
		const original = `${JSON.stringify({ version: 1, profiles: { default: entry() } }, null, 2)}\n`;
		writeFileSync(target, original, { mode: 0o600 });
		symlinkSync(target, credentialsFile());
		expect(getCredential("default")).toEqual(entry());

		setCredential("other", entry({ apiKeyId: "k_o" }));

		expect(lstatSync(credentialsFile()).isSymbolicLink()).toBe(false);
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(Object.keys(stored().profiles)).toEqual(["default", "other"]);
		// The file the link pointed at is not touched, and the lock sits in the home folder beside the link.
		expect(readFileSync(target, "utf8")).toBe(original);
		expect(homeFiles()).toEqual(["credentials.json", "elsewhere.json"]);

		fs.rmSync(credentialsFile());
		symlinkSync(target, credentialsFile());
		expect(removeCredential("default")).toBe(true);
		expect(lstatSync(credentialsFile()).isSymbolicLink()).toBe(false);
		expect(stored().profiles).toEqual({});
		expect(readFileSync(target, "utf8")).toBe(original);
		expect(homeFiles()).toEqual(["credentials.json", "elsewhere.json"]);
	});
});

describe("removing a profile that is not there", () => {
	it("returns false and writes nothing: the same bytes, the same file, no flush", () => {
		setCredential("keep", entry());
		const before = readFileSync(credentialsFile(), "utf8");
		const inode = statSync(credentialsFile()).ino;
		vi.mocked(fs.fsyncSync).mockClear();

		expect(removeCredential("nobody")).toBe(false);

		expect(fs.fsyncSync).not.toHaveBeenCalled();
		expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
		expect(statSync(credentialsFile()).ino).toBe(inode);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});

	it("returns false with no credentials file, and makes none", () => {
		expect(removeCredential("nobody")).toBe(false);
		expect(homeFiles()).toEqual([]);
	});

	it("returns false with no home folder, and makes no folder", () => {
		process.env.AGX_HOME = join(box.home, "not-made-yet");
		expect(removeCredential("nobody")).toBe(false);
		expect(existsSync(process.env.AGX_HOME)).toBe(false);
		expect(homeFiles()).toEqual([]);
	});

	it("returns false at once while another command holds the lock, and does not touch it", async () => {
		setCredential("keep", entry());
		plantLiveLock();
		const theirs = readFileSync(lockFile(), "utf8");

		const run = await onMovedClock(() => removeCredential("nobody"));

		expect(run.error).toBeUndefined();
		expect(run.value).toBe(false);
		expect(run.waited).toBeLessThan(1_000);
		expect(readFileSync(lockFile(), "utf8")).toBe(theirs);
		expect(homeFiles()).toEqual(["credentials.json", "credentials.json.lock"]);
	});

	it("returns false and leaves the mode of the home folder as it was", () => {
		setCredential("keep", entry());
		chmodSync(box.home, 0o750);
		expect(removeCredential("nobody")).toBe(false);
		expect(statSync(box.home).mode & 0o777).toBe(0o750);
		expect(homeFiles()).toEqual(["credentials.json"]);
	});
});

describe("agx commands that use credentials.json", () => {
	let mock: MockIndexServer;
	let restoreClock: () => void;

	beforeEach(async () => {
		const clock = fakeClock();
		restoreClock = useClock(clock);
		mock = await startMockIndexServer({ now: clock.now });
	});

	afterEach(async () => {
		await mock.close();
		restoreClock();
	});

	const leftovers = (): string[] => homeFiles().filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));

	it("login, config show, whoami and logout work as before and leave no lock or temp file behind", async () => {
		mock.onTokenPoll = () => mock.approve();
		const login = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(login.code, login.stderr).toBe(0);
		const key = mock.keys[0];
		expect(stored().profiles.default).toMatchObject({ apiKey: key?.key, source: "login", apiBaseUrl: mock.origin });
		expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
		expect(leftovers()).toEqual([]);

		const show = await agx("config", "show", "--json");
		expect(show.code, show.stderr).toBe(0);
		expect(jsonDocuments(show.stdout).at(-1)).toMatchObject({ profile: "default", credentials: { source: "login" } });
		expect(`${show.stdout}${show.stderr}`).not.toContain(key?.key ?? "missing");

		const whoami = await agx("whoami", "--json");
		expect(whoami.code, whoami.stderr).toBe(0);
		expect(jsonDocuments(whoami.stdout).at(-1)).toMatchObject({ loggedIn: true, profile: "default" });

		const logout = await agx("logout", "--json");
		expect(logout.code, logout.stderr).toBe(0);
		expect(jsonDocuments(logout.stdout).at(-1)).toEqual({ loggedOut: [{ profile: "default", revoked: true, reason: "revoked" }] });
		expect(stored().profiles).toEqual({});
		expect(leftovers()).toEqual([]);
	});

	it("config set apiKey, then logout of a key that is not revocable, work as before and leave nothing behind", async () => {
		const stored1 = await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin", "--profile", "one"));
		expect(stored1.code, stored1.stderr).toBe(0);
		const stored2 = await withStdin(OTHER_KEY, () => agx("config", "set", "apiKey", "--stdin", "--profile", "two"));
		expect(stored2.code, stored2.stderr).toBe(0);
		expect(Object.keys(stored().profiles)).toEqual(["one", "two"]);
		expect(`${stored1.stdout}${stored1.stderr}${stored2.stdout}${stored2.stderr}`).not.toContain(KEY);
		expect(leftovers()).toEqual([]);

		// A key of an earlier agx is cleared, never sent anywhere: nothing here connects.
		setCredential("old", entry({ source: "migrated" }));
		const out = await agx("logout", "--profile", "old", "--json");
		expect(out.code, out.stderr).toBe(0);
		expect(Object.keys(stored().profiles)).toEqual(["one", "two"]);
		expect(leftovers()).toEqual([]);
	});
});
