import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProfile } from "../config.js";
import { sandbox } from "../../test/helpers.js";
import {
	setTailscaleStarterForTests,
	tailscaleRelayProxyForProfile,
} from "./index.js";

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const PROXY_URL = "socks5h://127.0.0.1:49153";

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
