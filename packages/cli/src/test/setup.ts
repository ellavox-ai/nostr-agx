import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { profileSchema } from "../lib/config.js";
import { runtime, setRuntimeForTests } from "../lib/runtime.js";
import { failTestsThatConnect } from "./default-relay-guard.js";

/**
 * Runs before every test file. No test may ever read or write the real
 * `~/.agx`, or send a real credential anywhere: point AGX_HOME at a throwaway
 * directory and drop every inherited AGX_* override before any module loads.
 * Tests that need their own home use `sandbox()` on top of this.
 */
for (const key of Object.keys(process.env)) {
	if (key.startsWith("AGX_")) {
		delete process.env[key];
	}
}
const home = mkdtempSync(join(tmpdir(), "agx-test-home-"));
process.env.AGX_HOME = home;
process.env.AGX_NO_BROWSER = "1";

/**
 * Every agx HTTP call goes through `runtime().fetch`. In tests it may only
 * reach this machine (the mock index); anything else fails the way an offline
 * machine does, before a byte is sent. A test that stores a key for
 * `https://app.ellaworks.ai` therefore exercises the offline path instead of
 * presenting a test key to the real server. Tests that script the network
 * install their own `fetch` on top, and restoring it brings this one back.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = runtime().fetch;
setRuntimeForTests({
	fetch: (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!LOOPBACK.has(url.hostname)) {
			return Promise.reject(
				Object.assign(new TypeError("fetch failed"), {
					cause: Object.assign(
						new Error(`tests never reach ${url.origin}`),
						{ code: "ECONNREFUSED" },
					),
				}),
			);
		}
		return realFetch(input, init);
	},
});

/**
 * A stock profile's relay is `agx relay` on this machine (`ws://127.0.0.1:7447`).
 * A machine that runs one would answer a test that leaves that default in
 * place, so the result would depend on the machine. Nothing in the suite may
 * connect to that port: the connection is refused like a closed port and the
 * test that tried fails. A test that needs a relay sets the profile's `relays`
 * itself, to one it starts on port 0 (or to none).
 */
failTestsThatConnect(
	profileSchema.parse({}).relays.map((url) => Number(new URL(url).port)),
);

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});
