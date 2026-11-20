/**
 * The bundled tsnet launcher.
 *
 * The npm-side wrapper for the bundled Go launcher. It finds the native binary
 * under `bin/<platform>/`; no optional platform packages are needed. The Go
 * source is in `launcher/` and the binaries are staged with
 * `make -C launcher stage`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
const BINARY_NAME = process.platform === "win32" ? "agx-tailscale.exe" : "agx-tailscale";

export interface StartBundledTailscaleOptions {
	/** Tailscale auth key. Defaults to TS_AUTHKEY. */
	authKey?: string;
	/** Tailscale hostname. Defaults to agx-tailscale. */
	hostname?: string;
	/** Persistent tsnet state directory. Defaults to ~/.nostr-agx/tailscale. */
	stateDir?: string;
	/** Alternative coordination server URL. */
	controlUrl?: string;
	/** Register an ephemeral node. */
	ephemeral?: boolean;
	/** ACL tags such as tag:agx. */
	tags?: string[];
	/** SOCKS5 listen address. Must be loopback. Defaults to 127.0.0.1:0. */
	listen?: string;
	/** How long to wait for the tailnet and the SOCKS5 address. Defaults to 120000. */
	timeoutMs?: number;
	/** Override the bundled binary path, mainly for development. */
	binary?: string;
}

export interface BundledTailscaleProxy {
	/** SOCKS5 proxy URL, suitable for a relayProxy setting. */
	readonly url: string;
	/** Proxy address as host:port. */
	readonly address: string;
	readonly host: string;
	readonly port: number;
	/** Stop the child process. Safe to call more than once. */
	stop(): Promise<void>;
}

/**
 * Start the bundled platform binary, wait for it to join the tailnet and
 * report its SOCKS5 address, and return that address for use as `relayProxy`.
 *
 * The child exits when this process exits, because it watches stdin for EOF.
 */
export async function startBundledTailscale(
	options: StartBundledTailscaleOptions = {},
): Promise<BundledTailscaleProxy> {
	if (options === null || typeof options !== "object") {
		throw new TypeError("options must be an object");
	}

	const {
		authKey,
		hostname,
		stateDir,
		controlUrl,
		ephemeral = false,
		tags = [],
		listen,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		binary,
	} = options;

	if (authKey !== undefined && typeof authKey !== "string") {
		throw new TypeError("authKey must be a string");
	}
	if (authKey === "") {
		throw new TypeError("authKey must not be empty");
	}
	if (hostname !== undefined && typeof hostname !== "string") {
		throw new TypeError("hostname must be a string");
	}
	if (stateDir !== undefined && typeof stateDir !== "string") {
		throw new TypeError("stateDir must be a string");
	}
	if (controlUrl !== undefined && typeof controlUrl !== "string") {
		throw new TypeError("controlUrl must be a string");
	}
	if (listen !== undefined && typeof listen !== "string") {
		throw new TypeError("listen must be a string");
	}
	if (binary !== undefined && typeof binary !== "string") {
		throw new TypeError("binary must be a string");
	}
	if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
		throw new TypeError("tags must be an array of strings");
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("timeoutMs must be a positive number");
	}

	const executable = binary ?? process.env.AGX_TAILSCALE_BINARY ?? resolveBinary();
	const args = ["--exit-on-stdin-eof", "--connect-timeout", `${Math.ceil(timeoutMs)}ms`];
	if (stateDir) args.push("--state-dir", stateDir);
	if (hostname) args.push("--hostname", hostname);
	if (controlUrl) args.push("--control-url", controlUrl);
	if (listen) args.push("--listen", listen);
	if (ephemeral) args.push("--ephemeral");
	if (tags.length > 0) args.push("--tags", tags.join(","));

	// Minimal environment: the launcher only needs HOME and the resolved auth
	// key. Do not pass the parent's full environment through, so host secrets
	// cannot reach the child (and the tailnet node) unintentionally.
	const env: NodeJS.ProcessEnv = {};
	if (process.env.HOME) {
		env.HOME = process.env.HOME;
	}
	if (authKey !== undefined) {
		env.TS_AUTHKEY = authKey;
	}

	const child = spawn(executable, args, {
		env,
		stdio: ["pipe", "pipe", "inherit"],
		windowsHide: true,
	});
	const { stdin, stdout } = child;
	if (!stdin || !stdout) {
		child.kill();
		throw new Error("The bundled agx-tailscale launcher did not get usable stdio pipes");
	}
	stdout.setEncoding("utf8");
	stdin.on("error", () => {});
	child.on("error", () => {});

	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	let url: string;
	try {
		url = await waitForAddress(child, stdout, timeoutMs, executable);
	} catch (error) {
		child.kill();
		throw error;
	}

	// Keep draining stdout so the child cannot block on a full pipe.
	stdout.on("data", () => {});
	// From here on the caller has the address it was waiting for. The child
	// watches stdin for EOF and exits with its parent; it must not keep a
	// short-lived CLI process alive if a caller forgets to stop the proxy.
	// Callers that own the handle still stop it, which closes stdin first.
	child.unref();

	const parsed = new URL(url);
	const port = Number(parsed.port);
	if (!parsed.hostname || !Number.isInteger(port) || port <= 0) {
		child.kill();
		throw new Error(`The bundled launcher reported an invalid SOCKS5 address: ${url}`);
	}
	if (!parsed.username || !parsed.password) {
		child.kill();
		throw new Error(
			"The bundled launcher reported an unauthenticated SOCKS5 proxy; refusing to use a proxy that any local process could join.",
		);
	}

	let stopping: Promise<void> | undefined;
	return {
		url,
		address: parsed.host,
		host: parsed.hostname,
		port,
		stop(): Promise<void> {
			stopping ??= stopChild(child, stdin, exited);
			return stopping;
		},
	};
}

function waitForAddress(
	child: ChildProcess,
	stdout: Readable,
	timeoutMs: number,
	executable: string,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let buffer = "";

		const settle = (): boolean => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			stdout.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			return true;
		};
		const succeed = (value: string): void => {
			if (settle()) resolve(value);
		};
		const fail = (error: Error): void => {
			if (settle()) reject(error);
		};
		const onData = (chunk: string): void => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("socks5://")) {
					succeed(line);
					return;
				}
			}
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			fail(
				new Error(
					`agx-tailscale exited before reporting a SOCKS5 address (${
						signal ? `signal ${signal}` : `code ${code}`
					})`,
				),
			);
		};
		const onError = (error: Error): void => {
			fail(new Error(`could not start ${executable}: ${error.message}`, { cause: error }));
		};
		const timer = setTimeout(() => {
			fail(new Error(`agx-tailscale did not report a SOCKS5 address within ${timeoutMs} ms`));
		}, timeoutMs);
		timer.unref();

		stdout.on("data", onData);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

async function stopChild(
	child: ChildProcess,
	stdin: Writable,
	exited: Promise<void>,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	// The launcher is unref'd so a caller that forgets to stop it cannot keep a
	// one-shot CLI alive. Once stop IS requested, keep the event loop alive
	// until its `exit` event arrives; otherwise a process with nothing else to
	// do can exit while this promise is still pending, skipping the caller's
	// cleanup (for example removing the run's Tailscale state dir).
	child.ref();
	try {
		try {
			stdin.end();
		} catch {
			// The child already closed its stdin.
		}
		const term = setTimeout(() => child.kill("SIGTERM"), 1_000);
		const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
		term.unref();
		force.unref();
		try {
			await exited;
		} finally {
			clearTimeout(term);
			clearTimeout(force);
		}
	} finally {
		child.unref();
	}
}

/** Resolve the bundled native binary for this platform. */
export function bundledBinaryPath(): string {
	const platform = `${process.platform}-${process.arch}`;
	const path = fileURLToPath(new URL(`../bin/${platform}/${BINARY_NAME}`, import.meta.url));
	if (!existsSync(path)) {
		throw new Error(
			`@nostr-agx/tailscale has no bundled launcher for ${platform} at ${path}. ` +
				`Rebuild it with "make -C launcher stage", or set AGX_TAILSCALE_BINARY to a local build.`,
		);
	}
	return path;
}

function resolveBinary(): string {
	return process.env.AGX_TAILSCALE_BINARY ?? bundledBinaryPath();
}
