import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { oauthAuthKey } from "./auth.js";

const RESERVED_PORTS = new Set([7447, 53505]);
/** Throwaway values, made fresh for every run. */
const hex = (length: number): string => Math.random().toString(16).slice(2).padEnd(length, "0").slice(0, length);
const CLIENT_SECRET = `secret-${hex(16)}`;
const MINTED_KEY = `tskey-auth-${hex(20)}`;

let servers: Server[] = [];

afterEach(async () => {
	for (const server of servers) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	servers = [];
});

/** A local HTTP server on a free port; `requests()` counts what it was asked. */
async function serve(handler: (url: string) => { status: number; headers: Record<string, string>; body?: string }) {
	for (;;) {
		let count = 0;
		const server = createServer((request, response) => {
			count += 1;
			request.resume();
			request.on("end", () => {
				const answer = handler(request.url ?? "");
				response.writeHead(answer.status, answer.headers);
				response.end(answer.body ?? "");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		if (!RESERVED_PORTS.has(port)) {
			servers.push(server);
			return { port, requests: () => count };
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const json = { "content-type": "application/json" };

describe("the CLI's OAuth key request and redirects", () => {
	it("does not follow a redirect from the token endpoint", async () => {
		const target = await serve(() => ({ status: 200, headers: json, body: JSON.stringify({ authKey: MINTED_KEY }) }));
		const service = await serve(() => ({
			status: 307,
			headers: { location: `http://127.0.0.1:${target.port}/collect` },
		}));
		await expect(
			oauthAuthKey({
				tokenUrl: `http://127.0.0.1:${service.port}/oauth/token`,
				tokenAuth: "post",
				clientId: "client",
				clientSecret: CLIENT_SECRET,
			}),
		).rejects.toThrow(/answered with a redirect/);
		expect(service.requests()).toBe(1);
		expect(target.requests(), "the redirect target was asked").toBe(0);
	});

	it("still takes a key the token endpoint returns itself", async () => {
		const service = await serve(() => ({ status: 200, headers: json, body: JSON.stringify({ authKey: MINTED_KEY }) }));
		await expect(
			oauthAuthKey({
				tokenUrl: `http://127.0.0.1:${service.port}/oauth/token`,
				clientId: "client",
				clientSecret: CLIENT_SECRET,
			}),
		).resolves.toBe(MINTED_KEY);
	});
});
