import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProxyWebSocket, type DnsLookup } from "./relay-proxy";
import {
	type FakeSocks5,
	type SocksRequest,
	startFakeSocks5,
} from "./test-net";

// A peer's relay is a name that was looked up and vetted on this machine. On the
// pinned path the proxy must be asked for that address, not for the name, or it
// would look the name up again and could land somewhere else. The proxy here is a
// fake SOCKS5 server that records the destination it was asked to connect to, and
// the resolver is injected, so no real DNS is used.

const PEER_RELAY = "wss://peer-relay.example.test/";
const PEER_HOST = "peer-relay.example.test";
/** From the range reserved for documentation (RFC 5737). */
const VETTED_V4 = "203.0.113.7";
/** From the range reserved for documentation (RFC 3849). */
const VETTED_V6 = "2001:db8::1";

let proxy: FakeSocks5;

beforeEach(async () => {
	proxy = await startFakeSocks5();
});

afterEach(async () => {
	await proxy.close();
});

function vetted(address: string): DnsLookup {
	return (_hostname, _options, callback) => {
		callback(null, address, address.includes(":") ? 6 : 4);
	};
}

/** Dial the peer relay once and report what the proxy was asked to reach. */
async function destination(
	proxyUrl: string,
	options?: Parameters<typeof createProxyWebSocket>[2],
): Promise<SocksRequest> {
	const Wrapped = (await createProxyWebSocket(
		proxyUrl,
		WebSocket,
		options,
	)) as typeof WebSocket;
	const socket = new Wrapped(PEER_RELAY);
	socket.on("error", () => {});
	const [request] = await proxy.waitForRequests(1);
	socket.terminate();
	return request!;
}

const at = (scheme: string) => `${scheme}://127.0.0.1:${proxy.port}`;

describe("the pinned path sends the vetted address to the proxy", () => {
	it.each(["socks", "SOCKS"])(
		"%s:// gets the address, not the name",
		async (scheme) => {
			const lookup = vi.fn(vetted(VETTED_V4));

			const request = await destination(at(scheme), { dns: "pinned", lookup });

			expect(request).toEqual({ type: "ipv4", host: VETTED_V4, port: 443 });
			expect(lookup).toHaveBeenCalledOnce();
			expect(lookup.mock.calls[0]?.[0]).toBe(PEER_HOST);
		},
	);

	it("socks:// sends an IPv6 vetted address as an address too", async () => {
		const request = await destination(at("socks"), {
			dns: "pinned",
			lookup: vetted(VETTED_V6),
		});

		expect(request).toEqual({
			type: "ipv6",
			host: "2001:db8:0:0:0:0:0:1",
			port: 443,
		});
	});

	it("socks:// does not reach the proxy for a host that was never vetted", async () => {
		const lookup: DnsLookup = (hostname, _options, callback) =>
			callback(new Error(`No vetted address for peer relay host ${hostname}`));
		const Wrapped = (await createProxyWebSocket(at("socks"), WebSocket, {
			dns: "pinned",
			lookup,
		})) as typeof WebSocket;
		const socket = new Wrapped(PEER_RELAY);
		const failure = await new Promise<Error>((resolve) =>
			socket.on("error", resolve),
		);

		expect(failure.message).toMatch(/No vetted address/);
		expect(proxy.connections()).toBe(0);
	});

	it.each(["socks5", "socks5h"])(
		"%s:// gets the address, not the name",
		async (scheme) => {
			const request = await destination(at(scheme), {
				dns: "pinned",
				lookup: vetted(VETTED_V4),
			});

			expect(request).toEqual({ type: "ipv4", host: VETTED_V4, port: 443 });
		},
	);
});

describe("the default path leaves name resolution to the proxy", () => {
	// An operator's own relay may be a name only the proxy can resolve, such as a
	// tailnet name. That is what the default path is for, and it must not change.
	it.each(["socks", "socks5", "socks5h"])(
		"%s:// sends the name",
		async (scheme) => {
			const request = await destination(at(scheme));

			expect(request).toEqual({ type: "domain", host: PEER_HOST, port: 443 });
		},
	);
});
