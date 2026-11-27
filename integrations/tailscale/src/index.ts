import type {
	RelayProxyHandle,
	RelayProxyInput,
} from "@nostr-agx/nostr";
import {
	resolveTailscaleAuthKey,
	type TailscaleAuthKeyInput,
} from "./auth-key";
import { TailscaleError } from "./errors";
import { startBundledTailscale, type BundledTailscaleExit } from "./launcher";

export {
	DEFAULT_TAILSCALE_AUTH_KEY_ENV,
	DEFAULT_TAILSCALE_OAUTH_TAGS,
	customAuthKey,
	environmentAuthKey,
	firstAuthKey,
	isWellFormedTailscaleAuthKey,
	oauthAuthKey,
	resolveTailscaleAuthKey,
	staticAuthKey,
	type TailscaleAuthKeyInput,
	type TailscaleAuthKeyProvider,
	type TailscaleOAuthOptions,
} from "./auth-key";
export { TailscaleError, type TailscaleErrorCode } from "./errors";
export {
	bundledBinaryPath,
	startBundledTailscale,
	type BundledTailscaleExit,
	type BundledTailscaleProxy,
	type StartBundledTailscaleOptions,
} from "./launcher";

/** Options accepted by the bundled tsnet launcher. */
export interface TailscaleStartOptions {
	/** Tailscale auth key. Resolved from {@link TailscaleRelayConfig.authKey} first. */
	authKey?: string;
	/** Tailscale hostname. Defaults to `nostr-agx`. */
	hostname?: string;
	/**
	 * Persistent tsnet state directory. A node enrolled in it is reused, and the
	 * directory is kept when the node stops. When omitted, the node gets a private
	 * temporary directory of its own, deleted when it stops.
	 */
	stateDir?: string;
	/** Alternative coordination server URL. */
	controlUrl?: string;
	/** Register an ephemeral node. */
	ephemeral?: boolean;
	/**
	 * Do not let Tailscale upload this node's client logs to `log.tailscale.com`,
	 * which tsnet does by default. Tailscale's documentation says this also opts the
	 * device out of support that would need those logs. Defaults to false, so the
	 * launcher's default applies unless `TS_NO_LOGS_NO_SUPPORT` is set in this
	 * process.
	 */
	disableLogUpload?: boolean;
	/** ACL tags such as `tag:agx-agent`. */
	tags?: string[];
	/** SOCKS5 listen address. Must be loopback. Defaults to `127.0.0.1:0`. */
	listen?: string;
	/** How long to wait for the tailnet and the SOCKS5 address. Defaults to 120s. */
	timeoutMs?: number;
	/** Override the platform binary path, mainly for development. */
	binary?: string;
}

/** The started node, as returned by the bundled launcher. */
export interface TailscaleProxy {
	/** SOCKS5 URL, suitable as a relay proxy. */
	readonly url: string;
	/** Proxy address as `host:port`, when the launcher reports it. */
	readonly address?: string;
	readonly host?: string;
	readonly port?: number;
	/** Stop the child process. Idempotent. */
	stop(): Promise<void>;
	/**
	 * Call `listener` if the launcher ends on its own; returns a function that
	 * removes it. Optional, so a custom {@link TailscaleStarter} need not offer it.
	 */
	onExit?(listener: (exit: BundledTailscaleExit) => void): () => void;
}

/**
 * What {@link startTailscaleRelayProxy} returns: a relay proxy handle that can
 * also tell you when the launcher ends without `stop()`. A transport that is
 * given this handle keeps only `url` and `stop()`, so subscribe before handing
 * it over.
 */
export interface TailscaleRelayProxyHandle extends RelayProxyHandle {
	/**
	 * Call `listener` if the launcher ends without `stop()` having been called, for
	 * example because it crashed. From then on `url` no longer works. Returns a
	 * function that removes the listener. A launcher that offers no such notice
	 * (a custom {@link TailscaleStarter}) never calls it.
	 */
	onExit(listener: (exit: BundledTailscaleExit) => void): () => void;
}

/** Replace the default launcher, e.g. to inject a fake in tests. */
export type TailscaleStarter = (
	options: TailscaleStartOptions,
) => Promise<TailscaleProxy>;

/**
 * Opt-in Tailscale routing for relay connections.
 *
 * ```ts
 * await NostrTransport.create({
 *   signer,
 *   relays: ["wss://relay.private.ts.net"],
 *   ws: WebSocket,
 *   relayProxy: tailscaleRelayProxy({
 *     authKey: firstAuthKey(
 *       environmentAuthKey(),
 *       oauthAuthKey({ clientId, clientSecret, tags: ["tag:agx-agent"] }),
 *     ),
 *     hostname: "my-agent",
 *   }),
 * });
 * ```
 *
 * Pass the result of {@link tailscaleRelayProxy} as the transport's
 * `relayProxy`. `@nostr-agx/nostr` has no Tailscale dependency of its own.
 */
export interface TailscaleRelayConfig
	extends Omit<TailscaleStartOptions, "authKey"> {
	/**
	 * Direct key, provider, or lazy callback. When omitted, `TS_AUTHKEY` and
	 * `AGX_TAILSCALE_AUTH_KEY` are read in that order.
	 */
	authKey?: TailscaleAuthKeyInput;
	/**
	 * Custom launcher. Defaults to the bundled tsnet launcher; inject another
	 * implementation in tests or when driving a separately managed binary.
	 */
	start?: TailscaleStarter;
}

/**
 * Start a local tsnet node and return its loopback SOCKS5 proxy as a
 * {@link RelayProxyHandle}. The auth key is resolved first and passed through
 * the child's environment by the launcher; it never appears in argv.
 */
export async function startTailscaleRelayProxy(
	config: TailscaleRelayConfig = {},
): Promise<TailscaleRelayProxyHandle> {
	const starter = config.start ?? startBundledTailscale;
	const authKey = await resolveTailscaleAuthKey(config.authKey);
	const options: TailscaleStartOptions = {
		authKey,
		hostname: config.hostname ?? "nostr-agx",
		stateDir: config.stateDir,
		controlUrl: config.controlUrl,
		ephemeral: config.ephemeral,
		disableLogUpload: config.disableLogUpload,
		tags: config.tags,
		listen: config.listen,
		timeoutMs: config.timeoutMs,
		binary: config.binary,
	};

	let proxy: TailscaleProxy;
	try {
		proxy = await starter(options);
	} catch (error) {
		if (error instanceof TailscaleError) {
			throw error;
		}
		throw launcherError(error);
	}
	if (
		!proxy ||
		typeof proxy.url !== "string" ||
		typeof proxy.stop !== "function"
	) {
		throw new TailscaleError(
			"module",
			"The bundled Tailscale launcher returned no usable proxy.",
			"The launcher must return { url, stop() }.",
		);
	}
	return {
		url: proxy.url,
		stop: () => proxy.stop(),
		onExit: (listener) => proxy.onExit?.(listener) ?? (() => {}),
	};
}

/**
 * The drop-in bridge to `NostrTransport`: a lazy {@link RelayProxyInput} that
 * starts the node when the transport is created and hands its lifecycle over.
 *
 * ```ts
 * const transport = await NostrTransport.create({
 *   signer,
 *   relays,
 *   ws: WebSocket,
 *   relayProxy: tailscaleRelayProxy({ authKey }),
 * });
 * ```
 *
 * Because the lazy resolver returns a handle rather than a bare URL, the
 * transport owns the node: `transport.stop()` closes the subscriptions first,
 * then stops the Tailscale child process. The transport cannot be restarted
 * afterwards — create a new one, or start Tailscale once and pass its `.url`.
 */
export function tailscaleRelayProxy(
	config: TailscaleRelayConfig = {},
): RelayProxyInput {
	return () => startTailscaleRelayProxy(config);
}

function launcherError(error: unknown): TailscaleError {
	const message = error instanceof Error ? error.message : String(error);
	const missingBinary = /bundled|binary|AGX_TAILSCALE_BINARY|platform/i.test(message);
	return new TailscaleError(
		missingBinary ? "module" : "network",
		`The local Tailscale node could not start. ${message}`,
		missingBinary
			? 'Rebuild the bundled launcher with "make -C launcher stage", or set AGX_TAILSCALE_BINARY to a local build.'
			: "Check the auth key, the tailnet ACLs, and this machine's network, then retry.",
		{ cause: error },
	);
}
