import { format } from "node:util";
import type { AgxLogger } from "@nostr-agx/core";
import { NostrTransport } from "@nostr-agx/nostr";
import WebSocket, { type ClientOptions } from "ws";
import type { Profile } from "./config.js";
import { configError } from "./errors.js";
import type { Identity } from "./identity.js";
import { errLine } from "./output.js";
import { tailscaleRelayProxyForProfile } from "./tailscale/index.js";

/** How long a relay may take to accept the WebSocket upgrade. */
export const HANDSHAKE_TIMEOUT_MS = 7_000;

/**
 * `WebSocket` from `ws`, giving up on a relay that takes the connection and
 * never answers the upgrade. `ws` sets no limit of its own, and the relay pool
 * stops waiting without closing the socket, so such a relay would hold one
 * more socket on every poll, until a long-running `agx serve` or `agx gateway`
 * ran out of file descriptors.
 *

 */
export function withHandshakeTimeout(timeoutMs: number) {
	return class extends WebSocket {
		constructor(
			address: string | URL,
			protocols?: string | string[],
			options?: ClientOptions,
		) {
			super(address, protocols, { ...options, handshakeTimeout: timeoutMs });
		}
	};
}

/**
 * Build the Nostr transport for this profile.
 *
 * `ws` is injected explicitly: Node 20 has no global WebSocket, and each
 * transport keeps its own injection (so a proxied transport cannot capture
 * another transport's relay dials).
 *
 * The relay URLs configured here are the agent's OWN, and are never SSRF-guarded
 * — only peer-advertised relays (from a NIP-65 list) and NIP-05 lookups are. So
 * a plain `ws://127.0.0.1:7447` works locally with no scheme gymnastics.
 */
export interface TransportOptions {
	/** Needed only to read this profile's private Tailscale secrets. */
	profileName?: string;
	/** Per-run Tailscale opt-in/out flags (`--tailscale`, `--without-tailscale`). */
	tailscale?: boolean;
	withoutTailscale?: boolean;
}

export function createTransport(
	profile: Profile,
	identity: Identity,
	logger?: AgxLogger,
	options: TransportOptions = {},
): Promise<NostrTransport> {
	if (profile.relays.length === 0) {
		throw configError(
			"This profile has no relays configured.",
			"agx config set relays ws://127.0.0.1:7447\n  and run a local relay with:\n    agx relay",
		);
	}
	// A lazy proxy means the bundled tsnet node starts only when the transport
	// is created, and NostrTransport owns its stop() on shutdown.
	const relayProxy = tailscaleRelayProxyForProfile(
		options.profileName ?? "default",
		profile,
		options,
	);
	return NostrTransport.create({
		signer: identity.signer,
		relays: profile.relays,
		ws: withHandshakeTimeout(HANDSHAKE_TIMEOUT_MS),
		logger,
		relayProxy,
	});
}

/** A logger that only speaks when asked. The transport warns on undecryptable
 * events, which is noise during a demo but essential when debugging one. */
export function makeLogger(verbose: boolean): AgxLogger | undefined {
	if (!verbose) {
		return undefined;
	}
	// `format` writes the line the way `console.error` would, so the scrub sees the
	// text that would have been printed, including what is inside `meta`.
	return {
		debug: (message: string, meta?: unknown) =>
			errLine(format("[agx:debug]", message, meta ?? "")),
		info: (message: string, meta?: unknown) =>
			errLine(format("[agx:info]", message, meta ?? "")),
		warn: (message: string, meta?: unknown) =>
			errLine(format("[agx:warn]", message, meta ?? "")),
		error: (message: string, meta?: unknown) =>
			errLine(format("[agx:error]", message, meta ?? "")),
	};
}
