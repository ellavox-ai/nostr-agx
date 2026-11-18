import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { type RelayEvent, type RunningRelay, startRelay } from "./server.js";

/**
 * What the local relay (`agx relay`, `agx link up`) should refuse. These tests
 * are written to FAIL on the relay as it is: each one asserts the behaviour a
 * fix would give. Every test is a plain loopback connection with no key in it.
 *
 * Two kinds of limit are asserted, and neither number is a guess:
 * - A frame of 1 MiB. The largest event AGX sends is `INTEROP_MAX_EVENT_BYTES`
 *   (64 KiB, in packages/nostr/src/events.ts), so any `maxPayload` from about
 *   70 KiB up to 1 MiB passes; `ws` allows 100 MiB by default.
 * - A REQ that stalls the process. The time bound is generous: the fixed relay
 *   is expected to answer in milliseconds.
 */

const relays: RunningRelay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

async function start(): Promise<RunningRelay> {
	const relay = await startRelay({ port: 0 });
	relays.push(relay);
	return relay;
}

async function connect(port: number, headers: Record<string, string> = {}): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
	sockets.push(socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
}

/** How a connection attempt ends: it opened, or the relay answered the upgrade with a status. */
function attempt(port: number, headers: Record<string, string>): Promise<"opened" | `refused ${number}` | "failed"> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
		sockets.push(socket);
		socket.once("open", () => resolve("opened"));
		socket.once("unexpected-response", (_req, res) => resolve(`refused ${res.statusCode ?? 0}`));
		socket.once("error", () => resolve("failed"));
	});
}

function nextMessage(socket: WebSocket, timeoutMs = 5_000): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for relay message")), timeoutMs);
		socket.once("message", (data: RawData) => {
			clearTimeout(timer);
			resolve(JSON.parse(data.toString()) as unknown[]);
		});
	});
}

function makeEvent(id: string, content = ""): RelayEvent {
	return {
		id,
		pubkey: "sender",
		created_at: Math.floor(Date.now() / 1_000),
		kind: 1059,
		tags: [["p", "recipient"]],
		content,
		sig: "",
	};
}

describe("relay: a web page cannot reach it (B-38)", () => {
	it("refuses an upgrade that carries an Origin header, as a browser page sends", async () => {
		const relay = await start();
		// Any refusal will do (401 or 403), as will a connection that fails: it must not open.
		expect(await attempt(relay.port, { Origin: "http://evil.example" })).not.toBe("opened");
	});

	it("does not store an event sent on a connection that carries an Origin header", async () => {
		const relay = await start();
		const socket = new WebSocket(`ws://127.0.0.1:${relay.port}`, { headers: { Origin: "http://evil.example" } });
		sockets.push(socket);
		await new Promise<void>((resolve) => {
			socket.once("open", () => {
				socket.send(JSON.stringify(["EVENT", makeEvent("from-a-web-page")]));
				setTimeout(resolve, 300);
			});
			socket.once("unexpected-response", () => resolve());
			socket.once("error", () => resolve());
		});
		expect(relay.events().map((event) => event.id)).not.toContain("from-a-web-page");
	});

	// Control: passes before and after. A client that is not a browser sends no Origin header.
	it("accepts an upgrade with no Origin header (control)", async () => {
		const relay = await start();
		expect(await attempt(relay.port, {})).toBe("opened");
	});
});

describe("relay: resource limits (B-39)", () => {
	it("closes a connection that sends a 1 MiB frame, 16 times the largest AGX event", async () => {
		const relay = await start();
		const socket = await connect(relay.port);
		const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
		socket.send("x".repeat(1024 * 1024));
		const outcome = await Promise.race([closed, new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 2_000))]);
		expect(outcome).toBe(1009);
	});

	// Control: passes before and after. An event of about 60 KB is within what AGX sends.
	it("still accepts an event of about 60 KB (control)", async () => {
		const relay = await start();
		const socket = await connect(relay.port);
		const reply = nextMessage(socket);
		socket.send(JSON.stringify(["EVENT", makeEvent("big-but-fine", "a".repeat(60_000))]));
		expect(await reply).toEqual(["OK", "big-but-fine", true, ""]);
	});

	it("answers a REQ with 20,000 filter keys in under a second, with 400 events stored", async () => {
		const relay = await start();
		const socket = await connect(relay.port);
		for (let i = 0; i < 400; i++) {
			const reply = nextMessage(socket);
			socket.send(JSON.stringify(["EVENT", makeEvent(`seed-${i}`)]));
			await reply;
		}
		const filter: Record<string, unknown> = { kinds: [1059] };
		for (let i = 0; i < 20_000; i++) {
			filter[`#k${i}`] = ["z"];
		}
		const started = Date.now();
		const done = new Promise<void>((resolve) => {
			// Closing the connection is also an answer: a request this big may be refused.
			socket.once("close", () => resolve());
			socket.on("message", (data: RawData) => {
				// Answered either way: the events, or a refusal of a request this big.
				if (["EOSE", "CLOSED"].includes((JSON.parse(data.toString()) as unknown[])[0] as string)) {
					resolve();
				}
			});
		});
		socket.send(JSON.stringify(["REQ", "heavy", filter]));
		await done;
		// A wide margin on both sides: the relay as it is takes several seconds, and a relay that
		// builds the key list once per request, or caps the keys, takes milliseconds.
		expect(Date.now() - started).toBeLessThan(1_000);
	}, 60_000);
});
