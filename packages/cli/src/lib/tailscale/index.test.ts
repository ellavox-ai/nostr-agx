import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProfile } from "../config.js";
import { sandbox } from "../../test/helpers.js";
import {
	setTailscaleStarterForTests,
	startTailscaleForProfile,
	tailscaleRelayProxyForProfile,
} from "./index.js";

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const PROXY_URL = "socks5h://agx:secret@127.0.0.1:49153";

let box: ReturnType<typeof sandbox>;
let restoreStarter: (() => void) | null = null;

beforeEach(() => {
	box = sandbox();
	process.env.AGX_TAILSCALE_AUTH_KEY = KEY;
});
afterEach(() => {
	restoreStarter?.();
	restoreStarter = null;
	box.restore();
});

describe("tailscaleRelayProxyForProfile", () => {
	it("is absent for runs that do not opt in", () => {
		const profile = effectiveProfile("default");
		expect(tailscaleRelayProxyForProfile("default", profile)).toBeUndefined();
		expect(
			tailscaleRelayProxyForProfile("default", profile, {
				withoutTailscale: true,
			}),
		).toBeUndefined();
	});

	it("starts the SDK proxy lazily and returns its handle", async () => {
		let started = 0;
		let stopped = 0;
		restoreStarter = setTailscaleStarterForTests(async () => {
			started += 1;
			return {
				url: PROXY_URL,
				stop: async () => {
					stopped += 1;
				},
			};
		});
		const base = effectiveProfile("default");
		const profile = {
			...base,
			tailscale: { ...base.tailscale, enabled: true, hostname: "agx-custom" },
		};
		const input = tailscaleRelayProxyForProfile("default", profile, {
			tailscale: true,
		});
		expect(typeof input).toBe("function");
		expect(started).toBe(0);

		const handle = await (input as () => Promise<{ url: string; stop(): Promise<void> }>)();
		expect(started).toBe(1);
		expect(handle.url).toBe(PROXY_URL);
		await handle.stop();
		expect(stopped).toBe(1);
	});
});

describe("startTailscaleForProfile state directory", () => {
	it("uses a private fresh dir under AGX_HOME and removes it when the node stops", async () => {
		let seen: { stateDir?: string } | undefined;
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			seen = options;
			return { url: PROXY_URL, stop: async () => undefined };
		});

		const handle = await startTailscaleForProfile("default", effectiveProfile("default"));
		const dir = seen?.stateDir;
		expect(dir).toBeTruthy();
		expect(dir?.startsWith(join(box.home, "tailscale-runs") + sep)).toBe(true);
		expect(statSync(dir!).mode & 0o777).toBe(0o700);
		expect(existsSync(dir!)).toBe(true);

		await handle.stop();
		expect(existsSync(dir!)).toBe(false);
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it("keeps an explicitly configured state dir, including after stop", async () => {
		const persistent = join(box.home, "keep-this-state");
		mkdirSync(persistent, { recursive: true, mode: 0o700 });
		let seen: { stateDir?: string } | undefined;
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			seen = options;
			return { url: PROXY_URL, stop: async () => undefined };
		});
		const base = effectiveProfile("default");
		const profile = {
			...base,
			tailscale: { ...base.tailscale, stateDir: persistent },
		};

		const handle = await startTailscaleForProfile("default", profile);
		expect(seen?.stateDir).toBe(persistent);
		await handle.stop();
		expect(existsSync(persistent)).toBe(true);
	});

	it("removes the fresh dir when the launcher fails to start", async () => {
		let failedDir: string | undefined;
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			failedDir = options.stateDir;
			throw new Error("launcher failed");
		});

		await expect(
			startTailscaleForProfile("default", effectiveProfile("default")),
		).rejects.toThrow(/launcher failed/);
		expect(failedDir).toBeTruthy();
		expect(existsSync(failedDir!)).toBe(false);
	});
});
