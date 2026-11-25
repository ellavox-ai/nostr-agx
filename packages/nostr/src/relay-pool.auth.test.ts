import { type Event, finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GIFT_WRAP_KIND } from "./kinds";
import {
	fetchByAuthorWithStatus,
	listenEvents,
	pollInbox,
	publishToRelays,
} from "./relay-pool";
import { type AgxSigner, localSigner } from "./signer";
import { configureWebSocket } from "./ws";

// These tests use the REAL nostr-tools relay client against a small relay that
// listens on a loopback port. relay-pool.test.ts replaces the client with a
// stand-in, and the failure pinned here lives inside the client: when a relay
// sends an AUTH challenge, nostr-tools signs a reply and keeps a promise for the
// relay's answer to it. If the connection is closed first, or the relay answers
// "no", that promise is rejected and nobody is listening, so Node ends the
// whole process. A stand-in client cannot show that.
//
// Which nostr-tools versions end the process: 2.25.0 to 2.25.2, the one the
// lockfile pins (and 2.24.3, the oldest looked at). From 2.25.3 the client
// prints "automatic auth failed:" with a stack trace instead of re-throwing, and
// 2.26.1 also catches a reply sent on a closed socket. Both are covered here:
// every test asserts that nothing reached `console.warn` or `console.error`, so
// the tests still mean something after the library is bumped.

beforeAll(() => {
	configureWebSocket(WebSocket);
});

const ME = getPublicKey(generateSecretKey());
/** How long the relay waits before it answers the client's REQ or EVENT. The AUTH
 * reply is on the wire well within this, and still unanswered when the answer
 * arrives and the client closes the connection. */
const ANSWER_DELAY_MS = 50;
/** A turn of the event loop is enough for Node to report an unhandled rejection;
 * this leaves room for a slow machine. */
const SETTLE_MS = 80;

interface RelayBehaviour {
	/** Send an AUTH frame when the first REQ or EVENT arrives. */
	challenge: boolean;
	/** The frame sent for it. */
	challengeFrame: unknown[];
	/** What the relay says to the client's own AUTH event. */
	authReply: "silent" | "accept" | "refuse";
	/** What the relay says to an EVENT. */
	eventReply: "accept" | "auth-required" | "invalid";
}

interface LoopbackRelay {
	url: string;
	/** Every frame the relay received, in order. */
	frames: unknown[][];
	close(): Promise<void>;
}

const openRelays: LoopbackRelay[] = [];

async function startRelay(
	behaviour: Partial<RelayBehaviour> = {},
): Promise<LoopbackRelay> {
	const b: RelayBehaviour = {
		challenge: true,
		challengeFrame: ["AUTH", "challenge-1"],
		authReply: "silent",
		eventReply: "accept",
		...behaviour,
	};
	const frames: unknown[][] = [];
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => {
		let challenged = false;
		const send = (frame: unknown[]) => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(frame));
			}
		};
		socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as unknown[];
			frames.push(frame);
			if (frame[0] === "AUTH") {
				const id = (frame[1] as { id: string }).id;
				if (b.authReply === "accept") {
					send(["OK", id, true, ""]);
				} else if (b.authReply === "refuse") {
					send(["OK", id, false, "restricted: this key is not on the list"]);
				}
				return;
			}
			if (frame[0] !== "REQ" && frame[0] !== "EVENT") {
				return;
			}
			if (b.challenge && !challenged) {
				challenged = true;
				send(b.challengeFrame);
			}
			setTimeout(() => {
				if (frame[0] === "REQ") {
					send(["EOSE", frame[1] as string]);
					return;
				}
				const id = (frame[1] as { id: string }).id;
				if (b.eventReply === "accept") {
					send(["OK", id, true, ""]);
				} else if (b.eventReply === "auth-required") {
					send(["OK", id, false, "auth-required: sign in first"]);
				} else {
					send(["OK", id, false, "invalid: event too large"]);
				}
			}, ANSWER_DELAY_MS);
		});
	});
	const relay: LoopbackRelay = {
		url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
		frames,
		close: async () => {
			for (const client of wss.clients) {
				client.terminate();
			}
			await new Promise((resolve) => wss.close(resolve));
		},
	};
	openRelays.push(relay);
	return relay;
}

// Node reports a rejection nobody handled to `unhandledRejection`; by default
// that ends the process. Vitest listens too, and would fail the whole run
// instead of the one test, so its listeners step aside while a test runs and
// the rejections are collected here and asserted on.
const unhandled: unknown[] = [];
const collect = (reason: unknown) => {
	unhandled.push(reason);
};
let displaced: NodeJS.UnhandledRejectionListener[] = [];
// What the library (or this code) printed with console.warn or console.error,
// stack and all. A library that stops ending the process but prints a stack
// trace instead still fails these tests.
const logged: string[] = [];
const record = (...args: unknown[]) => {
	logged.push(
		args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" "),
	);
};

beforeEach(() => {
	unhandled.length = 0;
	logged.length = 0;
	vi.spyOn(console, "warn").mockImplementation(record);
	vi.spyOn(console, "error").mockImplementation(record);
	displaced = process.listeners("unhandledRejection");
	process.removeAllListeners("unhandledRejection");
	process.on("unhandledRejection", collect);
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.off("unhandledRejection", collect);
	for (const listener of displaced) {
		process.on("unhandledRejection", listener);
	}
	await Promise.all(openRelays.splice(0).map((r) => r.close()));
});

/** Let any rejection the last call left behind reach `unhandledRejection`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

function signedEvent(): Event {
	return finalizeEvent(
		{ kind: GIFT_WRAP_KIND, created_at: 1_700_000_000, tags: [["p", ME]], content: "x" },
		generateSecretKey(),
	);
}

const signer = () => localSigner(generateSecretKey());

/** The process was not ended and nothing was printed. */
function expectQuiet(): void {
	expect(unhandled.map(String)).toEqual([]);
	expect(logged).toEqual([]);
}

async function waitFor(done: () => boolean, what: string, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!done()) {
		if (Date.now() > end) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A signer that does not answer until `release()`, so a test, not a timer,
 * decides whether the connection is still open when the AUTH reply is signed. */
function gatedSigner(): { signer: AgxSigner; release: () => void; asked: () => number } {
	const inner = signer();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let asked = 0;
	return {
		signer: {
			...inner,
			signEvent: async (template) => {
				asked++;
				await gate;
				return inner.signEvent(template);
			},
		},
		release: () => release(),
		asked: () => asked,
	};
}

describe("publishing to a relay that sends an AUTH challenge", () => {
	it("counts the event as published when the relay accepts it, whatever it does with our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, total: 1, rejected: [] });
		expectQuiet();
	});

	it("reports a relay that wants AUTH as a normal per-relay refusal", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "auth-required" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		expect(res.rejected).toEqual([
			{
				relay: relay.url,
				error: "auth-required: sign in first",
				kind: "refused",
			},
		]);
		expectQuiet();
	});

	it("still delivers to the other relays in the list", async () => {
		const wantsAuth = await startRelay({ authReply: "silent", eventReply: "auth-required" });
		const plain = await startRelay({ challenge: false });
		const res = await publishToRelays(
			[wantsAuth.url, plain.url],
			signedEvent(),
			signer(),
		);
		await settle();

		expect(res.ok).toBe(true);
		expect(res.accepted).toBe(1);
		expect(res.total).toBe(2);
		expect(res.rejected.map((r) => r.relay)).toEqual([wantsAuth.url]);
		expect(plain.frames.some((f) => f[0] === "EVENT")).toBe(true);
		expectQuiet();
	});

	it("is not brought down by a relay that answers our AUTH reply with a refusal", async () => {
		const relay = await startRelay({ authReply: "refuse", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expectQuiet();
	});
});

describe("an AUTH frame with no challenge in it", () => {
	// nostr-tools answers these with "can't perform auth, no challenge was
	// received", thrown from the same unhandled place.
	it.each([[["AUTH"]], [["AUTH", ""]]])(
		"does not end the process or print a stack: %j",
		async (challengeFrame) => {
			const relay = await startRelay({ challengeFrame });
			const res = await publishToRelays([relay.url], signedEvent(), signer());
			await settle();

			expect(res).toMatchObject({ ok: true, accepted: 1, total: 1, rejected: [] });
			expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
			expectQuiet();
		},
	);
});

describe("reading from a relay that sends an AUTH challenge", () => {
	it("answers a lookup by author", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const res = await fetchByAuthorWithStatus({
			relays: [relay.url],
			author: ME,
			kinds: [10002],
			signer: signer(),
		});
		await settle();

		expect(res).toEqual({ events: [], answered: 1 });
		expectQuiet();
	});

	it("completes an inbox poll", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const res = await pollInbox({
			relays: [relay.url],
			pubkey: ME,
			since: 1000,
			signer: signer(),
		});
		await settle();

		expect(res).toEqual({ events: [], complete: true });
		expectQuiet();
	});
});

describe("listening on a relay that sends an AUTH challenge", () => {
	it("keeps listening when the relay refuses our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "refuse" });
		const subs = await listenEvents(signer(), [relay.url], { pubkey: ME }, () => {});
		await settle();
		const stillOpen = subs.map((s) => s.relay.connected);
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expect(stillOpen).toEqual([true]);
		expectQuiet();
	});

	it("can be stopped while the relay has not answered our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const subs = await listenEvents(signer(), [relay.url], { pubkey: ME }, () => {});
		await settle();
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(true);
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expectQuiet();
	});
});

describe("a live listener held open past nostr-tools' AUTH timer", () => {
	// nostr-tools gives the relay `publishTimeout` (4.4 s) to answer our AUTH
	// reply and then rejects with "auth timed out". A listener is the one
	// connection that is still open when that happens. This is the one test that
	// really waits: about 5 s.
	const WAIT_PAST_TIMER_MS = 5000;

	it("stays connected, quiet and alive when the relay never answers our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const subs = await listenEvents(signer(), [relay.url], { pubkey: ME }, () => {});
		await waitFor(() => relay.frames.some((f) => f[0] === "AUTH"), "the AUTH reply");
		// Guards the wait: if the library's timer ever grew past it, this test
		// would pass without having tested anything.
		expect(subs[0].relay.publishTimeout).toBeLessThan(WAIT_PAST_TIMER_MS);

		await new Promise((resolve) => setTimeout(resolve, WAIT_PAST_TIMER_MS));
		const stillOpen = subs.map((s) => s.relay.connected);
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expect(stillOpen).toEqual([true]);
		expectQuiet();
	}, 15_000);
});

describe("a signer that is slower than the relay", () => {
	// A remote signer can take longer to sign the AUTH reply than the relay takes
	// to answer the event. By then the connection is closed. Up to 2.26.0
	// nostr-tools sends the reply anyway, and the failed send is an unhandled
	// rejection; 2.26.1 catches it. A gate in the signer, not a timer, decides
	// when it answers.
	it("does not send, or fail on, an AUTH reply it finishes signing after the connection is closed", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const slow = gatedSigner();
		const res = await publishToRelays([relay.url], signedEvent(), slow.signer);
		// The challenge reaches us before the relay's answer, so the signer was
		// asked while the connection was open; it is closed by now.
		expect(slow.asked()).toBe(1);
		slow.release();
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expectQuiet();
	});

	it("still sends the AUTH reply when the connection is still open", async () => {
		const relay = await startRelay({ authReply: "accept" });
		const slow = gatedSigner();
		const subs = await listenEvents(slow.signer, [relay.url], { pubkey: ME }, () => {});
		await waitFor(() => slow.asked() === 1, "the signer to be asked");
		slow.release();
		await waitFor(() => relay.frames.some((f) => f[0] === "AUTH"), "the AUTH reply");
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expectQuiet();
	});
});

describe("controls: what must keep working", () => {
	it("a relay that never sends an AUTH challenge still takes the event", async () => {
		const relay = await startRelay({ challenge: false });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, total: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expectQuiet();
	});

	it("a relay that refuses for another reason is still a refusal with its own reason", async () => {
		const relay = await startRelay({ challenge: false, eventReply: "invalid" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res.ok).toBe(false);
		expect(res.rejected).toEqual([
			{ relay: relay.url, error: "invalid: event too large", kind: "refused" },
		]);
		expectQuiet();
	});

	it("still answers the challenge with a signed AUTH event for this relay", async () => {
		const relay = await startRelay({ authReply: "accept", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		const auth = relay.frames.find((f) => f[0] === "AUTH");
		expect(auth).toBeDefined();
		const authEvent = (auth as unknown[])[1] as Event;
		expect(authEvent.kind).toBe(22242);
		expect(authEvent.tags).toContainEqual(["challenge", "challenge-1"]);
		const relayTag = authEvent.tags.find((t) => t[0] === "relay");
		expect(relayTag?.[1]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/?$/);
		expectQuiet();
	});

	it("without a signer the challenge is left alone and the event still goes through", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expectQuiet();
	});

	it("does not send an AUTH reply whose signature does not check out", async () => {
		const relay = await startRelay({ authReply: "accept", eventReply: "accept" });
		const inner = signer();
		const forging: AgxSigner = {
			...inner,
			signEvent: async (template) => {
				const e = await inner.signEvent(template);
				// A fresh object with the right id and a signature that does not
				// match it (a copy by spread would carry nostr-tools' "already
				// verified" mark along).
				return {
					id: e.id,
					pubkey: e.pubkey,
					kind: e.kind,
					created_at: e.created_at,
					tags: e.tags,
					content: e.content,
					sig: "0".repeat(128),
				};
			},
		};
		const res = await publishToRelays([relay.url], signedEvent(), forging);
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		// Not `expectQuiet()`: when the check fails, nostr-tools prints "subscribe
		// auth function failed:" with the error. That is how it was before this
		// change and it is left alone.
		expect(unhandled.map(String)).toEqual([]);
	});
});
