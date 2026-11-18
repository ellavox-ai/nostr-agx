import { hexToBytes, localSigner, NostrTransport } from "@nostr-agx/nostr";
import kleur from "kleur";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { createIdentity, type IdentityFile, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// What `agx serve` prints when the relay refuses its automatic reply. The reason
// is the relay's own text, so it must reach the terminal as text. The relay here
// is a loopback socket on a free port that answers by hand: it keeps the one
// message the sender publishes, hands it to the receiver, and then refuses the
// reply with the reason the test chose.

/** A reason with a colour code and a window-title sequence ended by a bell. */
const ESCAPE_REASON = "blocked: \u001b[31mred\u001b]0;title\u0007";
/** The same reason as it should be printed: each control character replaced by U+FFFD. */
const PRINTED_REASON = "blocked: \uFFFD[31mred\uFFFD]0;title\uFFFD";
const PLAIN_REASON = "blocked: rate-limited, try again later";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

let box: ReturnType<typeof sandbox>;
let receiver: IdentityFile;
let ally: IdentityFile;
let relay: HandRelay | null = null;
const otherRelays: HandRelay[] = [];

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(() => {
	box = sandbox();
	receiver = createIdentity();
	ally = createIdentity();
	saveIdentity("default", receiver);
});

afterEach(async () => {
	await relay?.close();
	relay = null;
	await Promise.all(otherRelays.splice(0).map((other) => other.close()));
	box.restore();
});

interface HandRelay {
	url: string;
	/** Refuse every event published from now on with `reason`. */
	refuseWith(reason: string): void;
	close(): Promise<void>;
}

/** A relay that stores what it is given and replays it to a REQ, until told to refuse. */
async function startHandRelay(): Promise<HandRelay> {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((resolve) => wss.once("listening", resolve));
	const stored: { kind: number }[] = [];
	let refusal: string | null = null;
	wss.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg[0] === "EVENT") {
				if (refusal === null) {
					stored.push(msg[1]);
				}
				socket.send(JSON.stringify(["OK", msg[1].id, refusal === null, refusal ?? ""]));
			}
			if (msg[0] === "REQ") {
				for (const event of stored) {
					if (!msg[2]?.kinds || msg[2].kinds.includes(event.kind)) {
						socket.send(JSON.stringify(["EVENT", msg[1], event]));
					}
				}
				socket.send(JSON.stringify(["EOSE", msg[1]]));
			}
		});
	});
	return {
		url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
		refuseWith: (reason) => {
			refusal = reason;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) {
					client.terminate();
				}
				wss.close(() => resolve());
			}),
	};
}

/** A relay holding one message from `ally` to the receiver; it takes everything until told to refuse. */
async function startRelayHoldingOneMessage(): Promise<HandRelay> {
	const started = await startHandRelay();
	relay = started;
	updateProfile("default", { relays: [started.url], allow: [ally.publicKey] });
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(ally.secretKeyHex)),
		relays: [started.url],
		ws: WebSocket,
	});
	try {
		const sent = await transport.publishMessage(receiver.npub, { text: "hello", contextId: "ctx-1" });
		expect(sent.ok).toBe(true);
	} finally {
		await transport.stop();
	}
	return started;
}

const replyFailedLines = (stdout: string): string[] =>
	stdout.split("\n").filter((line) => line.startsWith("REPLY failed"));

describe("agx serve, when the relay refuses its reply", () => {
	it("prints the refusal reason with control characters replaced, so a terminal does not act on them", async () => {
		(await startRelayHoldingOneMessage()).refuseWith(ESCAPE_REASON);

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(replyFailedLines(run.stdout)).toEqual([`REPLY failed: ${relay?.url}: ${PRINTED_REASON}`]);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
	});

	it("keeps a refusal reason with a line break on one line", async () => {
		(await startRelayHoldingOneMessage()).refuseWith("blocked: first\nRECV forged");

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(replyFailedLines(run.stdout)).toHaveLength(1);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		expect(run.stdout).not.toMatch(/^RECV forged/m);
	});

	it.each([
		["a C1 control (CSI)", "blocked: \u009b[2Jcleared", "blocked: \uFFFD[2Jcleared"],
		["a line separator", "blocked: first\u2028RECV forged", "blocked: first\uFFFDRECV forged"],
	])("replaces %s in a refusal reason", async (_name, reason, printed) => {
		(await startRelayHoldingOneMessage()).refuseWith(reason);

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(replyFailedLines(run.stdout)).toEqual([`REPLY failed: ${relay?.url}: ${printed}`]);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		expect(run.stdout).not.toMatch(/^RECV forged/m);
	});

	it("prints the reason of every relay that refuses, each with control characters replaced", async () => {
		const first = await startRelayHoldingOneMessage();
		first.refuseWith("blocked: first \u001b[31mred");
		const second = await startHandRelay();
		otherRelays.push(second);
		second.refuseWith("blocked: second \u001b]0;title\u0007");
		updateProfile("default", { relays: [first.url, second.url], allow: [ally.publicKey] });

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(replyFailedLines(run.stdout)).toEqual([
			`REPLY failed: ${first.url}: blocked: first \uFFFD[31mred; ${second.url}: blocked: second \uFFFD]0;title\uFFFD`,
		]);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
	});

	it("prints a plain-text refusal reason unchanged", async () => {
		(await startRelayHoldingOneMessage()).refuseWith(PLAIN_REASON);

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(replyFailedLines(run.stdout)).toEqual([`REPLY failed: ${relay?.url}: ${PLAIN_REASON}`]);
	});
});

describe("agx serve, when the relay takes its reply", () => {
	it("prints the REPLY line and no failure", async () => {
		await startRelayHoldingOneMessage();

		const run = await agx("serve", "--once", "--no-tasks");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toMatch(/^REPLY → \S+\s+event [0-9a-f]{8}\s+1\/1 relays$/m);
		expect(replyFailedLines(run.stdout)).toEqual([]);
	});
});
