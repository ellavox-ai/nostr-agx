import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RelayProxyHandle, RelayProxyInput } from "@nostr-agx/nostr";
import type { Profile } from "../config.js";
import { configError } from "../errors.js";
import { agxHome, ensureDir } from "../paths.js";
import { runtime } from "../runtime.js";
import { rememberSecret } from "../secrets.js";
import { asCliError, type TailscaleOAuthOptions } from "./auth.js";
import { loadTailscaleSecret } from "./credentials.js";
import {
	loadTailscaleSdk,
	type TailscaleRelayConfig,
	type TailscaleStarter,
} from "./sdk.js";

export {
	DEFAULT_TAILSCALE_OAUTH_TAGS,
	isWellFormedTailscaleAuthKey,
	oauthAuthKey,
	resolveTailscaleAuthKey,
	type ResolvedAuthKey,
	type TailscaleOAuthOptions,
} from "./auth.js";
export { setTailscaleSdkLoaderForTests } from "./sdk.js";
export {
	forgetTailscaleSecret,
	loadTailscaleSecret,
	saveTailscaleSecret,
	type TailscaleSecret,
} from "./credentials.js";

/** Proxy URLs now carry per-run SOCKS credentials. Never print the raw URL:
 * it is a bearer credential for this node's tailnet identity. */
export function displayTailscaleProxyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) {
			return url;
		}
		parsed.username = "redacted";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return "[redacted proxy URL]";
	}
}

/** Whether a command should use the profile's Tailscale integration. */
export function tailscaleRequested(
	profile: Profile,
	options: { tailscale?: boolean; withoutTailscale?: boolean } = {},
): boolean {
	if (options.withoutTailscale) {
		return false;
	}
	return options.tailscale === true || profile.tailscale.enabled;
}

export interface TailscaleUseOptions {
	tailscale?: boolean;
	withoutTailscale?: boolean;
	/** One-off key from a command flag; never persisted. */
	authKey?: string | null;
	/** An OAuth client secret not stored yet, to check before it is; never persisted here. */
	oauthClientSecret?: string | null;
}

let testStarter: TailscaleStarter | undefined;

/** Tests inject a fake bundled launcher through here. */
export function setTailscaleStarterForTests(
	starter?: TailscaleStarter,
): () => void {
	const previous = testStarter;
	testStarter = starter;
	return () => {
		testStarter = previous;
	};
}

export function defaultTailscaleHostname(profileName: string): string {
	const safe = profileName
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `agx-${safe || "agent"}`;
}

/**
 * A private state dir for one node, under AGX_HOME rather than the real home
 * (so `AGX_HOME` sandboxes and profiles cannot share an enrolled identity).
 * tsnet ignores an auth key once its state holds a node, which would leave old
 * tags in place; a fresh dir per run keeps the "--state-dir default: fresh per
 * run" promise honest.
 */
function createRunStateDir(): string {
	const parent = join(agxHome(), "tailscale-runs");
	ensureDir(parent);
	const dir = mkdtempSync(join(parent, "node-"));
	// mkdtemp already uses 0700 on POSIX; chmod explicitly because this dir
	// holds the new node's private key, not just scratch state.
	ensureDir(dir);
	return dir;
}

function removeRunStateDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function envValue(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

/**
 * Resolve the profile into SDK launcher config. The key is a lazy provider:
 * environment and stored keys win over OAuth, and the minted key (if any) is
 * remembered for output redaction. Nothing here starts a node or makes a
 * network call — the SDK only resolves the provider when a proxy is created.
 */
export async function tailscaleConfigForProfile(
	profileName: string,
	profile: Profile,
	options: TailscaleUseOptions = {},
): Promise<TailscaleRelayConfig> {
	const sdk = await loadTailscaleSdk();
	const secret = loadTailscaleSecret(profileName);
	const oauth =
		profile.tailscale.authMode === "oauth"
			? oauthFor(profileName, profile, options.oauthClientSecret)
			: null;
	const explicit = options.authKey?.trim() || null;
	const storedKey =
		!explicit && profile.tailscale.authMode === "key" ? secret.authKey : null;

	const provider = sdk.firstAuthKey(
		explicit ? sdk.staticAuthKey(explicit) : null,
		sdk.environmentAuthKey({
			names: ["AGX_TAILSCALE_AUTH_KEY", "TS_AUTHKEY"],
		}),
		storedKey ? sdk.staticAuthKey(storedKey) : null,
		oauth
			? sdk.oauthAuthKey({
					...oauth,
					scope: oauth.scope ?? undefined,
					fetch: runtime().fetch,
				})
			: null,
	);
	const keyProvider = sdk.customAuthKey(async () => {
		const key = await provider.resolve();
		if (key) {
			rememberSecret(key);
		}
		return key;
	}, "profile");

	return {
		authKey: keyProvider,
		hostname: profile.tailscale.hostname ?? defaultTailscaleHostname(profileName),
		stateDir: profile.tailscale.stateDir ?? undefined,
		ephemeral: profile.tailscale.ephemeral,
		start: testStarter,
	};
}

/**
 * Start this profile's SDK-managed tsnet node and return its loopback SOCKS5
 * proxy. The caller owns the handle and must `stop()` it; in transports that is
 * handled by `NostrTransport`.
 */
export async function startTailscaleForProfile(
	profileName: string,
	profile: Profile,
	options: TailscaleUseOptions = {},
): Promise<RelayProxyHandle> {
	const config = await tailscaleConfigForProfile(profileName, profile, options);
	// An explicit state dir is the operator asking to reuse a node. Otherwise
	// give this run its own and delete it when the node is stopped.
	const runStateDir = config.stateDir ? undefined : createRunStateDir();
	if (runStateDir) {
		config.stateDir = runStateDir;
	}
	try {
		const { startTailscaleRelayProxy } = await loadTailscaleSdk();
		const proxy = await startTailscaleRelayProxy(config);
		if (!runStateDir) {
			return proxy;
		}
		let stopping: Promise<void> | undefined;
		return {
			url: proxy.url,
			stop(): Promise<void> {
				stopping ??= (async () => {
					try {
						await proxy.stop();
					} finally {
						removeRunStateDir(runStateDir);
					}
				})();
				return stopping;
			},
		};
	} catch (error) {
		if (runStateDir) {
			removeRunStateDir(runStateDir);
		}
		throw asCliError(error);
	}
}

/**
 * The lazy `relayProxy` input for `NostrTransport.create`. Returns `undefined`
 * when this run does not use Tailscale, so non-Tailscale runs are untouched.
 */
export function tailscaleRelayProxyForProfile(
	profileName: string,
	profile: Profile,
	options: TailscaleUseOptions = {},
): RelayProxyInput | undefined {
	if (!tailscaleRequested(profile, options)) {
		return undefined;
	}
	return () => startTailscaleForProfile(profileName, profile, options);
}

function oauthFor(
	profileName: string,
	profile: Profile,
	pendingClientSecret?: string | null,
): TailscaleOAuthOptions {
	const secret = loadTailscaleSecret(profileName);
	const config = profile.tailscale.oauth;
	const clientId =
		envValue("AGX_TAILSCALE_OAUTH_CLIENT_ID") ?? config.clientId;
	const clientSecret =
		pendingClientSecret?.trim() ||
		(envValue("AGX_TAILSCALE_OAUTH_CLIENT_SECRET") ?? secret.oauthClientSecret);
	if (!clientId || !clientSecret) {
		throw configError(
			`Profile "${profileName}" asks for Tailscale OAuth, but has no ${clientId ? "client secret" : "client id"}.`,
			"Configure both, keeping the secret on stdin:\n    printf %s \"$CLIENT_SECRET\" | agx tailscale enable --oauth-client-id <id> --oauth-client-secret-stdin",
		);
	}
	rememberSecret(clientSecret);
	const tokenAuth =
		envValue("AGX_TAILSCALE_OAUTH_TOKEN_AUTH") ?? config.tokenAuth;
	if (tokenAuth !== "basic" && tokenAuth !== "post") {
		throw configError(
			`The Tailscale OAuth token-auth method must be basic or post, not ${JSON.stringify(tokenAuth)}.`,
			"agx tailscale enable --oauth-token-auth basic",
		);
	}
	const tagsEnv = envValue("AGX_TAILSCALE_TAGS");
	return {
		tokenUrl: envValue("AGX_TAILSCALE_OAUTH_URL") ?? config.tokenUrl,
		tokenAuth,
		clientId,
		clientSecret,
		scope: envValue("AGX_TAILSCALE_OAUTH_SCOPE") ?? config.scope,
		tailnet: envValue("AGX_TAILSCALE_TAILNET") ?? config.tailnet,
		apiBaseUrl:
			envValue("AGX_TAILSCALE_OAUTH_API_BASE_URL") ?? config.apiBaseUrl,
		tags: tagsEnv
			? tagsEnv.split(",").map((tag) => tag.trim()).filter(Boolean)
			: config.tags,
	};
}

export interface TailscaleStatusInfo {
	enabled: boolean;
	authMode: "key" | "oauth";
	/** Credentials are present; nothing has been validated against Tailscale. */
	authReady: boolean;
	storedAuthKey: boolean;
	storedOAuthClientSecret: boolean;
	hostname: string;
	stateDir: string | null;
	ephemeral: boolean;
}

/** Describe the profile's opt-in and credential readiness without starting a node. */
export function tailscaleStatusForProfile(
	profileName: string,
	profile: Profile,
): TailscaleStatusInfo {
	const secrets = loadTailscaleSecret(profileName);
	const envKey = Boolean(envValue("AGX_TAILSCALE_AUTH_KEY") ?? envValue("TS_AUTHKEY"));
	const oauthId = Boolean(
		envValue("AGX_TAILSCALE_OAUTH_CLIENT_ID") ?? profile.tailscale.oauth.clientId,
	);
	const oauthSecret = Boolean(
		envValue("AGX_TAILSCALE_OAUTH_CLIENT_SECRET") ?? secrets.oauthClientSecret,
	);
	const authReady = !profile.tailscale.enabled
		? false
		: profile.tailscale.authMode === "oauth"
			? oauthId && oauthSecret
			: envKey || Boolean(secrets.authKey);
	return {
		enabled: profile.tailscale.enabled,
		authMode: profile.tailscale.authMode,
		authReady,
		storedAuthKey: Boolean(secrets.authKey),
		storedOAuthClientSecret: Boolean(secrets.oauthClientSecret),
		hostname: profile.tailscale.hostname ?? defaultTailscaleHostname(profileName),
		stateDir: profile.tailscale.stateDir,
		ephemeral: profile.tailscale.ephemeral,
	};
}
