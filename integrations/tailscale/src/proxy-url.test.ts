import { describe, expect, it } from "vitest";
import { redactProxyUrl } from "./proxy-url";

describe("redactProxyUrl", () => {
	it("replaces the user name and password and keeps the scheme, host and port", () => {
		expect(redactProxyUrl("socks5://agx:secret@127.0.0.1:45678")).toBe(
			"socks5://redacted@127.0.0.1:45678",
		);
		expect(redactProxyUrl("socks5h://agx:secret@[::1]:1080")).toBe(
			"socks5h://redacted@[::1]:1080",
		);
	});

	it("replaces a user name alone and a password alone", () => {
		expect(redactProxyUrl("socks5://agx@127.0.0.1:1080")).toBe("socks5://redacted@127.0.0.1:1080");
		expect(redactProxyUrl("socks5://:secret@127.0.0.1:1080")).toBe("socks5://redacted@127.0.0.1:1080");
	});

	it("replaces percent-encoded credentials", () => {
		const shown = redactProxyUrl("socks5://a%40b:p%3Aw%2Fd@127.0.0.1:1080");
		expect(shown).toBe("socks5://redacted@127.0.0.1:1080");
	});

	it("returns a URL without credentials exactly as given", () => {
		for (const url of ["socks5://127.0.0.1:1080", "socks5h://127.0.0.1:9050", "socks5://[::1]:1080"]) {
			expect(redactProxyUrl(url)).toBe(url);
		}
	});

	it("never echoes text that does not parse", () => {
		const shown = redactProxyUrl("socks5://agx:secret@[not-an-ip:1080");
		expect(shown).toBe("[redacted proxy URL]");
		expect(shown).not.toContain("secret");
	});
});
