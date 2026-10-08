import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Request security for `agx ui`.
 *
 * The UI listens on 127.0.0.1 only, so the remaining attackers are web pages in
 * the user's own browser: a page on another origin that fires requests at
 * `http://127.0.0.1:<port>` (CSRF), or a DNS name that is rebound to 127.0.0.1
 * (DNS rebinding). Four independent checks stop them, and a request needs all:
 *
 *   - a session cookie (HttpOnly, SameSite=Strict) obtained by exchanging a
 *     one-time launch token, printed only to the user's terminal / browser tab;
 *   - a CSRF header equal to a per-session secret that only same-origin script
 *     can read from the HTML;
 *   - a `Host` header naming the loopback address and our port (a rebound
 *     name carries its own `Host`);
 *   - an `Origin` that is ours on every request that changes anything.
 *
 * No CORS headers are ever sent, so a browser never lets another origin read a
 * response.
 */

export const SESSION_COOKIE = "agx_ui";
export const CSRF_HEADER = "x-agx-csrf";

/** How long a launch token can be exchanged. Single use either way. */
const LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface Session {
	id: string;
	csrf: string;
}

export interface SecurityOptions {
	port: number;
	now?: () => number;
}

export type Verdict =
	| { ok: true; session: Session }
	| { ok: false; status: 401 | 403; reason: string };

export interface Security {
	/** The one-time token to put in the URL the user opens. */
	launchToken: string;
	/** Exchange the launch token for a session; null when wrong, used or expired. */
	exchangeLaunchToken(token: string): Session | null;
	/** Is the `Host` header this server's own loopback name? */
	hostAllowed(host: string | undefined): boolean;
	/** Check Host, Origin, cookie and CSRF for an API request. */
	authorizeApi(req: IncomingMessage): Verdict;
	/** Check Host and cookie only, for the HTML page and static assets. */
	authorizePage(req: IncomingMessage): Verdict;
	sessionFromCookie(cookieHeader: string | undefined): Session | null;
}

export function createSecurity(options: SecurityOptions): Security {
	const now = options.now ?? Date.now;
	const launchToken = randomToken();
	const issuedAt = now();
	let launchUsed = false;
	const sessions = new Map<string, Session>();
	const allowedHosts = new Set([
		`127.0.0.1:${options.port}`,
		`localhost:${options.port}`,
	]);
	const allowedOrigins = new Set(
		[...allowedHosts].map((host) => `http://${host}`),
	);

	function hostAllowed(host: string | undefined): boolean {
		return host !== undefined && allowedHosts.has(host.toLowerCase());
	}

	function sessionFromCookie(cookieHeader: string | undefined): Session | null {
		const id = parseCookies(cookieHeader)[SESSION_COOKIE];
		if (!id) {
			return null;
		}
		return sessions.get(id) ?? null;
	}

	function originOk(req: IncomingMessage): boolean {
		const origin = req.headers.origin;
		const changes = !["GET", "HEAD"].includes(req.method ?? "GET");
		if (origin === undefined) {
			// A same-origin GET carries no Origin. Anything that changes state must.
			return !changes;
		}
		return allowedOrigins.has(origin);
	}

	function fetchSiteOk(req: IncomingMessage): boolean {
		const site = req.headers["sec-fetch-site"];
		return site === undefined || site === "same-origin" || site === "none";
	}

	function authorizePage(req: IncomingMessage): Verdict {
		if (!hostAllowed(req.headers.host)) {
			return { ok: false, status: 403, reason: "host not allowed" };
		}
		const session = sessionFromCookie(req.headers.cookie);
		if (!session) {
			return { ok: false, status: 401, reason: "no session" };
		}
		return { ok: true, session };
	}

	function authorizeApi(req: IncomingMessage): Verdict {
		if (!hostAllowed(req.headers.host)) {
			return { ok: false, status: 403, reason: "host not allowed" };
		}
		if (!originOk(req) || !fetchSiteOk(req)) {
			return { ok: false, status: 403, reason: "origin not allowed" };
		}
		const session = sessionFromCookie(req.headers.cookie);
		if (!session) {
			return { ok: false, status: 401, reason: "no session" };
		}
		const header = req.headers[CSRF_HEADER];
		if (typeof header !== "string" || !safeEqual(header, session.csrf)) {
			return { ok: false, status: 403, reason: "csrf header missing or wrong" };
		}
		return { ok: true, session };
	}

	function exchangeLaunchToken(token: string): Session | null {
		if (launchUsed || now() - issuedAt > LAUNCH_TOKEN_TTL_MS) {
			return null;
		}
		if (!safeEqual(token, launchToken)) {
			// A wrong guess does not burn the real token.
			return null;
		}
		launchUsed = true;
		const session = { id: randomToken(), csrf: randomToken() };
		sessions.set(session.id, session);
		return session;
	}

	return {
		launchToken,
		exchangeLaunchToken,
		hostAllowed,
		authorizeApi,
		authorizePage,
		sessionFromCookie,
	};
}

export function randomToken(): string {
	return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0) {
			out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
		}
	}
	return out;
}

export function sessionCookie(session: Session): string {
	return `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Headers for every response. There is deliberately no CORS header. */
export const SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
	"cross-origin-resource-policy": "same-origin",
	"cross-origin-opener-policy": "same-origin",
	"x-frame-options": "DENY",
};

export function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	extra: Record<string, string> = {},
): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"content-type": "application/json; charset=utf-8",
		...extra,
	});
	res.end(JSON.stringify(body));
}
