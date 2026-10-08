import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
	createSecurity,
	CSRF_HEADER,
	parseCookies,
	SECURITY_HEADERS,
	SESSION_COOKIE,
	sessionCookie,
} from "./security.js";

const PORT = 4321;

function request(headers: Record<string, string>, method = "GET"): IncomingMessage {
	return { headers, method } as unknown as IncomingMessage;
}

function login(now = () => Date.now()) {
	const security = createSecurity({ port: PORT, now });
	const session = security.exchangeLaunchToken(security.launchToken);
	if (!session) {
		throw new Error("login failed");
	}
	const cookie = `${SESSION_COOKIE}=${session.id}`;
	const good = {
		host: `127.0.0.1:${PORT}`,
		cookie,
		[CSRF_HEADER]: session.csrf,
	};
	return { security, session, good };
}

describe("launch token", () => {
	it("is exchanged once for a session", () => {
		const security = createSecurity({ port: PORT });
		expect(security.exchangeLaunchToken(security.launchToken)).not.toBeNull();
		expect(security.exchangeLaunchToken(security.launchToken)).toBeNull();
	});

	it("is not burned by a wrong guess", () => {
		const security = createSecurity({ port: PORT });
		expect(security.exchangeLaunchToken("wrong")).toBeNull();
		expect(security.exchangeLaunchToken(security.launchToken)).not.toBeNull();
	});

	it("expires", () => {
		let clock = 1_000;
		const security = createSecurity({ port: PORT, now: () => clock });
		clock += 11 * 60 * 1000;
		expect(security.exchangeLaunchToken(security.launchToken)).toBeNull();
	});

	it("gives a different session id and csrf secret each time", () => {
		const a = login().session;
		const b = login().session;
		expect(a.id).not.toBe(b.id);
		expect(a.csrf).not.toBe(a.id);
	});
});

describe("host check (DNS rebinding)", () => {
	const security = createSecurity({ port: PORT });
	it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`])("accepts %s", (host) => {
		expect(security.hostAllowed(host)).toBe(true);
	});
	it.each([undefined, "", "evil.example", `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, "127.0.0.1", `127.0.0.1.evil.example:${PORT}`, `0.0.0.0:${PORT}`])("rejects %s", (host) => {
		expect(security.hostAllowed(host)).toBe(false);
	});
});

describe("API authorization", () => {
	it("accepts the cookie plus the CSRF header on our own host", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request(good)).ok).toBe(true);
	});

	it("rejects a request with no cookie (401)", () => {
		const { security, good } = login();
		const { cookie: _cookie, ...noCookie } = good;
		expect(security.authorizeApi(request(noCookie))).toMatchObject({ ok: false, status: 401 });
	});

	it("rejects a cookie that is not a session (401)", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request({ ...good, cookie: `${SESSION_COOKIE}=forged` }))).toMatchObject({ ok: false, status: 401 });
	});

	it("rejects a missing or wrong CSRF header (403)", () => {
		const { security, good } = login();
		const { [CSRF_HEADER]: _csrf, ...noCsrf } = good;
		expect(security.authorizeApi(request(noCsrf))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, [CSRF_HEADER]: "nope" }))).toMatchObject({ ok: false, status: 403 });
	});

	it("rejects a foreign Origin (403)", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request({ ...good, origin: "https://evil.example" }, "POST"))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, origin: "http://127.0.0.1:9999" }, "POST"))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, origin: "null" }, "POST"))).toMatchObject({ ok: false, status: 403 });
	});

	it("needs an Origin on anything that changes state", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request(good, "POST"))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, origin: `http://127.0.0.1:${PORT}` }, "POST")).ok).toBe(true);
	});

	it("rejects a cross-site fetch by Sec-Fetch-Site", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request({ ...good, "sec-fetch-site": "cross-site" }))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, "sec-fetch-site": "same-site" }))).toMatchObject({ ok: false, status: 403 });
		expect(security.authorizeApi(request({ ...good, "sec-fetch-site": "same-origin" })).ok).toBe(true);
	});

	it("rejects a rebound Host even with a valid session (403)", () => {
		const { security, good } = login();
		expect(security.authorizeApi(request({ ...good, host: `evil.example:${PORT}` }))).toMatchObject({ ok: false, status: 403 });
	});

	it("pages need the cookie and our host, not the CSRF header", () => {
		const { security, good } = login();
		const { [CSRF_HEADER]: _csrf, ...page } = good;
		expect(security.authorizePage(request(page)).ok).toBe(true);
		expect(security.authorizePage(request({ ...page, host: "evil.example" }))).toMatchObject({ ok: false, status: 403 });
	});
});

describe("cookie and headers", () => {
	it("sets an HttpOnly, SameSite=Strict cookie", () => {
		const { session } = login();
		const cookie = sessionCookie(session);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");
	});

	it("parses cookies", () => {
		expect(parseCookies("a=1; agx_ui=abc; b=2")).toEqual({ a: "1", agx_ui: "abc", b: "2" });
		expect(parseCookies(undefined)).toEqual({});
	});

	it("sends a strict CSP and never a CORS header", () => {
		const csp = SECURITY_HEADERS["content-security-policy"] ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).not.toContain("unsafe-inline");
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).toContain("frame-ancestors 'none'");
		for (const name of Object.keys(SECURITY_HEADERS)) {
			expect(name.startsWith("access-control-")).toBe(false);
		}
	});
});
