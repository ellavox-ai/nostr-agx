import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bundledBinaryPath, ensureExecutable, startBundledTailscale } from "./launcher";

const posix = process.platform !== "win32";
const supportedPlatforms = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64",
]);
const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "agx-tailscale.exe" : "agx-tailscale";
const hasBundledBinary =
	posix &&
	supportedPlatforms.has(platform) &&
	existsSync(fileURLToPath(new URL(`../bin/${platform}/${binaryName}`, import.meta.url)));

async function fakeBinary(source: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(path, source, { mode: 0o755 });
	await chmod(path, 0o755);
	return { dir, path };
}

/** A launcher that reports a proxy and then waits for stdin to close, like the real one. */
const RUNNING = "echo socks5://agx:secret@127.0.0.1:43220\nexec cat >/dev/null\n";

/**
 * Reports a proxy, then ends the way `ending` says once the file `trigger`
 * exists, or once the process that started it is gone. `<trigger>.gone` is
 * written just before it ends.
 */
function endingTail(trigger: string, ending: string): string {
	return (
		"echo socks5://agx:secret@127.0.0.1:43230\n" +
		"p=$PPID\n" +
		`while [ ! -e ${JSON.stringify(trigger)} ] && kill -0 $p 2>/dev/null; do sleep 0.05; done\n` +
		`: > ${JSON.stringify(`${trigger}.gone`)}\n` +
		`${ending}\n`
	);
}

/** Fail with `what` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Wait until `condition` holds, or fail after `timeoutMs`. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * A fake launcher that writes its arguments to `<dir>/args.<pid>`, then runs
 * `tail`. One file per launch, so two launches from one binary stay apart.
 */
async function recordingBinary(tail: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-args-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(dir)}/args.$$\n${tail}`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path };
}

/** The arguments of each launch a recording binary saw. */
async function recordedLaunches(dir: string): Promise<string[][]> {
	const names = (await readdir(dir)).filter((name) => name.startsWith("args.")).sort();
	return Promise.all(
		names.map(async (name) =>
			(await readFile(join(dir, name), "utf8")).split("\n").filter(Boolean),
		),
	);
}

/** The arguments of the one launch a recording binary saw, once it has written them. */
async function firstLaunch(dir: string): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const [launch] = await recordedLaunches(dir);
		if (launch) return launch;
		if (Date.now() > deadline) throw new Error("the launcher never recorded its arguments");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function stateDirArg(args: string[]): string {
	const flag = args.indexOf("--state-dir");
	expect(flag, `no --state-dir in ${JSON.stringify(args)}`).toBeGreaterThanOrEqual(0);
	return args[flag + 1]!;
}

describe("bundledBinaryPath", () => {
	it.skipIf(!hasBundledBinary)("resolves the binary for the current platform", () => {
		const binary = bundledBinaryPath();
		expect(binary).toContain(join("bin", platform));
		expect(binary).toMatch(/agx-tailscale(\.exe)?$/);
	});
});

describe("ensureExecutable", () => {
	it.skipIf(!posix)("restores the executable bit a packed launcher lost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		try {
			const path = join(dir, "agx-tailscale");
			await writeFile(path, "#!/bin/sh\n", { mode: 0o644 });
			await chmod(path, 0o644);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o755);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("leaves an executable launcher as it is", async () => {
		const { dir, path } = await fakeBinary("#!/bin/sh\n");
		try {
			await chmod(path, 0o700);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o700);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("startBundledTailscale", () => {
	it.skipIf(!posix)("starts a child and reports its authenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://agx:secret@127.0.0.1:43210\nexec cat >/dev/null\n",
		);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			expect(proxy).toMatchObject({
				url: "socks5://agx:secret@127.0.0.1:43210",
				address: "127.0.0.1:43210",
				host: "127.0.0.1",
				port: 43210,
			});
			await proxy.stop();
			await proxy.stop();
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes the auth key through the environment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		const keyFile = join(dir, "key.txt");
		const fake = await fakeBinary(
			'#!/bin/sh\nprintf "%s" "$TS_AUTHKEY" > ' + JSON.stringify(keyFile) +
				"\necho socks5://agx:secret@127.0.0.1:43211\nexec cat >/dev/null\n",
		);
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-test-value");
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not pass the parent environment to the launcher", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-env-test-"));
		const marker = join(dir, "parent-env-marker");
		const fake = await fakeBinary(
			`#!/bin/sh\nprintf '%s' "$AGX_TEST_PARENT_SECRET" > ${JSON.stringify(marker)}\necho socks5://agx:secret@127.0.0.1:43213\nexec cat >/dev/null\n`,
		);
		const previous = process.env.AGX_TEST_PARENT_SECRET;
		process.env.AGX_TEST_PARENT_SECRET = "parent-secret";
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(marker, "utf8")).toBe("");
		} finally {
			if (previous === undefined) delete process.env.AGX_TEST_PARENT_SECRET;
			else process.env.AGX_TEST_PARENT_SECRET = previous;
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("rejects an unauthenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://127.0.0.1:43212\nexec cat >/dev/null\n",
		);
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/unauthenticated SOCKS5/);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty auth key", async () => {
		await expect(startBundledTailscale({ authKey: "" })).rejects.toThrow(
			/authKey must not be empty/,
		);
	});
});

describe("the default state directory", () => {
	it.skipIf(!posix)(
		"gives two handles started with defaults different state directories",
		async () => {
			const fake = await recordingBinary(RUNNING);
			const proxies: Awaited<ReturnType<typeof startBundledTailscale>>[] = [];
			try {
				proxies.push(await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }));
				proxies.push(await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }));
				const dirs = (await recordedLaunches(fake.dir)).map(stateDirArg);
				expect(dirs).toHaveLength(2);
				expect(new Set(dirs).size).toBe(2);
				for (const dir of dirs) {
					expect(dir.startsWith(tmpdir())).toBe(true);
				}
			} finally {
				for (const proxy of proxies) await proxy.stop();
				await rm(fake.dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!posix)("is private while the handle runs and deleted when it stops", async () => {
		const fake = await recordingBinary(RUNNING);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			const dir = stateDirArg(await firstLaunch(fake.dir));
			expect(existsSync(dir)).toBe(true);
			expect((await stat(dir)).mode & 0o777).toBe(0o700);

			await proxy.stop();
			expect(existsSync(dir)).toBe(false);
			await proxy.stop();
		} finally {
			await proxy.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher exits before it reports an address", async () => {
		const fake = await recordingBinary("exit 3\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/exited before reporting/);
			expect(existsSync(stateDirArg(await firstLaunch(fake.dir)))).toBe(false);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher does not report an address in time", async () => {
		const fake = await recordingBinary("exec cat >/dev/null\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 1_000 }),
			).rejects.toThrow(/did not report/);
			const dir = stateDirArg(await firstLaunch(fake.dir));
			// The launcher is told to stop, and the directory goes once it has.
			await until(() => !existsSync(dir));
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher reports an unauthenticated address", async () => {
		const fake = await recordingBinary("echo socks5://127.0.0.1:43221\nexec cat >/dev/null\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/unauthenticated SOCKS5/);
			const dir = stateDirArg(await firstLaunch(fake.dir));
			await until(() => !existsSync(dir));
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher cannot be started", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-tmpdir-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			await expect(
				startBundledTailscale({ binary: join(scratch, "no-such-launcher"), timeoutMs: 5_000 }),
			).rejects.toThrow(/could not start/);
			expect(await readdir(scratch)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher process cannot even be created", async () => {
		const fake = await recordingBinary(RUNNING);
		const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-tmpdir-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			// A NUL byte in an argument makes spawn() itself throw.
			await expect(
				startBundledTailscale({
					binary: fake.path,
					hostname: `bad${String.fromCharCode(0)}name`,
					timeoutMs: 5_000,
				}),
			).rejects.toThrow();
			expect(await readdir(scratch)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await rm(fake.dir, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes a directory the caller names through, and keeps it", async () => {
		const fake = await recordingBinary(RUNNING);
		const named = await mkdtemp(join(tmpdir(), "agx-launcher-named-state-"));
		try {
			const proxy = await startBundledTailscale({
				binary: fake.path,
				stateDir: named,
				timeoutMs: 5_000,
			});
			expect(stateDirArg(await firstLaunch(fake.dir))).toBe(named);
			await proxy.stop();
			expect(existsSync(named)).toBe(true);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
			await rm(named, { recursive: true, force: true });
		}
	});
});

/** The package folder (where `tsx` is installed) and the launcher source a child process loads. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER_SOURCE = fileURLToPath(new URL("./launcher.ts", import.meta.url));

/**
 * A stand-in launcher that writes a file into its `--state-dir` (as the real one
 * writes the node's keys), reports a proxy, and ends when its stdin closes.
 */
async function stateWritingBinary(
	options: { locked?: boolean } = {},
): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-writer-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!${process.execPath}\n` +
			`const args = process.argv.slice(2);\n` +
			`const dir = args[args.indexOf("--state-dir") + 1];\n` +
			`require("fs").writeFileSync(require("path").join(dir, "tailscaled.state"), "stand-in state, not a key\\n");\n` +
			// A folder that cannot be emptied: removing the state directory fails until
			// the host gives it back its permissions.
			(options.locked
				? `const locked = require("path").join(dir, "locked");\n` +
					`require("fs").mkdirSync(locked);\n` +
					`require("fs").writeFileSync(require("path").join(locked, "inner"), "x");\n` +
					`require("fs").chmodSync(locked, 0o500);\n`
				: "") +
			`console.log("socks5://agx:secret@127.0.0.1:43240");\n` +
			`process.stdin.resume();\n` +
			`process.stdin.on("end", () => process.exit(0));\n`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path };
}

/** What a host process that started a launcher leaves in its temporary folder. */
interface EndedHost {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Folders named like a launcher's own state directory. */
	leftover: string[];
	scratch: string;
	stdout: string;
}

/**
 * Run a small host process (loaded with `tsx`) that starts the launcher with
 * `options` and ends the way `ending` says: "exit" calls process.exit(), "throw"
 * lets an exception go uncaught, "reject" lets a rejection go unhandled, "stop"
 * awaits stop() first; any other ending waits to be sent `signal`. The host's
 * temporary folder is a scratch folder, so what it leaves behind can be listed.
 */
async function endHost(
	ending: "exit" | "throw" | "reject" | "stop" | "locked" | "signal",
	options: { stateDir?: string; signal?: NodeJS.Signals } = {},
): Promise<EndedHost> {
	const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-host-"));
	const writer = await stateWritingBinary({ locked: ending === "locked" });
	const script = join(writer.dir, "host.mts");
	await writeFile(
		script,
		`import { startBundledTailscale } from ${JSON.stringify(LAUNCHER_SOURCE)};\n` +
			`const [ending, binary, stateDir] = process.argv.slice(2);\n` +
			`const proxy = await startBundledTailscale({ binary, stateDir: stateDir || undefined, timeoutMs: 20_000 });\n` +
			`process.stdout.write("READY\\n");\n` +
			`if (ending === "exit") process.exit(0);\n` +
			`else if (ending === "throw") setTimeout(() => { throw new Error("host failed"); }, 0);\n` +
			`else if (ending === "reject") void Promise.reject(new Error("host failed"));\n` +
			`else if (ending === "stop") { await proxy.stop(); process.exit(0); }\n` +
			// stop() could not remove the directory. Then the host restores its permissions and ends.
			`else if (ending === "locked") {\n` +
			`  await proxy.stop();\n` +
			`  const { readdirSync, chmodSync } = await import("node:fs");\n` +
			`  const { join } = await import("node:path");\n` +
			`  const dirs = readdirSync(process.env.TMPDIR).filter((n) => n.startsWith("agx-tailscale-"));\n` +
			`  await new Promise((resolve) => process.stdout.write("AFTER_STOP " + dirs.length + "\\n", resolve));\n` +
			`  for (const n of dirs) chmodSync(join(process.env.TMPDIR, n, "locked"), 0o700);\n` +
			`  process.exit(0);\n` +
			`}\n` +
			`else setInterval(() => {}, 1_000);\n`,
	);
	const host = spawn(
		process.execPath,
		["--import", "tsx", script, ending, writer.path, options.stateDir ?? ""],
		{ cwd: PACKAGE_ROOT, env: { ...process.env, TMPDIR: scratch }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	host.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	host.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		host.once("close", (code, signal) => resolve({ code, signal })),
	);
	try {
		if (ending === "signal") {
			await within(
				(async () => {
					await until(() => stdout.includes("READY") || host.exitCode !== null, 20_000);
					if (!stdout.includes("READY")) throw new Error(`host never got ready: ${stderr}`);
				})(),
				"the host process",
				25_000,
			);
			host.kill(options.signal ?? "SIGTERM");
		}
		const result = await within(closed, "the host process ending", 25_000);
		if (ending !== "signal" && !stdout.includes("READY")) {
			throw new Error(`host never got ready: ${stderr}`);
		}
		const leftover = (await readdir(scratch)).filter((name) => name.startsWith("agx-tailscale-"));
		return { ...result, leftover, scratch, stdout };
	} finally {
		if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
		await rm(writer.dir, { recursive: true, force: true });
	}
}

describe("the default state directory when the whole process ends", () => {
	// What the directory holds is the node's private keys, so it is only ever
	// the launcher's own, and these endings are the ones a host can end in.
	it.skipIf(!posix).each([
		["calls process.exit()", "exit"],
		["lets an exception go uncaught", "throw"],
		["lets a promise rejection go unhandled", "reject"],
	] as const)("is deleted when the host %s", async (_what, ending) => {
		const ended = await endHost(ending);
		try {
			expect(ended.leftover, `left behind in ${ended.scratch}`).toEqual([]);
		} finally {
			await rm(ended.scratch, { recursive: true, force: true });
		}
	}, 60_000);

	it.skipIf(!posix)("is deleted when the host awaits stop() and then ends", async () => {
		const ended = await endHost("stop");
		try {
			expect(ended.code).toBe(0);
			expect(ended.leftover).toEqual([]);
		} finally {
			await rm(ended.scratch, { recursive: true, force: true });
		}
	}, 60_000);

	// Signals with no handler end a process without running its exit listeners,
	// and nothing can run after SIGKILL. A host that wants the directory removed
	// there handles the signal itself and calls stop() (or process.exit()).
	it.skipIf(!posix).each(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as const)(
		"is left behind, private, when the host is ended by %s with no handler",
		async (signal) => {
			const ended = await endHost("signal", { signal });
			try {
				expect(ended.signal).toBe(signal);
				expect(ended.leftover).toHaveLength(1);
				const dir = join(ended.scratch, ended.leftover[0]!);
				expect((await stat(dir)).mode & 0o777).toBe(0o700);
				expect(existsSync(join(dir, "tailscaled.state"))).toBe(true);
			} finally {
				await rm(ended.scratch, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it.skipIf(!posix)("is deleted at exit when stop() could not delete it", async () => {
		// The directory has a folder that cannot be emptied, so the removal in stop()
		// fails. The host then gives the folder its permissions back and ends: the exit
		// listener must still know about the directory.
		const ended = await endHost("locked");
		try {
			expect(ended.stdout).toContain("AFTER_STOP 1\n");
			expect(ended.code).toBe(0);
			expect(ended.leftover, `left behind in ${ended.scratch}`).toEqual([]);
		} finally {
			await rm(ended.scratch, { recursive: true, force: true });
		}
	}, 60_000);

	it.skipIf(!posix)("never deletes a directory the caller named, when the host ends", async () => {
		const named = await mkdtemp(join(tmpdir(), "agx-launcher-named-state-"));
		let ended: EndedHost | undefined;
		try {
			ended = await endHost("exit", { stateDir: named });
			expect(ended.leftover).toEqual([]);
			expect(existsSync(join(named, "tailscaled.state"))).toBe(true);
		} finally {
			if (ended) await rm(ended.scratch, { recursive: true, force: true });
			await rm(named, { recursive: true, force: true });
		}
	}, 60_000);

	it.skipIf(!posix)(
		"registers one exit listener however many handles run, and drops it with the last one",
		async () => {
			const fake = await recordingBinary(RUNNING);
			const named = await mkdtemp(join(tmpdir(), "agx-launcher-named-state-"));
			const before = process.listenerCount("exit");
			const proxies: Awaited<ReturnType<typeof startBundledTailscale>>[] = [];
			try {
				// A directory the caller names is never this module's to remove.
				const kept = await startBundledTailscale({
					binary: fake.path,
					stateDir: named,
					timeoutMs: 5_000,
				});
				expect(process.listenerCount("exit")).toBe(before);
				await kept.stop();

				for (let i = 0; i < 4; i++) {
					proxies.push(await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }));
				}
				expect(process.listenerCount("exit")).toBe(before + 1);
				await proxies[0]!.stop();
				await proxies[1]!.stop();
				expect(process.listenerCount("exit")).toBe(before + 1);
				await proxies[2]!.stop();
				await proxies[3]!.stop();
				expect(process.listenerCount("exit")).toBe(before);

				// A start that fails leaves no listener behind either.
				const failing = await recordingBinary("exit 3\n");
				try {
					await expect(
						startBundledTailscale({ binary: failing.path, timeoutMs: 5_000 }),
					).rejects.toThrow(/exited before reporting/);
					expect(process.listenerCount("exit")).toBe(before);
				} finally {
					await rm(failing.dir, { recursive: true, force: true });
				}
			} finally {
				for (const proxy of proxies) await proxy.stop();
				await rm(fake.dir, { recursive: true, force: true });
				await rm(named, { recursive: true, force: true });
			}
		},
	);
});

describe("a stand-in that waits for a trigger file", () => {
	it.skipIf(!posix)("leaves when the process that started it is gone", async () => {
		// A short-lived parent starts the stand-in and ends at once, as a host that
		// was killed would; nothing ever creates the trigger file.
		const trigger = join(tmpdir(), `agx-launcher-no-trigger-${process.pid}`);
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let pid = 0;
		try {
			const parent = spawn(
				process.execPath,
				[
					"-e",
					`const c = require("node:child_process").spawn(${JSON.stringify(fake.path)}, [], { stdio: "ignore" }); console.log(c.pid); c.unref();`,
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			let printed = "";
			parent.stdout.on("data", (chunk: Buffer) => {
				printed += chunk.toString();
			});
			await new Promise((resolve) => parent.on("close", resolve));
			pid = Number(printed.trim());
			expect(pid).toBeGreaterThan(1);
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "EPERM";
				}
			};
			let gone = false;
			try {
				await until(() => !alive(), 5_000);
				gone = true;
			} catch {
				// still running: reported below
			}
			expect(gone, `the stand-in (pid ${pid}) was still running 5 s after its parent ended`).toBe(true);
		} finally {
			if (pid > 1) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			await rm(fake.dir, { recursive: true, force: true });
			// The stand-in writes this file just before it ends; it is outside `fake.dir`.
			await rm(`${trigger}.gone`, { force: true });
		}
	}, 20_000);
});

describe("the exit notice", () => {
	it.skipIf(!posix)("gives a listener the exit code when the launcher exits on its own", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const exit = new Promise<unknown>((resolve) => proxy?.onExit(resolve));
			await writeFile(trigger, "");
			expect(await within(exit, "the exit notice")).toEqual({ code: 7, signal: null });
			// The handle is still safe to stop afterwards.
			await proxy.stop();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("gives a listener the signal when the launcher is killed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "kill -KILL $$"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const exit = new Promise<unknown>((resolve) => proxy?.onExit(resolve));
			await writeFile(trigger, "");
			expect(await within(exit, "the exit notice")).toEqual({ code: null, signal: "SIGKILL" });
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("tells a listener that subscribes after the launcher already ended", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 9"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			await writeFile(trigger, "");
			await until(() => existsSync(`${trigger}.gone`));
			await new Promise((resolve) => setTimeout(resolve, 500));
			const exit = new Promise<unknown>((resolve) => proxy?.onExit(resolve));
			expect(await within(exit, "the exit notice")).toEqual({ code: 9, signal: null });
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not call a listener that was removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const removed = vi.fn();
			const off = proxy.onExit(removed);
			const kept = new Promise<unknown>((resolve) => proxy?.onExit(resolve));
			off();
			await writeFile(trigger, "");
			// The second listener was added after the first, so it has been called by
			// the time this resolves; the first never is.
			await within(kept, "the exit notice");
			expect(removed).not.toHaveBeenCalled();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is not given when stop() ended the launcher", async () => {
		const fake = await fakeBinary("#!/bin/sh\n" + RUNNING);
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const listener = vi.fn();
			proxy.onExit(listener);
			await proxy.stop();
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(listener).not.toHaveBeenCalled();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("comes after the launcher's own state directory has been deleted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await recordingBinary(endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const stateDir = stateDirArg(await firstLaunch(fake.dir));
			const seenByListener = new Promise<boolean>((resolve) =>
				proxy?.onExit(() => resolve(existsSync(stateDir))),
			);
			expect(existsSync(stateDir)).toBe(true);
			await writeFile(trigger, "");
			expect(await within(seenByListener, "the exit notice")).toBe(false);
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("calls each listener exactly once, also after stop() and for a late subscriber", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const first = vi.fn();
			const second = vi.fn();
			proxy.onExit(first);
			proxy.onExit(second);
			await writeFile(trigger, "");
			await until(() => first.mock.calls.length > 0 && second.mock.calls.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await proxy.stop();
			const late = vi.fn();
			proxy.onExit(late);
			await until(() => late.mock.calls.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			for (const listener of [first, second, late]) {
				expect(listener).toHaveBeenCalledTimes(1);
				expect(listener).toHaveBeenCalledWith({ code: 7, signal: null });
			}
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	describe("when a listener throws", () => {
		type Proxy = Awaited<ReturnType<typeof startBundledTailscale>>;

		/** What the handle kept of the errors its listeners threw. */
		function listenerErrorsOf(proxy: Proxy): readonly unknown[] {
			return (proxy as unknown as { listenerErrors?: readonly unknown[] }).listenerErrors ?? [];
		}

		/** Run `body` with a launcher that ends (code 7) once told to, and uncaught exceptions collected. */
		async function withEndingLauncher(
			body: (
				proxy: Proxy,
				end: () => Promise<void>,
				uncaught: unknown[],
				warnings: (Error & { code?: string })[],
			) => Promise<void>,
		): Promise<void> {
			const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
			const trigger = join(dir, "go");
			const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
			const uncaught: unknown[] = [];
			const warnings: (Error & { code?: string })[] = [];
			const onUncaught = (error: unknown): void => {
				uncaught.push(error);
			};
			const onWarning = (warning: Error & { code?: string }): void => {
				warnings.push(warning);
			};
			process.on("uncaughtException", onUncaught);
			process.on("warning", onWarning);
			let proxy: Proxy | undefined;
			try {
				proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				await body(proxy, () => writeFile(trigger, ""), uncaught, warnings);
			} finally {
				await proxy?.stop();
				process.off("uncaughtException", onUncaught);
				process.off("warning", onWarning);
				await rm(fake.dir, { recursive: true, force: true });
				await rm(dir, { recursive: true, force: true });
			}
		}

		it.skipIf(!posix)("still calls the listeners after it, and does not end the host", async () => {
			await withEndingLauncher(async (proxy, end, uncaught) => {
				const later = vi.fn();
				proxy.onExit(() => {
					throw new Error("listener failed");
				});
				proxy.onExit(later);
				await end();
				await until(() => later.mock.calls.length > 0);
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(later).toHaveBeenCalledTimes(1);
				expect(later).toHaveBeenCalledWith({ code: 7, signal: null });
				expect(uncaught).toEqual([]);
			});
		});

		it.skipIf(!posix)("keeps the error on the handle and reports it as a process warning", async () => {
			await withEndingLauncher(async (proxy, end, _uncaught, warnings) => {
				proxy.onExit(() => {
					throw new Error("listener failed");
				});
				await end();
				await until(() => listenerErrorsOf(proxy).length === 1);
				expect((listenerErrorsOf(proxy)[0] as Error).message).toBe("listener failed");
				await until(() => warnings.some((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER"));
				const warning = warnings.find((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER")!;
				expect(warning.message).toContain("listener failed");
			});
		});

		// Whatever a listener throws, describing it must not throw too.
		it.skipIf(!posix).each([
			[
				"an object with no prototype",
				() => {
					throw Object.create(null);
				},
			],
			[
				"an error whose message cannot be read",
				() => {
					const error = new Error("hidden");
					Object.defineProperty(error, "message", {
						get() {
							throw new Error("message getter failed");
						},
					});
					throw error;
				},
			],
			[
				"a value that cannot be turned into text",
				() => {
					throw { toString: () => { throw new Error("toString failed"); } };
				},
			],
			[
				"a string",
				() => {
					throw "plain text";
				},
			],
			[
				"nothing",
				() => {
					throw undefined;
				},
			],
		] as const)("keeps going when a listener throws %s", async (_what, thrower) => {
			await withEndingLauncher(async (proxy, end, uncaught, warnings) => {
				const later = vi.fn();
				proxy.onExit(thrower);
				proxy.onExit(later);
				await end();
				await until(() => later.mock.calls.length > 0);
				await until(() => listenerErrorsOf(proxy).length === 1);
				await until(() => warnings.some((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER"));
				expect(later).toHaveBeenCalledTimes(1);
				expect(uncaught).toEqual([]);
			});
		});

		it.skipIf(!posix)("cuts a very long message in the warning to 500 characters", async () => {
			await withEndingLauncher(async (proxy, end, uncaught, warnings) => {
				proxy.onExit(() => {
					throw new Error("m".repeat(100_000));
				});
				await end();
				await until(() => warnings.some((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER"));
				const warning = warnings.find((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER")!;
				expect(warning.message).toBe(`An onExit listener threw: ${"m".repeat(500)}`);
				expect(uncaught).toEqual([]);
			});
		});

		it.skipIf(!posix)("does not print a login that is in the thrown error", async () => {
			await withEndingLauncher(async (proxy, end, uncaught, warnings) => {
				const later = vi.fn();
				proxy.onExit(() => {
					throw new Error("hook failed for http://huser:hpass-throwaway@proxy.invalid:3128");
				});
				proxy.onExit(later);
				await end();
				await until(() => warnings.some((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER"));
				const warning = warnings.find((w) => w.code === "AGX_TAILSCALE_ONEXIT_LISTENER")!;
				expect(warning.message).toBe(
					"An onExit listener threw: hook failed for http://***@proxy.invalid:3128",
				);
				expect(later).toHaveBeenCalledTimes(1);
				expect(uncaught).toEqual([]);
			});
		});

		it.skipIf(!posix)("treats a listener that subscribes after the launcher ended the same way", async () => {
			await withEndingLauncher(async (proxy, end, uncaught) => {
				await end();
				// Give the launcher time to end before anyone subscribes.
				await new Promise((resolve) => setTimeout(resolve, 600));
				const later = vi.fn();
				proxy.onExit(() => {
					throw new Error("late listener failed");
				});
				proxy.onExit(later);
				await until(() => later.mock.calls.length > 0);
				await until(() => listenerErrorsOf(proxy).length === 1);
				expect(later).toHaveBeenCalledTimes(1);
				expect(uncaught).toEqual([]);
			});
		});
	});
});

/**
 * A fake launcher written in JavaScript (a shell would add variables of its
 * own) that saves the environment it was started with, then reports a proxy.
 */
async function envDumpingBinary(): Promise<{ dir: string; path: string; envFile: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-envdump-"));
	const path = join(dir, "fake-agx-tailscale");
	const envFile = join(dir, "env.json");
	await writeFile(
		path,
		`#!${process.execPath}\n` +
			`require("fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\n` +
			'console.log("socks5://agx:secret@127.0.0.1:43240");\n' +
			"process.stdin.resume();\n",
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path, envFile };
}

/** The environment a launcher saw, minus the one variable macOS adds to every process. */
async function savedEnv(envFile: string): Promise<Record<string, string>> {
	await until(() => existsSync(envFile));
	const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
	delete env.__CF_USER_TEXT_ENCODING;
	return env;
}

/** Run `fn` with these variables set in (or, for undefined, removed from) this process. */
async function withParentEnv<T>(
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

const PASSED_THROUGH = [
	"USERPROFILE",
	"SystemRoot",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"TS_NO_LOGS_NO_SUPPORT",
] as const;

describe("the launcher's environment", () => {
	it.skipIf(!posix)("passes the allowlisted variables that are set, and nothing else", async () => {
		const fake = await envDumpingBinary();
		const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-tmpdir-"));
		const parent: Record<string, string> = {
			USERPROFILE: "/throwaway/userprofile",
			SystemRoot: "/throwaway/systemroot",
			TMPDIR: scratch,
			HTTP_PROXY: "http://upper-http.invalid:3128",
			HTTPS_PROXY: "http://upper-https.invalid:3128",
			NO_PROXY: "upper.invalid",
			http_proxy: "http://lower-http.invalid:3128",
			https_proxy: "http://lower-https.invalid:3128",
			no_proxy: "lower.invalid",
			TS_NO_LOGS_NO_SUPPORT: "true",
			// None of these may reach the launcher.
			OPENAI_API_KEY: "throwaway-not-a-real-key",
			AWS_SECRET_ACCESS_KEY: "throwaway-not-a-real-secret",
			ALL_PROXY: "socks5://other.invalid:1080",
			TS_AUTHKEY: "tskey-auth-throwaway-from-parent",
			TS_AUTH_KEY: "tskey-auth-throwaway-underscore-from-parent",
			TS_CONTROL_URL: "https://control.invalid",
			TSNET_FORCE_LOGIN: "1",
			AGX_TAILSCALE_AUTH_KEY: "throwaway-agx-key-from-parent",
		};
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			await withParentEnv(parent, async () => {
				proxy = await startBundledTailscale({
					binary: fake.path,
					authKey: "tskey-auth-test-value",
					timeoutMs: 5_000,
				});
			});
			const expected: Record<string, string> = {
				HOME: process.env.HOME!,
				TS_AUTHKEY: "tskey-auth-test-value",
			};
			for (const name of PASSED_THROUGH) expected[name] = parent[name]!;
			expect(await savedEnv(fake.envFile)).toEqual(expected);
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes only HOME and the key when none of the others are set", async () => {
		const fake = await envDumpingBinary();
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			await withParentEnv(
				{
					...Object.fromEntries(PASSED_THROUGH.map((name) => [name, undefined])),
					// Set but empty counts as not set.
					HTTPS_PROXY: "",
				},
				async () => {
					proxy = await startBundledTailscale({
						binary: fake.path,
						authKey: "tskey-auth-test-value",
						timeoutMs: 5_000,
					});
				},
			);
			expect(await savedEnv(fake.envFile)).toEqual({
				HOME: process.env.HOME!,
				TS_AUTHKEY: "tskey-auth-test-value",
			});
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not take the auth key from the parent environment", async () => {
		const fake = await envDumpingBinary();
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			await withParentEnv(
				{
					TS_AUTHKEY: "tskey-auth-throwaway-from-parent",
					// tsnet itself also reads this spelling of the variable.
					TS_AUTH_KEY: "tskey-auth-throwaway-underscore-from-parent",
					AGX_TAILSCALE_AUTH_KEY: "throwaway",
				},
				async () => {
					proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				},
			);
			const env = await savedEnv(fake.envFile);
			expect(env).not.toHaveProperty("TS_AUTHKEY");
			expect(env).not.toHaveProperty("TS_AUTH_KEY");
			expect(env).not.toHaveProperty("AGX_TAILSCALE_AUTH_KEY");
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});
});

/** Run `fn` while writes to this process's stderr are collected instead of printed. */
async function collectingStderr<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
	let written = "";
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		written += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		return true;
	}) as typeof process.stderr.write);
	try {
		const value = await fn();
		return { value, written };
	} finally {
		spy.mockRestore();
	}
}

/** The spellings Go's strconv.ParseBool, which tsnet reads this variable with, accepts. */
const BOOLEANS_TAILSCALE_ACCEPTS = [
	"1",
	"t",
	"T",
	"TRUE",
	"true",
	"True",
	"0",
	"f",
	"F",
	"FALSE",
	"false",
	"False",
] as const;

/** What the SDK says when it leaves the variable out: the name, never the value. */
const IGNORED_NOTICE =
	"@nostr-agx/tailscale: ignoring TS_NO_LOGS_NO_SUPPORT from the environment, because Tailscale does not accept its value (use true or false).\n";

describe("a TS_NO_LOGS_NO_SUPPORT value in the environment", () => {
	async function launcherSaw(
		value: string,
		options: { disableLogUpload?: boolean } = {},
	): Promise<{ env: Record<string, string>; written: string }> {
		const fake = await envDumpingBinary();
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			const { written } = await withParentEnv({ TS_NO_LOGS_NO_SUPPORT: value }, () =>
				collectingStderr(async () => {
					proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000, ...options });
				}),
			);
			return { env: await savedEnv(fake.envFile), written };
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	}

	it.skipIf(!posix).each(BOOLEANS_TAILSCALE_ACCEPTS)(
		"passes %j on, because Tailscale reads it as a boolean",
		async (value) => {
			const { env, written } = await launcherSaw(value);
			expect(env.TS_NO_LOGS_NO_SUPPORT).toBe(value);
			expect(written).toBe("");
		},
	);

	it.skipIf(!posix).each(["yes", "no", "on", "off", "2", "tRuE", " true", "true ", "enabled"])(
		"leaves %j out, because Tailscale would refuse it at start, and names only the variable",
		async (value) => {
			const { env, written } = await launcherSaw(value);
			expect(env).not.toHaveProperty("TS_NO_LOGS_NO_SUPPORT");
			expect(written).toBe(IGNORED_NOTICE);
		},
	);

	it.skipIf(!posix)("is replaced by true, without a notice, when the switch is on", async () => {
		const { env, written } = await launcherSaw("yes", { disableLogUpload: true });
		expect(env.TS_NO_LOGS_NO_SUPPORT).toBe("true");
		expect(written).toBe("");
	});

	it.skipIf(!posix)("is left out without a notice when it is set but empty", async () => {
		const { env, written } = await launcherSaw("");
		expect(env).not.toHaveProperty("TS_NO_LOGS_NO_SUPPORT");
		expect(written).toBe("");
	});
});

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/** What the SDK says when it leaves a proxy variable out: the name, never the value. */
function skippedProxyNotice(name: string): string {
	return `@nostr-agx/tailscale: not passing ${name} to the launcher, because its value holds a login (a user name and password) that the launcher would print in its log. Use a proxy address without one.\n`;
}

describe("a proxy variable that holds a login", () => {
	async function launcherSaw(
		parent: Record<string, string | undefined>,
	): Promise<{ env: Record<string, string>; written: string }> {
		const fake = await envDumpingBinary();
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			const { written } = await withParentEnv(
				{ ...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, undefined])), ...parent },
				() =>
					collectingStderr(async () => {
						proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
					}),
			);
			return { env: await savedEnv(fake.envFile), written };
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	}

	it.skipIf(!posix).each(PROXY_VARIABLES)(
		"is not passed on in %s, and the notice names the variable and not the value",
		async (name) => {
			const { env, written } = await launcherSaw({ [name]: "http://puser:ppass@proxy.invalid:3128" });
			expect(env).not.toHaveProperty(name);
			expect(written).toBe(skippedProxyNotice(name));
			expect(written).not.toContain("puser");
			expect(written).not.toContain("ppass");
		},
	);

	it.skipIf(!posix).each([
		["a user name alone", "http://puser@proxy.invalid:3128"],
		["no scheme", "puser:ppass@proxy.invalid:3128"],
		["a space in the password, which is not a valid address", "http://puser:pp ass@proxy.invalid:3128"],
		["an @ in the password", "http://puser:pp@ss@proxy.invalid:3128"],
		["a slash in the password, which is not a valid address", "http://puser:pp/ss@proxy.invalid:3128"],
		["a SOCKS address", "socks5h://puser:ppass@proxy.invalid:1080"],
	] as const)("is not passed on when it has %s", async (_what, value) => {
		const { env, written } = await launcherSaw({ HTTPS_PROXY: value });
		expect(env).not.toHaveProperty("HTTPS_PROXY");
		expect(written).toBe(skippedProxyNotice("HTTPS_PROXY"));
		expect(written).not.toContain("ppass");
		expect(written).not.toContain("pp ass");
	});

	it.skipIf(!posix)("is left out one variable at a time, and the others still go on", async () => {
		const { env, written } = await launcherSaw({
			HTTPS_PROXY: "http://puser:ppass@proxy.invalid:3128",
			https_proxy: "http://puser:ppass@proxy.invalid:3128",
			HTTP_PROXY: "http://plain.invalid:3128",
			NO_PROXY: "internal.invalid",
		});
		expect(env).not.toHaveProperty("HTTPS_PROXY");
		expect(env).not.toHaveProperty("https_proxy");
		expect(env.HTTP_PROXY).toBe("http://plain.invalid:3128");
		expect(env.NO_PROXY).toBe("internal.invalid");
		expect(written).toBe(skippedProxyNotice("HTTPS_PROXY") + skippedProxyNotice("https_proxy"));
	});

	it.skipIf(!posix)("does not stop a proxy address without a login from being passed on", async () => {
		const { env, written } = await launcherSaw({
			HTTPS_PROXY: "http://proxy.invalid:3128/path?x=1#frag",
			https_proxy: "proxy.invalid:3128",
		});
		expect(env.HTTPS_PROXY).toBe("http://proxy.invalid:3128/path?x=1#frag");
		expect(env.https_proxy).toBe("proxy.invalid:3128");
		expect(written).toBe("");
	});

	it.skipIf(!posix)("is only a concern for the proxy address, not for NO_PROXY", async () => {
		const { env, written } = await launcherSaw({ NO_PROXY: "a@b.invalid", no_proxy: "c@d.invalid" });
		expect(env.NO_PROXY).toBe("a@b.invalid");
		expect(env.no_proxy).toBe("c@d.invalid");
		expect(written).toBe("");
	});
});

/** Run `run` while writes to this process's stderr are kept in `writes` instead of printed. */
async function withStderrWrites<T>(run: (writes: string[]) => Promise<T>): Promise<T> {
	const writes: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
		return true;
	}) as typeof process.stderr.write);
	try {
		return await run(writes);
	} finally {
		spy.mockRestore();
	}
}

/**
 * A stand-in launcher that writes each of `parts` to its stderr (waiting
 * `delayMs` after it), then reports a proxy and waits for stdin to close.
 */
async function stderrWritingBinary(
	parts: [text: string, delayMs: number][],
	ending: "run" | "exit3" = "run",
): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-stderr-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!${process.execPath}\n` +
			`const parts = ${JSON.stringify(parts)};\n` +
			`(async () => {\n` +
			`  for (const [text, delayMs] of parts) {\n` +
			`    process.stderr.write(text);\n` +
			`    await new Promise((resolve) => setTimeout(resolve, delayMs));\n` +
			`  }\n` +
			(ending === "exit3"
				? `  process.exit(3);\n`
				: `  console.log("socks5://agx:secret@127.0.0.1:43250");\n` +
					`  process.stdin.resume();\n` +
					`  process.stdin.on("end", () => process.exit(0));\n`) +
			`})();\n`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path };
}

/**
 * A stand-in launcher that runs `body` (JavaScript) first, then reports a proxy
 * and waits for stdin to close.
 */
async function scriptedStderrBinary(body: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-script-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!${process.execPath}\n${body}\n` +
			`console.log("socks5://agx:secret@127.0.0.1:43260");\n` +
			`process.stdin.resume();\n` +
			`process.stdin.on("end", () => process.exit(0));\n`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path };
}

describe("what the launcher writes on its stderr", () => {
	/** The URL the launcher's own proxy logging prints, with credentials in it. */
	const PROXY_LINE =
		'2026/11/26 23:10:00 tshttpproxy: using proxy "http://puser:ppass@127.0.0.1:9" for URL: "https://controlplane.tailscale.com/key?v=130"\n';
	const PROXY_LINE_MASKED =
		'2026/11/26 23:10:00 tshttpproxy: using proxy "http://***@127.0.0.1:9" for URL: "https://controlplane.tailscale.com/key?v=130"\n';

	/** Start a launcher, let it run for a moment, stop it, and return what reached stderr. */
	async function stderrOf(fake: { path: string }): Promise<string[]> {
		return withStderrWrites(async (writes) => {
			const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			await new Promise((resolve) => setTimeout(resolve, 300));
			await proxy.stop();
			return writes;
		});
	}

	it.skipIf(!posix)("reaches this process's stderr with a URL's user name and password masked", async () => {
		const fake = await stderrWritingBinary([[PROXY_LINE, 0]]);
		try {
			const writes = await stderrOf(fake);
			expect(writes.join("")).toBe(PROXY_LINE_MASKED);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("masks a user name alone, an encoded password and a SOCKS5 address too", async () => {
		const fake = await stderrWritingBinary([
			[
				"a https://tok3nvalue@proxy.invalid:8080/x b\n" +
					"c http://u:p%40ss%2Fw0rd@h.invalid:1 d\n" +
					'e "socks5://agx:hunter2@127.0.0.1:1080" f\n',
				0,
			],
		]);
		try {
			const text = (await stderrOf(fake)).join("");
			expect(text).toBe(
				"a https://***@proxy.invalid:8080/x b\n" +
					"c http://***@h.invalid:1 d\n" +
					'e "socks5://***@127.0.0.1:1080" f\n',
			);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is masked even when the launcher writes the URL in two pieces", async () => {
		const fake = await stderrWritingBinary([
			['tshttpproxy: using proxy "http://pu', 250],
			['ser:ppass@127.0.0.1:9" for URL: "x"\n', 0],
		]);
		try {
			const writes = await stderrOf(fake);
			expect(writes.join("")).toBe('tshttpproxy: using proxy "http://***@127.0.0.1:9" for URL: "x"\n');
			// Whole lines only, so no piece of a credential is ever written alone.
			for (const piece of writes) expect(piece.endsWith("\n")).toBe(true);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	// The CONNECT line Tailscale logs for every request through a proxy: the proxy
	// address (with its login) and the first 20 characters of the
	// Proxy-Authorization header, which is "Basic " and the start of
	// base64(user:password).
	it.skipIf(!posix)("masks the proxy's login and the start of its header in a CONNECT line", async () => {
		const line =
			'2026/11/27 01:20:01 tshttpproxy: CONNECT response from http://puser:ppass@127.0.0.1:9 for target "controlplane.tailscale.com:443" (auth "Basic cHVzZXI6cHBh...(26 total bytes)"): 407 Proxy Authentication Required\n';
		const fake = await stderrWritingBinary([[line, 0]]);
		try {
			expect((await stderrOf(fake)).join("")).toBe(
				'2026/11/27 01:20:01 tshttpproxy: CONNECT response from http://***@127.0.0.1:9 for target "controlplane.tailscale.com:443" (auth "***"): 407 Proxy Authentication Required\n',
			);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("masks a whole encoded login, a header line and a loose Basic value", async () => {
		// For a short login the 20 characters hold all of base64(user:password).
		const fake = await stderrWritingBinary([
			[
				'x (auth "Basic dTpwYXNzd29yZA==") y\n' +
					"Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==\n" +
					"proxy-authorization: Bearer some-token-value\n" +
					"sent Basic dXNlcjpwYXNzd29yZA== to the proxy\n",
				0,
			],
		]);
		try {
			expect((await stderrOf(fake)).join("")).toBe(
				'x (auth "***") y\n' +
					"Proxy-Authorization: ***\n" +
					"proxy-authorization: ***\n" +
					"sent Basic *** to the proxy\n",
			);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("masks every login on a line, not only the first", async () => {
		const fake = await stderrWritingBinary([
			[
				"a http://u1:p1@h1.invalid:1 b socks5://u2:p2@h2.invalid:2 c\n" +
					"sent Basic dXNlcjpwYXNzd29yZA== and Basic eHl6OmFiY2RlZmdoaWo= end\n" +
					'x (auth "Basic dTE6cDE=") y (auth "Basic dTI6cDI=") z\n',
				0,
			],
		]);
		try {
			expect((await stderrOf(fake)).join("")).toBe(
				"a http://***@h1.invalid:1 b socks5://***@h2.invalid:2 c\n" +
					"sent Basic *** and Basic *** end\n" +
					'x (auth "***") y (auth "***") z\n',
			);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("masks a login in a last line that has no newline", async () => {
		const fake = await stderrWritingBinary([['using proxy "http://puser:ppass@127.0.0.1:9"', 0]]);
		try {
			expect((await stderrOf(fake)).join("")).toBe('using proxy "http://***@127.0.0.1:9"');
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is passed on unchanged when it holds no credentials", async () => {
		const text =
			"2026/11/26 23:10:01 plain line\n" +
			"mail a@b.invalid or git@github.com:org/repo\n" +
			'proxy "https://example.invalid:3128/path?x=1#frag" for me\n' +
			"no newline at the end";
		const fake = await stderrWritingBinary([[text, 0]]);
		try {
			expect((await stderrOf(fake)).join("")).toBe(text);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	// A line is held until it ends, so that a login is never written in pieces. The
	// most that is held is 64 KiB of one line.
	const CAP = 64 * 1024;
	const LINE_CUT = " [line cut]\n";

	/** Wait for `count` cut markers in what has reached stderr. */
	async function waitForCuts(writes: string[], count: number, timeoutMs = 15_000): Promise<string> {
		await until(() => writes.join("").split(LINE_CUT).length - 1 >= count, timeoutMs);
		return writes.join("");
	}

	it.skipIf(!posix)("cuts a line that is longer than the cap and goes on with the next one", async () => {
		const fake = await stderrWritingBinary([["x".repeat(CAP + 1000) + "\nafter\n", 0]]);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				try {
					await until(() => writes.join("").endsWith("after\n"));
					expect(writes.join("")).toBe("x".repeat(CAP) + LINE_CUT + "after\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("keeps a line of exactly the cap and cuts one character more", async () => {
		const exact = "e".repeat(CAP - 1) + "\n";
		const over = "o".repeat(CAP) + "\n";
		const fake = await stderrWritingBinary([[exact + over + "end\n", 0]]);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				try {
					await until(() => writes.join("").endsWith("end\n"));
					expect(writes.join("")).toBe(exact + "o".repeat(CAP) + LINE_CUT + "end\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("drops the rest of a cut line even when it arrives in many pieces", async () => {
		const piece = "y".repeat(40_000);
		const fake = await stderrWritingBinary([
			[piece, 30],
			[piece, 30],
			[piece, 30],
			[piece + "\nnext\n", 0],
		]);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				try {
					await until(() => writes.join("").endsWith("next\n"));
					expect(writes.join("")).toBe("y".repeat(CAP) + LINE_CUT + "next\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not end a cut line in the middle of a character of two UTF-16 units", async () => {
		// The cap falls between the two halves of the emoji.
		const fake = await stderrWritingBinary([["a".repeat(CAP - 1) + "\u{1F600}" + "tail\nnext\n", 0]]);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				try {
					await until(() => writes.join("").endsWith("next\n"));
					expect(writes.join("")).toBe("a".repeat(CAP - 1) + LINE_CUT + "next\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("cuts a last line that is too long and has no newline", async () => {
		const fake = await stderrWritingBinary([["z".repeat(CAP * 2), 0]]);
		try {
			const text = (await stderrOf(fake)).join("");
			expect(text).toBe("z".repeat(CAP) + LINE_CUT);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	// Whatever the cap lands in the middle of, nothing of a login is written.
	it.skipIf(!posix).each([
		["a proxy address with a login", ' using proxy "http://zq7user:zq7pass@h.invalid:1" for me'],
		[
			"a CONNECT line's header text",
			' response (auth "Basic enE3dXNlcjp6cTdwYXNz...(40 total bytes)"): 407',
		],
		[
			"a CONNECT line's header text of another scheme",
			' response (auth "Negotiate YIIRjwYGKwYBBQUCoIIRIzCC...(1800 total bytes)"): 407',
		],
		["a header written out", " sent Proxy-Authorization: Basic enE3dXNlcjp6cTdwYXNz now"],
		["a loose Basic value", " sent Basic enE3dXNlcjp6cTdwYXNz now"],
	])(
		"writes nothing of a login that the cap falls inside, for %s, wherever it falls",
		async (_what, login) => {
			// One line for each place the cap can fall in the login, and one with the
			// whole login before it. Every one is longer than the cap by at least its newline.
			const lines = login.length + 1;
			const fake = await scriptedStderrBinary(
				`const login = ${JSON.stringify(login)};\n` +
					`for (let i = 0; i <= login.length; i++) {\n` +
					`  process.stderr.write("a".repeat(${CAP} - i) + login + "\\n");\n` +
					`}\n`,
			);
			try {
				await withStderrWrites(async (writes) => {
					const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 10_000 });
					try {
						const text = await waitForCuts(writes, lines);
						expect(text.split(LINE_CUT)).toHaveLength(lines + 1);
						expect(text).not.toMatch(/zq|7user|7pass|enE|dXNl|cjp6|cTdw|YXNz|YII|Rjw|GKw/);
					} finally {
						await proxy.stop();
					}
				});
			} finally {
				await rm(fake.dir, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it.skipIf(!posix)("passes 20 MB written as one line in a bounded time", async () => {
		const fake = await scriptedStderrBinary(
			`const chunk = "x".repeat(1024);\n` +
				`let left = 20 * 1024;\n` +
				`function go() {\n` +
				`  while (left > 0) {\n` +
				`    left--;\n` +
				`    if (!process.stderr.write(chunk)) { process.stderr.once("drain", go); return; }\n` +
				`  }\n` +
				`  process.stderr.write("\\nthe end\\n");\n` +
				`}\n` +
				`go();\n`,
		);
		try {
			await withStderrWrites(async (writes) => {
				const started = Date.now();
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 10_000 });
				try {
					await until(() => writes.join("").endsWith("the end\n"), 30_000);
					expect(Date.now() - started).toBeLessThan(15_000);
					expect(writes.join("")).toBe("x".repeat(CAP) + LINE_CUT + "the end\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	}, 60_000);

	it.skipIf(!posix)("writes every whole line of one piece without waiting for more", async () => {
		// All three lines arrive in one piece and nothing follows. They must be written
		// while the launcher still runs, not when it ends.
		const fake = await stderrWritingBinary([["line one\nline two\nline three\n", 0]]);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				try {
					await until(() => writes.join("").includes("line three\n"), 3_000);
					expect(writes.join("")).toBe("line one\nline two\nline three\n");
				} finally {
					await proxy.stop();
				}
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is written before stop() returns, even from a process that outlives the launcher", async () => {
		// The launcher ends at once. A process it started still has its stderr open
		// and writes 150 ms later, as a launcher's last words can arrive after it ended.
		const fake = await scriptedStderrBinary(
			`const { spawn } = require("child_process");\n` +
				`spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write('late words\\\\n'), 150)"], {\n` +
				`  stdio: ["ignore", "inherit", "inherit"],\n` +
				`}).unref();\n`,
		);
		try {
			await withStderrWrites(async (writes) => {
				const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
				await proxy.stop();
				expect(writes.join("")).toBe("late words\n");
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is written before a start that times out is reported, from a late last line", async () => {
		// The start times out, the launcher is sent SIGTERM, and writes its last line
		// 150 ms after that.
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-late-"));
		const path = join(dir, "fake-agx-tailscale");
		await writeFile(
			path,
			`#!${process.execPath}\n` +
				`process.on("SIGTERM", () => { setTimeout(() => { process.stderr.write("last words on SIGTERM\\n"); process.exit(0); }, 150); });\n` +
				`setInterval(() => {}, 1000);\n`,
			{ mode: 0o755 },
		);
		await chmod(path, 0o755);
		try {
			await withStderrWrites(async (writes) => {
				await expect(startBundledTailscale({ binary: path, timeoutMs: 500 })).rejects.toThrow(
					/did not report/,
				);
				expect(writes.join("")).toBe("last words on SIGTERM\n");
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it.skipIf(!posix)("reaches stderr before a failed start is reported", async () => {
		// The launcher says why it is ending and ends before it reports an address:
		// the caller must find that line already written when the error arrives.
		const fake = await stderrWritingBinary([[PROXY_LINE, 0]], "exit3");
		try {
			await withStderrWrites(async (writes) => {
				await expect(
					startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
				).rejects.toThrow(/exited before reporting/);
				expect(writes.join("")).toBe(PROXY_LINE_MASKED);
			});
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});
});

describe("the log upload switch", () => {
	async function launchedEnv(
		parent: Record<string, string | undefined>,
		options: { disableLogUpload?: boolean },
	): Promise<Record<string, string>> {
		const fake = await envDumpingBinary();
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			await withParentEnv(parent, async () => {
				proxy = await startBundledTailscale({
					binary: fake.path,
					timeoutMs: 5_000,
					...options,
				});
			});
			return await savedEnv(fake.envFile);
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	}

	it.skipIf(!posix)("turns the upload off for the launcher when asked to", async () => {
		const env = await launchedEnv({ TS_NO_LOGS_NO_SUPPORT: undefined }, { disableLogUpload: true });
		expect(env.TS_NO_LOGS_NO_SUPPORT).toBe("true");
	});

	it.skipIf(!posix)("prefers the option to a different value in the environment", async () => {
		const env = await launchedEnv({ TS_NO_LOGS_NO_SUPPORT: "false" }, { disableLogUpload: true });
		expect(env.TS_NO_LOGS_NO_SUPPORT).toBe("true");
	});

	it("rejects a switch that is not a boolean, before starting anything", async () => {
		await expect(
			startBundledTailscale({
				binary: join(tmpdir(), "no-such-launcher"),
				disableLogUpload: "false" as unknown as boolean,
			}),
		).rejects.toThrow(/disableLogUpload must be a boolean/);
	});

	it.skipIf(!posix)("leaves the launcher's default alone when the option is off or absent", async () => {
		for (const options of [{}, { disableLogUpload: false }]) {
			const env = await launchedEnv({ TS_NO_LOGS_NO_SUPPORT: undefined }, options);
			expect(env).not.toHaveProperty("TS_NO_LOGS_NO_SUPPORT");
		}
	});
});
