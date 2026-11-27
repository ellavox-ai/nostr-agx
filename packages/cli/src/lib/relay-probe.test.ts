import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { probeRelay } from "./relay-probe.js";

/** A local listener on a free port that counts the connections it is given. */
async function listener(): Promise<{ url: string; connections: () => number; close(): Promise<void> }> {
	let count = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		count += 1;
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.destroy();
	});
	for (;;) {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		if (port !== 7447 && port !== 53505) {
			return {
				url: `ws://127.0.0.1:${port}`,
				connections: () => count,
				close: async () => {
					for (const socket of sockets) {
						socket.destroy();
					}
					await new Promise<void>((resolve) => server.close(() => resolve()));
				},
			};
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** A stand-in for the WebSocket class that opens at once and records what it was asked to dial. */
function openingClass(dialled: string[]): typeof WebSocket {
	return class extends EventEmitter {
		constructor(url: string) {
			super();
			dialled.push(url);
			queueMicrotask(() => this.emit("open"));
		}
		terminate(): void {}
	} as unknown as typeof WebSocket;
}

describe("probeRelay", () => {
	it("dials with the WebSocket class it is given, not with its own", async () => {
		const relay = await listener();
		try {
			const dialled: string[] = [];
			expect(await probeRelay(relay.url, 2000, openingClass(dialled))).toBe(true);
			expect(dialled).toEqual([relay.url]);
			expect(relay.connections()).toBe(0);
		} finally {
			await relay.close();
		}
	});

	it("dials directly when no class is given", async () => {
		const relay = await listener();
		try {
			expect(await probeRelay(relay.url, 2000)).toBe(false);
			expect(relay.connections()).toBe(1);
		} finally {
			await relay.close();
		}
	});
});
