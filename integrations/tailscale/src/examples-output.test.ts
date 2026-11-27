import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The example scripts, run for real against a fake launcher and a local
 * stand-in for the relay. Nothing here reaches a network or a tailnet: the fake
 * launcher prints a SOCKS5 address on this machine that drops every connection,
 * so each run fails fast at its first publish, after it has printed its
 * start-up lines.
 */
const posix = process.platform !== "win32";
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const RESERVED_PORTS = new Set([7447, 53505]);
const RUN_TIMEOUT_MS = 60_000;

/** Throwaway values, made fresh for every run. */
const hex = (length: number): string => Math.random().toString(16).slice(2).padEnd(length, "0").slice(0, length);
const PROXY_USER = `user${hex(8)}`;
const PROXY_PASS = `pass${hex(8)}`;

interface Listener {
	port: number;
	close(): Promise<void>;
}

async function listenOnFreePort(
	make: () => { listen(port: number, host: string, done: () => void): unknown; address(): unknown; close(done: () => void): unknown },
	onClose: () => void = () => undefined,
): Promise<Listener> {
	for (;;) {
		const server = make();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		if (!RESERVED_PORTS.has(port)) {
			return {
				port,
				close: async () => {
					onClose();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				},
			};
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** A local TCP listener that drops every connection. */
function droppingListener(): Promise<Listener> {
	const sockets = new Set<Socket>();
	return listenOnFreePort(
		() =>
			createServer((socket) => {
				sockets.add(socket);
				socket.on("error", () => undefined);
				socket.destroy();
			}),
		() => sockets.forEach((socket) => socket.destroy()),
	);
}

let dir: string;
let keyFile: string;
let proxyListener: Listener;
let relayListener: Listener;
let extra: Listener[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "agx-example-test-"));
	keyFile = join(dir, "key-seen-by-launcher");
	proxyListener = await droppingListener();
	relayListener = await droppingListener();
	extra = [];
});

afterEach(async () => {
	await proxyListener.close();
	await relayListener.close();
	for (const listener of extra) {
		await listener.close();
	}
	await rm(dir, { recursive: true, force: true });
});

/** A launcher that records the key it was given and reports a SOCKS5 address with credentials. */
async function fakeLauncher(): Promise<string> {
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!/bin/sh\nprintf '%s' "$TS_AUTHKEY" > ${JSON.stringify(keyFile)}\n` +
			`echo socks5://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${proxyListener.port}\nexec cat >/dev/null\n`,
	);
	await chmod(path, 0o755);
	return path;
}

interface Run {
	code: number | null;
	output: string;
}

/** Run an example with only the environment it is given, and feed it `stdin`. */
async function runExample(
	script: string,
	args: string[],
	options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<Run> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		AGX_TAILSCALE_BINARY: await fakeLauncher(),
		...options.env,
	};
	const child = spawn(process.execPath, [tsx, join(packageDir, "examples", script), ...args], {
		cwd: packageDir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	child.stdin.on("error", () => undefined);
	child.stdin.end(options.stdin ?? "");
	const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS - 5_000);
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	clearTimeout(timer);
	return { code, output };
}

const relayArgs = (): string[] => ["--relay", `ws://127.0.0.1:${relayListener.port}`];
const REDACTED_PROXY = /relay proxy socks5:\/\/redacted@127\.0\.0\.1:\d+/;

describe.skipIf(!posix)("two-agents-auth-key example", () => {
	it("prints the relay proxy without its user name and password", async () => {
		const key = `tskey-auth-${hex(20)}`;
		const run = await runExample("two-agents-auth-key.ts", relayArgs(), { env: { TS_AUTHKEY: key } });
		expect(run.output).not.toContain(PROXY_USER);
		expect(run.output).not.toContain(PROXY_PASS);
		expect(run.output).not.toContain(key);
		expect(run.output).toMatch(REDACTED_PROXY);
	}, RUN_TIMEOUT_MS);

	it("reads the auth key from stdin", async () => {
		const key = `tskey-auth-${hex(20)}`;
		const run = await runExample("two-agents-auth-key.ts", [...relayArgs(), "--auth-key-stdin"], {
			stdin: `${key}\n`,
		});
		expect(existsSync(keyFile), `the launcher was not started: ${run.output}`).toBe(true);
		expect(await readFile(keyFile, "utf8")).toBe(key);
		expect(run.output).not.toContain(key);
	}, RUN_TIMEOUT_MS);

	it("refuses an auth key given as an argument, without starting anything or printing it", async () => {
		for (const form of ["separate", "joined"] as const) {
			const key = `tskey-auth-${hex(20)}`;
			const args = form === "separate" ? ["--auth-key", key] : [`--auth-key=${key}`];
			const run = await runExample("two-agents-auth-key.ts", [...relayArgs(), ...args]);
			expect(run.code, run.output).not.toBe(0);
			expect(run.output, form).not.toContain(key);
			expect(run.output, form).toContain("--auth-key-stdin");
			expect(existsSync(keyFile), `${form}: the launcher was started`).toBe(false);
		}
	}, RUN_TIMEOUT_MS);

	it("says nothing came on stdin when stdin is empty", async () => {
		const run = await runExample("two-agents-auth-key.ts", [...relayArgs(), "--auth-key-stdin"], { stdin: "\n" });
		expect(run.code, run.output).toBe(1);
		expect(run.output).toContain("No Tailscale auth key was available on stdin.");
		expect(existsSync(keyFile), "the launcher was started").toBe(false);
	}, RUN_TIMEOUT_MS);

	it("names stdin, not an argument, as the source of a key it finds malformed", async () => {
		const words = `tskey-${hex(6)} ${hex(6)}`;
		const run = await runExample("two-agents-auth-key.ts", [...relayArgs(), "--auth-key-stdin"], {
			stdin: `${words}\n`,
		});
		expect(run.code, run.output).toBe(1);
		expect(run.output).toMatch(/auth key from stdin /);
		expect(run.output).not.toMatch(/from argument/);
		expect(run.output).not.toContain(words);
		expect(existsSync(keyFile), "the launcher was started").toBe(false);
	}, RUN_TIMEOUT_MS);

	it("names the environment, not an argument, as the source of a key it finds malformed", async () => {
		const words = `tskey-${hex(6)} ${hex(6)}`;
		const run = await runExample("two-agents-auth-key.ts", relayArgs(), { env: { TS_AUTHKEY: words } });
		expect(run.code, run.output).toBe(1);
		expect(run.output).toMatch(/auth key from the environment /);
		expect(run.output).not.toMatch(/from argument/);
		expect(run.output).not.toContain(words);
		expect(existsSync(keyFile), "the launcher was started").toBe(false);
	}, RUN_TIMEOUT_MS);

	it("still answers --help and asks for a key when none is given", async () => {
		const help = await runExample("two-agents-auth-key.ts", ["--help"]);
		expect(help.code).toBe(0);
		expect(help.output).toContain("--relay");
		expect(help.output).toContain("--hostname");

		const none = await runExample("two-agents-auth-key.ts", relayArgs());
		expect(none.code).toBe(1);
		expect(none.output).toContain("TS_AUTHKEY");
		expect(existsSync(keyFile)).toBe(false);
	}, RUN_TIMEOUT_MS);
});

describe.skipIf(!posix)("two-agents-oauth example", () => {
	it("prints the relay proxy without its user name and password", async () => {
		const minted = `tskey-auth-${hex(20)}`;
		const secret = `secret-${hex(16)}`;
		let requests = 0;
		const service = await listenOnFreePort(() =>
			createHttpServer((request, response) => {
				requests += 1;
				request.resume();
				request.on("end", () => {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ authKey: minted }));
				});
			}),
		);
		extra.push(service);
		const run = await runExample(
			"two-agents-oauth.ts",
			[...relayArgs(), "--token-url", `http://127.0.0.1:${service.port}/token`, "--client-id", "test-client", "--client-secret-stdin"],
			{ stdin: `${secret}\n` },
		);
		expect(run.output).not.toContain(PROXY_USER);
		expect(run.output).not.toContain(PROXY_PASS);
		expect(run.output).not.toContain(minted);
		expect(run.output).not.toContain(secret);
		expect(run.output).toMatch(REDACTED_PROXY);
		// The minted key still reaches the launcher.
		expect(requests).toBe(1);
		expect(await readFile(keyFile, "utf8")).toBe(minted);
	}, RUN_TIMEOUT_MS);
});

describe.skipIf(!posix)("the examples and an argument they do not know", () => {
	/** Run `example` with `args` and check that it refuses without repeating `secret` or starting anything. */
	async function refusesWithout(example: string, args: string[], secret: string): Promise<Run> {
		const run = await runExample(example, [...relayArgs(), ...args]);
		expect(run.code, run.output).toBe(1);
		expect(run.output).not.toContain(secret);
		expect(run.output).toMatch(/not shown/i);
		expect(existsSync(keyFile), "the launcher was started").toBe(false);
		return run;
	}

	it("auth-key example: does not repeat the value of an unknown option written as name=value", async () => {
		const key = `tskey-auth-${hex(20)}`;
		const run = await refusesWithout("two-agents-auth-key.ts", [`--authkey=${key}`], key);
		expect(run.output).toContain("--authkey");
	}, RUN_TIMEOUT_MS);

	it("auth-key example: does not repeat a key typed after --auth-key-stdin", async () => {
		const key = `tskey-auth-${hex(20)}`;
		await refusesWithout("two-agents-auth-key.ts", ["--auth-key-stdin", key], key);
	}, RUN_TIMEOUT_MS);

	it("auth-key example: does not repeat a key given as a bare argument", async () => {
		const key = `tskey-auth-${hex(20)}`;
		await refusesWithout("two-agents-auth-key.ts", [key], key);
	}, RUN_TIMEOUT_MS);

	it("oauth example: does not repeat the value of an unknown option written as name=value", async () => {
		const secret = `secret-${hex(16)}`;
		const run = await refusesWithout("two-agents-oauth.ts", [`--clientsecret=${secret}`], secret);
		expect(run.output).toContain("--clientsecret");
	}, RUN_TIMEOUT_MS);

	it("oauth example: does not repeat a secret typed after --client-secret-stdin", async () => {
		const secret = `secret-${hex(16)}`;
		await refusesWithout("two-agents-oauth.ts", ["--client-secret-stdin", secret], secret);
	}, RUN_TIMEOUT_MS);

	it("both examples still name an unknown option that has no value", async () => {
		for (const example of ["two-agents-auth-key.ts", "two-agents-oauth.ts"]) {
			const run = await runExample(example, [...relayArgs(), "--bogus"]);
			expect(run.code, example).toBe(1);
			expect(run.output, example).toContain("--bogus");
			expect(existsSync(keyFile), `${example}: the launcher was started`).toBe(false);
		}
	}, RUN_TIMEOUT_MS);
});
