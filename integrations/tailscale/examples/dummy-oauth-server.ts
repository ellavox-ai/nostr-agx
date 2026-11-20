/**
 * Local dummy OAuth token endpoint for the Tailscale examples.
 *
 * It authenticates a client with the OAuth client-credentials grant and, on
 * success, calls the REAL Tailscale API with an API access token to mint a
 * one-off auth key. The access token lives only in this process (env), never in
 * the AGX example or the launcher. The key's ACL tags are defined here by the
 * server (DUMMY_OAUTH_TAGS, default tag:agx-agent); client-supplied tags are
 * ignored.
 *
 *   export TAILSCALE_API_ACCESS_TOKEN=tskey-api-...     # real token, needs auth_keys scope
 *   pnpm --filter @nostr-agx/tailscale dummy-oauth:server
 *
 * If DUMMY_OAUTH_CLIENT_ID / DUMMY_OAUTH_CLIENT_SECRET are not set, a random
 * dummy client is created at startup and printed once. Point the AGX example at
 * it with --token-url http://127.0.0.1:<port>/oauth/token — the server returns
 * { "authKey": "tskey-…" }, so --api-base-url is not needed.
 *
 * This is a demo/proxy, not a general-purpose OAuth provider: no database, no
 * refresh tokens, no user consent. Binds to loopback only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

interface Config {
	port: number;
	apiBaseUrl: string;
	accessToken: string;
	clientId: string;
	clientSecret: string;
	tailnet: string;
	/** Tags are defined here, on the server; clients cannot supply them. */
	tags: string[];
	expirySeconds: number;
	description: string;
	timeoutMs: number;
}

const MAX_BODY_BYTES = 8 * 1024;

function env(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? fallback);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(): Config {
	const accessToken = env("TAILSCALE_API_ACCESS_TOKEN");
	if (!accessToken) {
		throw new Error(
			"Set TAILSCALE_API_ACCESS_TOKEN to a real Tailscale API access token with the auth_keys scope.",
		);
	}
	const apiBaseUrl = (
		env("TAILSCALE_API_BASE_URL") ?? "https://api.tailscale.com/api/v2"
	).replace(/\/+$/, "");
	let apiUrl: URL;
	try {
		apiUrl = new URL(apiBaseUrl);
	} catch {
		throw new Error(`TAILSCALE_API_BASE_URL is not a URL: ${apiBaseUrl}`);
	}
	if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost" && apiUrl.hostname !== "127.0.0.1") {
		throw new Error("TAILSCALE_API_BASE_URL must be https:// (or loopback for testing).");
	}

	// "Create client": use the configured dummy credentials, or generate a
	// single ephemeral client and print it once for the demo.
	const generated = !env("DUMMY_OAUTH_CLIENT_ID") || !env("DUMMY_OAUTH_CLIENT_SECRET");
	const clientId = env("DUMMY_OAUTH_CLIENT_ID") ?? `agx-demo-${randomBytes(6).toString("hex")}`;
	const clientSecret =
		env("DUMMY_OAUTH_CLIENT_SECRET") ?? randomBytes(24).toString("base64url");
	if (generated) {
		console.info("Created a dummy OAuth client for this run (not stored):");
		console.info(`  client id:     ${clientId}`);
		console.info(`  client secret: ${clientSecret}`);
		console.info("Pass these to the AGX example. They are discarded on exit.\n");
	}

	return {
		port: positiveInt(env("DUMMY_OAUTH_PORT"), 8788),
		apiBaseUrl,
		accessToken,
		clientId,
		clientSecret,
		tailnet: env("DUMMY_OAUTH_TAILNET") ?? "-",
		tags: (env("DUMMY_OAUTH_TAGS") ?? "tag:agx-agent")
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean),
		expirySeconds: positiveInt(env("DUMMY_OAUTH_EXPIRY_SECONDS"), 3600),
		description: (env("DUMMY_OAUTH_DESCRIPTION") ?? "nostr-agx-demo").slice(0, 50),
		timeoutMs: positiveInt(env("DUMMY_OAUTH_TIMEOUT_MS"), 15_000),
	};
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const part = Buffer.from(chunk);
		size += part.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error("request body too large");
		}
		chunks.push(part);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function credentialsFrom(
	req: IncomingMessage,
	form: URLSearchParams,
): { id: string | null; secret: string | null } {
	const header = req.headers.authorization;
	if (header?.startsWith("Basic ")) {
		try {
			const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
			const separator = decoded.indexOf(":");
			if (separator >= 0) {
				return {
					id: decoded.slice(0, separator),
					secret: decoded.slice(separator + 1),
				};
			}
		} catch {
			// Fall through to the form values.
		}
	}
	return { id: form.get("client_id"), secret: form.get("client_secret") };
}

function secretMatches(actual: string | null, expected: string): boolean {
	if (actual === null) return false;
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Ask the real Tailscale API for a single-use auth key. */
async function mintAuthKey(config: Config): Promise<string> {
	const url = `${config.apiBaseUrl}/tailnet/${encodeURIComponent(config.tailnet)}/keys`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${config.accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				capabilities: {
					devices: {
						create: {
							reusable: false,
							ephemeral: true,
							preauthorized: true,
							tags: config.tags,
						},
					},
				},
				expirySeconds: config.expirySeconds,
				description: config.description,
			}),
			signal: AbortSignal.timeout(config.timeoutMs),
		});
	} catch (error) {
		throw new Error(
			`could not reach the Tailscale API: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		// Only its status and error field are useful; never echo the raw body.
	}
	if (!response.ok) {
		const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
		const detail =
			typeof body.message === "string" ? body.message : `Tailscale API returned HTTP ${response.status}`;
		throw new Error(`${code}: ${detail}`);
	}
	for (const field of ["key", "authKey", "auth_key"]) {
		const value = body[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	throw new Error("the Tailscale API answered without an auth key");
}

async function main(): Promise<void> {
	const config = loadConfig();
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`).pathname;
		if (req.method === "GET" && path === "/healthz") {
			json(res, 200, { ok: true });
			return;
		}
		if (req.method !== "POST" || path !== "/oauth/token") {
			json(res, 404, { error: "not_found" });
			return;
		}

		let form: URLSearchParams;
		try {
			form = new URLSearchParams(await readBody(req));
		} catch {
			json(res, 400, { error: "invalid_request", error_description: "unreadable request body" });
			return;
		}
		if (form.get("grant_type") !== "client_credentials") {
			json(res, 400, { error: "unsupported_grant_type" });
			return;
		}
		const credentials = credentialsFrom(req, form);
		if (
			credentials.id !== config.clientId ||
			!secretMatches(credentials.secret, config.clientSecret)
		) {
			json(res, 401, { error: "invalid_client" });
			return;
		}

		try {
			const authKey = await mintAuthKey(config);
			// The SDK's oauthAuthKey() accepts a direct authKey response, so the
			// real API access token never leaves this process.
			json(res, 200, {
				authKey,
				token_type: "Bearer",
				expires_in: config.expirySeconds,
			});
			console.info("POST /oauth/token 200 — auth key minted (value not logged)");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			json(res, 502, { error: "upstream_error", error_description: message });
			console.error(`POST /oauth/token 502 — ${message}`);
		}
	});

	server.listen(config.port, "127.0.0.1", () => {
		console.info(`dummy OAuth endpoint listening on http://127.0.0.1:${config.port}/oauth/token`);
		console.info(`minting keys via ${config.apiBaseUrl} (access token redacted)`);
	});
	const shutdown = (): void => {
		server.close(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().then(
	() => undefined,
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);
