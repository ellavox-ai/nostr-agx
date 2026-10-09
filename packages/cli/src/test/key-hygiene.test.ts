import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { writePrivateJson } from "../lib/paths.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, type CliRun, fakeClock, sandbox, useClock } from "./helpers.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * A key that cannot be a header value (CR, LF, NUL, spaces) is refused
 * wherever it enters agx, is never sent, and is never printed. Before 0.4.0's
 * review fixes, undici's "Headers.append: "<key>" is an invalid header value"
 * reached stderr verbatim.
 */

const SECRET = "SECRETSECRETSECRET";

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
	updateProfile("default", { apiBaseUrl: mock.origin, orgSlug: "acme-robotics" });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

function expectNoLeak(run: CliRun): void {
	expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET);
}

const BAD_KEYS: Array<[string, string]> = [
	["LF", `ela_${SECRET}\nrest`],
	["CR", `ela_${SECRET}\rrest`],
	["NUL", `ela_${SECRET}\u0000rest`],
	["a space", `ela_${SECRET} rest`],
];

describe("a malformed key is refused before anything is sent, and never printed", () => {
	// An environment variable cannot hold a NUL (Node truncates the value there,
	// as a C environment would), so that case cannot reach agx through the env.
	it.each(BAD_KEYS.filter(([label]) => label !== "NUL"))("AGX_API_KEY with %s: exit 3 for whoami, org list and listing list", async (_label, key) => {
		process.env.AGX_API_KEY = key;
		for (const args of [["whoami", "--json"], ["org", "list", "--json"], ["listing", "list"]]) {
			const run = await agx(...args);
			expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(3);
			expect(run.stderr).toMatch(/AGX_API_KEY is not a valid API key/);
			expectNoLeak(run);
		}
		expect(mock.requests).toEqual([]);
	});

	it.each(BAD_KEYS)("config set apiKey --stdin with %s: exit 2, nothing stored", async (_label, key) => {
		const restore = setStdinForTests(key);
		let run: CliRun;
		try {
			run = await agx("config", "set", "apiKey", "--stdin");
		} finally {
			restore();
		}
		expect(run.code).toBe(2);
		expectNoLeak(run);
		expect(existsSync(join(box.home, "credentials.json"))).toBe(false);
	});

	it("a positional key with a control character: exit 2, nothing stored", async () => {
		const restore = setStdinForTests(null);
		let run: CliRun;
		try {
			run = await agx("config", "set", "apiKey", `ela_${SECRET}\u0001x`);
		} finally {
			restore();
		}
		expect(run.code).toBe(2);
		expectNoLeak(run);
		expect(existsSync(join(box.home, "credentials.json"))).toBe(false);
	});

	it("a malformed key already in credentials.json: exit 3, not sent; logout forgets it without sending it", async () => {
		setCredential("default", {
			apiBaseUrl: mock.origin,
			apiKey: `ela_${SECRET}\nrest`,
			apiKeyId: null,
			source: "manual",
			clientId: null,
			organization: null,
			user: null,
			scopes: null,
			expiresAt: null,
			createdAt: new Date(clock.now()).toISOString(),
		});
		for (const args of [["listing", "list"], ["whoami"], ["doctor", "--json"]]) {
			const run = await agx(...args);
			expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(3);
			expectNoLeak(run);
		}
		const out = await agx("logout", "--json");
		expect(out.code).toBe(0);
		expectNoLeak(out);
		expect(out.stdout).toMatch(/already-invalid/);
		expect(mock.requests.filter((r) => r.path.startsWith("/api/rpc/"))).toEqual([]);
	});

	it("a malformed 0.3 key in config.json: exit 3, not sent", async () => {
		writePrivateJson(join(box.home, "config.json"), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: mock.origin, apiKey: `ela_${SECRET}\u0000x`, orgSlug: "acme-robotics" } },
		});
		const run = await agx("listing", "list");
		expect(run.code).toBe(3);
		expect(run.stderr).toMatch(/0\.3 API key/);
		expectNoLeak(run);
		expect(mock.requests).toEqual([]);
	});

	it("a /token 200 whose access_token holds a line break: exit 6, nothing stored or printed", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		mock.queueToken({
			status: 200,
			body: {
				...CONTRACT.deviceToken.success,
				access_token: `ela_${SECRET}\nrest`,
				api_key_id: "k_bad",
			},
		});
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(6);
		expect(run.stderr).toMatch(/access_token/);
		expectNoLeak(run);
		const credentials = join(box.home, "credentials.json");
		expect(existsSync(credentials) ? readFileSync(credentials, "utf8") : "").not.toContain(SECRET);
	});
});
