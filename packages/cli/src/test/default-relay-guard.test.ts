import { type AddressInfo, connect as netConnect, createServer, Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { profileSchema } from "../lib/config.js";
import { failTestsThatConnect, guardedPorts, refuseConnections } from "./default-relay-guard.js";

/**
 * The guard that keeps every test away from the default relay port. These tests
 * never go near that port: each guard here covers a port of a listener this file
 * opened itself (port 0), and the listener counts what reaches it.
 */

interface Listener {
	port: number;
	seen: () => number;
}

const listeners: Array<ReturnType<typeof createServer>> = [];

async function listen(): Promise<Listener> {
	let seen = 0;
	const server = createServer((socket) => {
		seen += 1;
		socket.destroy();
	});
	listeners.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, seen: () => seen };
}

afterAll(async () => {
	await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
});

const guarded = await listen();
const open = await listen();
const hooked = await listen();

/** What a plain TCP client sees: "connected", or the error code. */
function dialNet(socket: Socket): Promise<string> {
	return new Promise((resolve) => {
		socket.once("connect", () => {
			socket.destroy();
			resolve("connected");
		});
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
	});
}

/** What `ws` (the library `agx doctor` probes a relay with) sees: the error code. */
function dialWs(url: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url);
		socket.once("open", () => {
			socket.terminate();
			resolve("open");
		});
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
	});
}

const WAYS: Array<[string, (port: number) => Promise<string>]> = [
	["ws to 127.0.0.1", (port) => dialWs(`ws://127.0.0.1:${port}`)],
	["ws to localhost", (port) => dialWs(`ws://localhost:${port}`)],
	["net.connect(port, host)", (port) => dialNet(netConnect(port, "127.0.0.1"))],
	["new Socket().connect(port, host)", (port) => dialNet(new Socket().connect(port, "127.0.0.1"))],
	["net.connect({ port })", (port) => dialNet(netConnect({ port }))],
];

describe("refuseConnections", () => {
	it.each(WAYS)("%s to a guarded port: refused like a closed port, never reaches the listener", async (_way, dial) => {
		const before = guarded.seen();
		const guard = refuseConnections([guarded.port]);
		try {
			expect(await dial(guarded.port)).toBe("ECONNREFUSED");
			expect(() => guard.assertNoneRefused()).toThrow(new RegExp(`:${guarded.port}\\b`));
		} finally {
			guard.restore();
		}
		expect(guarded.seen()).toBe(before);
	});

	it("names what was refused once, then is quiet again", async () => {
		const guard = refuseConnections([guarded.port]);
		try {
			await dialWs(`ws://127.0.0.1:${guarded.port}`);
			expect(() => guard.assertNoneRefused()).toThrow(/the default relay port/);
			expect(() => guard.assertNoneRefused()).not.toThrow();
		} finally {
			guard.restore();
		}
	});

	it("a port that is not guarded is reached, and nothing is refused", async () => {
		const guard = refuseConnections([guarded.port]);
		try {
			expect(await dialNet(netConnect(open.port, "127.0.0.1"))).toBe("connected");
			expect(() => guard.assertNoneRefused()).not.toThrow();
		} finally {
			guard.restore();
		}
	});

	it("after restore the port is reachable again", async () => {
		const guard = refuseConnections([guarded.port]);
		expect(guardedPorts()).toContain(guarded.port);
		guard.restore();
		expect(guardedPorts()).not.toContain(guarded.port);
		expect(await dialNet(netConnect(guarded.port, "127.0.0.1"))).toBe("connected");
		expect(() => guard.assertNoneRefused()).not.toThrow();
	});
});

describe("failTestsThatConnect", () => {
	const guard = failTestsThatConnect([hooked.port]);
	afterAll(() => guard.restore());

	// The failure is raised by the afterEach hook, after the test body returned:
	// `it.fails` passes only when the test is reported as failed.
	it.fails("fails a test that connects to a guarded port, after its body has run", async () => {
		expect(await dialWs(`ws://127.0.0.1:${hooked.port}`)).toBe("ECONNREFUSED");
	});

	it("does not fail a test that connects to nothing guarded", async () => {
		expect(await dialNet(netConnect(open.port, "127.0.0.1"))).toBe("connected");
	});
});

describe("the guard the suite installs in setup.ts", () => {
	it("covers the port of every relay a stock profile starts with", () => {
		const relays = profileSchema.parse({}).relays;
		expect(relays.length).toBeGreaterThan(0);
		for (const url of relays) {
			expect(guardedPorts()).toContain(Number(new URL(url).port));
		}
	});
});
