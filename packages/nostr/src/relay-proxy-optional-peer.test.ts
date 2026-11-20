import { describe, expect, it, vi } from "vitest";

vi.mock("socks-proxy-agent", () => {
	throw new Error("Cannot find package 'socks-proxy-agent'");
});

class FakeWebSocket {}

describe("createProxyWebSocket without the optional peer", () => {
	it("explains that socks-proxy-agent must be installed", async () => {
		const { createProxyWebSocket, RelayProxyError } = await import(
			"./relay-proxy"
		);

		await expect(
			createProxyWebSocket("socks5://127.0.0.1:1080", FakeWebSocket),
		).rejects.toBeInstanceOf(RelayProxyError);
		await expect(
			createProxyWebSocket("socks5://127.0.0.1:1080", FakeWebSocket),
		).rejects.toThrow(/optional socks-proxy-agent/);
	});
});
