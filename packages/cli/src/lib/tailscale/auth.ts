import { AgxCliError, EXIT } from "../errors.js";
import { isTailscaleError, loadTailscaleSdk } from "./sdk.js";
import { runtime } from "../runtime.js";
import { rememberSecret } from "../secrets.js";

/**
 * Getting an auth key into the SDK's bundled tsnet node. Two supported routes:
 *
 *   1. a Tailscale auth key (`tskey-…`), supplied directly, through the
 *      environment, or stored by `agx tailscale enable`;
 *   2. an OAuth client-credentials call to an authentication service. The
 *      service may return the auth key itself, or an access token that the SDK
 *      exchanges for a short-lived key through the Tailscale API.
 *
 * The key is a bearer credential. It is never printed, never put in argv, and
 * is remembered for error redaction before any request carries it. Minting is
 * delegated to the SDK; this module only keeps the CLI's error shape.
 */

export interface TailscaleOAuthOptions {
	/** Accepts Tailscale's token endpoint or a custom authentication service. */
	tokenUrl: string;
	/** `basic`: client_secret_basic. `post`: client_secret_post. */
	tokenAuth?: "basic" | "post";
	clientId: string;
	clientSecret: string;
	scope?: string | null;
	tailnet?: string;
	/** Where to mint a key when the response is an access token, not a key. */
	apiBaseUrl?: string;
	tags?: string[];
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export interface ResolveAuthKeyOptions {
	/** A one-off key from `--auth-key` or the profile store. */
	authKey?: string | null;
	/** Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Used only when no direct key is available. */
	oauth?: TailscaleOAuthOptions | null;
}

export interface ResolvedAuthKey {
	authKey: string;
	source: "argument" | "env" | "oauth";
}

const ENV_AUTH_KEYS = ["AGX_TAILSCALE_AUTH_KEY", "TS_AUTHKEY"] as const;

/** ACL tag applied to OAuth-minted keys when none is configured. */
export { DEFAULT_TAILSCALE_OAUTH_TAGS } from "./sdk.js";

/** Printable, non-empty, no whitespace/control characters. Real keys are
 * `tskey-…`; this only rejects what can never be a key. */
export function isWellFormedTailscaleAuthKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 2048 &&
		!/[\s\x00-\x1f\x7f]/.test(value)
	);
}

function malformedKey(where: string): AgxCliError {
	return new AgxCliError(
		`${where} is not a valid Tailscale auth key: it is empty, too long, or contains spaces or control characters. It was not passed to the node.`,
		{
			exitCode: EXIT.config,
			remediation:
				"Pipe a single key on stdin, which keeps it out of argv:\n    printf %s \"$TS_AUTHKEY\" | agx tailscale enable --auth-key-stdin",
		},
	);
}

export async function resolveTailscaleAuthKey(
	options: ResolveAuthKeyOptions = {},
): Promise<ResolvedAuthKey> {
	const direct = options.authKey?.trim();
	if (direct) {
		if (!isWellFormedTailscaleAuthKey(direct)) {
			throw malformedKey("The provided Tailscale auth key");
		}
		rememberSecret(direct);
		return { authKey: direct, source: "argument" };
	}
	const env = options.env ?? process.env;
	for (const name of ENV_AUTH_KEYS) {
		const value = env[name]?.trim();
		if (value) {
			if (!isWellFormedTailscaleAuthKey(value)) {
				throw malformedKey(name);
			}
			rememberSecret(value);
			return { authKey: value, source: "env" };
		}
	}
	if (options.oauth) {
		const key = await oauthAuthKey(options.oauth);
		rememberSecret(key);
		return { authKey: key, source: "oauth" };
	}
	throw new AgxCliError(
		"No Tailscale auth key is configured for this profile.",
		{
			exitCode: EXIT.config,
			remediation:
				"Store one, or configure an OAuth service:\n    printf %s \"$TS_AUTHKEY\" | agx tailscale enable --auth-key-stdin\n    agx tailscale enable --oauth-url https://api.tailscale.com/api/v2/oauth/token --oauth-client-id <id> --oauth-client-secret-stdin",
		},
	);
}

/**
 * Ask the SDK's OAuth provider for a key. A custom service can answer
 * `{ "authKey": "tskey-…" }`; Tailscale's OAuth endpoint answers
 * `{ "access_token": … }`, which the SDK exchanges for an ephemeral,
 * preauthorized key through the API. Errors carry the service's OAuth error
 * code and description, never the whole body; the client secret and the
 * resulting key are remembered for output redaction.
 */
export async function oauthAuthKey(
	options: TailscaleOAuthOptions,
): Promise<string> {
	const clientSecret = options.clientSecret.trim();
	if (!clientSecret) {
		throw new AgxCliError("The OAuth client secret is empty.", {
			exitCode: EXIT.config,
			remediation:
				"Pipe the secret on stdin so it stays out of argv:\n    printf %s \"$CLIENT_SECRET\" | agx tailscale enable --oauth-client-secret-stdin",
		});
	}
	rememberSecret(clientSecret);

	let key: string | undefined;
	try {
		const sdk = await loadTailscaleSdk();
		key = await sdk.oauthAuthKey({
			clientId: options.clientId,
			clientSecret,
			tokenUrl: options.tokenUrl,
			tokenAuth: options.tokenAuth,
			scope: options.scope ?? undefined,
			tailnet: options.tailnet,
			apiBaseUrl: options.apiBaseUrl,
			tags: options.tags,
			fetch: options.fetch ?? runtime().fetch,
			timeoutMs: options.timeoutMs,
		}).resolve();
	} catch (error) {
		throw asCliError(error);
	}
	if (!key) {
		throw new AgxCliError("The OAuth service did not return a Tailscale auth key.", {
			exitCode: EXIT.remote,
			remediation:
				'Return { "authKey": "tskey-…" } from the service, or a standard { "access_token": … } for Tailscale\'s API.',
		});
	}
	rememberSecret(key);
	return key;
}

/** Keep the CLI's exit codes and remediation while the SDK owns the message. */
export function asCliError(error: unknown): AgxCliError {
	if (error instanceof AgxCliError) {
		return error;
	}
	if (isTailscaleError(error)) {
		const exitCode =
			error.code === "configuration"
				? EXIT.config
				: error.code === "auth"
					? EXIT.auth
					: EXIT.network;
		return new AgxCliError(error.message, {
			exitCode,
			remediation: error.remediation ?? null,
		});
	}
	return new AgxCliError(
		error instanceof Error ? error.message : String(error),
		{
			exitCode: EXIT.generic,
			remediation: "Check the Tailscale configuration and retry.",
		},
	);
}
