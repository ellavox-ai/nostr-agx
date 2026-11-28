import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity } from "../lib/identity.js";
import { type HeldConfigLock, holdConfigLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../test/config-lock-helpers.js";
import { sandbox } from "../test/helpers.js";
import { changeAllowOnDisk } from "./ui.js";

const A = createIdentity().publicKey;
const B = createIdentity().publicKey;
const C = createIdentity().publicKey;

let box: ReturnType<typeof sandbox>;
let held: HeldConfigLock | undefined;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	held?.child.kill("SIGKILL");
	held = undefined;
	box.restore();
});

describe("the allow toggle of agx ui", () => {
	it("puts a peer on the allowlist and takes it off again", () => {
		updateProfile("default", { allow: [A] });

		changeAllowOnDisk("default", B, true);
		expect(getProfile("default").allow).toEqual([A, B]);

		changeAllowOnDisk("default", A, false);
		expect(getProfile("default").allow).toEqual([B]);
	});

	it("does not list a peer twice when it is switched on twice", () => {
		changeAllowOnDisk("default", A, true);
		changeAllowOnDisk("default", A, true);
		expect(getProfile("default").allow).toEqual([A]);
	});

	it("keeps a peer another command allowed while it waited for the config lock", async () => {
		updateProfile("default", { allow: [A] });
		// Another command allows B while this one is queued behind it for the lock.
		held = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow.push(${JSON.stringify(B)});`);

		changeAllowOnDisk("default", C, true);

		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").allow).toEqual([A, B, C]);
	}, PATIENT_TEST_MS);

	it("keeps a peer another command allowed while a switch-off waited for the config lock", async () => {
		updateProfile("default", { allow: [A, B] });
		held = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow.push(${JSON.stringify(C)});`);

		changeAllowOnDisk("default", A, false);

		expect(await held.sawWaiter).toBe(true);
		expect(getProfile("default").allow).toEqual([B, C]);
	}, PATIENT_TEST_MS);
});
