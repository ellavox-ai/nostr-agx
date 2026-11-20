import { type ChildProcess, spawn } from "node:child_process";
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

function start(...args: string[]): { child: ChildProcess; done: Promise<Run> } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) delete env[key];
	}
	env.AGX_HOME = home;
	env.AGX_TAILSCALE = "1";
	env.AGX_TAILSCALE_AUTH_KEY = KEY;
	env.AGX_TAILSCALE_BINARY = launcher;
	env.FAKE_SOCKS_PORT = String(socks.port);
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
	return { child, done };
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

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
	});

	afterEach(async () => {
		await socks.close();
		await relay.close();
		rmSync(home, { recursive: true, force: true });
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
	}, 20_000);
});
