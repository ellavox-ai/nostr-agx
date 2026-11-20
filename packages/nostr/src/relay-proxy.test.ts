import { describe, expect, it, vi } from "vitest";
import {
	createProxyWebSocket,
	isRelayProxyHandle,
	RelayProxyError,
	resolveRelayProxy,
	wrapWebSocket,
} from "./relay-proxy";

const { agentUrls } = vi.hoisted(() => ({ agentUrls: [] as string[] }));

vi.mock("socks-proxy-agent", () => ({
	SocksProxyAgent: class {
		constructor(url: string) {
			agentUrls.push(url);
		}
	},
}));

class FakeWebSocket {
	static OPEN = 1;
	readonly args: unknown[];
	constructor(...args: unknown[]) {
		this.args = args;
	}
}

describe("relay proxy resolution", () => {
	it("accepts a SOCKS5 URL", async () => {
		const proxy = await resolveRelayProxy(" socks5://127.0.0.1:1080 ");
		expect(proxy?.url).toBe("socks5://127.0.0.1:1080");
		await expect(proxy?.stop()).resolves.toBeUndefined();
	});

	it("unwraps lazy resolvers and keeps the handle's stop", async () => {
		const stop = vi.fn(async () => {});
		const handle = { url: "socks5h://127.0.0.1:9050", stop };
		expect(isRelayProxyHandle(handle)).toBe(true);
		const proxy = await resolveRelayProxy(async () => handle);
		expect(proxy?.url).toBe(handle.url);
		await proxy?.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("returns undefined when a lazy resolver has no proxy", async () => {
		await expect(resolveRelayProxy(() => undefined)).resolves.toBeUndefined();
	});

	it("rejects non-SOCKS and malformed URLs before dialing", async () => {
		for (const url of ["http://127.0.0.1:8080", "not a url", "socks5://"]) {
			await expect(resolveRelayProxy(url)).rejects.toBeInstanceOf(RelayProxyError);
		}
	});

	it("does not recurse forever on a self-returning resolver", async () => {
		const loop = (): unknown => loop;
		await expect(
			resolveRelayProxy(loop as never),
		).rejects.toBeInstanceOf(RelayProxyError);
	});
});

describe("proxy WebSocket wrapping", () => {
	it("extends the injected implementation and passes options through", () => {
		const Wrapped = wrapWebSocket(FakeWebSocket, {
			agent: "agent",
			handshakeTimeout: 1000,
		});
		const socket = new (Wrapped as typeof FakeWebSocket)("wss://relay.example");
		expect(socket.args).toEqual([
			"wss://relay.example",
			undefined,
			{ agent: "agent", handshakeTimeout: 1000 },
		]);
		expect((Wrapped as typeof FakeWebSocket).OPEN).toBe(1);
	});

	it("adds a SOCKS proxy agent that resolves names at the proxy", async () => {
		const Wrapped = await createProxyWebSocket(
			"socks5://127.0.0.1:1080",
			FakeWebSocket,
		);
		expect(agentUrls.at(-1)).toBe("socks5h://127.0.0.1:1080");
		const socket = new (Wrapped as typeof FakeWebSocket)("wss://relay.example");
		const options = socket.args[2] as { agent?: unknown };
		expect(options.agent).toBeDefined();
	});

	it("keeps pinned relays on local DNS and passes through the vetted lookup", async () => {
		const lookup = vi.fn();
		const Wrapped = await createProxyWebSocket(
			"socks5://user:pass@127.0.0.1:1080",
			FakeWebSocket,
			{ dns: "pinned", lookup },
		);
		expect(agentUrls.at(-1)).toBe("socks5://user:pass@127.0.0.1:1080");
		const socket = new (Wrapped as typeof FakeWebSocket)("wss://relay.example");
		const options = socket.args[2] as { lookup?: unknown };
		expect(options.lookup).toBe(lookup);
	});

	it("forces remote-DNS proxy URLs back to local DNS in pinned mode", async () => {
		await createProxyWebSocket("socks5h://user:pass@127.0.0.1:1080", FakeWebSocket, {
			dns: "pinned",
			lookup: vi.fn(),
		});
		expect(agentUrls.at(-1)).toBe("socks5://user:pass@127.0.0.1:1080");
	});

	it("fails clearly when no WebSocket implementation exists", () => {
		vi.stubGlobal("WebSocket", undefined);
		try {
			expect(() => wrapWebSocket(undefined, {})).toThrow(RelayProxyError);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("refuses to claim a proxy without an explicit WebSocket implementation", async () => {
		await expect(
			createProxyWebSocket("socks5://127.0.0.1:1080"),
		).rejects.toBeInstanceOf(RelayProxyError);
	});
});
