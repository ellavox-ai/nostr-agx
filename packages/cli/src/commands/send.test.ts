import kleur from "kleur";
import { WebSocketServer } from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

// What `agx send` prints when a relay answers `["OK", id, false, "<reason>"]`.
// The reason is the relay's own text, so it must reach the terminal as text.
// The relays here are loopback sockets on a free port that answer by hand.

/** A reason with a colour code and a window-title sequence ended by a bell. */
const ESCAPE_REASON = "blocked: \u001b[31mred\u001b]0;title\u0007";
/** The same reason as it should be printed: each control character replaced by U+FFFD. */
const PRINTED_REASON = "blocked: \uFFFD[31mred\uFFFD]0;title\uFFFD";
const PLAIN_REASON = "blocked: rate-limited, try again later";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

let box: ReturnType<typeof sandbox>;
let peer: string;
const relays: { close: () => Promise<void> }[] = [];

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", createIdentity());
	peer = createIdentity().npub;
});

afterEach(async () => {
	await Promise.all(relays.splice(0).map((relay) => relay.close()));
	box.restore();
});

/** A relay that answers every REQ with EOSE and every EVENT with `reason` as a refusal, or an acceptance when `reason` is null. */
async function startAnsweringRelay(reason: string | null): Promise<string> {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg[0] === "REQ") {
				socket.send(JSON.stringify(["EOSE", msg[1]]));
			}
			if (msg[0] === "EVENT") {
				socket.send(JSON.stringify(["OK", msg[1].id, reason === null, reason ?? ""]));
			}
		});
	});
	relays.push({
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) {
					client.terminate();
				}
				wss.close(() => resolve());
			}),
	});
	return `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
}

/** One relay takes the message and one refuses it with `reason`: `agx send` succeeds and warns. */
async function sendWhileOneRelayRefuses(reason: string, ...flags: string[]) {
	const accepting = await startAnsweringRelay(null);
	const refusing = await startAnsweringRelay(reason);
	updateProfile("default", { relays: [accepting, refusing] });
	const run = await agx(...flags, "send", peer, "hello");
	return { run, refusing };
}

/** The only relay refuses with `reason`: `agx send` fails. */
async function sendWhileTheOnlyRelayRefuses(reason: string, ...flags: string[]) {
	const refusing = await startAnsweringRelay(reason);
	updateProfile("default", { relays: [refusing] });
	const run = await agx(...flags, "send", peer, "hello");
	return { run, refusing };
}

describe("agx send, when one relay refuses and another accepts", () => {
	it("prints the refusal reason with control characters replaced, so a terminal does not act on them", async () => {
		const { run, refusing } = await sendWhileOneRelayRefuses(ESCAPE_REASON);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(`! relay refused: ${refusing} — ${PRINTED_REASON}\n`);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
	});

	it.each([
		["a carriage return", "blocked: first\rOK forged"],
		["a line feed", "blocked: first\nOK forged"],
		["a C1 control (CSI)", "blocked: \u009b31mred"],
		["a form feed", "blocked: first\fOK forged"],
		["a line separator", "blocked: first\u2028OK forged"],
	])("keeps a refusal reason with %s on one line", async (_name, reason) => {
		const { run, refusing } = await sendWhileOneRelayRefuses(reason);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		const refusedLines = run.stdout.split("\n").filter((line) => line.includes("relay refused:"));
		expect(refusedLines).toHaveLength(1);
		expect(refusedLines[0]).toContain(refusing);
		expect(run.stdout).not.toMatch(/^OK forged/m);
	});

	it("keeps a refusal that the relay words like a connection failure on one line, with control characters replaced", async () => {
		// A reason that starts with "relay connection" is filed as "unreachable", not "refused".
		const { run, refusing } = await sendWhileOneRelayRefuses("relay connection x\u001b[31m\nRECV forged");

		expect(run.code, run.stderr).toBe(0);
		const unreachableLines = run.stdout.split("\n").filter((line) => line.includes("relay unreachable:"));
		expect(unreachableLines).toEqual([`! relay unreachable: ${refusing} — relay connection x\uFFFD[31m\uFFFDRECV forged`]);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		expect(run.stdout).not.toMatch(/^RECV forged/m);
	});

	it("prints a plain-text refusal reason unchanged", async () => {
		const { run, refusing } = await sendWhileOneRelayRefuses(PLAIN_REASON);

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(`! relay refused: ${refusing} — ${PLAIN_REASON}\n`);
		expect(run.stdout).toContain("relays           1/2 accepted");
	});

	it("keeps the relay's own text in --json output, as escaped JSON", async () => {
		const { run, refusing } = await sendWhileOneRelayRefuses(ESCAPE_REASON, "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		const [doc] = jsonDocuments(run.stdout) as { ok: boolean; rejected: { relay: string; error: string; kind: string }[] }[];
		expect(doc?.ok).toBe(true);
		expect(doc?.rejected).toEqual([{ relay: refusing, error: ESCAPE_REASON, kind: "refused" }]);
	});
});

describe("agx send, when every relay refuses", () => {
	it.each([
		["human", []],
		["--json", ["--json"]],
	])("prints the refusal reason with control characters replaced (%s output)", async (_name, flags) => {
		const { run, refusing } = await sendWhileTheOnlyRelayRefuses(ESCAPE_REASON, ...flags);

		expect(run.code).toBe(5);
		expect(run.stderr).toContain(`Could not publish to any relay: ${refusing} (${PRINTED_REASON})`);
		expect(run.stderr).not.toMatch(CONTROL_CHARACTER);
	});

	it("keeps a refusal reason with a line break on one line", async () => {
		const { run } = await sendWhileTheOnlyRelayRefuses("blocked: first\nOK forged");

		expect(run.code).toBe(5);
		expect(run.stderr).not.toMatch(CONTROL_CHARACTER);
		expect(run.stderr).not.toMatch(/^OK forged/m);
	});

	it("prints a plain-text refusal reason unchanged", async () => {
		const { run, refusing } = await sendWhileTheOnlyRelayRefuses(PLAIN_REASON);

		expect(run.code).toBe(5);
		expect(run.stderr).toContain(`Could not publish to any relay: ${refusing} (${PLAIN_REASON})`);
	});
});

describe("agx send, when every relay accepts", () => {
	it("prints no refusal line", async () => {
		const accepting = await startAnsweringRelay(null);
		updateProfile("default", { relays: [accepting] });

		const run = await agx("send", peer, "hello");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("relays           1/1 accepted");
		expect(run.stdout).not.toContain("relay refused");
		expect(run.stderr).toBe("");
	});
});
