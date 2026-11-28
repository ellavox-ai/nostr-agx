import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile } from "../lib/config.js";
import { type HeldConfigLock, holdConfigLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../test/config-lock-helpers.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx tailscale enable` fills every setting it was not given from the stored profile. That profile has to
// be read once the config lock is held: a value another command stored while this one waited for the lock
// is then kept, not overwritten with the copy read earlier. (The state directory and the other two commands
// are covered in `tailscale.test.ts`.)

let box: ReturnType<typeof sandbox>;
let held: HeldConfigLock | undefined;

beforeEach(() => {
	box = sandbox();
	delete process.env.TS_AUTHKEY;
});

afterEach(() => {
	held?.child.kill("SIGKILL");
	held = undefined;
	box.restore();
});

/** A stored profile to start from, made by `enable` itself. Nothing is started (`--no-up`). */
async function storedProfile(): Promise<void> {
	const run = await agx("tailscale", "enable", "--no-up");
	expect(run.code, run.stderr).toBe(0);
}

describe("agx tailscale enable while another agx command is writing config.json", () => {
	it("keeps a hostname another command stored while it waited for the lock, when no hostname is given", async () => {
		await storedProfile();
		held = await holdConfigLockUntilSomeoneWaits('c.profiles.default.tailscale.hostname = "agx-from-another";');

		const run = await agx("tailscale", "enable", "--no-up");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({ enabled: true, hostname: "agx-from-another" });
	}, PATIENT_TEST_MS);

	it("keeps the OAuth settings another command stored while it waited for the lock, when only the token URL is given", async () => {
		await storedProfile();
		held = await holdConfigLockUntilSomeoneWaits(
			[
				"const o = c.profiles.default.tailscale.oauth;",
				'o.clientId = "id-from-another"; o.scope = "scope-from-another"; o.tailnet = "tailnet-from-another";',
				'o.apiBaseUrl = "https://api.example.test/v2"; o.tags = ["tag:from-another"];',
			].join(" "),
		);

		const run = await agx("tailscale", "enable", "--no-up", "--oauth-url", "https://auth.example.test/token");

		expect(run.code, run.stderr).toBe(0);
		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").tailscale).toMatchObject({
			enabled: true,
			authMode: "oauth",
			oauth: {
				tokenUrl: "https://auth.example.test/token",
				clientId: "id-from-another",
				scope: "scope-from-another",
				tailnet: "tailnet-from-another",
				apiBaseUrl: "https://api.example.test/v2",
				tags: ["tag:from-another"],
			},
		});
	}, PATIENT_TEST_MS);
});
