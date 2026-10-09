import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgxCliError, EXIT } from "./errors";
import { acquireLock, clearAbandoned, LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./lock";
import { ensureDir, lockPath, profileDir } from "./paths";

let home: string;
let previous: string | undefined;

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-lock-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

function writeLock(record: Record<string, unknown> | string): void {
	ensureDir(profileDir("p"));
	writeFileSync(lockPath("p"), typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
}

function age(seconds: number): void {
	const past = new Date(Date.now() - seconds * 1000);
	utimesSync(lockPath("p"), past, past);
}

const OTHER_HOST = "some-other-container";

describe("acquireLock", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes this pid, host and a token, and removes the file on release", () => {
		const release = acquireLock("p");
		const record = JSON.parse(readFileSync(lockPath("p"), "utf8")) as Record<string, unknown>;
		expect(record).toMatchObject({ pid: process.pid, host: hostname() });
		expect(typeof record.token).toBe("string");
		release();
		expect(existsSync(lockPath("p"))).toBe(false);
	});

	it("leaves no temporary files behind", () => {
		acquireLock("p")();
		expect(readdirSync(profileDir("p")).filter((f) => f.startsWith("serve.lock"))).toEqual([]);
	});

	it("keeps profiles independent", () => {
		const a = acquireLock("a");
		const b = acquireLock("b");
		a();
		b();
	});

	describe("a holder on this host", () => {
		it("refuses to start while another live process holds the lock", () => {
			writeLock({ pid: process.ppid, host: hostname(), token: "t" });
			expect(() => acquireLock("p")).toThrow(AgxCliError);
			expect(JSON.parse(readFileSync(lockPath("p"), "utf8")).pid).toBe(process.ppid);
		});

		it("takes over a lock left by a dead process", () => {
			writeLock({ pid: 2147483646, host: hostname(), token: "t" });
			acquireLock("p")();
		});

		it("takes over a lock that names this very pid: an earlier life of this process", () => {
			writeLock({ pid: process.pid, host: hostname(), token: "old" });
			acquireLock("p")();
			expect(existsSync(lockPath("p"))).toBe(false);
		});

		it.each(["", "\n", "not a pid", "0", "-5", "1.5", "{", '{"pid":"x"}'])("takes over a lock file that holds %j", (content) => {
			writeLock(content);
			const release = acquireLock("p");
			expect(JSON.parse(readFileSync(lockPath("p"), "utf8")).pid).toBe(process.pid);
			release();
		});

		it("still reads the old format, a bare pid", () => {
			writeLock(`${process.ppid}\n`);
			expect(() => acquireLock("p")).toThrow(AgxCliError);
		});
	});

	describe("a holder on another host sharing the profile directory", () => {
		it("refuses while its heartbeat is recent, even when its pid equals ours", () => {
			writeLock({ pid: process.pid, host: OTHER_HOST, token: "theirs" });
			expect(() => acquireLock("p")).toThrow(/some-other-container/);
			expect(JSON.parse(readFileSync(lockPath("p"), "utf8")).token).toBe("theirs");
		});

		it("takes over once its heartbeat has stopped", () => {
			writeLock({ pid: 1, host: OTHER_HOST, token: "theirs" });
			age(LOCK_STALE_MS / 1000 + 5);
			const release = acquireLock("p");
			expect(JSON.parse(readFileSync(lockPath("p"), "utf8")).host).toBe(hostname());
			release();
		});
	});

	describe("the heartbeat", () => {
		it("keeps the lock fresh while held", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const release = acquireLock("p");
			age(30);
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			expect(Date.now() - statSync(lockPath("p")).mtimeMs).toBeLessThan(5_000);
			release();
		});

		it("does not touch a lock that now belongs to someone else, and does not remove it", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const release = acquireLock("p", undefined, () => undefined);
			writeLock({ pid: process.ppid, host: hostname(), token: "other" });
			age(30);
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS * 2);
			expect(Date.now() - statSync(lockPath("p")).mtimeMs).toBeGreaterThan(20_000);
			release();
			expect(existsSync(lockPath("p"))).toBe(true);
		});
	});

	describe("losing the lock", () => {
		it("calls onLost when another process holds it after a heartbeat tick and a second look", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
			const onLost = vi.fn();
			const release = acquireLock("p", undefined, onLost);
			writeLock({ pid: process.ppid, host: hostname(), token: "other" });
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			expect(onLost).not.toHaveBeenCalled();
			vi.advanceTimersByTime(250);
			expect(onLost).toHaveBeenCalledTimes(1);
			release();
		});

		it("does not call onLost when the file was only out for a moment", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
			const onLost = vi.fn();
			const release = acquireLock("p", undefined, onLost);
			const text = readFileSync(lockPath("p"), "utf8");
			rmSync(lockPath("p"));
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			writeFileSync(lockPath("p"), text);
			vi.advanceTimersByTime(250);
			expect(onLost).not.toHaveBeenCalled();
			release();
		});

		it("keeps refreshing the lock after a check that turned out fine", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
			const onLost = vi.fn();
			const release = acquireLock("p", undefined, onLost);
			const text = readFileSync(lockPath("p"), "utf8");
			rmSync(lockPath("p"));
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			writeFileSync(lockPath("p"), text);
			vi.advanceTimersByTime(250);
			age(30);
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			expect(Date.now() - statSync(lockPath("p")).mtimeMs).toBeLessThan(5_000);
			expect(onLost).not.toHaveBeenCalled();
			release();
		});

		it("does not report a loss after the lock was released", () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
			const onLost = vi.fn();
			const release = acquireLock("p", undefined, onLost);
			rmSync(lockPath("p"));
			vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
			release();
			vi.advanceTimersByTime(500);
			expect(onLost).not.toHaveBeenCalled();
		});
	});

	describe("clearing an abandoned lock", () => {
		it("removes the record it judged", () => {
			const judged = { pid: 2147483646, host: hostname(), token: "old" };
			writeLock(judged);
			clearAbandoned(lockPath("p"), judged);
			expect(existsSync(lockPath("p"))).toBe(false);
			expect(readdirSync(profileDir("p")).filter((f) => f.includes(".stale."))).toEqual([]);
		});

		it("puts back a fresh lock that a faster process took in the meantime", () => {
			const judged = { pid: 2147483646, host: hostname(), token: "old" };
			const fresh = { pid: process.ppid, host: hostname(), token: "fresh" };
			writeLock(fresh);
			clearAbandoned(lockPath("p"), judged);
			expect(JSON.parse(readFileSync(lockPath("p"), "utf8")).token).toBe("fresh");
			expect(readdirSync(profileDir("p")).filter((f) => f.includes(".stale."))).toEqual([]);
		});
	});

	it("reports the holder and uses the exit code it was given", () => {
		writeLock({ pid: process.ppid, host: hostname(), token: "t" });
		try {
			acquireLock("p", EXIT.generic);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AgxCliError);
			expect((error as AgxCliError).exitCode).toBe(EXIT.generic);
			expect((error as AgxCliError).message).toContain(`pid ${process.ppid}`);
		}
	});
});
