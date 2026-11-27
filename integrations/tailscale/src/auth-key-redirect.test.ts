import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { oauthAuthKey, TailscaleError } from "./index";

const RESERVED_PORTS = new Set([7447, 53505]);
/** Throwaway values, made fresh for every run. */
const hex = (length: number): string => Math.random().toString(16).slice(2).padEnd(length, "0").slice(0, length);
const CLIENT_SECRET = `secret-${hex(16)}`;
const ACCESS_TOKEN = `token-${hex(16)}`;
const MINTED_KEY = `tskey-auth-${hex(20)}`;

interface Seen {
	method: string | undefined;
	url: string | undefined;
	authorization: string | undefined;
	body: string;
}

interface Local {
	server: Server;
	port: number;
	seen: Seen[];
}

let started: Local[] = [];

afterEach(async () => {
	for (const { server } of started) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	started = [];
});

/** A local HTTP server on a free port that records what it is asked. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void): Promise<Local> {
	for (;;) {
		const seen: Seen[] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				const entry: Seen = {
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					body,
				};
				seen.push(entry);
				handler(request, response, entry);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		if (!RESERVED_PORTS.has(port)) {
			const local = { server, port, seen };
			started.push(local);
			return local;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function reply(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

describe("oauthAuthKey redirects", () => {
	it("asks fetch to refuse a redirect on both requests", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const fetch = (async (_url: unknown, init?: RequestInit) => {
			inits.push(init);
			return inits.length === 1
				? new Response(JSON.stringify({ access_token: ACCESS_TOKEN }), { status: 200 })
				: new Response(JSON.stringify({ key: MINTED_KEY }), { status: 200 });
		}) as typeof globalThis.fetch;
		const key = await oauthAuthKey({
			clientId: "client",
			clientSecret: CLIENT_SECRET,
			tokenUrl: "http://127.0.0.1:9/oauth/token",
			apiBaseUrl: "http://127.0.0.1:9/api",
			fetch,
		}).resolve();
		expect(key).toBe(MINTED_KEY);
		expect(inits.map((init) => init?.redirect)).toEqual(["error", "error"]);
	});

	for (const status of [301, 302, 303, 307, 308]) {
		it(`does not follow a ${status} from the token endpoint`, async () => {
			const target = await serve((_request, response) => reply(response, 200, { authKey: MINTED_KEY }));
			const service = await serve((_request, response) => {
				response.writeHead(status, { location: `http://127.0.0.1:${target.port}/collect` });
				response.end();
			});
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenAuth: "post",
				tokenUrl: `http://127.0.0.1:${service.port}/oauth/token`,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TailscaleError);
			expect(error).toMatchObject({ code: "network" });
			expect(service.seen).toHaveLength(1);
			expect(target.seen, "the redirect target was asked").toHaveLength(0);
		});
	}

	it("does not follow a redirect from the key endpoint", async () => {
		const target = await serve((_request, response) => reply(response, 200, { key: MINTED_KEY }));
		const service = await serve((request, response) => {
			if (request.url === "/api/oauth/token") {
				reply(response, 200, { access_token: ACCESS_TOKEN });
				return;
			}
			response.writeHead(307, { location: `http://127.0.0.1:${target.port}/collect` });
			response.end();
		});
		const error = await oauthAuthKey({
			clientId: "client",
			clientSecret: CLIENT_SECRET,
			apiBaseUrl: `http://127.0.0.1:${service.port}/api`,
		})
			.resolve()
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TailscaleError);
		expect(error).toMatchObject({ code: "network" });
		expect(service.seen.map((entry) => entry.url)).toEqual(["/api/oauth/token", "/api/tailnet/-/keys"]);
		expect(target.seen, "the redirect target was asked").toHaveLength(0);
	});

	describe("what the error says", () => {
		const secretQuery = `code=${hex(16)}`;
		const textOf = (error: unknown): string =>
			`${(error as Error).message}\n${(error as TailscaleError).remediation ?? ""}`;

		for (const status of [301, 302, 307]) {
			it(`says the token endpoint answered with a redirect (${status}) and does not repeat where to`, async () => {
				const target = await serve((_request, response) => reply(response, 200, { authKey: MINTED_KEY }));
				const service = await serve((_request, response) => {
					response.writeHead(status, { location: `http://127.0.0.1:${target.port}/collect?${secretQuery}` });
					response.end();
				});
				const error = await oauthAuthKey({
					clientId: "client",
					clientSecret: CLIENT_SECRET,
					tokenAuth: "post",
					tokenUrl: `http://127.0.0.1:${service.port}/oauth/token`,
				})
					.resolve()
					.catch((e: unknown) => e);
				expect(error).toBeInstanceOf(TailscaleError);
				expect(error).toMatchObject({ code: "network" });
				expect((error as Error).message).toMatch(/answered with a redirect/);
				expect(textOf(error)).not.toMatch(/could not reach/);
				expect(textOf(error)).not.toContain(secretQuery);
				expect(textOf(error)).not.toContain(String(target.port));
				expect(textOf(error)).not.toContain(CLIENT_SECRET);
			});
		}

		it("says the key endpoint answered with a redirect", async () => {
			const service = await serve((request, response) => {
				if (request.url === "/api/oauth/token") {
					reply(response, 200, { access_token: ACCESS_TOKEN });
					return;
				}
				response.writeHead(307, { location: `https://example.invalid/collect?${secretQuery}` });
				response.end();
			});
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				apiBaseUrl: `http://127.0.0.1:${service.port}/api`,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect((error as Error).message).toMatch(/key request.*answered with a redirect/);
			expect(textOf(error)).not.toContain(secretQuery);
			expect(textOf(error)).not.toContain(ACCESS_TOKEN);
		});

		it("finds the redirect in the failure a fetch implementation throws", async () => {
			const fetch = (async () => {
				throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
			}) as typeof globalThis.fetch;
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenUrl: "https://auth.example.test/token",
				fetch,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect((error as Error).message).toMatch(/answered with a redirect/);
		});

		it("names only the address that was called, not its path or query, and adds nothing from the failure", async () => {
			const target = await serve((_request, response) => reply(response, 200, { authKey: MINTED_KEY }));
			const service = await serve((_request, response) => {
				response.writeHead(302, { location: `http://127.0.0.1:${target.port}/collect` });
				response.end();
			});
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenAuth: "post",
				tokenUrl: `http://127.0.0.1:${service.port}/oauth/token?${secretQuery}`,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect((error as Error).message).toBe(
				`OAuth token request to http://127.0.0.1:${service.port} was answered with a redirect, which is not followed.`,
			);
			expect(textOf(error)).not.toContain(secretQuery);
		});

		it("finds the redirect when it sits several causes down in the failure", async () => {
			const fetch = (async () => {
				throw new TypeError("fetch failed", {
					cause: new Error("request failed", { cause: new Error("connection step", { cause: new Error("unexpected redirect") }) }),
				});
			}) as typeof globalThis.fetch;
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenUrl: "https://auth.example.test/token",
				fetch,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect((error as Error).message).toMatch(/answered with a redirect/);
		});

		it("still says it could not reach a service that is not there", async () => {
			const closed = await serve(() => undefined);
			const port = closed.port;
			closed.server.closeAllConnections();
			await new Promise<void>((resolve) => closed.server.close(() => resolve()));
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect(error).toMatchObject({ code: "network" });
			expect((error as Error).message).toMatch(/could not reach/);
			expect((error as Error).message).not.toMatch(/redirect/);
		});

		it("still says it could not reach a service when the failure is an ordinary network error", async () => {
			const fetch = (async () => {
				throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
			}) as typeof globalThis.fetch;
			const error = await oauthAuthKey({
				clientId: "client",
				clientSecret: CLIENT_SECRET,
				tokenUrl: "https://auth.example.test/token",
				fetch,
			})
				.resolve()
				.catch((e: unknown) => e);
			expect((error as Error).message).toMatch(/could not reach/);
		});
	});

	it("still mints a key from a service that answers directly", async () => {
		const service = await serve((request, response) => {
			if (request.url === "/api/oauth/token") {
				reply(response, 200, { access_token: ACCESS_TOKEN });
				return;
			}
			reply(response, 200, { key: MINTED_KEY });
		});
		const key = await oauthAuthKey({
			clientId: "client",
			clientSecret: CLIENT_SECRET,
			apiBaseUrl: `http://127.0.0.1:${service.port}/api`,
		}).resolve();
		expect(key).toBe(MINTED_KEY);
		expect(service.seen).toHaveLength(2);
		expect(service.seen[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
	});

	it("still takes a key the token endpoint returns itself", async () => {
		const service = await serve((_request, response) => reply(response, 200, { authKey: MINTED_KEY }));
		const key = await oauthAuthKey({
			clientId: "client",
			clientSecret: CLIENT_SECRET,
			tokenUrl: `http://127.0.0.1:${service.port}/oauth/token`,
		}).resolve();
		expect(key).toBe(MINTED_KEY);
	});
});
