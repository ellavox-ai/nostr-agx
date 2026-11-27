import WebSocket from "ws";
import { generateSecretKey } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NostrTransport } from "./nostr-transport";
import {
	createProxyWebSocket,
	RelayProxyError,
	wrapWebSocket,
} from "./relay-proxy";
import { localSigner } from "./signer";
import {
	type ConnectWatch,
	type FakeSocks5,
	startFakeSocks5,
	startTcpListener,
	type TcpListener,
	watchConnects,
} from "./test-net";

// The WebSocket that Node 22 and later ship does not take the options `ws` takes,
// so it cannot be sent through a proxy: it ignores the proxy agent and dials the
// relay straight. A class that extends it does the same. Node 20 has no such
// class. Everything here runs against a TCP listener and a fake SOCKS5 server on
// free loopback ports, so nothing reaches beyond this machine.

const builtIn = (globalThis as { WebSocket?: unknown }).WebSocket as
	| typeof WebSocket
	| undefined;

let relay: TcpListener;
let proxy: FakeSocks5;
let watch: ConnectWatch;

beforeEach(async () => {
	relay = await startTcpListener();
	proxy = await startFakeSocks5();
	watch = watchConnects();
});

afterEach(async () => {
	watch.stop();
	vi.unstubAllGlobals();
	await relay.close();
	await proxy.close();
});

const proxyUrl = () => `socks5://127.0.0.1:${proxy.port}`;
const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

/** Create the proxy class, then try one dial, the way a transport would. */
async function createAndDial(base: unknown): Promise<void> {
	const Wrapped = await createProxyWebSocket(proxyUrl(), base as never).catch(
		() => undefined,
	);
	if (!Wrapped) {
		return;
	}
	try {
		const socket = new (Wrapped as typeof WebSocket)(relayUrl());
		socket.onerror = () => {};
	} catch {
		// A class that refuses to dial is the expected outcome here.
	}
}

describe.skipIf(!builtIn)(
	"the built-in WebSocket of the runtime (Node 22 and later; skipped on Node 20, which has none)",
	() => {
		const subjects: [string, () => typeof WebSocket][] = [
			["the built-in class itself", () => builtIn as typeof WebSocket],
			[
				"a class that extends it",
				() => class extends (builtIn as typeof WebSocket) {},
			],
		];

		it.each(subjects)(
			"%s is refused when the proxy class is created",
			async (_name, make) => {
				const base = make();
				const error = await createProxyWebSocket(proxyUrl(), base).catch(
					(e: unknown) => e,
				);
				expect(error).toBeInstanceOf(RelayProxyError);
				const pinned = await createProxyWebSocket(proxyUrl(), base, {
					dns: "pinned",
					lookup: vi.fn(),
				}).catch((e: unknown) => e);
				expect(pinned).toBeInstanceOf(RelayProxyError);
			},
		);

		it.each(subjects)(
			"%s never dials the relay straight when it is used with a proxy",
			async (_name, make) => {
				await createAndDial(make());
				// Nothing was refused if a dial got through, and the dial of the built-in
				// class starts a few ticks later: give it the time to show.
				await new Promise((resolve) => setTimeout(resolve, 200));

				expect(watch.to(relay.port)).toBe(0);
				expect(await relay.settle()).toBe(0);
			},
		);

		it("says what to pass instead, and leaves the proxy address out", async () => {
			const withLogin = `socks5://agxuser:agxsecret@127.0.0.1:${proxy.port}`;
			const error = (await createProxyWebSocket(withLogin, builtIn).catch(
				(e: unknown) => e,
			)) as RelayProxyError;

			expect(error).toBeInstanceOf(RelayProxyError);
			expect(`${error.message} ${error.remediation}`).toMatch(/\bws\b/);
			const shown = JSON.stringify([error.message, error.remediation, error.stack]);
			expect(shown).not.toContain("agxsecret");
			expect(shown).not.toContain("agxuser");
			expect(shown).not.toContain(String(proxy.port));
		});

		it("is refused when a transport is created, and the proxy it started is released", async () => {
			const stop = vi.fn(async () => {});
			const error = await NostrTransport.create({
				signer: localSigner(generateSecretKey()),
				relays: [relayUrl()],
				ws: builtIn,
				relayProxy: () => ({ url: proxyUrl(), stop }),
			}).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(RelayProxyError);
			expect(stop).toHaveBeenCalledOnce();
		});

		it("is refused by wrapWebSocket when no class is given and the built-in one would be used", () => {
			expect(() => wrapWebSocket(undefined, { agent: { addRequest() {} } })).toThrow(
				RelayProxyError,
			);
		});
	},
);

describe("the ws class, the one to pass with a proxy", () => {
	it("is accepted and dials through the proxy", async () => {
		const Wrapped = (await createProxyWebSocket(
			proxyUrl(),
			WebSocket,
		)) as typeof WebSocket;
		const socket = new Wrapped(relayUrl());
		socket.on("error", () => {});

		await proxy.waitForRequests(1);
		expect(watch.to(relay.port)).toBe(0);
		expect(await relay.settle()).toBe(0);
		socket.terminate();
	});

	it("is accepted when the runtime has no built-in WebSocket at all", async () => {
		vi.stubGlobal("WebSocket", undefined);

		const Wrapped = await createProxyWebSocket(proxyUrl(), WebSocket);

		expect(typeof Wrapped).toBe("function");
		expect(watch.total).toBe(0);
	});
});
