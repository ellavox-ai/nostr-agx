import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ApiDeps,
	BodyTooLargeError,
	handleApi,
	readJsonBody,
} from "./api.js";
import {
	createSecurity,
	CSRF_HEADER,
	SECURITY_HEADERS,
	type Security,
	sendJson,
	sessionCookie,
} from "./security.js";

const LAUNCH_PAGE =
	'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>agx ui</title><p>Opening agx ui\u2026</p>';

export interface UiAssets {
	html: string;
	js: string;
	css: string;
}

export interface UiServerOptions {
	api: ApiDeps;
	assets: () => UiAssets;
	port?: number;
	/** Idle exit in ms; 0 disables. */
	idleMs?: number;
	onIdle?: () => void;
	/** Called every `syncEveryMs` while open, to pull new messages. */
	syncEveryMs?: number;
	/** Called when a pull fails; the next tick tries again. */
	onSyncError?: (error: unknown) => void;
}

export interface UiServer {
	port: number;
	/** `http://127.0.0.1:<port>/?t=<one-time token>` */
	url: string;
	security: Security;
	close(): Promise<void>;
}

const LOOPBACK = "127.0.0.1";

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
	const idleMs = options.idleMs ?? 60 * 60 * 1000;
	let lastActivity = Date.now();
	let security: Security;

	const server: Server = createServer((req, res) => {
		lastActivity = Date.now();
		void route(req, res).catch(() => {
			if (!res.headersSent) {
				sendJson(res, 500, { error: { code: "internal", message: "Internal error." } });
			} else {
				res.end();
			}
		});
	});

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
		const method = req.method ?? "GET";

		if (!security.hostAllowed(req.headers.host)) {
			return sendText(res, 403, "Forbidden");
		}

		if (url.pathname.startsWith("/api/")) {
			const verdict = security.authorizeApi(req);
			if (!verdict.ok) {
				return sendJson(res, verdict.status, { error: { code: "forbidden", message: verdict.reason } });
			}
			let body: unknown = {};
			if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
				try {
					body = await readJsonBody(req);
				} catch (error) {
					const tooLarge = error instanceof BodyTooLargeError;
					return sendJson(res, tooLarge ? 413 : 400, {
						error: { code: tooLarge ? "too_large" : "bad_json", message: tooLarge ? "Request too large." : "Body is not valid JSON." },
					});
				}
			}
			const result = await handleApi(options.api, method, url, body);
			return sendJson(res, result.status, result.body);
		}

		if (method !== "GET" && method !== "HEAD") {
			return sendText(res, 405, "Method Not Allowed", { allow: "GET, HEAD" });
		}

		// The launch link: exchange the one-time token for a cookie, then drop it
		// from the address bar.
		if (url.pathname === "/" && url.searchParams.has("t")) {
			const session = security.exchangeLaunchToken(url.searchParams.get("t") ?? "");
			if (!session) {
				return sendText(res, 403, "This link was already used or has expired. Run agx ui again.");
			}
			// A 200 page that moves on by itself, not a 303: when the link was opened from a
			// file:// page the redirect counts as cross-site and a Strict cookie is not sent with it.
			res.writeHead(200, {
				...SECURITY_HEADERS,
				"content-type": "text/html; charset=utf-8",
				"set-cookie": sessionCookie(session, port),
			});
			return void res.end(LAUNCH_PAGE);
		}

		const verdict = security.authorizePage(req);
		if (!verdict.ok) {
			return sendText(res, verdict.status, verdict.status === 401 ? "Open the link that agx ui printed." : "Forbidden");
		}
		const assets = options.assets();
		if (url.pathname === "/") {
			return sendAsset(res, "text/html; charset=utf-8", assets.html.replace("__CSRF__", verdict.session.csrf), method);
		}
		if (url.pathname === "/app.js") {
			return sendAsset(res, "text/javascript; charset=utf-8", assets.js, method);
		}
		if (url.pathname === "/app.css") {
			return sendAsset(res, "text/css; charset=utf-8", assets.css, method);
		}
		return sendText(res, 404, "Not Found");
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// Loopback only, never 0.0.0.0. Port 0 lets the OS pick a free one.
		server.listen(options.port ?? 0, LOOPBACK, resolve);
	});
	const port = (server.address() as AddressInfo).port;
	security = createSecurity({ port });

	const timers: NodeJS.Timeout[] = [];
	if (idleMs > 0) {
		const idle = setInterval(() => {
			if (Date.now() - lastActivity > idleMs) {
				options.onIdle?.();
			}
		}, Math.min(idleMs, 30_000));
		idle.unref();
		timers.push(idle);
	}
	const sync = options.api.store.sync;
	if (sync && options.syncEveryMs) {
		const pull = (): void => {
			void sync.call(options.api.store).catch((error: unknown) => options.onSyncError?.(error));
		};
		pull();
		const tick = setInterval(pull, options.syncEveryMs);
		tick.unref();
		timers.push(tick);
	}

	return {
		port,
		url: `http://${LOOPBACK}:${port}/?t=${security.launchToken}`,
		security,
		close: () =>
			new Promise<void>((resolve) => {
				for (const timer of timers) {
					clearInterval(timer);
				}
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

function sendText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
	res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", ...extra });
	res.end(text);
}

function sendAsset(res: ServerResponse, type: string, body: string, method: string): void {
	res.writeHead(200, { ...SECURITY_HEADERS, "content-type": type });
	res.end(method === "HEAD" ? undefined : body);
}

export { CSRF_HEADER };
