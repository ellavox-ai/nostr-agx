import kleur from "kleur";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import { agx, sandbox } from "../test/helpers.js";

// What `agx send` prints about the --context-id its user typed. Real sends run
// over an in-process relay (port 0) with throwaway identities made here.

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
const friend = createIdentity();

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(async () => {
	box = sandbox();
	relay = await startRelay({ port: 0 });
	saveIdentity("default", createIdentity());
	updateProfile("default", { relays: [`ws://127.0.0.1:${relay.port}`] });
});

afterEach(async () => {
	await relay.close();
	box.restore();
});

/** Every character a terminal or a line-oriented reader may act on, other than the newline that ends a line. */
function strayControls(text: string): string[] {
	const found: string[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
		}
	}
	return found;
}

/** What the `contextId` line of the human output shows after its label. */
function shownContextId(stdout: string): string | undefined {
	const line = stdout.split("\n").find((l) => l.trimStart().startsWith("contextId"));
	return line?.replace(/^\s*contextId\s+/, "");
}

const UNSAFE: [string, string, string][] = [
	["an escape sequence", "x\u001b[31my", "x�[31my"],
	["a bell", "x\u0007y", "x�y"],
	["a bare carriage return", "x\ry", "x�y"],
	["a delete character", "x\u007fy", "x�y"],
	["a C1 control (CSI)", "x\u009b2Jy", "x�2Jy"],
	["a line separator", "x\u2028y", "x�y"],
	["a newline that starts a second line", "x\n✓ Sent to npub1elsewhere", "x�✓ Sent to npub1elsewhere"],
];

describe("agx send --context-id with control characters in the id", () => {
	it.each(UNSAFE)("prints %s as a visible replacement, never as itself", async (_name, typed, expected) => {
		const run = await agx("send", friend.npub, "hello", "--context-id", typed);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(shownContextId(run.stdout)).toBe(expected);
	});

	it("keeps the output to the four lines of a send, whatever the id holds", async () => {
		const run = await agx("send", friend.npub, "hello", "--context-id", "x\n✓ Sent to npub1elsewhere");

		expect(run.stdout.split("\n").filter((line) => line !== "")).toHaveLength(4);
	});
});

describe("agx send --context-id with an ordinary id", () => {
	it("prints a plain id as typed, with the rest of the send report", async () => {
		const run = await agx("send", friend.npub, "hello", "--context-id", "plain-thread_1");

		expect(run.code, run.stderr).toBe(0);
		expect(shownContextId(run.stdout)).toBe("plain-thread_1");
		expect(run.stdout).toContain("Sent to npub1");
		expect(run.stdout).toContain("1/1 accepted");
	});

	it("prints letters, symbols and emoji from other scripts as typed", async () => {
		const typed = "café-線-1-\u{1F642}";
		const run = await agx("send", friend.npub, "hello", "--context-id", typed);

		expect(run.code, run.stderr).toBe(0);
		expect(shownContextId(run.stdout)).toBe(typed);
	});

	it("prints the id agx made up when none is given", async () => {
		const run = await agx("send", friend.npub, "hello");

		expect(run.code, run.stderr).toBe(0);
		expect(shownContextId(run.stdout)).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("agx --json send --context-id", () => {
	it.each(UNSAFE)("hands back %s exactly as typed, in one valid JSON document", async (_name, typed) => {
		const run = await agx("--json", "send", friend.npub, "hello", "--context-id", typed);

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const doc = JSON.parse(run.stdout) as { ok: boolean; contextId: string };
		expect(doc.ok).toBe(true);
		expect(doc.contextId).toBe(typed);
	});
});
