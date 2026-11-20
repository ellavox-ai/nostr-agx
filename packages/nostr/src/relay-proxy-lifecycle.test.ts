import { describe, expect, it, vi } from "vitest";
import { NostrTransport } from "./nostr-transport";
import { RelayProxyError } from "./relay-proxy";
import { localSigner } from "./signer";

const PROXY_URL = "socks5://agx:secret@127.0.0.1:45678";

class FakeWs {}

function transportWith(relayProxy: Parameters<typeof NostrTransport.create>[0]["relayProxy"]) {
	return NostrTransport.create({
		signer: localSigner(new Uint8Array(32).fill(7)),
		relays: [],
		ws: FakeWs,
		relayProxy,
	});
}

describe("relay proxy ownership", () => {
	it("stops an owned handle with the transport and cannot restart", async () => {
		const stop = vi.fn(async () => {});
		const transport = await transportWith(() => ({ url: PROXY_URL, stop }));

		expect(transport.relayProxyUrl).toBe(PROXY_URL);
		expect(stop).not.toHaveBeenCalled();
		await transport.stop();
		expect(stop).toHaveBeenCalledOnce();
		expect(transport.relayProxyUrl).toBeUndefined();

		const error = await transport.start().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RelayProxyError);
	});

	it("leaves a borrowed URL running and allows a restart", async () => {
		const transport = await transportWith(PROXY_URL);
		await transport.stop();
		expect(transport.relayProxyUrl).toBe(PROXY_URL);
		await expect(transport.start()).resolves.toBeUndefined();
		expect(transport.relayProxyUrl).toBe(PROXY_URL);
	});

	it("releases an owned handle when creation fails after resolution", async () => {
		const stop = vi.fn(async () => {});
		const error = await transportWith({
			url: "http://not-socks",
			stop,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RelayProxyError);
		expect(stop).toHaveBeenCalledOnce();
	});
});
