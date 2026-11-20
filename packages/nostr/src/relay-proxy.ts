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
			"Relay proxy support requires the optional socks-proxy-agent package.",
			"Install it in the host application: npm install socks-proxy-agent. The package could not be loaded because: " +
				detail,
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
	return class extends (Base as WebSocketConstructor) {
		constructor(address: string | URL, protocols?: string | string[]) {
			super(address, protocols, options);
		}
	} as WebSocketImpl;
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
