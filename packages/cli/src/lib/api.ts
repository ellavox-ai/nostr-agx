import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
	type ActionRequiredReason,
	AgxCliError,
	EXIT,
	HumanActionRequiredError,
} from "./errors.js";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { runtime, timeoutSignal } from "./runtime.js";
import {
	isWellFormedApiKey,
	malformedApiKeyError,
	redactSecrets,
	rememberSecret,
} from "./secrets.js";
import { AGX_CLI_VERSION } from "./version.js";

/**
 * oRPC client over the Agent Index HTTP surface, following the existing pattern
 * in `apps/cli/src/lib/registry-client.ts`: an `RPCLink` at `${base}/api/rpc`
 * authenticated with `X-API-Key`.
 *
 * `X-API-Key` rather than `Authorization: Bearer` deliberately — the bearer path
 * only routes to API-key verification for tokens matching the index's key prefix,
 * while the header is accepted verbatim, so a renamed key prefix cannot silently
 * turn into a session-auth attempt.
 *
 * Every procedure takes `orgSlug` as an INPUT FIELD, not a header, and the key's
 * `metadata.organizationId` must resolve to that same organization.
 */

/**
 * The oRPC client is only statically typed when the SERVER ROUTER TYPE is
 * imported — which would pull the index's server package into this one and break
 * the open-source boundary. Call sites declare the response shapes they rely on
 * instead, so the untyped surface stops at this seam.
 */
export type AgxApiClient = any;

/** What the CLI calls itself on the wire. */
export function userAgent(): string {
	return `agx/${AGX_CLI_VERSION} (node ${process.versions.node}; ${process.platform})`;
}

/** Just the two things a call needs; `orgSlug` travels in each input. */
export interface ApiTarget {
	baseUrl: string;
	apiKey: string;
}

/**
 * How long one API call may take, headers AND body. Without it the only bound
 * is undici's 300 s headers timeout, and a body trickled slowly never times
 * out at all. `verifyDomain` fetches a remote nostr.json server-side, so this
 * is generous.
 */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * A best-effort call (revoking a replaced login key, looking up a stored key's
 * id) gets a shorter leash: nothing depends on its answer, so a slow or dead
 * server may only delay the exit.
 */
export const BEST_EFFORT_RPC_TIMEOUT_MS = 10_000;

let rpcTimeoutOverrideMs: number | null = null;

/** Tests only: every API call times out after `ms`. Returns the restore function. */
export function setRpcTimeoutForTests(ms: number): () => void {
	const previous = rpcTimeoutOverrideMs;
	rpcTimeoutOverrideMs = ms;
	return () => {
		rpcTimeoutOverrideMs = previous;
	};
}

export function createApiClient(
	creds: ApiTarget,
	options?: { timeoutMs?: number },
): AgxApiClient {
	// The last check before a key goes on the wire. Every entry point checks
	// the shape too, with a better label; this catches whatever slipped past.
	if (!isWellFormedApiKey(creds.apiKey)) {
		throw malformedApiKeyError("The API key for this command");
	}
	rememberSecret(creds.apiKey);
	const timeoutMs =
		rpcTimeoutOverrideMs ?? options?.timeoutMs ?? RPC_TIMEOUT_MS;
	const link = new RPCLink({
		url: `${creds.baseUrl}/api/rpc`,
		headers: async () => ({
			"Content-Type": "application/json",
			"User-Agent": userAgent(),
			"X-API-Key": creds.apiKey,
		}),
		// RPCLink already asks for `redirect: "manual"`. A 3xx then has a
		// non-error status, so the link would decode its (usually empty) body
		// as a successful result; refuse it here instead. The key never
		// follows a redirect, and a redirect is never a result.
		fetch: async (request, init) => {
			const response = await runtime().fetch(request, {
				...init,
				redirect: "manual",
				// Bounds the body read too: the response stream is aborted with it.
				signal: timeoutSignal(timeoutMs, request.signal),
			});
			if (response.status >= 300 && response.status < 400) {
				throw redirectRefused(response.status);
			}
			return response;
		},
	});
	return createORPCClient(link);
}

function redirectRefused(status: number): AgxCliError {
	return new AgxCliError(
		`The server answered with a redirect (HTTP ${status}). agx never follows a redirect with a credential, so nothing was sent on.`,
		{
			exitCode: EXIT.remote,
			remediation:
				"Point agx at the server's real origin:\n    agx config show   (check apiBaseUrl)",
		},
	);
}

/** True when the CLI is talking to an index on this machine, which is the only
 * case where "start it" is useful advice rather than confusing. */
function isLocal(baseUrl?: string): boolean {
	if (!baseUrl) {
		return false;
	}
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Hosts on the same site as the base host: the base host's parent domain and
 * everything under it (`app.ellaworks.ai` → `ellaworks.ai`, `www.ellaworks.ai`).
 * Without a public-suffix list this is an approximation, so it is only used for
 * the Terms URL, which the server serves from its marketing host.
 */
function isSameSite(candidate: URL, base: URL): boolean {
	if (candidate.protocol !== "https:" || base.protocol !== "https:") {
		return false;
	}
	const labels = base.hostname.split(".");
	if (labels.length < 2 || /^[\d.]+$/.test(base.hostname)) {
		return false;
	}
	const site =
		labels.length >= 3 ? labels.slice(1).join(".") : base.hostname;
	return (
		candidate.hostname === site || candidate.hostname.endsWith(`.${site}`)
	);
}

/**
 * Turn a server-supplied URL into one that is safe to hand to a human.
 *
 * A relative URL is resolved against OUR base (the server's own idea of its
 * origin can differ on preview deploys). An absolute URL on our origin is kept.
 * Anything else — another origin, `//evil.example`, `javascript:` — is replaced
 * by `${base}/elladex`, so a response can never send the person somewhere the
 * CLI is not already talking to. `sameSite` additionally admits https hosts on
 * the base's own site (the Terms page).
 */
export function resolveActionUrl(
	url: unknown,
	baseUrl: string,
	options?: { sameSite?: boolean },
): string {
	const base = new URL(baseUrl);
	const fallback = `${base.origin}/elladex`;
	if (typeof url !== "string" || url.trim() === "") {
		return fallback;
	}
	let resolved: URL;
	try {
		resolved = new URL(url, `${base.origin}/`);
	} catch {
		return fallback;
	}
	if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
		return fallback;
	}
	resolved.username = "";
	resolved.password = "";
	if (resolved.origin === base.origin) {
		return resolved.toString();
	}
	if (options?.sameSite && isSameSite(resolved, base)) {
		return resolved.toString();
	}
	return fallback;
}

/** The fields of `ORPCError.data` the CLI branches on (LOGIN-CONTRACT.md
 * §1.7). */
interface ErrorData {
	code?: unknown;
	message?: unknown;
	url?: unknown;
	listingId?: unknown;
	required?: unknown;
	granted?: unknown;
	retryAfterMs?: unknown;
	termsVersion?: unknown;
	loginRequired?: unknown;
}

interface OrpcErrorLike {
	code?: string;
	status?: number;
	message?: string;
	data?: ErrorData;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** What to do about a key whose owner has left the key's organization: the
 * 403 `API_KEY_OWNER_NOT_MEMBER`, or `organization: null` from
 * `account.principal.get` (LOGIN-CONTRACT.md §1.5, §1.7). */
export const OWNER_NOT_MEMBER_REMEDIATION =
	"Log in with an account that belongs to the organization:\n    agx login --force";

/** The reasons whose fix is a click in a browser (exit 7). */
const HUMAN_ACTION_CODES: Record<string, ActionRequiredReason> = {
	HUMAN_CONFIRMATION_REQUIRED: "HUMAN_CONFIRMATION_REQUIRED",
	TERMS_ACCEPTANCE_REQUIRED: "TERMS_ACCEPTANCE_REQUIRED",
};

/**
 * Map a server error with a `data.code` (LOGIN-CONTRACT.md §1.7). Returns null
 * for a code this CLI does not know, so the status-based fallbacks below still
 * apply.
 */
function fromDataCode(
	data: ErrorData,
	context: string,
	baseUrl: string | undefined,
): AgxCliError | null {
	const code = str(data.code);
	if (!code) {
		return null;
	}

	const reason = HUMAN_ACTION_CODES[code];
	if (reason) {
		const base = baseUrl ?? DEFAULT_API_BASE_URL;
		const url = resolveActionUrl(data.url, base, {
			sameSite: reason === "TERMS_ACCEPTANCE_REQUIRED",
		});
		const listingId = str(data.listingId);
		if (reason === "HUMAN_CONFIRMATION_REQUIRED") {
			return new HumanActionRequiredError(
				`${context}: an organization admin has to confirm this in the browser: ${url}`,
				{
					reason,
					url,
					userCode: null,
					expiresIn: null,
					...(listingId ? { listingId } : {}),
				},
				"Open the link (or send it to an org admin) and publish there. Nothing else will make the listing public.",
			);
		}
		// Reserved (LOGIN-CONTRACT.md §1.7): no server sends it today. The
		// login approval page records no Terms acceptance, so logging in again
		// is never the fix; the browser is.
		return new HumanActionRequiredError(
			`${context}: the current Terms have to be accepted first: ${url}`,
			{ reason, url, userCode: null, expiresIn: null },
			"Accept them in the browser, then re-run the command.",
		);
	}

	switch (code) {
		case "INSUFFICIENT_SCOPE": {
			const required = str(data.required);
			return new AgxCliError(
				`${context}: this login covers listings and domains only; \`${context}\` needs a key from Settings${required ? ` (it needs ${required})` : ""}.`,
				{
					exitCode: EXIT.auth,
					remediation:
						"Mint a key in Settings → API keys and give it its own profile:\n    printf %s \"$KEY\" | agx --profile settings-key config set apiKey --stdin",
				},
			);
		}
		case "API_KEY_INVALID":
			return new AgxCliError(
				`${context}: the API key is not valid (unknown, revoked or deleted).`,
				{ exitCode: EXIT.auth, remediation: "agx login" },
			);
		case "API_KEY_EXPIRED":
			return new AgxCliError(`${context}: the API key has expired.`, {
				exitCode: EXIT.auth,
				remediation: "agx login",
			});
		case "API_KEY_DISABLED":
			return new AgxCliError(`${context}: the API key is disabled.`, {
				exitCode: EXIT.auth,
				remediation:
					"Re-enable it in Settings → API keys, or log in for a new one:\n    agx login",
			});
		case "API_KEY_OWNER_NOT_MEMBER":
			return new AgxCliError(
				`${context}: the account that owns this key is no longer a member of its organization.`,
				{ exitCode: EXIT.auth, remediation: OWNER_NOT_MEMBER_REMEDIATION },
			);
		case "API_KEY_RATE_LIMITED": {
			const ms =
				typeof data.retryAfterMs === "number" ? data.retryAfterMs : null;
			return new AgxCliError(
				`${context}: this key is rate limited${ms !== null ? ` for ${Math.ceil(ms / 1000)} s` : ""}.`,
				{
					exitCode: EXIT.remote,
					remediation:
						"Wait, then retry. The limit resets only after a quiet gap, so retrying in a tight loop keeps it locked.",
				},
			);
		}
		case "API_KEY_USAGE_EXCEEDED":
			return new AgxCliError(
				`${context}: this key has used up its lifetime request quota.`,
				{
					exitCode: EXIT.remote,
					remediation:
						"Mint a new key, or log in for one that has no quota:\n    agx login",
				},
			);
		case "API_KEY_SELF_REVOKE_ONLY":
			return new AgxCliError(
				`${context}: an API key may only revoke itself.`,
				{
					exitCode: EXIT.remote,
					remediation: "Revoke other keys in Settings → API keys.",
				},
			);
		case "LISTING_SLUG_TAKEN":
			return new AgxCliError(
				`${context}: that listing slug is already taken in this organization.`,
				{
					exitCode: EXIT.remote,
					remediation: "Pick another one: use --slug <another-slug>.",
				},
			);
		case "LISTING_ADDRESS_LIVE": {
			const listingId = str(data.listingId);
			return new AgxCliError(
				`${context}: this agent address is already listed${listingId ? ` (listing ${listingId} in this organization)` : " by another organization"}.`,
				{
					exitCode: EXIT.remote,
					remediation: listingId
						? `Work with the existing listing:\n    agx listing get ${listingId}`
						: "An address can be live in only one listing. Use another identity for a new listing:\n    agx --profile <name> identity new",
				},
			);
		}
		default:
			// An unknown code from a newer server: fall through to the status
			// mapping, with the server's own message.
			return null;
	}
}

/** An answer from the API, as oRPC decodes it (what `toCliError` may quote). */
function isOrpcError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return true;
	}
	const e = error as { code?: unknown; status?: unknown; defined?: unknown };
	return (
		typeof e?.code === "string" &&
		typeof e?.status === "number" &&
		typeof e?.defined === "boolean"
	);
}

/** Node and undici error codes that mean "the server could not be reached". */
const UNREACHABLE_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
]);

/** An identifier-like string (an error name or code), or null. Anything else
 * could be text that quotes a secret, so it is not printed. */
function token(value: unknown): string | null {
	return typeof value === "string" && /^[A-Za-z0-9_]{1,40}$/.test(value)
		? value
		: null;
}

/**
 * A failure that is NOT an answer from the API: the request was never sent,
 * never arrived, or what came back was not an oRPC response.
 *
 * Its raw message is never printed. undici quotes the offending header value —
 * the API key — when it refuses one, and a `fetch failed` hides its real
 * reason in `cause`. Only the error's name and Node/undici code are shown;
 * `AGX_DEBUG=1` adds the message, redacted.
 */
function fromTransportError(
	error: unknown,
	context: string,
	baseUrl: string | undefined,
): AgxCliError {
	const err = error as {
		name?: unknown;
		message?: unknown;
		code?: unknown;
		cause?: { name?: unknown; code?: unknown } | null;
	} | null;
	const message = typeof err?.message === "string" ? err.message : "";
	const code = token(err?.code) ?? token(err?.cause?.code);

	// The call's own deadline (createApiClient): on the request, or while
	// reading the body, where oRPC wraps it as "Cannot parse response body".
	const names = [token(err?.name), token(err?.cause?.name)];
	if (names.includes("TimeoutError") || names.includes("AbortError")) {
		return new AgxCliError(`${context}: the API did not answer in time.`, {
			exitCode: EXIT.network,
			remediation: isLocal(baseUrl)
				? `Check the agent index at ${baseUrl} is running and responsive, then re-run the command.`
				: "Check the API is up and reachable, then re-run the command:\n    agx doctor",
		});
	}

	if (
		(code !== null && UNREACHABLE_CODES.has(code)) ||
		message === "fetch failed"
	) {
		return new AgxCliError(
			`${context}: cannot reach the API${code ? ` (${code})` : ""}.`,
			{
				exitCode: EXIT.network,
				// "Start it" is only offered when the target actually is local; for a real
				// deployment the useful check is the configured URL.
				remediation: isLocal(baseUrl)
					? `Start the agent index at ${baseUrl}, then re-run the command.\n  To use a different index:  agx config set apiBaseUrl <url>`
					: "Check the API is running and that `apiBaseUrl` is correct:\n    agx config show",
			},
		);
	}

	// A 3xx the link decoded anyway, or an HTML error page: never a result.
	if (
		/^(Cannot parse response body|Invalid RPC response format)/.test(message)
	) {
		return new AgxCliError(
			`${context}: the server's answer was not an API response (a redirect or an HTML page).`,
			{
				exitCode: EXIT.remote,
				remediation:
					"Check that apiBaseUrl is the API's own origin:\n    agx config show",
			},
		);
	}

	const name = token(err?.name) ?? "Error";
	return new AgxCliError(
		`${context}: the request failed before the API answered (${name}${code ? ` ${code}` : ""}).`,
		{
			exitCode: EXIT.generic,
			remediation: process.env.AGX_DEBUG
				? `Details: ${debugText(message)}`
				: "Check the profile, then re-run with AGX_DEBUG=1 for details:\n    agx doctor",
		},
	);
}

/** An error message made safe to print for AGX_DEBUG: secrets redacted, no
 * control characters, bounded. */
function debugText(message: string): string {
	return redactSecrets(message)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.slice(0, 300);
}

/** What a server that predates `data.code` says, verbatim, for a key it does
 * not know (LOGIN-CONTRACT.md §1.7 keeps the message for
 * `API_KEY_INVALID`). */
const LEGACY_INVALID_KEY_MESSAGE = "Invalid API key";

/**
 * Did the server refuse the KEY itself — unknown, revoked, deleted or expired?
 * Only then may agx forget a key without revoking it.
 *
 * A 404 is never that: an API-key caller whose key the server does not know
 * gets 401 `API_KEY_INVALID` (LOGIN-CONTRACT.md §1.6, §1.7), so a 404 means
 * the procedure is missing (a server without it, a proxy, a wrong path) and
 * the key may well still work. A disabled key still exists and can be
 * re-enabled.
 *
 * A 401 WITHOUT a `data.code` counts only when its message is exactly the
 * 0.3 server's "Invalid API key". Any other 401 — a 0.3 server's "missing
 * organization scope", a proxy's or gateway's auth wall, a reworded message —
 * proves nothing about the key, which may still work: agx keeps it (logout
 * exits 4) or says it could not revoke it (login --force).
 */
export function isKeyRejected(error: unknown): boolean {
	if (error instanceof AgxCliError) {
		return false;
	}
	const err = error as OrpcErrorLike;
	const dataCode = str(err?.data?.code);
	if (dataCode) {
		return dataCode === "API_KEY_INVALID" || dataCode === "API_KEY_EXPIRED";
	}
	if (err?.status !== 401 && err?.code !== "UNAUTHORIZED") {
		return false;
	}
	return err?.message === LEGACY_INVALID_KEY_MESSAGE;
}

/**
 * Turn a transport or oRPC failure into something with a next action.
 *
 * `data.code` (LOGIN-CONTRACT.md §1.7) is consulted FIRST, then the oRPC
 * code/status, and the 0.3 message regexes only as a last resort for servers
 * that predate `data.code`.
 */
export function toCliError(
	error: unknown,
	context: string,
	baseUrl?: string,
): AgxCliError {
	if (error instanceof AgxCliError) {
		return error;
	}
	if (!isOrpcError(error)) {
		return fromTransportError(error, context, baseUrl);
	}
	const err = error as OrpcErrorLike;
	const code = err.code;
	// The server's own words. Redacted all the same, since agx prints them.
	const message = redactSecrets(str(err.data?.message) ?? err.message ?? "");

	if (err.data && typeof err.data === "object") {
		const mapped = fromDataCode(err.data, context, baseUrl);
		if (mapped) {
			return mapped;
		}
	}

	if (code === "UNAUTHORIZED" || err?.status === 401) {
		const unscoped = /organization scope/i.test(message);
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.auth,
			remediation: unscoped
				? "This key carries no organization scope, so it cannot act on any org. Log in for a key bound to an organization:\n    agx login"
				: "agx login",
		});
	}

	if (code === "FORBIDDEN" || err?.status === 403) {
		if (/does not have access to this organization/i.test(message)) {
			return new AgxCliError(`${context}: ${message}`, {
				exitCode: EXIT.auth,
				remediation:
					"An API key is bound to a single organization and cannot act on another. Log in to this organization, or switch profiles:\n    agx login --org <slug>\n    agx config use <profile>",
			});
		}
		if (/[Pp]rove possession/.test(message)) {
			return new AgxCliError(`${context}: ${message}`, {
				exitCode: EXIT.remote,
				remediation:
					"This is the anti-squatting control working. Run the proof flow:\n    agx register --slug <slug> --display-name <name> --capability <key>",
			});
		}
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
		});
	}

	if (code === "NOT_FOUND" || err?.status === 404) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
			remediation: /Organization not found/i.test(message)
				? "Check the organization slug your API key belongs to:\n    agx config set orgSlug <slug>"
				: null,
		});
	}

	if (code === "CONFLICT" || err?.status === 409) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
			remediation: /already listed/i.test(message)
				? "This agent address already has a live listing. Find it with:\n    agx listing list"
				: null,
		});
	}

	if (code === "PRECONDITION_FAILED" || err?.status === 412) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
		});
	}

	if (code === "TOO_MANY_REQUESTS" || err?.status === 429) {
		return new AgxCliError(`${context}: rate limited (${message}).`, {
			exitCode: EXIT.remote,
			remediation: "Wait a moment and retry.",
		});
	}

	if (code === "UNPROCESSABLE_CONTENT" || err?.status === 422) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
		});
	}

	return new AgxCliError(`${context}: ${message}`, {
		exitCode: EXIT.generic,
	});
}
