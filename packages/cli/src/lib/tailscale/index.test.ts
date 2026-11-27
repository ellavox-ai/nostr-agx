import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveProfile } from "../config.js";
import { sandbox } from "../../test/helpers.js";
import {
	describeTailscaleExit,
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

	it("removes the fresh dir even when stopping the node fails", async () => {
		let dir: string | undefined;
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			dir = options.stateDir;
			return {
				url: PROXY_URL,
				stop: async () => {
					throw new Error("the launcher did not stop");
				},
			};
		});

		const handle = await startTailscaleForProfile("default", effectiveProfile("default"));
		expect(existsSync(dir!)).toBe(true);
		await expect(handle.stop()).rejects.toThrow(/did not stop/);
		expect(existsSync(dir!)).toBe(false);
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

describe("startTailscaleForProfile when the process ends", () => {
	const exitListeners = (): Set<NodeJS.ExitListener> => new Set(process.listeners("exit"));
	const addedSince = (before: Set<NodeJS.ExitListener>): NodeJS.ExitListener[] =>
		process.listeners("exit").filter((listener) => !before.has(listener));

	it("removes the fresh dir at exit when stop() was never called", async () => {
		let seen: { stateDir?: string } | undefined;
		restoreStarter = setTailscaleStarterForTests(async (options) => {
			seen = options;
			return { url: PROXY_URL, stop: async () => undefined };
		});
		const before = exitListeners();
		const handle = await startTailscaleForProfile("default", effectiveProfile("default"));
		try {
			const dir = seen!.stateDir!;
			const added = addedSince(before);
			expect(added).toHaveLength(1);
			expect(existsSync(dir)).toBe(true);
			// What the process does as it ends, e.g. after process.exit().
			added[0]!(0);
			expect(existsSync(dir)).toBe(false);
		} finally {
			await handle.stop();
		}
		expect(addedSince(before)).toHaveLength(0);
	});

	it("leaves no exit listener after stop(), after a failed start, or for a dir the user chose", async () => {
		const before = exitListeners();
		restoreStarter = setTailscaleStarterForTests(async () => ({
			url: PROXY_URL,
			stop: async () => undefined,
		}));
		const handle = await startTailscaleForProfile("default", effectiveProfile("default"));
		expect(addedSince(before)).toHaveLength(1);
		await handle.stop();
		expect(addedSince(before)).toHaveLength(0);

		restoreStarter();
		restoreStarter = setTailscaleStarterForTests(async () => {
			throw new Error("launcher failed");
		});
		await expect(
			startTailscaleForProfile("default", effectiveProfile("default")),
		).rejects.toThrow(/launcher failed/);
		expect(addedSince(before)).toHaveLength(0);

		const persistent = join(box.home, "keep-this-state-at-exit");
		mkdirSync(persistent, { recursive: true, mode: 0o700 });
		restoreStarter();
		restoreStarter = setTailscaleStarterForTests(async () => ({
			url: PROXY_URL,
			stop: async () => undefined,
		}));
		const base = effectiveProfile("default");
		const kept = await startTailscaleForProfile("default", {
			...base,
			tailscale: { ...base.tailscale, stateDir: persistent },
		});
		expect(addedSince(before)).toHaveLength(0);
		await kept.stop();
		expect(existsSync(persistent)).toBe(true);
	});
});

describe("startTailscaleForProfile launcher exit", () => {
	it("tells onTailscaleExit when the launcher ends on its own", async () => {
		let notify:
			| ((exit: { code: number | null; signal: NodeJS.Signals | null }) => void)
			| undefined;
		restoreStarter = setTailscaleStarterForTests(async () => ({
			url: PROXY_URL,
			stop: async () => undefined,
			onExit: (listener) => {
				notify = listener;
				return () => undefined;
			},
		}));
		const onTailscaleExit = vi.fn();

		const handle = await startTailscaleForProfile("default", effectiveProfile("default"), {
			onTailscaleExit,
		});
		expect(onTailscaleExit).not.toHaveBeenCalled();
		expect(notify).toBeDefined();
		notify?.({ code: 7, signal: null });
		expect(onTailscaleExit).toHaveBeenCalledExactlyOnceWith({ code: 7, signal: null });
		await handle.stop();
	});

	it("starts a launcher that offers no exit notice when a listener is given", async () => {
		restoreStarter = setTailscaleStarterForTests(async () => ({
			url: PROXY_URL,
			stop: async () => undefined,
		}));
		const onTailscaleExit = vi.fn();

		const handle = await startTailscaleForProfile("default", effectiveProfile("default"), {
			onTailscaleExit,
		});
		expect(handle.url).toBe(PROXY_URL);
		await handle.stop();
		expect(onTailscaleExit).not.toHaveBeenCalled();
	});
});

describe("describeTailscaleExit", () => {
	it("names the exit code, or the signal when there is one", () => {
		expect(describeTailscaleExit({ code: 7, signal: null })).toBe("exit code 7");
		expect(describeTailscaleExit({ code: null, signal: "SIGKILL" })).toBe("signal SIGKILL");
	});
});
