import type { WebSocketImpl } from "./ws";

/**
 * SOCKS5 routing for relay connections.
 *
 * This is a transport concern, not a protocol one: AGX still speaks Nostr, but
 * the WebSocket dials leave through a local proxy instead of the host network.
 * That is what makes an otherwise private relay reachable without exposing it
 * publicly — for example the loopback SOCKS5 proxy a local tsnet node opens
 * after joining a tailnet.
 *
 * A proxy is entirely opt-in. Omitting it leaves relay connections exactly as
 * they were.
 */

/** A running proxy plus the cleanup for whatever provides it. */
export interface RelayProxyHandle {
	/** SOCKS5 URL, such as `socks5://127.0.0.1:54321`. */
	readonly url: string;
	/** Stop the proxy provider (e.g. the Tailscale child process). Idempotent. */
	stop(): Promise<void>;
}

/**
 * How a caller can supply a proxy:
 * - a SOCKS5 URL;
 * - a running handle, whose `stop()` the transport will call;
 * - a lazy function returning either, so the proxy can be started only when the
 *   transport is created and the handle can be owned by someone else.
 */
export type RelayProxyInput =
	| string
	| RelayProxyHandle
	| (() =>
			| string
			| RelayProxyHandle
			| undefined
			| Promise<string | RelayProxyHandle | undefined>);

const NOOP_STOP = async (): Promise<void> => {};

/** Marks a handle whose proxy the transport borrowed rather than started. */
const BORROWED = Symbol("agx.borrowedRelayProxy");

/** True when the transport should NOT treat `stop()` as ending the proxy. A bare
 * URL points at something another part of the process owns, so the transport
 * never stopped it and can start again. */
export function isBorrowedRelayProxy(handle: RelayProxyHandle): boolean {
	return (handle as RelayProxyHandle & { [BORROWED]?: true })[BORROWED] === true;
}

/** Protocols `socks-proxy-agent` understands. Tailscale reports `socks5://`. */
const SOCKS_PROTOCOLS = new Set([
	"socks:",
	"socks4:",
	"socks4a:",
	"socks5:",
	"socks5h:",
]);

/** True for a started proxy object rather than a bare URL. */
export function isRelayProxyHandle(value: unknown): value is RelayProxyHandle {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as RelayProxyHandle).url === "string" &&
		typeof (value as RelayProxyHandle).stop === "function"
	);
}

/**
 * Normalize any {@link RelayProxyInput} into a handle, or `undefined` when the
 * input resolves to nothing. Lazy inputs are unwrapped (bounded, so a function
 * that returns itself fails loudly instead of recursing forever).
 */
export async function resolveRelayProxy(
	input: RelayProxyInput | undefined,
): Promise<RelayProxyHandle | undefined> {
	return resolveRelayProxyAt(input, 0);
}

async function resolveRelayProxyAt(
	input: RelayProxyInput | undefined,
	depth: number,
): Promise<RelayProxyHandle | undefined> {
	if (input === undefined) {
		return undefined;
	}
	if (depth > 4) {
		throw new RelayProxyError(
			"A relay proxy resolver returned another resolver more than four times.",
			"Pass a SOCKS5 URL or a handle with { url, stop() } instead of a self-returning function.",
		);
	}
	if (typeof input === "function") {
		return resolveRelayProxyAt(await input(), depth + 1);
	}
	if (typeof input === "string") {
		return {
			url: assertSocksProxyUrl(input),
			stop: NOOP_STOP,
			[BORROWED]: true,
		} as RelayProxyHandle;
	}
	if (isRelayProxyHandle(input)) {
		try {
			return {
				url: assertSocksProxyUrl(input.url),
				stop: () => input.stop(),
			};
		} catch (error) {
			// The handle may already own a process (a tsnet node, for example).
			// Rejecting its URL must not strand it with nobody left to stop it.
			await input.stop().catch(() => undefined);
			throw error;
		}
	}
	throw new RelayProxyError(
		"The relay proxy is not a SOCKS5 URL or a proxy handle.",
		"Use a string such as socks5://127.0.0.1:1080, or a handle with { url, stop() } from a proxy provider.",
	);
}

/** Reject anything that is not a usable SOCKS URL before a WebSocket tries it. */
function assertSocksProxyUrl(raw: string): string {
	const value = raw.trim();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RelayProxyError(
			"The relay proxy URL is not a URL.",
			"Use a SOCKS5 URL such as socks5://127.0.0.1:1080.",
		);
	}
	if (!SOCKS_PROTOCOLS.has(url.protocol)) {
		throw new RelayProxyError(
			`The relay proxy URL uses ${url.protocol}, which is not a SOCKS protocol.`,
			"Use a socks5:// or socks5h:// URL with a host and port.",
		);
	}
	if (!url.hostname || !url.port) {
		throw new RelayProxyError(
			"The relay proxy URL must include a host and port.",
			"Use a SOCKS5 URL such as socks5://127.0.0.1:1080.",
		);
	}
	return value;
}

/** A Node-style lookup function, used to pin a hostname to vetted addresses
 * instead of letting the SOCKS proxy resolve it again. */
export type DnsLookup = (
	hostname: string,
	options: Record<string, unknown>,
	callback: (error: Error | null, address?: string, family?: number) => void,
) => void;

export interface ProxyWebSocketOptions {
	/** `remote` (default) resolves at the proxy so Tailnet MagicDNS works;
	 * `pinned` keeps local-DNS SOCKS semantics and uses `lookup` for the name. */
	dns?: "remote" | "pinned";
	/** Only meaningful with `dns: "pinned"`. Must fail closed for unknown hosts. */
	lookup?: DnsLookup;
}

/**
 * Wrap a WebSocket implementation so every connection dials through `proxyUrl`.
 *
 * `base` is the implementation the host already injects (`ws` in Node). The
 * returned class extends it, so `nostr-tools` sees the same static constants and
 * instance behaviour; only the dial changes. Options are passed as the third
 * constructor argument, which `ws` understands and browsers ignore.
 */
export async function createProxyWebSocket(
	proxyUrl: string,
	base?: WebSocketImpl,
	options: ProxyWebSocketOptions = {},
): Promise<WebSocketImpl> {
	if (!base) {
		// A global WHATWG WebSocket accepts no socket options, so an agent would be
		// silently ignored and traffic would leave directly. Fail instead of
		// pretending the proxy is in use.
		throw new RelayProxyError(
			"A relay proxy requires an explicit WebSocket implementation.",
			"Pass the Node `ws` package as `ws` in the transport config; its constructor accepts a SOCKS agent.",
		);
	}
	const validated = assertSocksProxyUrl(proxyUrl);
	const url =
		options.dns === "pinned"
			? localDnsProxyUrl(validated)
			: remoteDnsProxyUrl(validated);
	const { SocksProxyAgent } = await loadSocksProxyAgent();
	const agent = new SocksProxyAgent(url);
	return wrapWebSocket(base, {
		agent,
		...(options.dns === "pinned" && options.lookup
			? { lookup: options.lookup }
			: {}),
	});
}

/**
 * Resolve relay hostnames at the proxy, not on the host.
 *
 * Tailscale's loopback proxy knows the tailnet's MagicDNS names; the host may
 * not. `socks5://` in `socks-proxy-agent` means "look the name up locally", so
 * a `.ts.net` relay would fail before the proxy ever sees it. The `h`/`a`
 * variants ask the proxy to resolve instead, which is the whole point of
 * routing through a tailnet node.
 */
/** `socks-proxy-agent` is opt-in: only callers using `relayProxy` need it. A
 * missing optional peer should say so instead of surfacing a raw ESM error. */
async function loadSocksProxyAgent(): Promise<{
	SocksProxyAgent: new (url: string) => unknown;
}> {
	try {
		return await import("socks-proxy-agent");
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new RelayProxyError(
			`Relay proxy support could not load the optional socks-proxy-agent package: ${detail}`,
			"If it is not installed, install it in the host application: npm install socks-proxy-agent. If it is installed and the reason mentions a dynamic require, a bundler has copied it into the bundle: keep socks-proxy-agent out of the bundle (mark it external).",
			{ cause },
		);
	}
}

function remoteDnsProxyUrl(url: string): string {
	if (/^socks5:/i.test(url)) {
		return url.replace(/^socks5:/i, "socks5h:");
	}
	if (/^socks4:/i.test(url)) {
		return url.replace(/^socks4:/i, "socks4a:");
	}
	return url;
}

/** Inverse of {@link remoteDnsProxyUrl}: used for untrusted peer relays, whose
 * hostnames have already been vetted by local DNS and must not be resolved a
 * second time by the proxy. */
function localDnsProxyUrl(url: string): string {
	if (/^socks5h:/i.test(url)) {
		return url.replace(/^socks5h:/i, "socks5:");
	}
	if (/^socks4a:/i.test(url)) {
		return url.replace(/^socks4a:/i, "socks4:");
	}
	// `socks:` names no version, and `socks-proxy-agent` reads it as SOCKS5 with
	// the proxy resolving the name. SOCKS5 with local lookup is what is wanted.
	if (/^socks:/i.test(url)) {
		return url.replace(/^socks:/i, "socks5:");
	}
	return url;
}

type WebSocketConstructor = new (
	address: string | URL,
	protocols?: string | string[],
	options?: Record<string, unknown>,
) => object;

/**
 * Extend a WebSocket implementation with extra constructor options. Exported so
 * callers can compose other `ws` options (handshake timeouts, TLS settings)
 * with a proxy without having to know the subclass chain.
 *
 * Two invariants hold here, because a proxy that silently isn't used is the
 * worst possible outcome (traffic leaves the host DIRECTLY while the transport
 * still reports `relayProxyUrl`):
 *
 * 1. The wrapper accepts a third constructor argument and merges it under its
 *    own options, so wrapping a wrapped class keeps every option alive. A base
 *    that ignores the argument is caught below instead of trusted.
 * 2. If the base is `ws`-derived, the agent's arrival is VERIFIED:
 *    `ws` builds its HTTP request synchronously in the constructor and records
 *    it on `this._req`, so the moment `super()` returns we can tell whether the
 *    options were forwarded. A subclass that dropped them (e.g. a constructor
 *    that calls `super(address, protocols)` with its own options) is refused
 *    with a {@link RelayProxyError} — fail closed, not fail open. The check
 *    is made once, here, with a stand-in agent and a local socket path, so no
 *    relay is dialed to find out. It is repeated on every dial as well: a
 *    class that dropped the agent only for some addresses would otherwise
 *    start a direct connection that this check could only cut short.
 * 3. The runtime's built-in WebSocket (and a class extending it) takes no
 *    socket options and records no request, so it cannot be verified and is
 *    refused: with it the agent would be ignored without a sign.
 */
export function wrapWebSocket(
	base: WebSocketImpl | undefined,
	options: Record<string, unknown>,
): WebSocketImpl {
	const Base = (base ??
		(globalThis as { WebSocket?: unknown }).WebSocket) as
		| WebSocketConstructor
		| undefined;
	if (typeof Base !== "function") {
		throw new RelayProxyError(
			"No WebSocket implementation is available.",
			"Pass `ws` (the npm package) as `ws` in the transport config, or use a runtime with a global WebSocket.",
		);
	}
	const agent = options.agent;
	if (agent !== undefined) {
		assertAgentForwarded(Base as WebSocketConstructor, options);
	}
	return class extends (Base as WebSocketConstructor) {
		constructor(
			address: string | URL,
			protocols?: string | string[],
			more?: Record<string, unknown>,
		) {
			super(address, protocols, { ...more, ...options });
			if (agent === undefined) {
				return;
			}
			const req = recordedRequest(this);
			if (!req || req.agent === agent) {
				return;
			}
			// The base already started dialing DIRECTLY. Destroy that request
			// before throwing.
			abandonRequest(this, req);
			throw droppedAgentError();
		}
	} as WebSocketImpl;
}

/** The HTTP request `ws` started for an instance, as far as this file looks. */
interface RecordedRequest {
	agent?: unknown;
	destroy(cause?: Error): void;
}

/** Only a `ws`-derived implementation records its request; anything else (test
 * doubles) gives us nothing to check. */
function recordedRequest(instance: object): RecordedRequest | undefined {
	return (instance as { _req?: RecordedRequest })._req;
}

/** Destroy a request the base class started. `ws`'s own error emission on the
 * instance is quieted first, or the discarded EventEmitter crashes the process
 * with an unhandled 'error' event. */
function abandonRequest(instance: object, req: RecordedRequest): void {
	(instance as { on(event: string, listener: () => void): void }).on(
		"error",
		() => {},
	);
	req.destroy();
}

function droppedAgentError(): RelayProxyError {
	return new RelayProxyError(
		"The WebSocket implementation ignored the proxy agent.",
		"The WebSocket constructor must forward its third argument (the options) to super — see withHandshakeTimeout in @nostr-agx/cli for the shape to copy.",
	);
}

/** A socket path nothing listens on. A class that drops the options dials this
 * and finds nothing, so checking a class never touches the network. */
const CHECK_ADDRESS = "ws+unix:///agx-relay-proxy-check.sock:/";

/**
 * True for the WebSocket the runtime ships (Node 22 and later) and for a class
 * that extends it. It takes no socket options, so a proxy agent handed to it is
 * ignored and every dial goes straight to the relay. It records no request and
 * refuses the check address, so neither check below can see that.
 */
function isBuiltInWebSocket(Base: WebSocketConstructor): boolean {
	const builtIn = (globalThis as { WebSocket?: unknown }).WebSocket;
	return (
		typeof builtIn === "function" &&
		(Base === builtIn || Base.prototype instanceof builtIn)
	);
}

function builtInWebSocketError(): RelayProxyError {
	return new RelayProxyError(
		"The built-in WebSocket of this runtime cannot be used with a relay proxy: it ignores the proxy agent.",
		"Pass the WebSocket class of the `ws` package (npm install ws) as `ws` in the transport config.",
	);
}

/**
 * Check, once, that a WebSocket class forwards its options: build one socket
 * with a stand-in agent that never connects, and see whether the request `ws`
 * recorded carries it. The runtime's built-in WebSocket cannot be checked this
 * way and is refused outright. Any other class that cannot be checked (it
 * records no request, or refuses the check address) is accepted here and not
 * covered by the check on each dial either, which also needs the recorded
 * request.
 */
function assertAgentForwarded(
	Base: WebSocketConstructor,
	options: Record<string, unknown>,
): void {
	if (isBuiltInWebSocket(Base)) {
		throw builtInWebSocketError();
	}
	const standIn = { addRequest(): void {} };
	let probe: object;
	try {
		probe = new Base(CHECK_ADDRESS, undefined, { ...options, agent: standIn });
	} catch {
		return;
	}
	const req = recordedRequest(probe);
	if (!req) {
		return;
	}
	abandonRequest(probe, req);
	if (req.agent !== standIn) {
		throw droppedAgentError();
	}
}

/** A configuration or provider failure while setting up relay routing. */
export class RelayProxyError extends Error {
	/** What the caller can do about it. Never contains a credential. */
	readonly remediation?: string;

	constructor(message: string, remediation?: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RelayProxyError";
		this.remediation = remediation;
	}
}
