import { describe, expect, it } from "vitest";
import { setRuntimeForTests } from "../runtime.js";
import {
	isWellFormedTailscaleAuthKey,
	oauthAuthKey,
	resolveTailscaleAuthKey,
} from "./auth.js";

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const OTHER_KEY = "tskey-auth-k0987654321CNTRL-zyxwvutsrqponmlk";
const CLIENT_SECRET = "oauth-client-secret-value";

interface Call {
	url: string;
	init: RequestInit;
}

/** A fetch that answers each call from `answers`, recording requests. */
function fakeFetch(
	answers: Array<() => Response>,
): { calls: Call[]; restore: () => void } {
	const calls: Call[] = [];
	let index = 0;
	const restore = setRuntimeForTests({
		fetch: async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			const answer = answers[index++];
			if (!answer) {
				throw new Error("unexpected extra request");
			}
			return answer();
		},
	});
	return { calls, restore };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("isWellFormedTailscaleAuthKey", () => {
	it("accepts a single printable key and rejects spaces, controls and empties", () => {
		expect(isWellFormedTailscaleAuthKey(KEY)).toBe(true);
		expect(isWellFormedTailscaleAuthKey("short")).toBe(false);
		expect(isWellFormedTailscaleAuthKey("tskey with space")).toBe(false);
		expect(isWellFormedTailscaleAuthKey("tskey-with\nnewline")).toBe(false);
		expect(isWellFormedTailscaleAuthKey("")).toBe(false);
		expect(isWellFormedTailscaleAuthKey(null)).toBe(false);
	});
});

describe("resolveTailscaleAuthKey", () => {
	it("prefers an explicit key over the environment", async () => {
		const resolved = await resolveTailscaleAuthKey({
			authKey: KEY,
			env: { TS_AUTHKEY: OTHER_KEY },
		});
		expect(resolved).toEqual({ authKey: KEY, source: "argument" });
	});

	it("falls back to AGX_TAILSCALE_AUTH_KEY, then TS_AUTHKEY", async () => {
		expect(
			await resolveTailscaleAuthKey({
				env: {
					AGX_TAILSCALE_AUTH_KEY: KEY,
					TS_AUTHKEY: OTHER_KEY,
				},
			}),
		).toEqual({ authKey: KEY, source: "env" });
		expect(await resolveTailscaleAuthKey({ env: { TS_AUTHKEY: OTHER_KEY } })).toEqual({
			authKey: OTHER_KEY,
			source: "env",
		});
	});

	it("rejects a malformed key without echoing it", async () => {
		const bad = "tskey-with space";
		let message = "";
		try {
			await resolveTailscaleAuthKey({ authKey: bad, env: {} });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/not a valid Tailscale auth key/);
		expect(message).not.toContain(bad);
	});

	it("asks the OAuth service only when no direct key is available", async () => {
		const { calls, restore } = fakeFetch([() => json({ authKey: KEY })]);
		try {
			const resolved = await resolveTailscaleAuthKey({
				env: {},
				oauth: {
					tokenUrl: "https://auth.example.test/token",
					clientId: "client-id",
					clientSecret: CLIENT_SECRET,
				},
			});
			expect(resolved).toEqual({ authKey: KEY, source: "oauth" });
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe("https://auth.example.test/token");
		} finally {
			restore();
		}
	});

	it("explains what to configure when nothing is available", async () => {
		await expect(resolveTailscaleAuthKey({ env: {} })).rejects.toThrow(
			/No Tailscale auth key is configured/,
		);
	});
});

describe("oauthAuthKey", () => {
	it("accepts a custom service that returns authKey directly", async () => {
		const { calls, restore } = fakeFetch([() => json({ authKey: KEY })]);
		try {
			await expect(
				oauthAuthKey({
					tokenUrl: "https://auth.example.test/token",
					clientId: "client-id",
					clientSecret: CLIENT_SECRET,
				}),
			).resolves.toBe(KEY);
			const headers = calls[0].init.headers as Record<string, string>;
			expect(headers.authorization).toBe(
				`Basic ${Buffer.from(`client-id:${CLIENT_SECRET}`).toString("base64")}`,
			);
			expect(String(calls[0].init.body)).toContain("grant_type=client_credentials");
		} finally {
			restore();
		}
	});

	it("exchanges an access token for an ephemeral preauthorized key", async () => {
		const { calls, restore } = fakeFetch([
			() => json({ access_token: "access-token-value" }),
			() => json({ key: KEY }),
		]);
		try {
			await expect(
				oauthAuthKey({
					tokenUrl: "https://api.tailscale.com/api/v2/oauth/token",
					clientId: "client-id",
					clientSecret: CLIENT_SECRET,
					tailnet: "example.com",
					apiBaseUrl: "https://api.tailscale.com/api/v2",
					tags: ["tag:agx"],
				}),
			).resolves.toBe(KEY);
			expect(calls).toHaveLength(2);
			expect(calls[1].url).toBe(
				"https://api.tailscale.com/api/v2/tailnet/example.com/keys",
			);
			const headers = calls[1].init.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer access-token-value");
			const body = JSON.parse(String(calls[1].init.body)) as {
				capabilities: {
					devices: {
						create: { ephemeral: boolean; preauthorized: boolean; tags: string[] };
					};
				};
			};
			expect(body.capabilities.devices.create).toMatchObject({
				ephemeral: true,
				preauthorized: true,
				tags: ["tag:agx"],
			});
		} finally {
			restore();
		}
	});

	it("defaults to tag:agx-agent when no tags are configured", async () => {
		const { calls, restore } = fakeFetch([
			() => json({ access_token: "access-token-value" }),
			() => json({ key: KEY }),
		]);
		try {
			await expect(
				oauthAuthKey({
					tokenUrl: "https://api.tailscale.com/api/v2/oauth/token",
					clientId: "client-id",
					clientSecret: CLIENT_SECRET,
				}),
			).resolves.toBe(KEY);
			const body = JSON.parse(String(calls[1].init.body)) as {
				capabilities: { devices: { create: { tags: string[] } } };
			};
			expect(body.capabilities.devices.create.tags).toEqual(["tag:agx-agent"]);
		} finally {
			restore();
		}
	});

	it("puts the client secret in the form when tokenAuth is post", async () => {
		const { calls, restore } = fakeFetch([() => json({ authKey: KEY })]);
		try {
			await oauthAuthKey({
				tokenUrl: "https://auth.example.test/token",
				tokenAuth: "post",
				clientId: "client-id",
				clientSecret: CLIENT_SECRET,
			});
			const headers = calls[0].init.headers as Record<string, string>;
			expect(headers.authorization).toBeUndefined();
			const form = new URLSearchParams(String(calls[0].init.body));
			expect(form.get("client_id")).toBe("client-id");
			expect(form.get("client_secret")).toBe(CLIENT_SECRET);
		} finally {
			restore();
		}
	});

	it("reports the OAuth error code, never an unsolicited body", async () => {
		const { restore } = fakeFetch([
			() =>
				json(
					{
						error: "invalid_client",
						error_description: "the client secret is wrong",
						echo: CLIENT_SECRET,
					},
					401,
				),
		]);
		try {
			await expect(
				oauthAuthKey({
					tokenUrl: "https://auth.example.test/token",
					clientId: "client-id",
					clientSecret: CLIENT_SECRET,
				}),
			).rejects.toThrow(/HTTP 401 \(invalid_client\)/);
		} finally {
			restore();
		}
	});

	it("refuses a non-loopback plain-http token URL", async () => {
		await expect(
			oauthAuthKey({
				tokenUrl: "http://auth.example.test/token",
				clientId: "client-id",
				clientSecret: CLIENT_SECRET,
			}),
		).rejects.toThrow(/must be https:\/\//);
	});

	it("refuses a token URL that hides credentials in the userinfo", async () => {
		await expect(
			oauthAuthKey({
				tokenUrl: "https://user:pass@auth.example.test/token",
				clientId: "client-id",
				clientSecret: CLIENT_SECRET,
			}),
		).rejects.toThrow(/must not contain a user name, password/);
	});
});
