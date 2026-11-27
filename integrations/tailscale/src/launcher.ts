/**
 * The bundled tsnet launcher.
 *
 * The npm-side wrapper for the bundled Go launcher. It finds the native binary
 * under `bin/<platform>/`; no optional platform packages are needed. The Go
 * source is in `launcher/` and the binaries are staged with
 * `make -C launcher stage`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The only variables the launcher inherits from this process, when they are set:
 * where it lives (HOME; USERPROFILE and SystemRoot, which a Windows process
 * looks for, not tried on Windows), where it may write temporary files
 * (TMPDIR), the proxy a host sits behind (the HTTP_PROXY family, in both cases)
 * and Tailscale's own log setting. A proxy address that holds a login is not
 * passed on (see PROXY_ADDRESS_VARIABLES).
 */
const INHERITED_ENV = [
	"HOME",
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
/**
 * The spellings Go's strconv.ParseBool accepts. tsnet reads TS_NO_LOGS_NO_SUPPORT
 * with it and ends the program at start on any other value.
 */
const TAILSCALE_BOOLEANS = new Set([
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
]);
/**
 * The variables that name a proxy. A value with an `@` in it holds a login
 * (`user:password@host`), and the Tailscale code in the launcher prints the
 * proxy it uses in its log, login included, so such a value is not passed on.
 */
const PROXY_ADDRESS_VARIABLES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);

/**
 * What the launcher's log can show of a proxy login, and what is replaced. All
 * four patterns start at a fixed piece of text and look ahead only along a run
 * of characters that cannot start another match, so the time is linear.
 *
 * - What sits between `://` and `@` in a URL (`user:password` or a bare token).
 * - The `(auth "...")` of a CONNECT line: the first 20 characters of the
 *   Proxy-Authorization header, "Basic " and the start of base64(user:password).
 * - A Proxy-Authorization header written out in full, to the end of its line.
 * - Any other `Basic <base64>` text. A plain word that follows "Basic" (such as
 *   "Basic settings") is hidden too.
 */
const URL_CREDENTIALS = /(:\/\/)[^\s/?#@"'\\]+@/g;
const AUTH_LOG_VALUE = /(\(auth ")[^"]{0,120}"/g;
const AUTH_HEADER = /(proxy-authorization):?[^\n\r]*/gi;
const BASIC_VALUE = /\bBasic[ \t]+[A-Za-z0-9+/]{8,}={0,2}/g;

/**
 * A short text for whatever a listener threw, with logins masked. A thrown value
 * can be anything (an object with no prototype, an Error whose message getter
 * throws), so describing it must never throw.
 */
function describeThrown(thrown: unknown): string {
	try {
		const text = thrown instanceof Error ? thrown.message : String(thrown);
		return maskSecrets(typeof text === "string" ? text : "").slice(0, 500);
	} catch {
		return "a value that could not be described";
	}
}

function maskSecrets(text: string): string {
	return text
		.replace(URL_CREDENTIALS, "$1***@")
		.replace(AUTH_LOG_VALUE, '$1***"')
		.replace(AUTH_HEADER, "$1: ***")
		.replace(BASIC_VALUE, "Basic ***");
}

const BINARY_NAME = process.platform === "win32" ? "agx-tailscale.exe" : "agx-tailscale";

/**
 * The state directories this module made for handles and has not removed yet.
 * They hold the node's private keys, so as long as one is left a single listener
 * on the process "exit" event removes them, synchronously and best effort. That
 * covers process.exit(), an uncaught exception and an unhandled rejection; a
 * signal with no handler and SIGKILL end a process without that event.
 */
const ownedStateDirs = new Set<string>();

function removeOwnedStateDirsOnExit(): void {
	for (const dir of ownedStateDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Nothing more can be done while the process is ending.
		}
	}
}

function keepOwnedStateDir(dir: string): void {
	if (ownedStateDirs.size === 0) process.on("exit", removeOwnedStateDirsOnExit);
	ownedStateDirs.add(dir);
}

function releaseOwnedStateDir(dir: string): void {
	if (ownedStateDirs.delete(dir) && ownedStateDirs.size === 0) {
		process.off("exit", removeOwnedStateDirsOnExit);
	}
}

export interface StartBundledTailscaleOptions {
	/**
	 * Tailscale auth key, handed to the launcher as TS_AUTHKEY. The launcher does
	 * not inherit this process's TS_AUTHKEY (startTailscaleRelayProxy reads it for
	 * you when its authKey is omitted). Without a key the launcher can only resume
	 * a node already enrolled in stateDir.
	 */
	authKey?: string;
	/** Tailscale hostname. Defaults to agx-tailscale. */
	hostname?: string;
	/**
	 * Persistent tsnet state directory. A node enrolled in it is reused, and the
	 * directory is kept when the launcher stops. When omitted, the launcher gets a
	 * private temporary directory of its own (`agx-tailscale-XXXXXX` under the
	 * operating system's temporary folder, mode 0700), so two processes never share
	 * one node identity. It holds the node's private keys. It is deleted when the
	 * launcher ends, and when this process exits through process.exit(), an
	 * uncaught exception or an unhandled rejection. It is left behind when the
	 * process is ended by SIGKILL or by a signal it has no handler for (SIGINT,
	 * SIGTERM and SIGHUP by default): this module installs no signal handlers, so a
	 * host that wants it removed there handles the signal and calls `stop()`.
	 * A directory you pass is never deleted.
	 */
	stateDir?: string;
	/** Alternative coordination server URL. */
	controlUrl?: string;
	/** Register an ephemeral node. */
	ephemeral?: boolean;
	/**
	 * Do not let Tailscale upload this node's client logs to log.tailscale.com,
	 * which tsnet does by default. Sets TS_NO_LOGS_NO_SUPPORT=true for the
	 * launcher; Tailscale's documentation says that also opts the device out of
	 * support that would need those logs. When false or omitted the launcher's
	 * default applies, unless TS_NO_LOGS_NO_SUPPORT is already set in this process,
	 * in which case that value is passed on if Tailscale accepts it as a boolean
	 * (true, false, 1, 0, t, f and the usual capitalisations). Any other value is
	 * left out, with one line on stderr that names the variable and not its value.
	 */
	disableLogUpload?: boolean;
	/** ACL tags such as tag:agx. */
	tags?: string[];
	/** SOCKS5 listen address. Must be loopback. Defaults to 127.0.0.1:0. */
	listen?: string;
	/** How long to wait for the tailnet and the SOCKS5 address. Defaults to 120000. */
	timeoutMs?: number;
	/** Override the bundled binary path, mainly for development. */
	binary?: string;
}

/** How the launcher ended. */
export interface BundledTailscaleExit {
	/** The exit code, or null when a signal ended the launcher. */
	readonly code: number | null;
	/** The signal that ended the launcher, or null when it exited by itself. */
	readonly signal: NodeJS.Signals | null;
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
	/**
	 * Call `listener` if the launcher ends without `stop()` having been called, for
	 * example because it crashed or was killed from outside. From then on the proxy
	 * no longer works. A launcher stopped through `stop()` does not trigger it.
	 *
	 * The listener is called once, after the launcher's temporary state directory
	 * has been deleted. A listener added after the launcher already ended is called
	 * in a microtask, so not before the call to `onExit` returns. Returns a function
	 * that removes the listener.
	 *
	 * A listener that throws does not end the host and does not stop the listeners
	 * after it: the error is kept in `listenerErrors` and reported as a process
	 * warning (code `AGX_TAILSCALE_ONEXIT_LISTENER`).
	 */
	onExit(listener: (exit: BundledTailscaleExit) => void): () => void;
	/** The errors thrown by `onExit` listeners so far, oldest first. */
	readonly listenerErrors: readonly unknown[];
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
		disableLogUpload,
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
	if (disableLogUpload !== undefined && typeof disableLogUpload !== "boolean") {
		throw new TypeError("disableLogUpload must be a boolean");
	}
	if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
		throw new TypeError("tags must be an array of strings");
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("timeoutMs must be a positive number");
	}

	const executable = binary ?? process.env.AGX_TAILSCALE_BINARY ?? resolveBinary();
	// Without a directory of its own the launcher would fall back to
	// ~/.nostr-agx/tailscale, shared by every process: two nodes would race on one
	// state file, and tsnet ignores a new auth key (and its tags) once the state
	// holds a node.
	const ownedStateDir = stateDir ? undefined : mkdtempSync(join(tmpdir(), "agx-tailscale-"));
	if (ownedStateDir) keepOwnedStateDir(ownedStateDir);
	const removeOwnedStateDir = (): void => {
		if (!ownedStateDir) return;
		try {
			rmSync(ownedStateDir, { recursive: true, force: true });
			releaseOwnedStateDir(ownedStateDir);
		} catch {
			// Best effort: a leftover temporary directory is not worth failing a stop for.
			// It stays listed, so the exit listener tries once more.
		}
	};
	const args = ["--exit-on-stdin-eof", "--connect-timeout", `${Math.ceil(timeoutMs)}ms`];
	const stateDirectory = stateDir || ownedStateDir;
	if (stateDirectory) args.push("--state-dir", stateDirectory);
	if (hostname) args.push("--hostname", hostname);
	if (controlUrl) args.push("--control-url", controlUrl);
	if (listen) args.push("--listen", listen);
	if (ephemeral) args.push("--ephemeral");
	if (tags.length > 0) args.push("--tags", tags.join(","));

	// Minimal environment: the allowlist above and the auth key. Do not pass the
	// parent's full environment through, so host secrets cannot reach the child
	// (and the tailnet node) unintentionally.
	const env: NodeJS.ProcessEnv = {};
	for (const name of INHERITED_ENV) {
		const value = process.env[name];
		if (!value) continue;
		if (name === "TS_NO_LOGS_NO_SUPPORT" && !TAILSCALE_BOOLEANS.has(value)) {
			// The switch sets its own value below, so only say so when it is not on.
			if (!disableLogUpload) {
				process.stderr.write(
					`@nostr-agx/tailscale: ignoring ${name} from the environment, because Tailscale does not accept its value (use true or false).\n`,
				);
			}
			continue;
		}
		if (PROXY_ADDRESS_VARIABLES.has(name) && value.includes("@")) {
			process.stderr.write(
				`@nostr-agx/tailscale: not passing ${name} to the launcher, because its value holds a login (a user name and password) that the launcher would print in its log. Use a proxy address without one.\n`,
			);
			continue;
		}
		env[name] = value;
	}
	if (disableLogUpload) {
		env.TS_NO_LOGS_NO_SUPPORT = "true";
	}
	if (authKey !== undefined) {
		env.TS_AUTHKEY = authKey;
	}

	let child: ChildProcess;
	try {
		child = spawn(executable, args, {
			env,
			// stderr is piped, not inherited, so relayStderr can mask credentials in it.
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		removeOwnedStateDir();
		throw error;
	}
	const { stdin, stdout, stderr } = child;
	if (!stdin || !stdout || !stderr) {
		child.kill();
		throw new Error("The bundled agx-tailscale launcher did not get usable stdio pipes");
	}
	stdout.setEncoding("utf8");
	stdin.on("error", () => {});
	const stderrWritten = relayStderr(stderr);
	// A launcher that could not be started has no pid and never emits `exit`.
	child.on("error", () => {
		if (child.pid === undefined) removeOwnedStateDir();
	});

	// Whatever ends the launcher (stop, a failed start, or its own exit), its
	// state directory goes with it, and `exited` settles only after that.
	let stopRequested = false;
	let endedOnItsOwn: BundledTailscaleExit | undefined;
	const exitListeners = new Set<(exit: BundledTailscaleExit) => void>();
	const listenerErrors: unknown[] = [];
	// A listener belongs to the host. If it throws, the host keeps running and the
	// listeners after it still hear about the exit.
	const tell = (listener: (exit: BundledTailscaleExit) => void, exit: BundledTailscaleExit): void => {
		try {
			listener(exit);
		} catch (error) {
			listenerErrors.push(error);
			try {
				process.emitWarning(`An onExit listener threw: ${describeThrown(error)}`, {
					code: "AGX_TAILSCALE_ONEXIT_LISTENER",
				});
			} catch {
				// Reporting is best effort. The host and the other listeners go on.
			}
		}
	};
	const exited = new Promise<void>((resolve) =>
		child.once("exit", (code, signal) => {
			removeOwnedStateDir();
			resolve();
			if (stopRequested) return;
			endedOnItsOwn = { code, signal };
			for (const listener of [...exitListeners]) tell(listener, endedOnItsOwn);
		}),
	);
	let url: string;
	try {
		url = await waitForAddress(child, stdout, timeoutMs, executable);
	} catch (error) {
		child.kill();
		// What the launcher wrote on its way out reaches stderr before the error.
		await soon(stderrWritten);
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
			stopRequested = true;
			stopping ??= stopChild(child, stdin, exited).then(() => soon(stderrWritten));
			return stopping;
		},
		listenerErrors,
		onExit(listener): () => void {
			const ended = endedOnItsOwn;
			if (ended) {
				let removed = false;
				queueMicrotask(() => {
					if (!removed) tell(listener, ended);
				});
				return () => {
					removed = true;
				};
			}
			exitListeners.add(listener);
			return () => {
				exitListeners.delete(listener);
			};
		},
	};
}

/** The most of one launcher line that is held, in characters. */
const MAX_HELD_LINE = 64 * 1024;
const LINE_CUT_MARKER = " [line cut]\n";

/**
 * The start of a line that is too long, masked. The cut can fall in the middle of
 * a login, so what the patterns above cannot see yet (a login without its `@`, an
 * `(auth "` without its closing quote, a `Basic` value) is hidden up to the cut.
 */
function maskCutLine(head: string): string {
	// Never end on half of a character that takes two UTF-16 units.
	const last = head.charCodeAt(head.length - 1);
	const whole = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
	return maskSecrets(whole)
		.replace(/(:\/\/)[^\s/?#@"'\\]*$/, "$1***")
		.replace(/(\(auth ")[^"]*$/, "$1***")
		.replace(/\bBasic[ \t]+[A-Za-z0-9+/=]*$/, "Basic ***");
}

/**
 * Write the launcher's stderr to this process's stderr, one whole line at a time
 * and with logins masked. Settles once that stderr has ended.
 *
 * A line is held until it ends, so that a login is never written in two pieces.
 * Holding is capped at `MAX_HELD_LINE` characters of one line: a longer line is
 * written as its masked start and a marker, and the rest of it is thrown away up
 * to its newline. Each new piece is searched for a newline once, so the time is
 * linear in the amount written.
 */
function relayStderr(source: Readable): Promise<void> {
	let held = "";
	let dropping = false;
	source.setEncoding("utf8");
	source.on("data", (chunk: string) => {
		let out = "";
		let from = 0;
		while (from < chunk.length) {
			const newline = chunk.indexOf("\n", from);
			const end = newline === -1 ? chunk.length : newline + 1;
			const piece = chunk.slice(from, end);
			from = end;
			if (dropping) {
				if (newline !== -1) dropping = false;
				continue;
			}
			if (held.length + piece.length > MAX_HELD_LINE) {
				out += maskCutLine((held + piece).slice(0, MAX_HELD_LINE)) + LINE_CUT_MARKER;
				held = "";
				dropping = newline === -1;
			} else if (newline === -1) {
				held += piece;
			} else {
				out += maskSecrets(held + piece);
				held = "";
			}
		}
		if (out) process.stderr.write(out);
	});
	return new Promise<void>((resolve) => {
		source.once("close", () => {
			if (held) process.stderr.write(maskSecrets(held));
			held = "";
			resolve();
		});
	});
}

/** Wait for `done`, but for at most a second. */
function soon(done: Promise<void>): Promise<void> {
	return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref())]);
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
	ensureExecutable(path);
	return path;
}

/**
 * Give a bundled launcher back its executable bit if the install lost it.
 *
 * `@nostr-agx/tailscale@0.7.0` was packed without it (pnpm only marks a
 * manifest's `bin` entries executable), so every POSIX spawn failed with
 * EACCES. The tarball is fixed, but an install that copied files without their
 * mode would fail the same way. Windows has no executable bit.
 */
export function ensureExecutable(path: string): void {
	if (process.platform === "win32") return;
	try {
		accessSync(path, constants.X_OK);
		return;
	} catch {
		// Not executable for this user: try to fix it below.
	}
	try {
		chmodSync(path, 0o755);
		accessSync(path, constants.X_OK);
	} catch (cause) {
		throw new Error(
			`The bundled agx-tailscale launcher at ${path} is not executable and could not be made so. ` +
				`Run "chmod +x ${path}" as the user who installed it, or set AGX_TAILSCALE_BINARY to a local build.`,
			{ cause },
		);
	}
}

function resolveBinary(): string {
	return process.env.AGX_TAILSCALE_BINARY ?? bundledBinaryPath();
}
