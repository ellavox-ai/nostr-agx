import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { configPath } from "../lib/paths.js";

/**
 * Limits for tests that wait for something that normally takes milliseconds: a helper process to
 * start, or a lock to be handed over. Each call returns the moment it has what it waits for, so a
 * long limit costs nothing on an idle machine and only keeps a heavily loaded one from giving up
 * early. The default test timeout (5 s) is shorter than these, so a test that waits this way passes
 * `PATIENT_TEST_MS` as its own timeout.
 */
export const HELPER_START_MS = 20_000;
export const PATIENT_WAIT_MS = 20_000;
export const PATIENT_TEST_MS = 60_000;

/** The lock file sits next to config.json; written out here so a test does not depend on the lock module. */
export const configLockFile = (): string => `${configPath()}.lock`;

export interface HeldConfigLock {
	child: ChildProcess;
	/** Resolves on exit: true when a second writer was seen waiting and the change was made, false if the helper gave up. */
	sawWaiter: Promise<boolean>;
}

/**
 * Another agx process that holds the lock `lock` until a second writer is waiting for it, then
 * runs `mutation` on the parsed JSON file `target` (the variable `c`), writes it back and lets go.
 * With no `mutation` it only lets go. Resolves once the lock is held.
 *
 * A writer that waits has already made any read it did before asking for the lock, so what it
 * writes next is built from a copy that this change makes out of date. No timer decides the order,
 * so it comes out the same on an idle and on a heavily loaded machine.
 */
export async function holdLockUntilSomeoneWaits(lock: string, target: string, mutation?: string): Promise<HeldConfigLock> {
	const script = [
		'const fs = require("fs"), os = require("os"), path = require("path");',
		"const [lock, config] = process.argv.slice(1);",
		"const dir = path.dirname(lock), prefix = path.basename(lock) + '.';",
		'fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "other-writer" }) + "\\n");',
		// A waiting writer leaves a temp file named <lock>.<pid>.<token>; the breaker file has no pid in its name.
		"const waiting = () => fs.readdirSync(dir).some((n) => n.startsWith(prefix) && /^[0-9]+[.]/.test(n.slice(prefix.length)));",
		"const finish = (sawWaiter) => {",
		`  if (sawWaiter && ${JSON.stringify(Boolean(mutation))}) {`,
		'    const c = JSON.parse(fs.readFileSync(config, "utf8"));',
		`    ${mutation ?? ""}`,
		"    fs.writeFileSync(config, JSON.stringify(c));",
		"  }",
		"  fs.rmSync(lock);",
		"  process.exit(sawWaiter ? 0 : 3);",
		"};",
		`const giveUpAt = Date.now() + ${HELPER_START_MS};`,
		"const timer = setInterval(() => {",
		"  if (waiting()) { clearInterval(timer); finish(true); }",
		"  else if (Date.now() > giveUpAt) { clearInterval(timer); finish(false); }",
		"}, 5);",
	].join("\n");
	const child = spawn(process.execPath, ["-e", script, lock, target], { stdio: "ignore" });
	const sawWaiter = new Promise<boolean>((resolve) => {
		child.once("exit", (code) => resolve(code === 0));
	});
	const deadline = Date.now() + HELPER_START_MS;
	while (!existsSync(lock)) {
		if (Date.now() > deadline) {
			child.kill("SIGKILL");
			throw new Error("the helper process never took the lock");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return { child, sawWaiter };
}

/** The same, for the lock around config.json. */
export function holdConfigLockUntilSomeoneWaits(mutation?: string): Promise<HeldConfigLock> {
	return holdLockUntilSomeoneWaits(configLockFile(), configPath(), mutation);
}
