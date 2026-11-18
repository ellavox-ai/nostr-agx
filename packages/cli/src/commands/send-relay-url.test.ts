import kleur from "kleur";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// What `agx send` prints for the address of a relay that did not take the
// message. A recipient publishes their own relay list, and `agx send` also
// publishes to the relays on it, so the address is text the recipient chose.
// The transport is replaced, so the address can be any string the list holds.

const { publishMessage } = vi.hoisted(() => ({ publishMessage: vi.fn() }));
vi.mock("../lib/transport.js", () => ({
	createTransport: async () => ({ publishMessage }),
	makeLogger: () => undefined,
}));

/** A public IP address, then a path with a window-title sequence and a line break. */
const ODD_RELAY = "wss://1.1.1.1/x\u001b]0;t\u0007\nRECV forged";
/** The same address as it should be printed: each control character replaced by U+FFFD. */
const PRINTED_RELAY = "wss://1.1.1.1/x\uFFFD]0;t\uFFFD\uFFFDRECV forged";
const PLAIN_RELAY = "wss://relay.example.com";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

let box: ReturnType<typeof sandbox>;
let peer: string;

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", createIdentity());
	peer = createIdentity().npub;
	publishMessage.mockReset();
});

afterEach(() => {
	box.restore();
});

type Rejected = { relay: string; error: string; kind: "refused" | "unreachable" };

/** What the transport returns: `accepted` of `total` relays took the message. */
function transportResult(overrides: {
	ok: boolean;
	accepted: number;
	total: number;
	rejected: Rejected[];
	deliveredToPeer?: boolean;
}) {
	return {
		eventId: "ab".repeat(32),
		contextId: "ctx-1",
		errors: overrides.rejected.map((r) => `${r.relay}: ${r.error}`),
		...overrides,
	};
}

describe("agx send, when one relay took the message and another did not", () => {
	it.each([
		["relay refused", "refused"],
		["relay unreachable", "unreachable"],
	] as const)('prints the address on the "%s" line with control characters replaced', async (label, kind) => {
		publishMessage.mockResolvedValue(
			transportResult({
				ok: true,
				accepted: 1,
				total: 2,
				rejected: [{ relay: ODD_RELAY, error: "blocked: nope", kind }],
			}),
		);

		const run = await agx("send", peer, "hello");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(`! ${label}: ${PRINTED_RELAY} — blocked: nope\n`);
		expect(run.stdout).not.toMatch(CONTROL_CHARACTER);
		expect(run.stdout).not.toMatch(/^RECV forged/m);
	});

	it("prints an ordinary relay address unchanged", async () => {
		publishMessage.mockResolvedValue(
			transportResult({
				ok: true,
				accepted: 1,
				total: 2,
				rejected: [{ relay: PLAIN_RELAY, error: "blocked: nope", kind: "refused" }],
			}),
		);

		const run = await agx("send", peer, "hello");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(`! relay refused: ${PLAIN_RELAY} — blocked: nope\n`);
	});
});

describe("agx send, when no relay took the message", () => {
	it("prints the address of a relay that refused it with control characters replaced", async () => {
		publishMessage.mockResolvedValue(
			transportResult({
				ok: false,
				accepted: 0,
				total: 1,
				rejected: [{ relay: ODD_RELAY, error: "blocked: nope", kind: "refused" }],
			}),
		);

		const run = await agx("send", peer, "hello");

		expect(run.code).toBe(5);
		expect(run.stderr).toContain(`Could not publish to any relay: ${PRINTED_RELAY} (blocked: nope)`);
		expect(run.stderr).not.toMatch(CONTROL_CHARACTER);
		expect(run.stderr).not.toMatch(/^RECV forged/m);
	});

	it("prints the address when every relay the recipient advertises refused it, with control characters replaced", async () => {
		publishMessage.mockResolvedValue(
			transportResult({
				ok: false,
				accepted: 1,
				total: 2,
				deliveredToPeer: false,
				rejected: [{ relay: ODD_RELAY, error: "blocked: nope", kind: "refused" }],
			}),
		);

		const run = await agx("send", peer, "hello");

		expect(run.code).toBe(5);
		expect(run.stderr).toContain(`advertises refused it, so they will not see it: ${PRINTED_RELAY} (blocked: nope)`);
		expect(run.stderr).not.toMatch(CONTROL_CHARACTER);
		expect(run.stderr).not.toMatch(/^RECV forged/m);
	});

	it("prints an ordinary relay address unchanged", async () => {
		publishMessage.mockResolvedValue(
			transportResult({
				ok: false,
				accepted: 0,
				total: 1,
				rejected: [{ relay: PLAIN_RELAY, error: "blocked: nope", kind: "refused" }],
			}),
		);

		const run = await agx("send", peer, "hello");

		expect(run.code).toBe(5);
		expect(run.stderr).toContain(`Could not publish to any relay: ${PLAIN_RELAY} (blocked: nope)`);
	});
});
