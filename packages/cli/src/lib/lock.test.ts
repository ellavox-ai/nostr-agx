import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgxCliError } from "./errors";
import { acquireLock } from "./lock";
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

describe("acquireLock", () => {
	it("writes this pid and removes the file on release", () => {
		const release = acquireLock("p");
		expect(existsSync(lockPath("p"))).toBe(true);
		release();
		expect(existsSync(lockPath("p"))).toBe(false);
	});

	it("refuses a second holder while the first is alive", () => {
		const release = acquireLock("p");
		expect(() => acquireLock("p")).toThrow(AgxCliError);
		release();
	});

	it("takes over a stale lock left by a dead process", () => {
		ensureDir(profileDir("p"));
		writeFileSync(lockPath("p"), "2147483646\n");
		const release = acquireLock("p");
		expect(existsSync(lockPath("p"))).toBe(true);
		release();
	});

	it("keeps profiles independent", () => {
		const a = acquireLock("a");
		const b = acquireLock("b");
		a();
		b();
	});
});
