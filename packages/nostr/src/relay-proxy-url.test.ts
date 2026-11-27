import { createServer, type Socket } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NostrTransport } from "./nostr-transport";
import { localSigner } from "./signer";

/** Throwaway SOCKS5 credentials, made fresh for every run. */
const RUN = Math.random().toString(16).slice(2, 10);
const USER = `user${RUN}`;
const PASS = `pass${Math.random().toString(16).slice(2, 10)}`;
const RESERVED_PORTS = new Set([7447, 53505]);

class FakeWs {}

function transportWith(relayProxy: Parameters<typeof NostrTransport.create>[0]["relayProxy"], ws: unknown = FakeWs) {
	return NostrTransport.create({
		signer: localSigner(new Uint8Array(32).fill(7)),
		relays: [],
		ws,
		relayProxy,
	});
}

describe("a transport printed or written as JSON", () => {
	// A host that logs the transport object must not log the proxy's user name and password.
	function shownIn(transport: unknown): string[] {
		return [
			inspect(transport, { depth: null, showHidden: true }),
			inspect(transport, { depth: null }),
			JSON.stringify(transport),
		];
	}

	it("does not hold the proxy's user name or password (borrowed URL)", async () => {
		const transport = await transportWith(`socks5://${USER}:${PASS}@127.0.0.1:45678`);
		for (const text of shownIn(transport)) {
			expect(text).not.toContain(USER);
			expect(text).not.toContain(PASS);
		}
	});

	it("does not hold the proxy's user name or password (owned handle)", async () => {
		const transport = await transportWith(() => ({
			url: `socks5h://${USER}:${PASS}@127.0.0.1:45679`,
			stop: async () => {},
		}));
		for (const text of shownIn(transport)) {
			expect(text).not.toContain(USER);
			expect(text).not.toContain(PASS);
		}
		await transport.stop();
	});

	it("still shows a proxy without credentials, and a transport without a proxy", async () => {
		const plain = await transportWith("socks5://127.0.0.1:1080");
		expect(plain.relayProxyUrl).toBe("socks5://127.0.0.1:1080");
		const none = await transportWith(undefined);
		expect(none.relayProxyUrl).toBeUndefined();
		for (const text of [...shownIn(plain), ...shownIn(none)]) {
			expect(text.length).toBeGreaterThan(0);
		}
	});
});

describe("relayProxyUrl", () => {
	it("does not hold the proxy's user name or password (borrowed URL)", async () => {
		const transport = await transportWith(`socks5://${USER}:${PASS}@127.0.0.1:45678`);
		const shown = transport.relayProxyUrl;
		expect(shown).toBeDefined();
		expect(shown).not.toContain(USER);
		expect(shown).not.toContain(PASS);
		expect(shown).toContain("127.0.0.1:45678");
		expect(shown?.startsWith("socks5://")).toBe(true);
	});

	it("does not hold the proxy's user name or password (owned handle)", async () => {
		const transport = await transportWith(() => ({
			url: `socks5h://${USER}:${PASS}@127.0.0.1:45679`,
			stop: async () => {},
		}));
		const shown = transport.relayProxyUrl;
		expect(shown).not.toContain(USER);
		expect(shown).not.toContain(PASS);
		expect(shown).toContain("127.0.0.1:45679");
		expect(shown?.startsWith("socks5h://")).toBe(true);
		await transport.stop();
	});

	it("shows a URL without credentials exactly as given", async () => {
		for (const url of ["socks5://127.0.0.1:1080", "socks5h://127.0.0.1:9050", "socks5://[::1]:1080"]) {
			const transport = await transportWith(url);
			expect(transport.relayProxyUrl).toBe(url);
		}
	});

	it("is undefined without a proxy", async () => {
		const transport = await transportWith(undefined);
		expect(transport.relayProxyUrl).toBeUndefined();
	});
});

/** A SOCKS5 stand-in that records the user name and password the client sends, then drops the connection. */
async function recordingSocks(): Promise<{
	port: number;
	credentials: Promise<{ user: string; pass: string }>;
	close(): Promise<void>;
}> {
	let resolveCredentials!: (value: { user: string; pass: string }) => void;
	const credentials = new Promise<{ user: string; pass: string }>((resolve) => {
		resolveCredentials = resolve;
	});
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		let buffer = Buffer.alloc(0);
		let greeted = false;
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!greeted) {
				if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
				const offered = [...buffer.subarray(2, 2 + buffer[1]!)];
				buffer = buffer.subarray(2 + buffer[1]!);
				if (!offered.includes(0x02)) {
					socket.destroy();
					return;
				}
				socket.write(Buffer.from([0x05, 0x02]));
				greeted = true;
			}
			if (buffer.length < 2 || buffer.length < 3 + buffer[1]!) return;
			const userLength = buffer[1]!;
			if (buffer.length < 3 + userLength + buffer[2 + userLength]!) return;
			const passLength = buffer[2 + userLength]!;
			resolveCredentials({
				user: buffer.subarray(2, 2 + userLength).toString("utf8"),
				pass: buffer.subarray(3 + userLength, 3 + userLength + passLength).toString("utf8"),
			});
			socket.destroy();
		});
	});
	for (;;) {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		if (!RESERVED_PORTS.has(port)) {
			return {
				port,
				credentials,
				close: async () => {
					for (const socket of sockets) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				},
			};
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("relay proxy credentials", () => {
	it("still reach the SOCKS5 proxy exactly as given", async () => {
		const proxy = await recordingSocks();
		try {
			const transport = await transportWith(`socks5://${USER}:${PASS}@127.0.0.1:${proxy.port}`, WebSocket);
			const Dial = transport.webSocket as typeof WebSocket;
			// The address is the proxy's to open; port 9 is never dialled from here.
			const socket = new Dial("ws://127.0.0.1:9/");
			socket.on("error", () => undefined);
			const seen = await Promise.race([
				proxy.credentials,
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the proxy saw no credentials")), 10_000)),
			]);
			expect(seen).toEqual({ user: USER, pass: PASS });
			socket.terminate();
		} finally {
			await proxy.close();
		}
	});
});
