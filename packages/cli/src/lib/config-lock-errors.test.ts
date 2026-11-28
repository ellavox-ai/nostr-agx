import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configLockPath, withConfigLock } from "./config-lock.js";
import { PATIENT_WAIT_MS } from "../test/config-lock-helpers.js";
import { AgxCliError } from "./errors.js";

// Only `linkSync` is replaced, so a test can make taking the lock fail in a way a real file system
// will not on demand. It does the real thing until a test says otherwise.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

let home: string;
let previous: string | undefined;

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-lock-errors-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	vi.mocked(fs.linkSync).mockReset();
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

function linkFailsWith(code: string): void {
	vi.mocked(fs.linkSync).mockImplementation(() => {
		throw Object.assign(new Error(`${code}: link failed`), { code });
	});
}

describe("taking the config lock when the file system refuses the link", () => {
	it.each(["EPERM", "EACCES", "ENOSPC"])("raises the %s error as it is, and does not wait for the lock", (code) => {
		linkFailsWith(code);
		let ran = false;
		let error: unknown;
		try {
			withConfigLock(
				() => {
					ran = true;
				},
				{ waitMs: 300 },
			);
		} catch (caught) {
			error = caught;
		}
		expect(ran).toBe(false);
		// The real error, not the "another agx command has been writing" refusal.
		expect(error).not.toBeInstanceOf(AgxCliError);
		expect((error as NodeJS.ErrnoException).code).toBe(code);
		// No temp file left behind, and no lock.
		expect(readdirSync(home).filter((name) => name.startsWith("config.json.lock"))).toEqual([]);
	});

	it("still takes the lock normally once the file system works again", () => {
		linkFailsWith("EPERM");
		expect(() => withConfigLock(() => "ran", { waitMs: 300 })).toThrow();
		vi.mocked(fs.linkSync).mockReset();
		expect(withConfigLock(() => "ran", { waitMs: PATIENT_WAIT_MS })).toBe("ran");
		expect(existsSync(configLockPath())).toBe(false);
	});
});
