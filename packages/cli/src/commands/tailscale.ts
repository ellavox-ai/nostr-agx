import {
	effectiveProfile,
	getProfile,
	resolveProfileName,
	updateProfile,
} from "../lib/config.js";
import { configError, usageError } from "../lib/errors.js";
import { heading, info, json, kv, notice } from "../lib/output.js";
import { readSecretLine, stdinIsTTY } from "../lib/stdin.js";
import {
	displayTailscaleProxyUrl,
	forgetTailscaleSecret,
	saveTailscaleSecret,
	startTailscaleForProfile,
	tailscaleStatusForProfile,
	type TailscaleStatusInfo,
} from "../lib/tailscale/index.js";

/**
 * `agx tailscale`: opt in to routing relay WebSockets through a bundled tsnet
 * node. No `tailscale` command is installed or required. The SDK starts the
 * node and returns a loopback SOCKS5 URL that `NostrTransport` uses as
 * `relayProxy`, so NIP-AGX traffic stays ordinary Nostr over a private path.
 */

export interface TailscaleEnableOptions {
	profile?: string;
	authKey?: string;
	authKeyStdin?: boolean;
	oauthUrl?: string;
	oauthClientId?: string;
	oauthClientSecret?: string;
	oauthClientSecretStdin?: boolean;
	oauthScope?: string;
	oauthTailnet?: string;
	oauthTokenAuth?: string;
	oauthApiBaseUrl?: string;
	tag?: string[];
	hostname?: string;
	stateDir?: string;
	/** Commander turns `--no-up` into `up: false`. */
	up?: boolean;
	verbose?: boolean;
}

export interface TailscaleUpOptions {
	profile?: string;
	authKey?: string;
	authKeyStdin?: boolean;
	hostname?: string;
	stateDir?: string;
	verbose?: boolean;
}

export interface TailscaleStatusOptions {
	profile?: string;
}

export interface TailscaleDisableOptions {
	profile?: string;
	forget?: boolean;
}

function tokenAuthOf(value: string | undefined): "basic" | "post" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value !== "basic" && value !== "post") {
		throw usageError(
			`--oauth-token-auth must be basic or post, not "${value}".`,
		);
	}
	return value;
}

async function secretOption(
	value: string | undefined,
	stdinFlag: boolean | undefined,
	readPipedStdin: boolean,
	what: string,
): Promise<string | undefined> {
	if (value !== undefined && stdinFlag) {
		throw usageError(`Pass the ${what} either as an option or on stdin, not both.`);
	}
	if (stdinFlag || (readPipedStdin && value === undefined && !stdinIsTTY())) {
		return await readSecretLine(what);
	}
	return value;
}

function oauthRouteRequested(options: TailscaleEnableOptions): boolean {
	return Boolean(
		options.oauthUrl ||
			options.oauthClientId ||
			options.oauthScope ||
			options.oauthTailnet ||
			options.oauthTokenAuth ||
			options.oauthApiBaseUrl ||
			options.oauthClientSecret !== undefined ||
			options.oauthClientSecretStdin ||
			(options.tag && options.tag.length > 0),
	);
}

function stateDirDescription(status: TailscaleStatusInfo): string {
	return status.stateDir ?? "fresh per run (under AGX_HOME)";
}

export async function tailscaleEnableCommand(
	options: TailscaleEnableOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = getProfile(profileName);
	if (
		(options.authKey !== undefined || options.authKeyStdin) &&
		oauthRouteRequested(options)
	) {
		throw usageError(
			"Choose one Tailscale auth route: an auth key, or OAuth. Not both.",
		);
	}
	// Only read the route that was asked for (or the one being piped in). Reading
	// both would consume the same stdin line twice.
	const oauthRequested = oauthRouteRequested(options);
	const authKey = oauthRequested
		? undefined
		: await secretOption(
				options.authKey,
				options.authKeyStdin,
				options.up !== false,
				"Tailscale auth key",
			);
	const oauthSecret = oauthRequested
		? await secretOption(
				options.oauthClientSecret,
				options.oauthClientSecretStdin,
				options.up !== false,
				"OAuth client secret",
			)
		: undefined;
	if (!oauthRequested && !authKey && options.up !== false) {
		const envKey = Boolean(
			process.env.AGX_TAILSCALE_AUTH_KEY?.trim() ||
				process.env.TS_AUTHKEY?.trim(),
		);
		if (!envKey) {
			throw usageError(
				"No Tailscale auth route was given.",
				"Pipe a key (printf %s \"$TS_AUTHKEY\" | agx tailscale enable --auth-key-stdin), configure OAuth, or store the configuration only with --no-up.",
			);
		}
	}
	if (options.authKey !== undefined && !options.authKeyStdin) {
		notice(
			"Passing the Tailscale auth key as an argument can leave it in shell history and process listings. Prefer --auth-key-stdin.",
		);
	}
	if (
		options.oauthClientSecret !== undefined &&
		!options.oauthClientSecretStdin
	) {
		notice(
			"Passing the OAuth client secret as an argument can leave it in shell history and process listings. Prefer --oauth-client-secret-stdin.",
		);
	}

	const tokenAuth = tokenAuthOf(options.oauthTokenAuth);
	const authMode: "key" | "oauth" = oauthRequested ? "oauth" : "key";

	const next = updateProfile(profileName, {
		tailscale: {
			...profile.tailscale,
			enabled: true,
			authMode,
			hostname:
				options.hostname === undefined
					? profile.tailscale.hostname
					: options.hostname || null,
			stateDir:
				options.stateDir === undefined
					? profile.tailscale.stateDir
					: options.stateDir || null,
			ephemeral: profile.tailscale.ephemeral,
			oauth: {
				...profile.tailscale.oauth,
				tokenUrl: options.oauthUrl ?? profile.tailscale.oauth.tokenUrl,
				tokenAuth: tokenAuth ?? profile.tailscale.oauth.tokenAuth,
				clientId:
					options.oauthClientId === undefined
						? profile.tailscale.oauth.clientId
						: options.oauthClientId || null,
				scope:
					options.oauthScope === undefined
						? profile.tailscale.oauth.scope
						: options.oauthScope || null,
				tailnet: options.oauthTailnet ?? profile.tailscale.oauth.tailnet,
				apiBaseUrl:
					options.oauthApiBaseUrl ?? profile.tailscale.oauth.apiBaseUrl,
				tags:
					options.tag && options.tag.length > 0
						? options.tag
						: profile.tailscale.oauth.tags,
			},
		},
	});

	if (authKey || oauthSecret) {
		saveTailscaleSecret(profileName, {
			...(authKey ? { authKey } : {}),
			...(oauthSecret ? { oauthClientSecret: oauthSecret } : {}),
		});
	}

	const status = tailscaleStatusForProfile(profileName, next);
	heading("agx tailscale enable");
	kv("profile", profileName);
	kv("enabled", "yes (opt-in)");
	kv("auth", authMode === "oauth" ? "OAuth service" : "Tailscale auth key");
	kv("hostname", status.hostname);
	kv("state dir", stateDirDescription(status));
	kv("transport", "SOCKS5 relay proxy (bundled tsnet)");

	if (options.up === false) {
		info("Not starting the proxy yet (--no-up). Run `agx tailscale up` to check it.");
		return;
	}

	// A short start/stop verifies the credentials and the bundled launcher.
	// Long-running commands start their own proxy through NostrTransport.
	const proxy = await startTailscaleForProfile(profileName, effectiveProfile(profileName));
	try {
		kv("relay proxy", displayTailscaleProxyUrl(proxy.url));
		info(
			"Verified and stopped the node. `agx serve` and `agx gateway` start their own proxy when Tailscale is enabled.",
		);
		json({
			profile: profileName,
			enabled: true,
			authMode,
			hostname: status.hostname,
			relayProxy: displayTailscaleProxyUrl(proxy.url),
		});
	} finally {
		await proxy.stop();
	}
}

export async function tailscaleUpCommand(
	options: TailscaleUpOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	let profile = effectiveProfile(profileName);
	if (!profile.tailscale.enabled) {
		throw configError(
			`Profile "${profileName}" has not opted in to Tailscale.`,
			"agx tailscale enable --auth-key-stdin   (or: agx tailscale enable --oauth-url …)",
		);
	}
	const patch: Partial<typeof profile.tailscale> = {};
	if (options.hostname) {
		patch.hostname = options.hostname;
	}
	if (options.stateDir !== undefined) {
		patch.stateDir = options.stateDir || null;
	}
	if (Object.keys(patch).length > 0) {
		updateProfile(profileName, { tailscale: { ...profile.tailscale, ...patch } });
		profile = effectiveProfile(profileName);
	}
	const authKey = await secretOption(
		options.authKey,
		options.authKeyStdin,
		false,
		"Tailscale auth key",
	);
	if (authKey) {
		notice(
			"This one-off key is not stored. Use `agx tailscale enable --auth-key-stdin` to keep it for later.",
		);
	}

	const proxy = await startTailscaleForProfile(profileName, profile, { authKey });
	try {
		const status = tailscaleStatusForProfile(profileName, profile);
		heading("agx tailscale up");
		kv("profile", profileName);
		kv("hostname", status.hostname);
		kv("state dir", stateDirDescription(status));
		kv("relay proxy", displayTailscaleProxyUrl(proxy.url));
		info(
			"Verified and stopped the node. Long-running commands start their own proxy when Tailscale is enabled.",
		);
		json({
			profile: profileName,
			hostname: status.hostname,
			relayProxy: displayTailscaleProxyUrl(proxy.url),
		});
	} finally {
		await proxy.stop();
	}
}

export async function tailscaleStatusCommand(
	options: TailscaleStatusOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const status = tailscaleStatusForProfile(profileName, profile);
	json({ profile: profileName, ...status });
	heading("agx tailscale status");
	kv("profile", profileName);
	kv("opted in", status.enabled ? "yes" : "no");
	kv("auth", status.authMode === "oauth" ? "OAuth service" : "auth key");
	kv("auth ready", status.authReady ? "yes" : "no");
	kv("hostname", status.hostname);
	kv("state dir", stateDirDescription(status));
	kv("ephemeral nodes", status.ephemeral ? "yes" : "no");
	kv("transport", "SOCKS5 relay proxy (bundled tsnet)");
	if (!status.enabled) {
		info("Tailscale is opt-in. Enable it with `agx tailscale enable`.");
	} else if (!status.authReady) {
		info(
			status.authMode === "oauth"
				? "Set the OAuth client id and secret, then run `agx tailscale up`."
				: "Store an auth key with `agx tailscale enable --auth-key-stdin`.",
		);
	}
}

export async function tailscaleDisableCommand(
	options: TailscaleDisableOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = getProfile(profileName);
	let forgot = false;
	if (options.forget) {
		forgot = forgetTailscaleSecret(profileName);
	}
	const next = updateProfile(profileName, {
		tailscale: { ...profile.tailscale, enabled: false },
	});
	heading("agx tailscale disable");
	kv("profile", profileName);
	kv("opted in", "no");
	if (options.forget) {
		kv("secrets", forgot ? "removed" : "none stored");
	}
	info(
		"Commands no longer start a Tailscale proxy for this profile. The relays in the profile are unchanged.",
	);
	json({
		profile: profileName,
		enabled: next.tailscale.enabled,
		forgot,
	});
}
