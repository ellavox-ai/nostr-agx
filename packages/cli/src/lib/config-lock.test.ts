import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_LOCK_STALE_MS,
	CONFIG_LOCK_UNREADABLE_MS,
	clearUnderBreaker,
	configLockPath,
	withConfigLock,
} from "./config-lock.js";
import { AgxCliError } from "./errors.js";
import { configPath } from "./paths.js";
import { holdConfigLockUntilSomeoneWaits, PATIENT_TEST_MS, PATIENT_WAIT_MS } from "../test/config-lock-helpers.js";

let home: string;
let previous: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-lock-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
	}
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

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

function writeLock(record: Record<string, unknown> | string): void {
	writeFileSync(configLockPath(), typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
}

function age(seconds: number, path: string = configLockPath()): void {
	const past = new Date(Date.now() - seconds * 1000);
	utimesSync(path, past, past);
}

function writeBreaker(record: Record<string, unknown> | string): string {
	const path = `${configLockPath()}.break`;
	writeFileSync(path, typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
	return path;
}

/** Everything in the home folder that belongs to the lock: the lock itself, a breaker, a temp file. */
function lockFiles(): string[] {
	return readdirSync(home).filter((name) => name.startsWith("config.json.lock"));
}

describe("withConfigLock", () => {
	it("runs the function, returns its value, and leaves no lock file behind", () => {
		const value = withConfigLock(() => {
			expect(existsSync(configLockPath())).toBe(true);
			return 42;
		});
		expect(value).toBe(42);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("refuses, in its type, a function that returns a promise (checked by type-check)", () => {
		const neverCalled = (): void => {
			// @ts-expect-error the lock would be let go before the promise settles
			withConfigLock(async () => 1);
		};
		expect(neverCalled).toBeTypeOf("function");
	});

	describe("a function that returns a promise, past the types", () => {
		// The types refuse an async function, but a function typed `any`, a hand-made thenable and an open
		// generic all compile. The lock is let go when the function returns, so a promise would settle
		// later without it: it has to be refused when it runs.
		it("is refused for an async function cast through any: the lock is let go and nothing is written", () => {
			const later = (async () => 1) as any;
			expect(() => withConfigLock(later)).toThrow(/must be synchronous/);
			expect(existsSync(configLockPath())).toBe(false);
			expect(existsSync(configPath())).toBe(false);
			expect(withConfigLock(() => "again")).toBe("again");
		});

		it("is refused for a hand-made thenable", () => {
			const thenable = { then: () => undefined } as any;
			expect(() => withConfigLock(() => thenable)).toThrow(/must be synchronous/);
			expect(existsSync(configLockPath())).toBe(false);
		});

		it("is refused for a nested call too, even when the outer function drops the value, and the outer lock is let go", () => {
			const later = (async () => 1) as any;
			expect(() =>
				withConfigLock(() => {
					withConfigLock(later);
					return 1;
				}),
			).toThrow(/must be synchronous/);
			expect(existsSync(configLockPath())).toBe(false);
		});

		it("lets an ordinary value through, including one that merely has a property called then", () => {
			expect(withConfigLock(() => 42)).toBe(42);
			expect(withConfigLock(() => null)).toBeNull();
			expect(withConfigLock(() => undefined)).toBeUndefined();
			const notThenable = { then: "not a function" };
			expect(withConfigLock(() => notThenable)).toBe(notThenable);
			expect(existsSync(configLockPath())).toBe(false);
		});
	});

	it("releases the lock when the function throws", () => {
		expect(() =>
			withConfigLock(() => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(configLockPath())).toBe(false);
		expect(withConfigLock(() => "again")).toBe("again");
	});

	it("is re-entrant: a nested call does not wait for itself, and does not take the outer lock over", () => {
		const started = Date.now();
		const value = withConfigLock(() => {
			const before = readFileSync(configLockPath(), "utf8");
			const inner = withConfigLock(() => "inner", { waitMs: PATIENT_WAIT_MS });
			// Still the outer call's own lock, not a new one the nested call made.
			expect(readFileSync(configLockPath(), "utf8")).toBe(before);
			return inner;
		});
		expect(value).toBe("inner");
		// Far below the limit it was given: it did not wait at all.
		expect(Date.now() - started).toBeLessThan(PATIENT_WAIT_MS / 2);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("leaves no lock, breaker or temp file behind, after a run, a takeover or a refusal", () => {
		withConfigLock(() => undefined);
		expect(lockFiles()).toEqual([]);
		writeLock({ pid: deadPid(), host: hostname(), token: "gone" });
		withConfigLock(() => undefined, { waitMs: PATIENT_WAIT_MS });
		expect(lockFiles()).toEqual([]);
		writeLock({ pid: liveProcess(), host: hostname(), token: "other" });
		expect(() => withConfigLock(() => undefined, { waitMs: 100 })).toThrow(/config lock/i);
		// Only the other process's lock remains: no temp file of ours, no breaker.
		expect(lockFiles()).toEqual(["config.json.lock"]);
	});

	it("does not remove a lock that another process took while the function ran", () => {
		const theirs = { pid: liveProcess(), host: hostname(), token: "theirs" };
		withConfigLock(() => {
			rmSync(configLockPath());
			writeLock(theirs);
		});
		expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("theirs");
	});

	describe("while another process holds it", () => {
		it("refuses after the wait, and never runs the function", () => {
			writeLock({ pid: liveProcess(), host: hostname(), token: "other" });
			let ran = false;
			let error: unknown;
			try {
				withConfigLock(
					() => {
						ran = true;
					},
					{ waitMs: 150 },
				);
			} catch (caught) {
				error = caught;
			}
			expect(ran).toBe(false);
			expect(error).toBeInstanceOf(AgxCliError);
			expect((error as AgxCliError).message).toMatch(/config lock/i);
			expect((error as AgxCliError).remediation).toContain(configLockPath());
		});

		it("waits for it to be released, then runs", async () => {
			// The holder lets go once it has seen this writer waiting, so no timer decides the order.
			const held = await holdConfigLockUntilSomeoneWaits();
			children.push(held.child);
			let holder: string | undefined;
			withConfigLock(
				() => {
					holder = JSON.parse(readFileSync(configLockPath(), "utf8")).token;
				},
				{ waitMs: PATIENT_WAIT_MS },
			);
			expect(await held.sawWaiter).toBe(true);
			// By the time it ran, the lock was its own: the other process's record was gone.
			expect(holder).toBeDefined();
			expect(holder).not.toBe("other-writer");
		}, PATIENT_TEST_MS);

		it("waits 5 seconds when no limit is given, then refuses (on a clock the test moves, so nothing really waits)", () => {
			// A command that calls `withConfigLock` or `updateProfile` with no options gets the default wait. Every test
			// above passes its own, so without this nothing would notice a default that is far too short.
			writeLock({ pid: liveProcess(), host: hostname(), token: "other" });
			vi.useFakeTimers({ toFake: ["Date"] });
			const pause = vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, ms) => {
				vi.advanceTimersByTime(ms ?? 0);
				return "timed-out";
			});
			let error: unknown;
			let waited = 0;
			try {
				const started = Date.now();
				try {
					withConfigLock(() => "ran");
				} catch (caught) {
					error = caught;
				}
				waited = Date.now() - started;
			} finally {
				pause.mockRestore();
				vi.useRealTimers();
			}
			expect(error).toBeInstanceOf(AgxCliError);
			expect((error as AgxCliError).message).toContain("for more than 5 seconds");
			expect(waited).toBeGreaterThanOrEqual(5_000);
			expect(waited).toBeLessThan(6_000);
		});

		it("waits on a fresh lock from another host", () => {
			writeLock({ pid: 1, host: "some-other-container", token: "far" });
			expect(() => withConfigLock(() => undefined, { waitMs: 100 })).toThrow(/config lock/i);
		});

		it("waits on a lock whose pid belongs to another user: the process exists, so the lock is held", () => {
			// `kill(pid, 0)` answers EPERM for a process of another user. Made to happen for one pid, so the test
			// gives the same answer whoever runs it.
			const theirs = deadPid();
			writeLock({ pid: theirs, host: hostname(), token: "other-user" });
			const kill = process.kill.bind(process);
			const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
				if (pid === theirs && signal === 0) {
					throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
				}
				return kill(pid, signal);
			});
			try {
				expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
			} finally {
				spy.mockRestore();
			}
			expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("other-user");
		});
	});

	describe("a lock nobody is holding", () => {
		it("is taken over when its process has exited", () => {
			writeLock({ pid: deadPid(), host: hostname(), token: "gone" });
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
			expect(existsSync(configLockPath())).toBe(false);
		});

		it("is taken over when it is older than the stale age, whatever its pid", () => {
			writeLock({ pid: liveProcess(), host: hostname(), token: "forgotten" });
			age(CONFIG_LOCK_STALE_MS / 1000 + 5);
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		});

		it("is taken over when it is from another host and older than the stale age", () => {
			writeLock({ pid: 1, host: "some-other-container", token: "far" });
			age(CONFIG_LOCK_STALE_MS / 1000 + 5);
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		});

		it("is taken over when the file has stayed empty", () => {
			writeLock("");
			age(CONFIG_LOCK_UNREADABLE_MS / 1000 + 1);
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		});

		it("is NOT taken over while an unreadable file is new: it may be mid-change, and a vanished file is never abandoned", () => {
			writeLock("");
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
			expect(readFileSync(configLockPath(), "utf8")).toBe("");
		});

		it("is taken over when it is from this very pid but we do not hold it (an earlier life of the pid)", () => {
			writeLock({ pid: process.pid, host: hostname(), token: "earlier-life" });
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		});

		it("is taken over when its record has no host and its process has exited", () => {
			writeLock({ pid: deadPid(), token: "no-host" });
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		});

		it("is NOT taken over when its record has no host and its process is alive", () => {
			writeLock({ pid: liveProcess(), token: "no-host" });
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
		});

		it("is NOT taken over when it is fresh, from another host, and its pid is not running here", () => {
			writeLock({ pid: deadPid(), host: "some-other-container", token: "far" });
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
		});
	});

	describe("clearing a lock nobody holds", () => {
		const deadHolder = () => writeLock({ pid: deadPid(), host: hostname(), token: "gone" });

		it("goes through the breaker file: a breaker whose owner is running means someone else is clearing, so wait", () => {
			deadHolder();
			writeBreaker({ pid: liveProcess(), host: hostname(), token: "clearing" });
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
			expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("gone");
		});

		it("does not take a breaker away because it is old: its owner may only be paused, and would then remove a lock it no longer has the right to", () => {
			deadHolder();
			const breaker = writeBreaker({ pid: liveProcess(), host: hostname(), token: "paused" });
			age(5, breaker);
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
			expect(JSON.parse(readFileSync(breaker, "utf8")).token).toBe("paused");
			expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("gone");
		});

		it("removes a breaker whose owner has exited", () => {
			deadHolder();
			writeBreaker({ pid: deadPid(), host: hostname(), token: "died" });
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
			expect(lockFiles()).toEqual([]);
		});

		it("removes a breaker its owner has not refreshed for the stale age, as it does a lock", () => {
			deadHolder();
			const breaker = writeBreaker({ pid: liveProcess(), host: hostname(), token: "forgotten" });
			age(CONFIG_LOCK_STALE_MS / 1000 + 5, breaker);
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
			expect(lockFiles()).toEqual([]);
		});

		it("removes a breaker that has stayed unreadable, and waits while it is new", () => {
			deadHolder();
			writeBreaker("12345\n");
			expect(() => withConfigLock(() => "ran", { waitMs: 150 })).toThrow(/config lock/i);
			age(CONFIG_LOCK_UNREADABLE_MS / 1000 + 0.5, `${configLockPath()}.break`);
			expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
			expect(lockFiles()).toEqual([]);
		});
	});

	describe("clearUnderBreaker with a judgement that is out of date", () => {
		it("does not remove a live lock that took the place of the one judged abandoned", () => {
			const judged = { pid: deadPid(), host: hostname(), token: "judged" };
			writeLock({ pid: liveProcess(), host: hostname(), token: "newcomer" });
			clearUnderBreaker(configLockPath(), judged);
			expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("newcomer");
			expect(lockFiles()).toEqual(["config.json.lock"]);
		});

		it("removes the lock it judged when that lock is still abandoned, and leaves no breaker", () => {
			const record = { pid: deadPid(), host: hostname(), token: "judged" };
			writeLock(record);
			clearUnderBreaker(configLockPath(), record);
			expect(lockFiles()).toEqual([]);
		});

		it("does nothing, and leaves no breaker, when the lock has vanished", () => {
			clearUnderBreaker(configLockPath(), { pid: deadPid(), host: hostname(), token: "judged" });
			expect(lockFiles()).toEqual([]);
		});
	});
});
