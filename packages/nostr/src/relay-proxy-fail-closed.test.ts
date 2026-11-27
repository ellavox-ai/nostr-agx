import WebSocket, { type ClientOptions } from "ws";
import { generateSecretKey } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NostrTransport } from "./nostr-transport";
import { createProxyWebSocket, RelayProxyError } from "./relay-proxy";
import { localSigner } from "./signer";
import {
	type ConnectWatch,
	type FakeSocks5,
	startFakeSocks5,
	startTcpListener,
	type TcpListener,
	watchConnects,
} from "./test-net";

// A relay that is a bare IP address is the case where a wrong WebSocket class
// matters most: there is no name to look up, so the connection starts at once.
// The "relay" below is a TCP listener on a free loopback port that counts every
// connection it is given. The proxy is a fake SOCKS5 server on another free
// port, so nothing here reaches beyond this machine.

let relay: TcpListener;
let proxy: FakeSocks5;
let watch: ConnectWatch;

// Whether a listener sees a connection depends on timing: a socket destroyed at
// once can be gone before the listener accepts it, although the address has
// already been contacted. So the tests count the attempts to open a socket (all
// of them, `wss:` included) as well as the connections the listener accepted.
// The attempts are read before anything in the test makes a connection of its
// own, because the listener's `settle()` connects too.
beforeEach(async () => {
	relay = await startTcpListener();
	proxy = await startFakeSocks5();
	watch = watchConnects();
});

afterEach(async () => {
	watch.stop();
	await relay.close();
	await proxy.close();
});

const attemptsToRelay = () => watch.to(relay.port);

const proxyUrl = () => `socks5://127.0.0.1:${proxy.port}`;
const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

/** A subclass that takes the options argument and does not pass it on. */
class DroppingWebSocket extends WebSocket {
	constructor(
		address: string | URL,
		protocols?: string | string[],
		_options?: ClientOptions,
	) {
		super(address, protocols);
	}
}

/** A subclass that adds its own option and keeps the caller's, as a wrapper
 * around `ws` should. */
class MergingWebSocket extends WebSocket {
	constructor(
		address: string | URL,
		protocols?: string | string[],
		options?: ClientOptions,
	) {
		super(address, protocols, { ...options, handshakeTimeout: 5_000 });
	}
}

/** Create the proxy class, then try one dial, the way a transport would. */
async function createAndDial(base: unknown, address: string): Promise<void> {
	const Wrapped = await createProxyWebSocket(proxyUrl(), base).catch(
		() => undefined,
	);
	if (!Wrapped) {
		return;
	}
	try {
		new (Wrapped as typeof WebSocket)(address);
	} catch {
		// A class that refuses to dial is the expected outcome here.
	}
}

describe("a WebSocket class that drops the proxy agent", () => {
	it("is refused when the proxy class is created", async () => {
		await expect(
			createProxyWebSocket(proxyUrl(), DroppingWebSocket),
		).rejects.toBeInstanceOf(RelayProxyError);
		await expect(
			createProxyWebSocket(proxyUrl(), DroppingWebSocket, {
				dns: "pinned",
				lookup: vi.fn(),
			}),
		).rejects.toBeInstanceOf(RelayProxyError);
		// The class is checked without reaching any network address: not the relay,
		// not the proxy, not a port on any other host. (A class that drops its
		// options does try the local socket path of the check, which no network
		// reaches.)
		expect(watch.network).toBe(0);
	});

	it.each(["ws", "wss"])(
		"opens no connection to a relay that is a bare IP address (%s)",
		async (scheme) => {
			await createAndDial(DroppingWebSocket, `${scheme}://127.0.0.1:${relay.port}`);

			expect(attemptsToRelay()).toBe(0);
			expect(await relay.settle()).toBe(0);
			expect(proxy.connections()).toBe(0);
		},
	);

	it("is refused when a transport is created, and the proxy it started is released", async () => {
		const stop = vi.fn(async () => {});
		const error = await NostrTransport.create({
			signer: localSigner(generateSecretKey()),
			relays: [relayUrl()],
			ws: DroppingWebSocket,
			relayProxy: () => ({ url: proxyUrl(), stop }),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RelayProxyError);
		expect(stop).toHaveBeenCalledOnce();
		expect(watch.network).toBe(0);
		expect(await relay.settle()).toBe(0);
	});
});

describe("a WebSocket class that forwards its options", () => {
	it("is accepted when a transport is created, and nothing is dialed until it is used", async () => {
		const stop = vi.fn(async () => {});
		const transport = await NostrTransport.create({
			signer: localSigner(generateSecretKey()),
			relays: [relayUrl()],
			ws: WebSocket,
			relayProxy: () => ({ url: proxyUrl(), stop }),
		});

		expect(watch.total).toBe(0);
		expect(await relay.settle()).toBe(0);
		expect(proxy.connections()).toBe(0);
		await transport.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it.each([
		["the ws class itself", WebSocket],
		["a subclass that adds an option of its own", MergingWebSocket],
	])("%s is accepted and makes no connection when the proxy class is created", async (_name, base) => {
		await createProxyWebSocket(proxyUrl(), base);
		await createProxyWebSocket(proxyUrl(), base, {
			dns: "pinned",
			lookup: vi.fn(),
		});

		expect(watch.total).toBe(0);
		expect(await relay.settle()).toBe(0);
		expect(proxy.connections()).toBe(0);
	});

	it.each([
		["the ws class itself", WebSocket],
		["a subclass that adds an option of its own", MergingWebSocket],
	])("%s dials through the proxy and never straight to the relay", async (_name, base) => {
		const Wrapped = (await createProxyWebSocket(
			proxyUrl(),
			base,
		)) as typeof WebSocket;
		const socket = new Wrapped(relayUrl());
		socket.on("error", () => {});

		const [request] = await proxy.waitForRequests(1);
		expect(request).toEqual({
			type: "ipv4",
			host: "127.0.0.1",
			port: relay.port,
		});
		expect(attemptsToRelay()).toBe(0);
		expect(await relay.settle()).toBe(0);
		socket.terminate();
	});
});

describe("the check made when the proxy class is created", () => {
	it("does not block a class whose constructor refuses the check address", async () => {
		// Such a class cannot be verified up front. It is still checked on every
		// dial, so it is not turned away.
		class PickyWebSocket extends WebSocket {
			constructor(
				address: string | URL,
				protocols?: string | string[],
				options?: ClientOptions,
			) {
				if (String(address).startsWith("ws+unix:")) {
					throw new SyntaxError("only ws and wss addresses");
				}
				super(address, protocols, options);
			}
		}

		const Wrapped = (await createProxyWebSocket(
			proxyUrl(),
			PickyWebSocket,
		)) as typeof WebSocket;
		const socket = new Wrapped(relayUrl());
		socket.on("error", () => {});
		await proxy.waitForRequests(1);
		socket.terminate();
	});

	it("still checks each dial of a class that only drops the agent for some addresses", async () => {
		class SometimesDroppingWebSocket extends WebSocket {
			constructor(
				address: string | URL,
				protocols?: string | string[],
				options?: ClientOptions,
			) {
				super(
					address,
					protocols,
					String(address).startsWith("ws+unix:") ? options : undefined,
				);
			}
		}

		const Wrapped = (await createProxyWebSocket(
			proxyUrl(),
			SometimesDroppingWebSocket,
		)) as typeof WebSocket;
		expect(() => new Wrapped(relayUrl())).toThrow(RelayProxyError);
	});
});
