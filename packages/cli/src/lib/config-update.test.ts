import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, migrateLegacyKeysNow, updateProfile } from "./config.js";
import { createIdentity } from "./identity.js";
import { configPath } from "./paths.js";
import { configLockFile, type HeldConfigLock, holdConfigLockUntilSomeoneWaits, PATIENT_TEST_MS } from "../test/config-lock-helpers.js";

let home: string;
let previous: string | undefined;
let holder: HeldConfigLock | undefined;

const lockFile = configLockFile;

const A = createIdentity().publicKey;
const B = createIdentity().publicKey;
const C = createIdentity().publicKey;

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-update-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	holder?.child.kill("SIGKILL");
	holder = undefined;
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

describe("updateProfile with an updater function", () => {
	it("hands the updater the profile as it is on disk when it runs, not an earlier copy", () => {
		updateProfile("default", { allow: [A] });
		const earlierRead = getProfile("default");
		// Another writer lands after that read.
		updateProfile("default", { allow: [A, B] });
		expect(earlierRead.allow).toEqual([A]);

		updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(getProfile("default").allow).toEqual([A, B, C]);
	});

	it("holds the config lock while the updater runs, and lets go afterwards", () => {
		let heldDuring = false;
		updateProfile("default", (current) => {
			heldDuring = existsSync(lockFile());
			return { allow: [...current.allow, A] };
		});
		expect(heldDuring).toBe(true);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("reads the profile only after it holds the lock, so a change made while it waited is kept", async () => {
		updateProfile("default", { allow: [A] });
		holder = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow.push(${JSON.stringify(B)});`);

		const saved = updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(await holder.sawWaiter).toBe(true);
		expect(saved.allow).toEqual([A, B, C]);
		expect(getProfile("default").allow).toEqual([A, B, C]);
	}, PATIENT_TEST_MS);

	it("a plain patch is also applied over what is on disk once the lock is held", async () => {
		updateProfile("default", { allow: [A] });
		holder = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow.push(${JSON.stringify(B)});`);

		updateProfile("default", { orgSlug: "acme" });

		expect(await holder.sawWaiter).toBe(true);
		expect(getProfile("default").allow).toEqual([A, B]);
		expect(getProfile("default").orgSlug).toBe("acme");
	}, PATIENT_TEST_MS);

	it("returns the profile it saved", () => {
		updateProfile("default", { allow: [A] });
		const saved = updateProfile("default", (current) => ({ allow: [...current.allow, B] }));
		expect(saved.allow).toEqual([A, B]);
		expect(getProfile("default").allow).toEqual([A, B]);
	});

	it("leaves the file as it was, and no lock behind, when the updater throws", () => {
		updateProfile("default", { allow: [A] });
		expect(() =>
			updateProfile("default", () => {
				throw new Error("bad entry");
			}),
		).toThrow("bad entry");
		expect(getProfile("default").allow).toEqual([A]);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("still accepts a plain patch, and leaves no lock behind", () => {
		const saved = updateProfile("default", { allow: [A], orgSlug: "acme" });
		expect(saved.allow).toEqual([A]);
		expect(getProfile("default").orgSlug).toBe("acme");
		expect(existsSync(lockFile())).toBe(false);
	});
});

describe("migrateLegacyKeysNow", () => {
	it("waits for the config lock before it rewrites config.json", async () => {
		writeFileSync(
			configPath(),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		// The holder lets go once it has seen this writer waiting, so no timer decides the order.
		holder = await holdConfigLockUntilSomeoneWaits();
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			migrateLegacyKeysNow();
		} finally {
			spy.mockRestore();
		}
		// It could only run once the holder let go.
		expect(existsSync(lockFile())).toBe(false);
		expect(await holder.sawWaiter).toBe(true);
		expect(readFileSync(configPath(), "utf8")).not.toContain("ela_OLD");
	}, PATIENT_TEST_MS);

	it("reads config.json only after it holds the lock, so a change made while it waited is kept", async () => {
		writeFileSync(
			configPath(),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		holder = await holdConfigLockUntilSomeoneWaits(`c.profiles.default.allow = [${JSON.stringify(A)}];`);
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			migrateLegacyKeysNow();
		} finally {
			spy.mockRestore();
		}
		expect(await holder.sawWaiter).toBe(true);
		const stored = JSON.parse(readFileSync(configPath(), "utf8"));
		// The key was moved, and the other writer's allowlist entry is still there.
		expect(stored.profiles.default.apiKey).toBeNull();
		expect(stored.profiles.default.allow).toEqual([A]);
	}, PATIENT_TEST_MS);
});
