import { TailscaleError } from "./errors";

/**
 * Where the Tailscale auth key comes from.
 *
 * A key is a bearer credential: whoever has it can add a node to the tailnet
 * (within its tags). Nothing here logs, prints, or returns it except to the
 * starter that hands it to the local tsnet node.
 *
 * Providers are deliberately small and composable:
 *
 * ```ts
 * authKey: firstAuthKey(
 *   staticAuthKey(process.env.TS_AUTHKEY),
 *   oauthAuthKey({ clientId, clientSecret }), // defaults to tag:agx-agent
 * )
 * ```
 */

export interface TailscaleAuthKeyProvider {
	/** Human-readable source, used only in diagnostics. Never the key itself. */
	readonly name: string;
	/** Resolve a key, or `undefined` when this source has nothing to offer. */
	resolve(): Promise<string | undefined>;
}

/** A direct key, a provider, or a lazy callback. */
export type TailscaleAuthKeyInput =
	| string
	| TailscaleAuthKeyProvider
	| (() =>
			| string
			| null
			| undefined
			| Promise<string | null | undefined>);

/** Environment variable read by default, in order. */
export const DEFAULT_TAILSCALE_AUTH_KEY_ENV = [
	"TS_AUTHKEY",
	"AGX_TAILSCALE_AUTH_KEY",
] as const;

/**
 * A key already in hand. This is the `authKey` argument route: prefer it over
 * `TS_AUTHKEY` when the key comes from a vault or from the control plane.
 */
export function staticAuthKey(key: string): TailscaleAuthKeyProvider {
	return {
		name: "argument",
		async resolve() {
			const value = key.trim();
			return value || undefined;
		},
	};
}

/**
 * Read the key from the environment. `TS_AUTHKEY` is the variable the bundled
 * `agx-tailscale` binary itself understands; the `AGX_` name keeps it possible
 * to run several profiles with different keys.
 */
export function environmentAuthKey(
	options: {
		env?: NodeJS.ProcessEnv;
		/** One name or an ordered list. Defaults to {@link DEFAULT_TAILSCALE_AUTH_KEY_ENV}. */
		names?: string | readonly string[];
	} = {},
): TailscaleAuthKeyProvider {
	const names =
		typeof options.names === "string"
			? [options.names]
			: (options.names ?? DEFAULT_TAILSCALE_AUTH_KEY_ENV);
	return {
		name: `env(${names.join(",")})`,
		async resolve() {
			const env = options.env ?? process.env;
			for (const name of names) {
				const value = env[name]?.trim();
				if (value) {
					return value;
				}
			}
			return undefined;
		},
	};
}

/**
 * Any callback that can produce a key: a control-plane API, a vault, a KMS, a
 * file. The callback owns caching, refresh, and revocation.
 */
export function customAuthKey(
	resolve: () => string | null | undefined | Promise<string | null | undefined>,
	name = "custom",
): TailscaleAuthKeyProvider {
	return {
		name,
		async resolve() {
			return (await resolve()) ?? undefined;
		},
	};
}

/**
 * Try providers in order and use the first that returns a key. An absent source
 * (`undefined`/empty) falls through; a PRESENT but malformed key fails loudly
 * rather than silently trying the next one, because that is a configuration
 * error the developer needs to see.
 */
export function firstAuthKey(
	...inputs: Array<TailscaleAuthKeyInput | null | undefined>
): TailscaleAuthKeyProvider {
	const providers = inputs
		.filter((input): input is TailscaleAuthKeyInput => input != null)
		.map((input) => toProvider(input));
	return {
		name: providers.map((provider) => provider.name).join(" -> "),
		async resolve() {
			for (const provider of providers) {
				const value = (await provider.resolve())?.trim();
				if (!value) {
					continue;
				}
				assertWellFormedAuthKey(value, provider.name);
				return value;
			}
			return undefined;
		},
	};
}

/** OAuth client-credentials settings for minting a short-lived auth key. */
export interface TailscaleOAuthOptions {
	/** OAuth client id from the Tailscale admin console (or a custom service). */
	clientId: string;
	/** OAuth client secret. Keep it in a secret store, never in source. */
	clientSecret: string;
	/** `basic` (default) or `post` client authentication at the token endpoint. */
	tokenAuth?: "basic" | "post";
	/**
	 * Token endpoint. Defaults to Tailscale's, derived from {@link apiBaseUrl}.
	 * A custom service may answer `{ "authKey": "tskey-…" }` directly.
	 */
	tokenUrl?: string;
	/** Scopes to request, when the service needs them. Tailscale fixes them on
	 * the OAuth client instead. */
	scope?: string;
	/** Tailnet name, or `-` (default) for the token's own tailnet. */
	tailnet?: string;
	/** API base used to mint a key when the token response is an access token. */
	apiBaseUrl?: string;
	/**
	 * Tags for the minted key. Defaults to {@link DEFAULT_TAILSCALE_OAUTH_TAGS}.
	 * Tailscale requires at least one tag; these must already exist in tailnet
	 * policy and be allowed by the OAuth client.
	 */
	tags?: string[];
	/** Key lifetime. Defaults to one hour; the node's own key persists after
	 * enrollment, so a short window is normally enough. */
	expirySeconds?: number;
	/** Register the device as ephemeral. Defaults to true. */
	ephemeral?: boolean;
	/** Skip device approval. Defaults to true. */
	preauthorized?: boolean;
	/** Key description, at most 50 characters. Defaults to `nostr-agx`. */
	description?: string;
	/** Inject `fetch` for tests or a custom transport. */
	fetch?: typeof fetch;
	/** Per-request timeout. Defaults to 15 seconds. */
	timeoutMs?: number;
}

const DEFAULT_API_BASE_URL = "https://api.tailscale.com/api/v2";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXPIRY_SECONDS = 60 * 60;

/**
 * ACL tag applied to OAuth-minted keys when the caller does not supply one.
 * Tailscale requires at least one tag; this role tag must exist in tailnet
 * policy and be allowed by the OAuth client.
 */
export const DEFAULT_TAILSCALE_OAUTH_TAGS = ["tag:agx-agent"] as const;

/**
 * Mint a one-off, tagged key through an OAuth client-credentials exchange.
 *
 * The client secret never leaves this process and is never passed to the
 * Tailscale node. Each call creates a new single-use key, so a long-running
 * agent does not need a long-lived credential in its environment.
 */
export function oauthAuthKey(
	options: TailscaleOAuthOptions,
): TailscaleAuthKeyProvider {
	return {
		name: "oauth",
		async resolve() {
			return mintOAuthAuthKey(options);
		},
	};
}

/** Resolve any supported key input. `undefined` means "the default sources". */
export async function resolveTailscaleAuthKey(
	input?: TailscaleAuthKeyInput | null,
): Promise<string> {
	const provider = input == null ? environmentAuthKey() : toProvider(input);
	const value = (await provider.resolve())?.trim();
	if (!value) {
		throw new TailscaleError(
			"configuration",
			`No Tailscale auth key is available from ${provider.name}.`,
			"Pass authKey directly, set TS_AUTHKEY, or use oauthAuthKey({ clientId, clientSecret }).",
		);
	}
	assertWellFormedAuthKey(value, provider.name);
	return value;
}

/** True for a value that can plausibly be a Tailscale auth key. Real keys are
 * `tskey-…`; this rejects only what can never be a key — empty values, values
 * over 2 KiB, and anything containing whitespace or control characters. */
export function isWellFormedTailscaleAuthKey(
	value: unknown,
): value is string {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 2048 &&
		!/[\s\x00-\x1f\x7f]/.test(value)
	);
}

function assertWellFormedAuthKey(value: string, source: string): void {
	if (!isWellFormedTailscaleAuthKey(value)) {
		throw new TailscaleError(
			"configuration",
			`The Tailscale auth key from ${source} is empty, too long, or contains whitespace or control characters.`,
			"Pass one key exactly as Tailscale issued it (tskey-…), with no quotes, newlines, or surrounding text.",
		);
	}
}

function toProvider(input: TailscaleAuthKeyInput): TailscaleAuthKeyProvider {
	if (typeof input === "string") {
		return staticAuthKey(input);
	}
	if (typeof input === "function") {
		return customAuthKey(input);
	}
	if (
		typeof input === "object" &&
		input !== null &&
		typeof input.resolve === "function"
	) {
		return input;
	}
	throw new TailscaleError(
		"configuration",
		"authKey must be a string, a provider with resolve(), or a function.",
		"Use staticAuthKey, environmentAuthKey, oauthAuthKey, customAuthKey, or firstAuthKey.",
	);
}

async function mintOAuthAuthKey(
	options: TailscaleOAuthOptions,
): Promise<string> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new TailscaleError(
			"configuration",
			"No fetch implementation is available to mint a Tailscale auth key.",
			"Run on Node 20+, or pass `fetch` in the OAuth options.",
		);
	}
	const clientId = options.clientId?.trim();
	const clientSecret = options.clientSecret?.trim();
	if (!clientId || !clientSecret) {
		throw new TailscaleError(
			"configuration",
			"The Tailscale OAuth client id and secret are required.",
			"Set them from a secret store before creating the transport.",
		);
	}
	const apiBaseUrl = assertOAuthUrl(
		options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
		"Tailscale API base URL",
	).replace(/\/+$/, "");
	const tokenUrl = assertOAuthUrl(
		options.tokenUrl ?? `${apiBaseUrl}/oauth/token`,
		"OAuth token URL",
	);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const form = new URLSearchParams({ grant_type: "client_credentials" });
	const tokenAuth = options.tokenAuth ?? "basic";
	if (tokenAuth === "post") {
		form.set("client_id", clientId);
		form.set("client_secret", clientSecret);
	}
	if (options.scope) {
		form.set("scope", options.scope);
	}
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/x-www-form-urlencoded",
	};
	if (tokenAuth === "basic") {
		headers.authorization = `Basic ${Buffer.from(
			`${clientId}:${clientSecret}`,
		).toString("base64")}`;
	}

	const token = await requestJson(
		fetchImpl,
		tokenUrl,
		{ method: "POST", headers, body: form.toString() },
		timeoutMs,
		"OAuth token request",
	);

	// A custom authentication service may mint the key itself.
	const direct = keyFromResponse(token);
	if (direct) {
		assertWellFormedAuthKey(direct, "the OAuth service");
		return direct;
	}

	const accessToken = stringField(token, "access_token");
	if (!accessToken) {
		throw new TailscaleError(
			"network",
			"The OAuth service answered without an auth key or access token.",
			'Return { "authKey": "tskey-…" } from the service, or a standard { "access_token": … } for the Tailscale API.',
		);
	}

	const configuredTags = (options.tags ?? [])
		.map((tag) => tag.trim())
		.filter(Boolean);
	const tags =
		configuredTags.length > 0
			? configuredTags
			: [...DEFAULT_TAILSCALE_OAUTH_TAGS];
	const expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
	if (!Number.isInteger(expirySeconds) || expirySeconds <= 0) {
		throw new TailscaleError(
			"configuration",
			"expirySeconds must be a positive integer.",
			"Use a short lifetime such as 600 (10 minutes); the node keeps its own key after enrollment.",
		);
	}

	const tailnet = options.tailnet?.trim() || "-";
	const keyUrl = `${apiBaseUrl}/tailnet/${encodeURIComponent(tailnet)}/keys`;
	const minted = await requestJson(
		fetchImpl,
		keyUrl,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				capabilities: {
					devices: {
						create: {
							reusable: false,
							ephemeral: options.ephemeral ?? true,
							preauthorized: options.preauthorized ?? true,
							tags,
						},
					},
				},
				expirySeconds,
				description: (options.description ?? "nostr-agx").slice(0, 50),
			}),
		},
		timeoutMs,
		"Tailscale key request",
	);
	const mintedKey = keyFromResponse(minted);
	if (!mintedKey) {
		throw new TailscaleError(
			"network",
			"The Tailscale API answered without a key.",
			"Check that the OAuth client has the auth_keys scope and may create keys with the requested tags.",
		);
	}
	assertWellFormedAuthKey(mintedKey, "the Tailscale API");
	return mintedKey;
}

function keyFromResponse(value: unknown): string | null {
	const record = asRecord(value);
	for (const field of ["authKey", "auth_key", "key"]) {
		const candidate = record[field];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return null;
}

function stringField(value: unknown, field: string): string | null {
	const candidate = asRecord(value)[field];
	return typeof candidate === "string" && candidate.trim()
		? candidate.trim()
		: null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

async function requestJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	what: string,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new TailscaleError(
			"network",
			`${what} could not reach ${new URL(url).origin}.`,
			`Check the URL and this machine's network, then retry. (${errorMessage(error)})`,
			{ cause: error },
		);
	}
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// A non-JSON body is useful only for its status; never echo it.
	}
	if (!response.ok) {
		const oauthError = stringField(body, "error");
		const description = stringField(body, "error_description");
		throw new TailscaleError(
			response.status === 401 || response.status === 403 ? "auth" : "network",
			`${what} failed with HTTP ${response.status}` +
				`${oauthError ? ` (${oauthError})` : ""}` +
				`${description ? `: ${description}` : ""}.`,
			response.status === 401 || response.status === 403
				? "Check the OAuth client id, secret, and scopes. Nothing was passed to the node."
				: "Check the authentication service, the tailnet name, and the requested tags, then retry.",
		);
	}
	return body;
}

/** https, or plain http only on loopback; no user name, password, or fragment. */
function assertOAuthUrl(raw: string, label: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new TailscaleError("configuration", `${label} is not a URL.`);
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (url.username || url.password || url.hash) {
		throw new TailscaleError(
			"configuration",
			`${label} must not contain a user name, password, or fragment.`,
		);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new TailscaleError(
			"configuration",
			`${label} must be https:// (plain http is only allowed on loopback).`,
		);
	}
	return raw;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
