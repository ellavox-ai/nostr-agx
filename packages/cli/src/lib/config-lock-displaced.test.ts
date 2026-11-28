import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, saveProfile, updateProfile } from "./config.js";
import { configLockPath, withConfigLock } from "./config-lock.js";
import { AgxCliError, EXIT } from "./errors.js";
import { createIdentity } from "./identity.js";
import { configPath } from "./paths.js";

// A command that holds the config lock can be stopped for longer than the lock's age limit (a
// debugger, a laptop that goes to sleep). Another command then takes the lock, saves its own
// change and lets go. When the first command wakes up it must not publish its copy of config.json
// over the other command's.
//
// The file is written to a temp file, flushed with `fsyncSync`, and then renamed into place. The
// flush is the place where a slow disk or a stop can happen, so the tests use it as the point where
// "the other command" gets its turn: only `fsyncSync` is wrapped, and it does the real thing unless
// a test says otherwise.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

let home: string;
let previous: string | undefined;
let realFsync: (fd: number) => void;

const A = createIdentity().publicKey;
const B = createIdentity().publicKey;
const C = createIdentity().publicKey;

beforeEach(async () => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-displaced-"));
	process.env.AGX_HOME = home;
	realFsync = (await vi.importActual<typeof import("node:fs")>("node:fs")).fsyncSync;
});

afterEach(() => {
	vi.mocked(fs.fsyncSync).mockReset();
	vi.mocked(fs.fsyncSync).mockImplementation(realFsync);
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

/** Run `meanwhile` at the moment the next file write is flushed: after the temp file is written, before it is renamed into place. */
function whileStopped(meanwhile: () => void): void {
	vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
		meanwhile();
		realFsync(fd);
	});
}

/** What another command would have saved: the stored file with one more peer on the default profile's allowlist. */
function otherCommandSaves(peer: string): void {
	const stored = JSON.parse(readFileSync(configPath(), "utf8"));
	stored.profiles.default.allow.push(peer);
	writeFileSync(configPath(), `${JSON.stringify(stored, null, 2)}\n`);
}

function tempFiles(): string[] {
	return readdirSync(home).filter((name) => name.endsWith(".tmp"));
}

function lockRecord(): { token: string } {
	return JSON.parse(readFileSync(configLockPath(), "utf8"));
}

describe("a config write whose lock was taken over while it was stopped", () => {
	it("writes nothing and says the change was not saved, when the other command took the lock, saved and let go", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			rmSync(configLockPath());
			otherCommandSaves(B);
		});

		let error: unknown;
		try {
			updateProfile("default", (current) => ({ allow: [...current.allow, C] }));
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect((error as AgxCliError).message).toMatch(/another agx command took over the config lock/);
		// The file is as the other command saved it, and no temp file is left.
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(tempFiles()).toEqual([]);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("does the same, and leaves the other command's lock alone, when that command still holds it", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			rmSync(configLockPath());
			writeFileSync(
				configLockPath(),
				`${JSON.stringify({ pid: process.pid, host: hostname(), token: "the-other-command" })}\n`,
			);
			otherCommandSaves(B);
		});

		let error: unknown;
		try {
			updateProfile("default", (current) => ({ allow: [...current.allow, C] }));
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(tempFiles()).toEqual([]);
		// A lock that is not ours is never removed.
		expect(lockRecord().token).toBe("the-other-command");
	});

	it("saves as before when nothing happened while it was flushing", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => undefined);

		updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(getProfile("default").allow).toEqual([A, C]);
		expect(tempFiles()).toEqual([]);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("still saves when its lock has grown old but nobody took it: the lock is judged by its owner, not by its age", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			const past = new Date(Date.now() - 120_000);
			utimesSync(configLockPath(), past, past);
		});

		updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(getProfile("default").allow).toEqual([A, C]);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("does not refuse a save made outside the lock, which holds nothing to lose", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => otherCommandSaves(B));

		saveProfile("default", { ...getProfile("default"), allow: [C] });

		expect(getProfile("default").allow).toEqual([C]);
	});
});

function errorOf(run: () => void): unknown {
	try {
		run();
	} catch (caught) {
		return caught;
	}
	return undefined;
}

// Nothing in the program saves from inside a lock that is already held (a nested call takes no lock of
// its own), so these two tests guard the way the check must keep working if something ever does.
describe("the check also holds when the save is made in a nested lock call", () => {
	it("refuses a save made inside a nested lock call", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			rmSync(configLockPath());
			otherCommandSaves(B);
		});

		const error = errorOf(() => {
			withConfigLock(() => {
				// updateProfile takes the lock again: a nested call, which holds nothing new.
				updateProfile("default", (current) => ({ allow: [...current.allow, C] }));
			});
		});

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(tempFiles()).toEqual([]);
	});

	it("refuses a save made after a nested lock call has returned", () => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			rmSync(configLockPath());
			otherCommandSaves(B);
		});

		const error = errorOf(() => {
			withConfigLock(() => {
				withConfigLock(() => undefined);
				saveProfile("default", { ...getProfile("default"), allow: [A, C] });
			});
		});

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(tempFiles()).toEqual([]);
	});
});

// A lock is always linked in whole, so another command's lock is never unreadable. If the file at the
// lock path cannot be read as a lock record, it is not ours, and the save is refused. The thing at the
// lock path is never removed.
const canHideFile = process.platform !== "win32" && process.getuid?.() !== 0;
const unreadableLocks: { shape: string; put: (path: string) => void; stillThere: (path: string) => boolean }[] = [
	{ shape: "an empty file", put: (path) => writeFileSync(path, ""), stillThere: (path) => readFileSync(path, "utf8") === "" },
	{
		shape: "text that is not JSON",
		put: (path) => writeFileSync(path, "not json\n"),
		stillThere: (path) => readFileSync(path, "utf8") === "not json\n",
	},
	{
		shape: "JSON that is not a lock record",
		put: (path) => writeFileSync(path, '{"hello":1}\n'),
		stillThere: (path) => readFileSync(path, "utf8") === '{"hello":1}\n',
	},
	{ shape: "a directory", put: (path) => mkdirSync(path), stillThere: (path) => statSync(path).isDirectory() },
	...(canHideFile
		? [
				{
					shape: "a lock record in a file nobody can read",
					put: (path: string) => {
						writeFileSync(path, `${JSON.stringify({ pid: process.pid, host: hostname(), token: "the-other-command" })}\n`);
						chmodSync(path, 0o000);
					},
					stillThere: (path: string) => (statSync(path).mode & 0o777) === 0,
				},
			]
		: []),
];

describe("a save is refused when the lock path holds something that is not a readable lock record", () => {
	it.each(unreadableLocks)("refuses, writes nothing and leaves $shape in place", ({ put, stillThere }) => {
		updateProfile("default", { allow: [A] });
		whileStopped(() => {
			rmSync(configLockPath());
			put(configLockPath());
			otherCommandSaves(B);
		});

		const error = errorOf(() => updateProfile("default", (current) => ({ allow: [...current.allow, C] })));

		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).message).toMatch(/was not saved/);
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(tempFiles()).toEqual([]);
		expect(stillThere(configLockPath())).toBe(true);
	});
});
