import { describe, expect, it, vi } from "vitest";
import {
	firstAuthKey,
	environmentAuthKey,
	isWellFormedTailscaleAuthKey,
	oauthAuthKey,
	resolveTailscaleAuthKey,
	staticAuthKey,
	TailscaleError,
} from "./index";

const KEY = "tskey-auth-abcdefgh";
const TOKEN = "tskey-api-0123456789";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("tailscale auth key providers", () => {
	it("resolves a direct key", async () => {
		await expect(resolveTailscaleAuthKey(KEY)).resolves.toBe(KEY);
		await expect(resolveTailscaleAuthKey(staticAuthKey(` ${KEY} `))).resolves.toBe(
			KEY,
		);
	});

	it("reads environment variables in order", async () => {
		const key = environmentAuthKey({
			env: { AGX_TAILSCALE_AUTH_KEY: "tskey-auth-second00" },
			names: ["TS_AUTHKEY", "AGX_TAILSCALE_AUTH_KEY"],
		});
		await expect(key.resolve()).resolves.toBe("tskey-auth-second00");
	});

	it("falls through absent providers and stops at the first present key", async () => {
		const fallback = vi.fn(async () => "tskey-auth-fallback0");
		const chained = firstAuthKey(
			environmentAuthKey({ env: {}, names: ["TS_AUTHKEY"] }),
			staticAuthKey(KEY),
			{ name: "never", resolve: fallback },
		);
		await expect(chained.resolve()).resolves.toBe(KEY);
		expect(fallback).not.toHaveBeenCalled();
	});

	it("fails on a present but malformed key instead of falling through", async () => {
		const chained = firstAuthKey(staticAuthKey("too short"), staticAuthKey(KEY));
		await expect(chained.resolve()).rejects.toMatchObject({
			name: "TailscaleError",
			code: "configuration",
		});
	});

	it("reports the missing source when nothing resolves", async () => {
		const error = await resolveTailscaleAuthKey(
			environmentAuthKey({ env: {}, names: ["TS_AUTHKEY"] }),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TailscaleError);
		expect(error).toMatchObject({ code: "configuration" });
		expect((error as Error).message).toContain("env(TS_AUTHKEY)");
	});

	it("validates key shape without rejecting real keys", () => {
		expect(isWellFormedTailscaleAuthKey(KEY)).toBe(true);
		expect(isWellFormedTailscaleAuthKey("tskey-auth-a b")).toBe(false);
		expect(isWellFormedTailscaleAuthKey("")).toBe(false);
		expect(isWellFormedTailscaleAuthKey("short")).toBe(false);
	});
});

describe("oauthAuthKey", () => {
	it("exchanges client credentials for an access token, then mints a tagged key", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith("/oauth/token")) {
				return json({ access_token: TOKEN });
			}
			return json({ key: KEY });
		});
		const provider = oauthAuthKey({
			clientId: "client-id",
			clientSecret: "client-secret",
			tags: ["tag:agx-agent"],
			expirySeconds: 600,
			fetch: fetchMock as unknown as typeof fetch,
		});

		await expect(provider.resolve()).resolves.toBe(KEY);
		expect(calls).toHaveLength(2);

		const tokenCall = calls[0]!;
		expect(tokenCall.url).toBe("https://api.tailscale.com/api/v2/oauth/token");
		expect(tokenCall.init?.headers).toMatchObject({
			authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
		});
		expect(String(tokenCall.init?.body)).toContain("grant_type=client_credentials");

		const keyCall = calls[1]!;
		expect(keyCall.url).toBe("https://api.tailscale.com/api/v2/tailnet/-/keys");
		expect(keyCall.init?.headers).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
		});
		const body = JSON.parse(String(keyCall.init?.body));
		expect(body).toMatchObject({
			capabilities: {
				devices: {
					create: {
						reusable: false,
						ephemeral: true,
						preauthorized: true,
						tags: ["tag:agx-agent"],
					},
				},
			},
			expirySeconds: 600,
		});
	});

	it("accepts a custom service that returns the key directly", async () => {
		const fetchMock = vi.fn(async () => json({ authKey: KEY }));
		const provider = oauthAuthKey({
			clientId: "id",
			clientSecret: "secret",
			tokenUrl: "https://auth.example/token",
			fetch: fetchMock as unknown as typeof fetch,
		});
		await expect(provider.resolve()).resolves.toBe(KEY);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("defaults to tag:agx-agent when tags are omitted or empty", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return String(url).endsWith("/oauth/token")
				? json({ access_token: TOKEN })
				: json({ key: KEY });
		});
		for (const tags of [undefined, []]) {
			const provider = oauthAuthKey({
				clientId: "id",
				clientSecret: "secret",
				tags,
				fetch: fetchMock as unknown as typeof fetch,
			});
			await expect(provider.resolve()).resolves.toBe(KEY);
		}
		expect(fetchMock).toHaveBeenCalledTimes(4);
		for (const call of calls.filter((c) => c.url.endsWith("/keys"))) {
			const body = JSON.parse(String(call.init?.body));
			expect(body.capabilities.devices.create.tags).toEqual(["tag:agx-agent"]);
		}
	});

	it("lets caller-supplied tags override the default", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return String(url).endsWith("/oauth/token")
				? json({ access_token: TOKEN })
				: json({ key: KEY });
		});
		const provider = oauthAuthKey({
			clientId: "id",
			clientSecret: "secret",
			tags: ["tag:custom"],
			fetch: fetchMock as unknown as typeof fetch,
		});
		await expect(provider.resolve()).resolves.toBe(KEY);
		const keyCall = calls.find((call) => call.url.endsWith("/keys"));
		const body = JSON.parse(String(keyCall?.init?.body));
		expect(body.capabilities.devices.create.tags).toEqual(["tag:custom"]);
	});

	it("maps a rejected credential to an auth error without echoing the secret", async () => {
		const fetchMock = vi.fn(async () =>
			json({ error: "invalid_client", error_description: "bad credentials" }, 401),
		);
		const provider = oauthAuthKey({
			clientId: "id",
			clientSecret: "super-secret-value",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const error = await provider.resolve().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TailscaleError);
		expect(error).toMatchObject({ code: "auth" });
		expect((error as Error).message).toContain("invalid_client");
		expect((error as Error).message).not.toContain("super-secret-value");
	});
});
