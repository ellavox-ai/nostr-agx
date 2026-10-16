import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { vi } from "vitest";
import { runCli } from "../program.js";
import { setRuntimeForTests } from "../lib/runtime.js";

/**
 * A fresh AGX_HOME under the OS temp dir, and a clean AGX_* environment, for
 * one test. `restore()` puts the environment back and deletes the directory.
 */
export function sandbox(): { home: string; restore: () => void } {
	const saved = { ...process.env };
	const home = mkdtempSync(join(tmpdir(), "agx-test-"));
	if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) {
		throw new Error(`refusing to use ${home} as AGX_HOME`);
	}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("AGX_")) {
			delete process.env[key];
		}
	}
	process.env.AGX_HOME = home;
	process.env.AGX_NO_BROWSER = "1";
	return {
		home,
		restore: () => {
			for (const key of Object.keys(process.env)) {
				if (!(key in saved)) {
					delete process.env[key];
				}
			}
			Object.assign(process.env, saved);
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/**
 * A controllable clock shared by the CLI's runtime and the mock server:
 * `sleep(ms)` advances it by `ms` and yields to the event loop for
 * `realDelayMs` of real time (so real I/O, such as the mock server answering,
 * still happens), and every sleep is recorded for assertions.
 */
export function fakeClock(
	start = Date.parse("2026-09-30T18:00:00.000Z"),
	realDelayMs = 2,
) {
	let now = start;
	const sleeps: number[] = [];
	const clock = {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		sleeps,
		sleep: async (ms: number, signal?: AbortSignal) => {
			if (signal?.aborted) {
				throw signal.reason;
			}
			sleeps.push(ms);
			now += ms;
			await new Promise((r) => setTimeout(r, realDelayMs));
		},
	};
	return clock;
}

/** Install `clock` as the CLI runtime; returns the restore function. */
export function useClock(clock: ReturnType<typeof fakeClock>): () => void {
	return setRuntimeForTests({ now: clock.now, sleep: clock.sleep });
}

export interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Capture everything the CLI prints while `fn` runs: `console.log/error`
 * (every agx output helper) and `process.stdout/stderr.write` (commander).
 */
export async function capture<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const spies = [
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(`${args.map(String).join(" ")}\n`);
		}),
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			err.push(`${args.map(String).join(" ")}\n`);
		}),
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write),
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			err.push(String(chunk));
			return true;
		}) as typeof process.stderr.write),
	];
	try {
		const value = await fn();
		return { value, stdout: out.join(""), stderr: err.join("") };
	} finally {
		for (const spy of spies) {
			spy.mockRestore();
		}
	}
}

/** Run the real `agx` program in-process. */
export async function agx(...args: string[]): Promise<CliRun> {
	const { value, stdout, stderr } = await capture(() => runCli(args));
	return { code: value, stdout, stderr };
}

/** Every JSON object printed on its own line(s) of `text`. */
export function jsonDocuments(text: string): unknown[] {
	const docs: unknown[] = [];
	let buffer = "";
	for (const line of text.split("\n")) {
		if (!buffer && !line.trim().startsWith("{") && !line.trim().startsWith("[")) {
			continue;
		}
		buffer += `${line}\n`;
		try {
			docs.push(JSON.parse(buffer));
			buffer = "";
		} catch {
			// keep accumulating a pretty-printed document
		}
	}
	return docs;
}
