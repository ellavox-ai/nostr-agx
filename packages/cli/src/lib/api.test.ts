import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";
import {
	createApiClient,
	isKeyRejected,
	resolveActionUrl,
	setRpcTimeoutForTests,
	toCliError,
	userAgent,
} from "./api.js";
import { AgxCliError, EXIT, HumanActionRequiredError } from "./errors.js";

const BASE = "https://app.ellaworks.ai";

/** The LOGIN-CONTRACT.md §1.7 wire body, decoded the way RPCLink decodes it. */
function fromFixture(name: string): ORPCError<string, unknown> {
	const wire = (CONTRACT.rpcErrors[name]?.body as { json: Record<string, any> }).json;
	return new ORPCError(wire.code, {
		status: wire.status,
		message: wire.message,
		data: wire.data,
	});
}

describe("exit codes", () => {
	it("7 is human action required", () => {
		expect(EXIT.humanAction).toBe(7);
		const error = new HumanActionRequiredError("x", {
			reason: "LOGIN_APPROVAL_REQUIRED",
			url: BASE,
			userCode: "WDJB-MJHT",
			expiresIn: 1,
		});
		expect(error.exitCode).toBe(7);
		expect(error).toBeInstanceOf(AgxCliError);
	});
});

describe("toCliError: every LOGIN-CONTRACT.md §1.7 data.code", () => {
	it.each([
		["HUMAN_CONFIRMATION_REQUIRED", 7],
		["TERMS_ACCEPTANCE_REQUIRED", 7],
		["INSUFFICIENT_SCOPE", 4],
		["API_KEY_INVALID", 4],
		["API_KEY_EXPIRED", 4],
		["API_KEY_DISABLED", 4],
		["API_KEY_RATE_LIMITED", 6],
		["API_KEY_USAGE_EXCEEDED", 6],
		["API_KEY_OWNER_NOT_MEMBER", 4],
		["API_KEY_SELF_REVOKE_ONLY", 6],
		["LISTING_SLUG_TAKEN", 6],
		["LISTING_ADDRESS_LIVE", 6],
	])("%s → exit %i", (name, exit) => {
		const error = toCliError(fromFixture(name), "someProcedure", BASE);
		expect(error.exitCode).toBe(exit);
		expect(error.remediation).toBeTruthy();
	});

	it("data.code wins over the status and over the 0.3 message regexes", () => {
		// A 403 whose message would match a 0.3 regex, but whose code says scope.
		const error = toCliError(
			new ORPCError("FORBIDDEN", {
				message: "does not have access to this organization",
				data: { code: "INSUFFICIENT_SCOPE", required: "listings:write", granted: [] },
			}),
			"agentIndex.createListing",
			BASE,
		);
		expect(error.exitCode).toBe(4);
		expect(error.message).toMatch(/covers listings and domains only/);
		expect(error.message).toMatch(/listings:write/);
		expect(error.remediation).toMatch(/Settings/);
	});

	it("HUMAN_CONFIRMATION_REQUIRED carries the actionRequired object", () => {
		const error = toCliError(fromFixture("HUMAN_CONFIRMATION_REQUIRED"), "publishListing", BASE);
		expect(error).toBeInstanceOf(HumanActionRequiredError);
		expect((error as HumanActionRequiredError).actionRequired).toEqual({
			reason: "HUMAN_CONFIRMATION_REQUIRED",
			url: `${BASE}/elladex/listings/l_7?org=acme-robotics`,
			userCode: null,
			expiresIn: null,
			listingId: "l_7",
		});
	});

	it("TERMS_ACCEPTANCE_REQUIRED keeps the Terms URL on the same site (LOGIN-CONTRACT.md §1.8)", () => {
		const error = toCliError(fromFixture("TERMS_ACCEPTANCE_REQUIRED"), "x", BASE);
		expect((error as HumanActionRequiredError).actionRequired).toEqual({
			reason: "TERMS_ACCEPTANCE_REQUIRED",
			url: "https://www.ellaworks.ai/en/legal/terms",
			userCode: null,
			expiresIn: null,
		});
	});

	it("TERMS_ACCEPTANCE_REQUIRED (reserved) is fixed in the browser, never by logging in again, whatever loginRequired says", () => {
		const fixture = fromFixture("TERMS_ACCEPTANCE_REQUIRED");
		for (const loginRequired of [false, true]) {
			const error = toCliError(
				new ORPCError(fixture.code, {
					status: fixture.status,
					message: fixture.message,
					data: { ...(fixture.data as Record<string, unknown>), loginRequired },
				}),
				"x",
				BASE,
			);
			expect(error.exitCode).toBe(7);
			expect(error.remediation).toMatch(/in the browser/);
			expect(error.remediation).not.toMatch(/agx login/);
		}
	});

	it("API_KEY_RATE_LIMITED says how long to wait", () => {
		expect(toCliError(fromFixture("API_KEY_RATE_LIMITED"), "x", BASE).message).toMatch(/2 s/);
	});

	it("LISTING_ADDRESS_LIVE points at our own listing when the server names it", () => {
		expect(toCliError(fromFixture("LISTING_ADDRESS_LIVE"), "createListing", BASE).remediation).toMatch(/agx listing get l_7/);
	});

	it("PRECONDITION_FAILED without a known code → 6", () => {
		const error = toCliError(new ORPCError("PRECONDITION_FAILED", { message: "nope" }), "x", BASE);
		expect(error.exitCode).toBe(6);
		expect(error).not.toBeInstanceOf(HumanActionRequiredError);
	});

	it("CONFLICT without a known code → 6", () => {
		expect(toCliError(new ORPCError("CONFLICT", { message: "That agent address is already listed on the index." }), "x", BASE).exitCode).toBe(6);
	});

	it("an unknown data.code falls back to the status", () => {
		const error = toCliError(
			new ORPCError("FORBIDDEN", { message: "m", data: { code: "SOMETHING_NEW" } }),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(6);
	});

	it("an UNAUTHORIZED without a code now says agx login", () => {
		const error = toCliError(new ORPCError("UNAUTHORIZED", { message: "Invalid API key" }), "x", BASE);
		expect(error.exitCode).toBe(4);
		expect(error.remediation).toBe("agx login");
	});

	it("keeps the 0.3 regex fallbacks for servers without data.code", () => {
		expect(
			toCliError(new ORPCError("UNAUTHORIZED", { message: "API key is missing organization scope" }), "x", BASE).remediation,
		).toMatch(/no organization scope/);
		expect(
			toCliError(new ORPCError("FORBIDDEN", { message: "API key does not have access to this organization" }), "x", BASE).exitCode,
		).toBe(4);
		expect(
			toCliError(new ORPCError("FORBIDDEN", { message: "Prove possession of this key first" }), "x", BASE).remediation,
		).toMatch(/anti-squatting/);
	});

	it("an unfollowed 3xx decoded as a body → 6", () => {
		const error = toCliError(
			new Error("Cannot parse response body, please check the response body and content-type."),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(6);
	});

	it("an unreachable server → 5", () => {
		const error = toCliError(
			Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(5);
		expect(error.message).toBe("x: cannot reach the API (ECONNREFUSED).");
	});

	it("never prints a transport error's own message: undici quotes the refused header value", () => {
		const raw = new TypeError('Headers.append: "ela_HEADERSECRET\nrest" is an invalid header value.');
		const error = toCliError(raw, "account.principal.get", BASE);
		expect(error.exitCode).toBe(EXIT.generic);
		expect(error.message).toBe("account.principal.get: the request failed before the API answered (TypeError).");
		expect(`${error.message} ${error.remediation}`).not.toContain("HEADERSECRET");
	});

	it("a fetch failed whose cause quotes the key prints only the cause's code", () => {
		const raw = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error('invalid header "ela_CAUSESECRETCAUSE"'), { code: "UND_ERR_INVALID_ARG" }),
		});
		const error = toCliError(raw, "x", BASE);
		expect(`${error.message} ${error.remediation}`).not.toContain("CAUSESECRET");
	});

	it("AGX_DEBUG adds the message, with remembered keys redacted", () => {
		createApiClient({ baseUrl: BASE, apiKey: "ela_DEBUGSECRETDEBUGSECRET" }); // remembers the key
		process.env.AGX_DEBUG = "1";
		try {
			const error = toCliError(new TypeError('bad "ela_DEBUGSECRETDEBUGSECRET"'), "x", BASE);
			expect(error.remediation).toContain("[redacted]");
			expect(error.remediation).not.toContain("DEBUGSECRET");
		} finally {
			delete process.env.AGX_DEBUG;
		}
	});

	it("an oRPC error is still quoted (the server's words), but redacted", () => {
		createApiClient({ baseUrl: BASE, apiKey: "ela_ECHOEDSECRETECHOED" });
		const error = toCliError(
			new ORPCError("BAD_REQUEST", { message: "bad key ela_ECHOEDSECRETECHOED" }),
			"x",
			BASE,
		);
		expect(error.message).toBe("x: bad key [redacted]");
	});
});

describe("isKeyRejected (may a key be forgotten unrevoked?)", () => {
	it.each([
		["API_KEY_INVALID", true],
		["API_KEY_EXPIRED", true],
		["API_KEY_DISABLED", false],
		["API_KEY_OWNER_NOT_MEMBER", false],
		["API_KEY_SELF_REVOKE_ONLY", false],
		["INSUFFICIENT_SCOPE", false],
	])("%s → %s", (name, expected) => {
		expect(isKeyRejected(fromFixture(name))).toBe(expected);
	});

	it("a 401 without a code is only with the 0.3 message, exactly (an older server's Invalid API key)", () => {
		expect(isKeyRejected(new ORPCError("UNAUTHORIZED", { message: "Invalid API key" }))).toBe(true);
		expect(isKeyRejected(new ORPCError("SOMETHING", { status: 401, message: "Invalid API key" }))).toBe(true);
	});

	it.each([
		["the 0.3 missing-scope 401", "API key is missing organization scope"],
		["oRPC's default 401", undefined],
		["a gateway's auth wall", "Unauthorized"],
		["a reworded message", "Invalid API key."],
		["another case", "invalid api key"],
		["padding", " Invalid API key"],
		["a longer message", "Invalid API key for this proxy"],
	])("a 401 without a code is NOT (%s): the key may still work", (_label, message) => {
		const withMessage = message === undefined ? {} : { message };
		expect(isKeyRejected(new ORPCError("UNAUTHORIZED", withMessage))).toBe(false);
		expect(isKeyRejected(new ORPCError("UNAUTHORIZED", { ...withMessage, data: {} }))).toBe(false);
	});

	it("the 0.3 message on anything but a 401 is not", () => {
		expect(isKeyRejected(new ORPCError("FORBIDDEN", { message: "Invalid API key" }))).toBe(false);
		expect(isKeyRejected(new ORPCError("TOO_MANY_REQUESTS", { message: "Invalid API key" }))).toBe(false);
	});

	it("a 404 never is: it means the procedure is missing, not the key", () => {
		expect(isKeyRejected(new ORPCError("NOT_FOUND", { message: "Not found" }))).toBe(false);
		expect(isKeyRejected(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(false);
		expect(isKeyRejected(new AgxCliError("redirect", { exitCode: EXIT.remote }))).toBe(false);
	});
});

describe("resolveActionUrl", () => {
	it("resolves a relative URL against OUR base", () => {
		expect(resolveActionUrl("/elladex/listings/l_7?org=acme", BASE)).toBe(`${BASE}/elladex/listings/l_7?org=acme`);
		expect(resolveActionUrl("/x", "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000/x");
	});

	it("keeps an absolute URL on our origin, minus any user info", () => {
		expect(resolveActionUrl(`${BASE}/elladex/x`, BASE)).toBe(`${BASE}/elladex/x`);
		expect(resolveActionUrl("https://me:pw@app.ellaworks.ai/a", BASE)).toBe(`${BASE}/a`);
	});

	it.each([
		"https://evil.example/elladex/listings/l_7",
		"//evil.example/x",
		"javascript:alert(1)",
		"https://app.ellaworks.ai.evil.example/x",
		"http://app.ellaworks.ai/x",
		"",
		42,
	])("replaces %s with the base's /elladex", (url) => {
		expect(resolveActionUrl(url, BASE)).toBe(`${BASE}/elladex`);
	});

	it("admits same-site hosts only when asked (the Terms page)", () => {
		expect(resolveActionUrl("https://www.ellaworks.ai/en/legal/terms", BASE)).toBe(`${BASE}/elladex`);
		expect(resolveActionUrl("https://www.ellaworks.ai/en/legal/terms", BASE, { sameSite: true })).toBe(
			"https://www.ellaworks.ai/en/legal/terms",
		);
		expect(resolveActionUrl("https://ellaworks.ai.evil.example/t", BASE, { sameSite: true })).toBe(`${BASE}/elladex`);
		expect(resolveActionUrl("https://www.ellaworks.ai/t", "http://localhost:3000", { sameSite: true })).toBe(
			"http://localhost:3000/elladex",
		);
	});
});

describe("createApiClient", () => {
	let box: ReturnType<typeof sandbox>;
	let mock: MockIndexServer;
	beforeEach(async () => {
		box = sandbox();
		mock = await startMockIndexServer();
	});
	afterEach(async () => {
		await mock.close();
		box.restore();
	});

	it("sends X-API-Key and an agx User-Agent", async () => {
		const key = mock.addKey();
		await createApiClient({ baseUrl: mock.origin, apiKey: key.key }).organizations.list({});
		const call = mock.calls("/api/rpc/organizations/list")[0];
		expect(call?.headers["x-api-key"]).toBe(key.key);
		expect(call?.headers["user-agent"]).toBe(userAgent());
		expect(userAgent()).toMatch(/^agx\/\d+\.\d+\.\d+ \(node \d+\.\d+\.\d+; \w+\)$/);
	});

	it("refuses a malformed key before any request (exit 3), without quoting it", () => {
		try {
			createApiClient({ baseUrl: mock.origin, apiKey: "ela_CLIENTSECRET\nrest" });
			expect.unreachable();
		} catch (error) {
			expect((error as AgxCliError).exitCode).toBe(EXIT.config);
			expect((error as AgxCliError).message).not.toContain("CLIENTSECRET");
		}
		expect(mock.requests).toEqual([]);
	});

	it("refuses a redirect instead of decoding it as a result (exit 6)", async () => {
		const key = mock.addKey();
		const elsewhere = await startMockIndexServer();
		try {
			mock.setRpc("organizations/list", () => ({
				status: 307,
				headers: { Location: `${elsewhere.origin}/api/rpc/organizations/list` },
			}));
			const call = createApiClient({ baseUrl: mock.origin, apiKey: key.key }).organizations.list({});
			await expect(call).rejects.toMatchObject({ exitCode: EXIT.remote });
			expect(elsewhere.requests).toEqual([]);
		} finally {
			await elsewhere.close();
		}
	});

	it("times out a call whose answer never comes (exit 5)", async () => {
		const key = mock.addKey();
		mock.setRpc("organizations/list", () => new Promise(() => {}));
		const restore = setRpcTimeoutForTests(200);
		const started = Date.now();
		try {
			const error = await createApiClient({ baseUrl: mock.origin, apiKey: key.key })
				.organizations.list({})
				.catch((e: unknown) => e);
			const mapped = toCliError(error, "organizations.list", mock.origin);
			expect(mapped.exitCode).toBe(EXIT.network);
			expect(mapped.message).toBe("organizations.list: the API did not answer in time.");
		} finally {
			restore();
		}
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("times out a body that is trickled forever (exit 5)", async () => {
		const key = mock.addKey();
		const trickle = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.write('{"json":');
			const timer = setInterval(() => res.write(" "), 20);
			res.on("close", () => clearInterval(timer));
		});
		await new Promise<void>((resolve) => trickle.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${(trickle.address() as AddressInfo).port}`;
		const restore = setRpcTimeoutForTests(300);
		const started = Date.now();
		try {
			const error = await createApiClient({ baseUrl: origin, apiKey: key.key })
				.organizations.list({})
				.catch((e: unknown) => e);
			expect(toCliError(error, "organizations.list", origin).exitCode).toBe(EXIT.network);
		} finally {
			restore();
			trickle.closeAllConnections();
			await new Promise<void>((resolve) => trickle.close(() => resolve()));
		}
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("decodes a LOGIN-CONTRACT.md §1.7 wire error into data.code", async () => {
		const key = mock.addKey();
		const error = await createApiClient({ baseUrl: mock.origin, apiKey: key.key })
			.agentIndex.publishListing({ orgSlug: "acme-robotics", listingId: "l_7" })
			.catch((e: unknown) => e);
		const mapped = toCliError(error, "publishListing", mock.origin);
		expect(mapped).toBeInstanceOf(HumanActionRequiredError);
		expect((mapped as HumanActionRequiredError).actionRequired.url).toBe(
			`${mock.origin}/elladex/listings/l_7?org=acme-robotics`,
		);
	});
});
