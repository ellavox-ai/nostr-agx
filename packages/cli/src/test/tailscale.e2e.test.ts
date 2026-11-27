import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The built CLI, not the TypeScript sources: bundling `@nostr-agx/nostr` into
 * one ESM file used to inline the CommonJS `socks` package, whose
 * `require("events")` / `require("net")` throw at runtime. Unit tests alias the
 * sources and cannot see that. This test drives `dist/agx.js` with a local
 * relay and a fake launcher behind a local SOCKS5 proxy.
 */
const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));
const SDK = fileURLToPath(new URL("../../../../integrations/tailscale/dist/index.js", import.meta.url));
const posix = process.platform !== "win32";
const KEY = "tskey-auth-test-value-not-a-real-key";

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface SocksProxy {
	port: number;
	close(): Promise<void>;
}

const SOCKS_USER = "agx";
const SOCKS_PASS = "e2e-secret";

/** A minimal authenticated SOCKS5 CONNECT proxy: enough for `ws` to reach the
 * local relay, and strict enough to prove the CLI sends the URL credentials. */
async function startSocksProxy(): Promise<SocksProxy> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let buffer = Buffer.alloc(0);
		let greeted = false;
		let authenticated = false;
		let connected = false;
		socket.on("data", (chunk: Buffer | string) => {
			buffer = Buffer.concat([
				buffer,
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
			]);
			if (!greeted) {
				if (buffer.length < 2) return;
				const methods = buffer[1]!;
				if (buffer.length < 2 + methods) return;
				const offered = [...buffer.subarray(2, 2 + methods)];
				buffer = buffer.subarray(2 + methods);
				if (!offered.includes(0x02)) {
					socket.write(Buffer.from([0x05, 0xff]));
					socket.destroy();
					return;
				}
				socket.write(Buffer.from([0x05, 0x02]));
				greeted = true;
			}
			if (!authenticated) {
				if (buffer.length < 2) return;
				const userLength = buffer[1]!;
				if (buffer.length < 3 + userLength) return;
				const passLength = buffer[2 + userLength]!;
				if (buffer.length < 3 + userLength + passLength) return;
				const user = buffer.subarray(2, 2 + userLength).toString("utf8");
				const pass = buffer
					.subarray(3 + userLength, 3 + userLength + passLength)
					.toString("utf8");
				buffer = buffer.subarray(3 + userLength + passLength);
				if (user !== SOCKS_USER || pass !== SOCKS_PASS) {
					socket.write(Buffer.from([0x01, 0x01]));
					socket.destroy();
					return;
				}
				socket.write(Buffer.from([0x01, 0x00]));
				authenticated = true;
			}
			if (connected || buffer.length < 5) return;
			const atyp = buffer[3];
			let host: string;
			let offset = 4;
			if (atyp === 1) {
				if (buffer.length < 8) return;
				host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
				offset = 8;
			} else if (atyp === 3) {
				const length = buffer[4]!;
				if (buffer.length < 5 + length + 2) return;
				host = buffer.subarray(5, 5 + length).toString("utf8");
				offset = 5 + length;
			} else {
				socket.destroy();
				return;
			}
			const port = buffer.readUInt16BE(offset);
			const pending = buffer.subarray(offset + 2);
			connected = true;
			const upstream = connect({ host, port }, () => {
				socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
				if (pending.length > 0) upstream.write(pending);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			// The connection to the relay is closed with the others in `close()`: a
			// client that vanishes without a goodbye does not end it, and the relay's
			// own `close()` waits for every connection that is still open.
			sockets.add(upstream);
			upstream.once("close", () => sockets.delete(upstream));
			upstream.on("error", () => socket.destroy());
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("the fake SOCKS5 proxy has no TCP address");
	}
	return {
		port: address.port,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

let home: string;
let relay: RunningRelay;
let socks: SocksProxy;
let launcher: string;

/**
 * Ends the stand-in launcher this test started, if it still runs: the pid it
 * wrote is only used when that process is still running this test's own script.
 */
function endStandIn(): void {
	let pid: number;
	try {
		pid = Number(readFileSync(join(home, "launcher-pid"), "utf8").trim());
	} catch {
		return;
	}
	if (!Number.isInteger(pid) || pid <= 1) return;
	try {
		const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
			encoding: "utf8",
		});
		if (command.includes(launcher)) process.kill(pid, "SIGKILL");
	} catch {
		// Not running any more (ps finds no such process, or kill gets ESRCH).
	}
}

function start(...args: string[]): {
	child: ChildProcess;
	done: Promise<Run>;
	output: () => string;
	errors: () => string;
} {
	return startWith(args);
}

/** The environment of a command that does not use Tailscale: it dials the relay directly. */
const WITHOUT_TAILSCALE = {
	AGX_TAILSCALE: undefined,
	AGX_TAILSCALE_AUTH_KEY: undefined,
	AGX_TAILSCALE_BINARY: undefined,
};

function startWith(
	args: string[],
	envOverrides: Record<string, string | undefined> = {},
): {
	child: ChildProcess;
	done: Promise<Run>;
	output: () => string;
	errors: () => string;
} {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) delete env[key];
	}
	env.AGX_HOME = home;
	env.AGX_TAILSCALE = "1";
	env.AGX_TAILSCALE_AUTH_KEY = KEY;
	env.AGX_TAILSCALE_BINARY = launcher;
	env.FAKE_SOCKS_PORT = String(socks.port);
	for (const [name, value] of Object.entries(envOverrides)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	const child = spawn(process.execPath, [AGX, ...args], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const done = new Promise<Run>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done, output: () => stdout, errors: () => stderr };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

/** Every command started the launcher with a per-run state dir under AGX_HOME
 * and stopped its transport on shutdown, which removes the dir again. */
function expectTailscaleRunWasPerRunAndCleanedUp(): void {
	const args = readFileSync(join(home, "launcher-args"), "utf8")
		.trim()
		.split("\n");
	const stateFlag = args.indexOf("--state-dir");
	expect(stateFlag).toBeGreaterThanOrEqual(0);
	const stateDir = args[stateFlag + 1]!;
	expect(stateDir.startsWith(join(home, "tailscale-runs") + sep)).toBe(true);
	expect(
		existsSync(stateDir),
		`state dir survived: ${stateDir}; args: ${JSON.stringify(args)}`,
	).toBe(false);
	expect(readdirSync(join(home, "tailscale-runs"))).toEqual([]);
}

describe("the fake SOCKS5 proxy", () => {
	it("closes its connection to the relay when it is closed, even if its client vanished", async () => {
		// A plain TCP server stands in for the relay. A relay's own `close()` waits
		// for every connection that is still open, so a proxy that leaves one behind
		// makes the hook that closes both hang.
		const accepted: Socket[] = [];
		const relayStandIn = createServer((socket) => {
			accepted.push(socket);
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => relayStandIn.listen(0, "127.0.0.1", resolve));
		const relayPort = (relayStandIn.address() as { port: number }).port;
		const proxy = await startSocksProxy();
		const client = connect({ host: "127.0.0.1", port: proxy.port });
		client.on("error", () => undefined);
		try {
			let received = Buffer.alloc(0);
			client.on("data", (chunk: Buffer) => {
				received = Buffer.concat([received, chunk]);
			});
			const answered = async (length: number): Promise<void> => {
				await until(() => received.length >= length, 5_000);
				received = received.subarray(length);
			};
			client.write(Buffer.from([0x05, 0x01, 0x02]));
			await answered(2);
			client.write(
				Buffer.concat([
					Buffer.from([0x01, SOCKS_USER.length]),
					Buffer.from(SOCKS_USER),
					Buffer.from([SOCKS_PASS.length]),
					Buffer.from(SOCKS_PASS),
				]),
			);
			await answered(2);
			client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, relayPort >> 8, relayPort & 0xff]));
			await answered(10);
			await until(() => accepted.length === 1, 5_000);
			// The client goes away without a goodbye.
			client.resetAndDestroy();
			await proxy.close();
			let closed = false;
			try {
				await until(() => accepted[0]!.destroyed, 3_000);
				closed = true;
			} catch {
				// still open: reported below
			}
			expect(closed, "the proxy left its connection to the relay open after close()").toBe(true);
		} finally {
			client.destroy();
			for (const socket of accepted) socket.destroy();
			await new Promise<void>((resolve) => relayStandIn.close(() => resolve()));
		}
	}, 20_000);
});

describe.skipIf(!posix)("agx send through Tailscale (built CLI)", () => {
	beforeEach(async () => {
		expect(existsSync(AGX), "run pnpm build before the built-CLI test").toBe(true);
		expect(existsSync(SDK), "run pnpm build before the built-CLI test").toBe(true);
		home = mkdtempSync(join(tmpdir(), "agx-e2e-tailscale-"));
		relay = await startRelay({ port: 0 });
		socks = await startSocksProxy();
		launcher = join(home, "fake-agx-tailscale");
		// The SDK spawns this with `--exit-on-stdin-eof` and other flags it
		// does not understand; the shell wrapper ignores them.
		writeFileSync(
			launcher,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(home, "launcher-args"))}\necho socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${socks.port}\nexec cat >/dev/null\n`,
			{ mode: 0o755 },
		);
		chmodSync(launcher, 0o755);
		expect((await agx("identity", "new")).code).toBe(0);
		expect(
			(await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code,
		).toBe(0);
		// Every run below dials this throwaway relay, never the default relay on
		// port 7447 that a developer may have running.
		const shown = await agx("config", "show");
		expect(shown.stdout).toContain(`ws://127.0.0.1:${relay.port}`);
		expect(shown.stdout).not.toMatch(/ws:\/\/127\.0\.0\.1:7447\b/);
	});

	afterEach(async () => {
		// The folder goes first and whatever follows may take time: a hook that runs
		// out of time must not leave the throwaway home behind.
		try {
			endStandIn();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		await socks.close();
		await relay.close();
	});

	it("sends through the SOCKS proxy, prints JSON and exits on its own", async () => {
		const identity = await agx("identity", "show");
		const self = /npub1[0-9a-z]+/.exec(identity.stdout)?.[0];
		expect(self).toBeTruthy();

		const run = await agx("send", "--json", self!, "hello through tailscale");
		expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
		expect(run.stdout).toContain('"ok": true');
		expect(run.stderr).not.toMatch(/Dynamic require/);

		// The state dir really was per-run, under AGX_HOME, and removed on stop.
		expectTailscaleRunWasPerRunAndCleanedUp();
	}, 20_000);

	it("serve --once exits on its own and removes the run's state dir", async () => {
		// One-shot serve used to hang: `liveDispatch: false` meant client.stop()
		// never stopped the transport, so the unref'd launcher (holding stdio
		// pipes) kept the process alive, and the state directory — which holds
		// the node's private key — was left behind.
		const run = await agx("serve", "--once", "--no-reply", "--no-tasks");
		expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
		expectTailscaleRunWasPerRunAndCleanedUp();
	}, 30_000);

	it("serve reports a launcher that dies mid-run and exits non-zero", async () => {
		// The launcher reports its proxy, then ends by itself once `trigger` exists.
		const trigger = join(home, "launcher-die");
		waitingLauncher(trigger);
		const serve = start("serve", "--no-reply", "--no-tasks", "--poll-interval", "500");
		try {
			await until(() => serve.output().includes("watching for messages"), 20_000);
			writeFileSync(trigger, "");
			const run = await Promise.race([
				serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
			]);
			expect(run, "serve was still running 15 s after its launcher died").not.toBeNull();
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(5);
			expect(run!.stderr).toContain("Tailscale launcher");
			expect(run!.stderr).toContain("exit code 7");
			// Neither the SOCKS password nor the auth key may be in what serve says.
			for (const secret of [SOCKS_PASS, KEY]) {
				expect(run!.stderr).not.toContain(secret);
				expect(run!.stdout).not.toContain(secret);
			}
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			if (serve.child.exitCode === null && serve.child.signalCode === null) {
				serve.child.kill("SIGINT");
			}
			await serve.done;
		}
	}, 60_000);

	it("serve stops cleanly on Ctrl-C and says nothing about the launcher it stopped itself", async () => {
		const serve = start("serve", "--no-reply", "--no-tasks", "--poll-interval", "500");
		try {
			await until(() => serve.output().includes("watching for messages"), 20_000);
			await new Promise((r) => setTimeout(r, 500));
			serve.child.kill("SIGINT");
			const run = await serve.done;
			expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
			expect(run.stderr).not.toContain("Tailscale launcher");
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			if (serve.child.exitCode === null && serve.child.signalCode === null) {
				serve.child.kill("SIGINT");
			}
			await serve.done;
		}
	}, 60_000);

	it("serve that is already stopping says nothing when its launcher then ends", async () => {
		// serve waits for a running task before it stops the launcher. If the
		// launcher ends in that wait, serve is already stopping: it must not report
		// the launcher or cut the wait short with another exit status.
		const trigger = join(home, "launcher-die");
		const release = join(home, "release-task");
		waitingLauncher(trigger, `: > ${JSON.stringify(`${trigger}.gone`)}\n`);
		const handler = join(home, "held-handler.mjs");
		writeFileSync(
			handler,
			[
				'import { existsSync } from "node:fs";',
				"export default {",
				"	'held.echo': async () => {",
				`		while (!existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 50));`,
				"		return { held: true };",
				"	},",
				"};",
			].join("\n"),
		);
		// The asker dials the throwaway relay directly; check that before it connects.
		expect((await agx("--profile", "asker", "identity", "new")).code).toBe(0);
		expect(
			(await agx("--profile", "asker", "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code,
		).toBe(0);
		const askerConfig = await agx("--profile", "asker", "config", "show");
		expect(askerConfig.stdout).toContain(`ws://127.0.0.1:${relay.port}`);
		expect(askerConfig.stdout).not.toMatch(/ws:\/\/127\.0\.0\.1:7447\b/);
		const me = await agx("identity", "show");
		const npub = /npub1[0-9a-z]+/.exec(me.stdout)?.[0];
		expect(npub).toBeTruthy();

		const serve = start("serve", "--allow-all", "--handler", handler, "--poll-interval", "500");
		let request: ReturnType<typeof startWith> | undefined;
		try {
			await until(() => serve.output().includes("watching for messages"), 20_000);
			request = startWith(
				["--profile", "asker", "request", npub!, "held.echo", "--payload", "{}", "--timeout", "30000"],
				WITHOUT_TAILSCALE,
			);
			await until(() => serve.output().includes("TASK"), 20_000);
			serve.child.kill("SIGINT");
			await until(() => serve.output().includes("stopping"), 10_000);
			// The launcher ends while serve waits for the task.
			writeFileSync(trigger, "");
			await until(() => existsSync(`${trigger}.gone`), 10_000);
			await new Promise((r) => setTimeout(r, 1_000));
			writeFileSync(release, "");
			const run = await Promise.race([
				serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			]);
			expect(run, "serve was still running 20 s after its task was released").not.toBeNull();
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(0);
			expect(run!.stderr).not.toContain("Tailscale launcher");
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			writeFileSync(release, "");
			if (serve.child.exitCode === null && serve.child.signalCode === null) {
				serve.child.kill("SIGKILL");
			}
			await serve.done;
			if (request) {
				if (request.child.exitCode === null && request.child.signalCode === null) {
					request.child.kill("SIGKILL");
				}
				await request.done;
			}
		}
	}, 90_000);

	/**
	 * A launcher that ends when it is sent SIGINT, as the real one does (or when
	 * the process that started it is gone), and writes its pid where the test
	 * can read it.
	 */
	function interruptibleLauncher(): string {
		const pidFile = join(home, "launcher-pid");
		writeFileSync(
			launcher,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(home, "launcher-args"))}\necho $$ > ${JSON.stringify(pidFile)}\ntrap 'exit 0' INT\necho socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${socks.port}\np=$PPID\nwhile kill -0 $p 2>/dev/null; do sleep 1 & wait $!; done\n`,
			{ mode: 0o755 },
		);
		return pidFile;
	}

	/**
	 * A launcher that reports its proxy, waits until `trigger` exists (or the
	 * process that started it is gone), runs `after` (shell lines, each ending in
	 * a newline) and ends with code 7. It writes its pid where the test can read it.
	 */
	function waitingLauncher(trigger: string, after = ""): string {
		const pidFile = join(home, "launcher-pid");
		writeFileSync(
			launcher,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(home, "launcher-args"))}\necho $$ > ${JSON.stringify(pidFile)}\necho socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${socks.port}\np=$PPID\nwhile [ ! -e ${JSON.stringify(trigger)} ] && kill -0 $p 2>/dev/null; do sleep 0.1; done\n${after}exit 7\n`,
			{ mode: 0o755 },
		);
		return pidFile;
	}

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	it.each([
		["waits for a trigger file", () => waitingLauncher(join(home, "launcher-die"))],
		["waits for a signal", () => interruptibleLauncher()],
	])("a stand-in launcher that %s does not outlive an agx that was killed", async (_name, make) => {
		const pidFile = make();
		const serve = start("serve", "--no-reply", "--no-tasks", "--poll-interval", "500");
		let pid = 0;
		try {
			await until(() => serve.output().includes("watching for messages"), 20_000);
			pid = Number(readFileSync(pidFile, "utf8").trim());
			expect(pid).toBeGreaterThan(1);
			serve.child.kill("SIGKILL");
			await serve.done;
			let gone = false;
			try {
				await until(() => !isAlive(pid), 5_000);
				gone = true;
			} catch {
				// still running: reported below
			}
			expect(gone, `the stand-in launcher (pid ${pid}) was still running 5 s after its agx was killed`).toBe(true);
		} finally {
			if (serve.child.exitCode === null && serve.child.signalCode === null) {
				serve.child.kill("SIGKILL");
			}
			await serve.done;
			if (pid > 1 && isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		}
	}, 40_000);

	const LAUNCHER_NOTICE = "The Tailscale launcher stopped on its own";

	/**
	 * Start `serve` with a task that runs until `release()`, so that serve is
	 * inside its stop for as long as the test wants. Returns once the task runs.
	 */
	async function serveHoldingATask(): Promise<{
		serve: ReturnType<typeof start>;
		release: () => void;
		cleanUp: () => Promise<void>;
	}> {
		const release = join(home, "release-task");
		const handler = join(home, "held-handler.mjs");
		writeFileSync(
			handler,
			[
				'import { existsSync } from "node:fs";',
				"export default {",
				"	'held.echo': async () => {",
				`		while (!existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 50));`,
				"		return { held: true };",
				"	},",
				"};",
			].join("\n"),
		);
		// The asker dials the throwaway relay directly; check that before it connects.
		expect((await agx("--profile", "asker", "identity", "new")).code).toBe(0);
		expect(
			(await agx("--profile", "asker", "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code,
		).toBe(0);
		const askerConfig = await agx("--profile", "asker", "config", "show");
		expect(askerConfig.stdout).toContain(`ws://127.0.0.1:${relay.port}`);
		expect(askerConfig.stdout).not.toMatch(/ws:\/\/127\.0\.0\.1:7447\b/);
		const me = await agx("identity", "show");
		const npub = /npub1[0-9a-z]+/.exec(me.stdout)?.[0];
		expect(npub).toBeTruthy();

		const serve = start("serve", "--allow-all", "--handler", handler, "--poll-interval", "500");
		let request: ReturnType<typeof startWith> | undefined;
		const cleanUp = async (): Promise<void> => {
			writeFileSync(release, "");
			for (const running of [serve, request]) {
				if (!running) continue;
				if (running.child.exitCode === null && running.child.signalCode === null) {
					running.child.kill("SIGKILL");
				}
				await running.done;
			}
		};
		try {
			await until(() => serve.output().includes("watching for messages"), 20_000);
			request = startWith(
				["--profile", "asker", "request", npub!, "held.echo", "--payload", "{}", "--timeout", "30000"],
				WITHOUT_TAILSCALE,
			);
			await until(() => serve.output().includes("TASK"), 20_000);
		} catch (error) {
			await cleanUp();
			throw error;
		}
		return { serve, release: () => writeFileSync(release, ""), cleanUp };
	}

	// A Ctrl-C in a terminal reaches serve and the launcher it started at the same
	// moment. Either one can notice first; both orders must stop serve properly.
	it("a Ctrl-C that reaches serve after the launcher ended does not cut its stop short", async () => {
		const pidFile = interruptibleLauncher();
		const held = await serveHoldingATask();
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGINT");
			await until(() => held.serve.errors().includes(LAUNCHER_NOTICE), 10_000);
			// serve is now stopping, and waits for the task. The same Ctrl-C reaches it.
			held.serve.child.kill("SIGINT");
			await new Promise((r) => setTimeout(r, 1_500));
			expect(
				held.serve.child.exitCode === null && held.serve.child.signalCode === null,
				"serve ended at once instead of finishing its stop",
			).toBe(true);
			held.release();
			const run = await Promise.race([
				held.serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			]);
			expect(run, "serve was still running 20 s after its task was released").not.toBeNull();
			// The launcher ending is what started the stop, so that is the exit status.
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(5);
			expect(run!.stderr.split(LAUNCHER_NOTICE)).toHaveLength(2);
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			await held.cleanUp();
		}
	}, 90_000);

	it("a second signal after the one serve took in ends it at once, with 130 and no node keys left", async () => {
		const pidFile = interruptibleLauncher();
		const held = await serveHoldingATask();
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGINT");
			await until(() => held.serve.errors().includes(LAUNCHER_NOTICE), 10_000);
			held.serve.child.kill("SIGINT");
			await new Promise((r) => setTimeout(r, 1_000));
			expect(
				held.serve.child.exitCode === null && held.serve.child.signalCode === null,
				"serve ended on the first signal",
			).toBe(true);
			held.serve.child.kill("SIGINT");
			const run = await Promise.race([
				held.serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			]);
			expect(run, "serve did not end on the second signal").not.toBeNull();
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(130);
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			await held.cleanUp();
		}
	}, 90_000);

	it("a Ctrl-C that reaches serve before the launcher ends stops it with status 0", async () => {
		const pidFile = interruptibleLauncher();
		const held = await serveHoldingATask();
		try {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			held.serve.child.kill("SIGINT");
			await until(() => held.serve.output().includes("stopping"), 10_000);
			process.kill(pid, "SIGINT");
			await new Promise((r) => setTimeout(r, 1_500));
			held.release();
			const run = await Promise.race([
				held.serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			]);
			expect(run, "serve was still running 20 s after its task was released").not.toBeNull();
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(0);
			expect(run!.stderr).not.toContain("Tailscale launcher");
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			await held.cleanUp();
		}
	}, 90_000);

	it("leaves no node keys behind when a second Ctrl-C ends a stop that is waiting", async () => {
		// A second signal while serve is stopping ends it at once, with status 130,
		// as it always has. The run's state directory must not outlive it.
		const pidFile = interruptibleLauncher();
		const held = await serveHoldingATask();
		try {
			held.serve.child.kill("SIGINT");
			await until(() => held.serve.output().includes("stopping"), 10_000);
			const secondSignalAt = Date.now();
			held.serve.child.kill("SIGINT");
			const endedAt = held.serve.done.then(() => Date.now());
			const run = await Promise.race([
				held.serve.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			]);
			expect(run, "serve did not end on the second signal").not.toBeNull();
			expect(run!.code, `${run!.stdout}\n${run!.stderr}`).toBe(130);
			// serve also ends with 130 when its 10 second limit on a stop runs out, so
			// the status alone cannot tell "ended on the second signal" from "swallowed
			// it and waited for the limit": the time can.
			expect(
				(await endedAt) - secondSignalAt,
				"serve did not end at once on the second signal",
			).toBeLessThan(6_000);
			expect(existsSync(pidFile)).toBe(true);
			expectTailscaleRunWasPerRunAndCleanedUp();
		} finally {
			await held.cleanUp();
		}
	}, 90_000);

	it("serve --once does not give the launcher a proxy login, and masks one the launcher prints", async () => {
		// The Tailscale code in the real launcher logs the proxy it uses (with its
		// login) and the start of the Proxy-Authorization header. The stand-in prints
		// such a line whatever it was given, as a launcher that still got the login would.
		const envFile = join(home, "launcher-env");
		writeFileSync(
			launcher,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(home, "launcher-args"))}\nenv > ${JSON.stringify(envFile)}\necho "tshttpproxy: CONNECT response from http://leakuser:leak-pw-123@127.0.0.1:9 for target \\"x:443\\" (auth \\"Basic bGVha3VzZXI6bGVh...(36 total bytes)\\"): 407" >&2\necho socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${socks.port}\nexec cat >/dev/null\n`,
			{ mode: 0o755 },
		);
		const run = await startWith(["serve", "--once", "--no-reply", "--no-tasks"], {
			HTTPS_PROXY: "http://leakuser:leak-pw-123@127.0.0.1:9",
			NO_PROXY: "127.0.0.1,localhost",
		}).done;
		expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
		const launcherEnv = readFileSync(envFile, "utf8");
		expect(launcherEnv).not.toContain("leak-pw-123");
		expect(launcherEnv).not.toMatch(/^HTTPS_PROXY=/m);
		expect(launcherEnv).toMatch(/^NO_PROXY=127\.0\.0\.1,localhost$/m);
		const notice = "not passing HTTPS_PROXY to the launcher";
		expect(run.stderr.split(notice)).toHaveLength(2);
		expect(run.stderr).toContain("(auth \"***\")");
		expect(run.stderr).toContain("http://***@127.0.0.1:9");
		for (const secret of ["leakuser", "leak-pw-123", "bGVha3Vz"]) {
			expect(run.stderr, `stderr shows ${secret}`).not.toContain(secret);
			expect(run.stdout, `stdout shows ${secret}`).not.toContain(secret);
		}
		expectTailscaleRunWasPerRunAndCleanedUp();
	}, 60_000);

	it("inbox exits on its own and removes the run's state dir", async () => {
		const run = await agx("inbox", "--json", "--wait", "2");
		expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
		expectTailscaleRunWasPerRunAndCleanedUp();
	}, 30_000);
});
