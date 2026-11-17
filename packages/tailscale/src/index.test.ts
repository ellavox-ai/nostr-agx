import { localSigner, NostrTransport } from "@nostr-agx/nostr";
import { describe, expect, it, vi } from "vitest";
import {
	startTailscaleRelayProxy,
	tailscaleRelayProxy,
	TailscaleError,
	type TailscaleStartOptions,
} from "./index";

const KEY = "tskey-auth-abcdefgh";
const PROXY_URL = "socks5://127.0.0.1:45678";

class FakeWs {}

function testSigner() {
	return localSigner(new Uint8Array(32).fill(7));
}

function fakeStart(url = PROXY_URL) {
	const stop = vi.fn(async () => {});
	const start = vi.fn(async (_options: TailscaleStartOptions) => ({
		url,
		stop,
	}));
	return { start, stop };
}

describe("startTailscaleRelayProxy", () => {
	it("resolves the key, applies defaults, and returns a stoppable proxy", async () => {
		const { start, stop } = fakeStart();
		const proxy = await startTailscaleRelayProxy({
			authKey: KEY,
			start,
		});

		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({ authKey: KEY, hostname: "nostr-agx" }),
		);
		expect(proxy.url).toBe(PROXY_URL);
		await proxy.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("passes through launcher options", async () => {
		const { start } = fakeStart();
		await startTailscaleRelayProxy({
			authKey: KEY,
			hostname: "agent-one",
			stateDir: "/tmp/state",
			controlUrl: "https://control.example",
			ephemeral: true,
			tags: ["tag:agx-agent"],
			listen: "127.0.0.1:1080",
			timeoutMs: 5000,
			binary: "/usr/local/bin/agx-tailscale",
			start,
		});
		expect(start).toHaveBeenCalledWith({
			authKey: KEY,
			hostname: "agent-one",
			stateDir: "/tmp/state",
			controlUrl: "https://control.example",
			ephemeral: true,
			tags: ["tag:agx-agent"],
			listen: "127.0.0.1:1080",
			timeoutMs: 5000,
			binary: "/usr/local/bin/agx-tailscale",
		});
	});

	it("fails before starting when no auth key is available", async () => {
		const { start } = fakeStart();
		const error = await startTailscaleRelayProxy({
			authKey: { name: "empty", resolve: async () => undefined },
			start,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TailscaleError);
		expect(error).toMatchObject({ code: "configuration" });
		expect(start).not.toHaveBeenCalled();
	});

	it("maps a launcher failure to TailscaleError", async () => {
		const start = vi.fn(async () => {
			throw new Error("could not start binary");
		});
		const error = await startTailscaleRelayProxy({
			authKey: KEY,
			start,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TailscaleError);
		expect(error).toMatchObject({ code: "module" });
	});
});

describe("tailscaleRelayProxy", () => {
	it("hands the node's lifecycle to the transport", async () => {
		const { start, stop } = fakeStart();
		const transport = await NostrTransport.create({
			signer: testSigner(),
			relays: [],
			ws: FakeWs,
			relayProxy: tailscaleRelayProxy({
				authKey: KEY,
				hostname: "agent-one",
				start,
			}),
		});

		expect(start).toHaveBeenCalledOnce();
		expect(transport.relayProxyUrl).toBe(PROXY_URL);
		expect(stop).not.toHaveBeenCalled();

		await transport.stop();
		expect(stop).toHaveBeenCalledOnce();
		expect(transport.relayProxyUrl).toBeUndefined();
		await expect(transport.start()).rejects.toThrow(/proxy was released/);
	});

	it("releases a started node when later setup fails", async () => {
		const { start, stop } = fakeStart("http://not-socks");
		await expect(
			NostrTransport.create({
				signer: testSigner(),
				relays: [],
				ws: FakeWs,
				relayProxy: tailscaleRelayProxy({ authKey: KEY, start }),
			}),
		).rejects.toThrow(/not a SOCKS protocol/);
		expect(stop).toHaveBeenCalledOnce();
	});
});
