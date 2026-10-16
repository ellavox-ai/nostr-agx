import { afterEach, beforeEach, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { agx, sandbox } from "./helpers.js";

/**
 * `runCli` resolves to the exit code a command set through process.exitCode,
 * and does not leave it set for the next run in the same process.
 */

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	process.exitCode = undefined;
	box.restore();
});

it("returns inbox's exit 5 when no relay answers, and clears process.exitCode", async () => {
	expect((await agx("identity", "new")).code).toBe(EXIT.ok);
	// Port 1 on loopback refuses at once: no relay answers.
	expect((await agx("config", "set", "relays", "ws://127.0.0.1:1")).code).toBe(EXIT.ok);

	const run = await agx("inbox", "--summary", "--json", "--wait", "1");

	expect(run.code).toBe(EXIT.network);
	expect(process.exitCode).toBeUndefined();
	expect((await agx("config", "path")).code).toBe(EXIT.ok);
});
