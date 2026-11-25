import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../test/helpers.js";
import { HardLinksUnavailableError, PrivateFileExistsError, writePrivateJson, writePrivateText } from "./paths.js";

// writePrivateText replaces what is there, by default. With `exclusive` it
// creates the file only if nothing is there when it is written, and says so with
// PrivateFileExistsError. The file is finished before it becomes visible, is
// private (0600), and no temporary file is left behind, whichever way it ends.

/**
 * What a test can do to the file system calls the write makes: make the link
 * step or the removal of the temp name fail (the way a file system without hard
 * links does), or look at the target just before every call.
 */
const fsHook = vi.hoisted(() => ({
	link: undefined as undefined | NodeJS.ErrnoException,
	unlink: undefined as undefined | NodeJS.ErrnoException,
	before: undefined as undefined | ((call: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const wrapped: Record<string, unknown> = { ...actual };
	for (const [name, value] of Object.entries(actual)) {
		if (name.endsWith("Sync") && typeof value === "function") {
			wrapped[name] = (...args: unknown[]) => {
				fsHook.before?.(name);
				return (value as (...rest: unknown[]) => unknown)(...args);
			};
		}
	}
	wrapped.linkSync = (from: string, to: string) => {
		fsHook.before?.("linkSync");
		if (fsHook.link) {
			throw fsHook.link;
		}
		return actual.linkSync(from, to);
	};
	wrapped.unlinkSync = (path: string) => {
		fsHook.before?.("unlinkSync");
		if (fsHook.unlink) {
			throw fsHook.unlink;
		}
		return actual.unlinkSync(path);
	};
	return wrapped;
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

let box: ReturnType<typeof sandbox>;
let target: string;
const folder = () => readdirSync(dirname(target)).sort();
const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
	box = sandbox();
	target = join(box.home, "profiles", "p", "secret.json");
});

afterEach(() => {
	fsHook.link = undefined;
	fsHook.unlink = undefined;
	fsHook.before = undefined;
	box.restore();
});

describe("an exclusive private write", () => {
	it("creates the file complete and private when nothing is there, and leaves no temporary file", () => {
		writePrivateText(target, "first\n", { exclusive: true });
		expect(readFileSync(target, "utf8")).toBe("first\n");
		expect(mode(target)).toBe(0o600);
		expect(mode(dirname(target))).toBe(0o700);
		expect(folder()).toEqual(["secret.json"]);
	});

	it("writes JSON the same way", () => {
		writePrivateJson(target, { a: 1 }, { exclusive: true });
		expect(readFileSync(target, "utf8")).toBe('{\n  "a": 1\n}\n');
		expect(mode(target)).toBe(0o600);
	});

	it("refuses when a file is there, with an error that names the path and nothing else", () => {
		const marker = randomBytes(16).toString("hex");
		writePrivateText(target, "old\n");
		let caught: unknown;
		try {
			writePrivateText(target, `new ${marker}\n`, { exclusive: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PrivateFileExistsError);
		expect((caught as PrivateFileExistsError).path).toBe(target);
		expect(String((caught as Error).stack).includes(marker)).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(folder()).toEqual(["secret.json"]);
	});

	it("refuses when an empty file is there", () => {
		writePrivateText(target, "");
		expect(() => writePrivateText(target, "new\n", { exclusive: true })).toThrow(PrivateFileExistsError);
		expect(readFileSync(target, "utf8")).toBe("");
	});

	it("passes on a failure of the link that is not 'already exists' or 'no hard links', and writes nothing", () => {
		fsHook.link = Object.assign(new Error("input/output error, link"), { code: "EIO" });
		let caught: unknown;
		try {
			writePrivateText(target, "new\n", { exclusive: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(fsHook.link);
		expect(caught).not.toBeInstanceOf(PrivateFileExistsError);
		expect((caught as Error).name).not.toBe("HardLinksUnavailableError");
		expect(existsSync(target)).toBe(false);
		expect(folder()).toEqual([]);
	});

	it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])(
		"says so, and writes nothing, when the file system cannot make hard links (%s)",
		(code) => {
			fsHook.link = Object.assign(new Error(`${code}: operation not supported on socket, link 'a.tmp' -> 'b'`), { code });
			let caught: unknown;
			try {
				writePrivateText(target, "new\n", { exclusive: true });
			} catch (error) {
				caught = error;
			}
			expect((caught as Error).name).toBe("HardLinksUnavailableError");
			expect(caught).toBeInstanceOf(HardLinksUnavailableError);
			expect((caught as HardLinksUnavailableError).path).toBe(target);
			expect(String((caught as Error).message).includes(".tmp")).toBe(false);
			expect(existsSync(target)).toBe(false);
			expect(folder()).toEqual([]);
		},
	);

	it("is not turned into a failure by a temp name that cannot be removed after the file was made", () => {
		fsHook.unlink = Object.assign(new Error("input/output error, unlink"), { code: "EIO" });
		writePrivateText(target, "first\n", { exclusive: true });
		expect(readFileSync(target, "utf8")).toBe("first\n");
		expect(mode(target)).toBe(0o600);
	});

	it("refuses when the target is a symlink, and neither follows nor replaces it", () => {
		const elsewhere = join(box.home, "elsewhere.json");
		writeFileSync(elsewhere, "not ours\n");
		writePrivateText(join(dirname(target), "other.json"), "x\n");
		symlinkSync(elsewhere, target);
		expect(() => writePrivateText(target, "new\n", { exclusive: true })).toThrow(PrivateFileExistsError);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readFileSync(elsewhere, "utf8")).toBe("not ours\n");
	});

	it("refuses when the target is a symlink to nothing, and does not create what it points to", () => {
		const elsewhere = join(box.home, "nothing-here.json");
		writePrivateText(join(dirname(target), "other.json"), "x\n");
		symlinkSync(elsewhere, target);
		expect(() => writePrivateText(target, "new\n", { exclusive: true })).toThrow(PrivateFileExistsError);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(existsSync(elsewhere)).toBe(false);
		expect(folder()).toEqual(["other.json", "secret.json"]);
	});
});

describe("an exclusive private write, step by step", () => {
	/** Looks at the target before every file system call the write makes; a target that is there must hold the whole text. */
	function watch(expected: string): { calls: string[]; incomplete: string[] } {
		const seen = { calls: [] as string[], incomplete: [] as string[] };
		fsHook.before = (call) => {
			seen.calls.push(call);
			if (!actualFs.existsSync(target)) {
				return;
			}
			if (actualFs.readFileSync(target, "utf8") !== expected) {
				seen.incomplete.push(call);
			}
		};
		return seen;
	}

	it("never shows a target that is not complete: it is absent, then whole", () => {
		const text = `${"x".repeat(300_000)}\n`;
		const seen = watch(text);
		writePrivateText(target, text, { exclusive: true });
		fsHook.before = undefined;
		expect(seen.calls).toContain("linkSync");
		expect(seen.incomplete).toEqual([]);
		expect(readFileSync(target, "utf8") === text).toBe(true);
	});

	it("leaves the file that is there whole at every step of a refusal", () => {
		const old = `${"o".repeat(300_000)}\n`;
		writePrivateText(target, old);
		const seen = watch(old);
		expect(() => writePrivateText(target, `${"n".repeat(300_000)}\n`, { exclusive: true })).toThrow(PrivateFileExistsError);
		fsHook.before = undefined;
		expect(seen.calls).toContain("linkSync");
		expect(seen.incomplete).toEqual([]);
		expect(readFileSync(target, "utf8") === old).toBe(true);
	});
});

describe("a private write that is not exclusive", () => {
	it("still replaces what is there, privately", () => {
		writePrivateText(target, "old\n");
		writeFileSync(target, "old\n", { mode: 0o644 });
		writePrivateText(target, "new\n");
		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(mode(target)).toBe(0o600);
		expect(folder()).toEqual(["secret.json"]);
	});

	it("does not use the link step, so a file system without hard links is not affected", () => {
		fsHook.link = Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
		writePrivateText(target, "first\n");
		writePrivateText(target, "second\n");
		expect(readFileSync(target, "utf8")).toBe("second\n");
	});
});
