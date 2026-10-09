import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * The BUILT CLI (`dist/agx.js`) against the mock index, as a separate process
 * with every inherited AGX_* variable stripped: checks what the in-process
 * tests cannot — the bin entry, real exit statuses, and commander's parsing of
 * root options placed after the subcommand.
 *
 *   pnpm build && pnpm --filter @nostr-agx/cli test:e2e:login
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let mock: MockIndexServer;

/** Start the built CLI; `done` settles when it exits. */
function start(...args: string[]): { child: ChildProcess; done: Promise<Run> } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", AGX_NO_BROWSER: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_") && key !== "AGX_NO_BROWSER") {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	const done = new Promise<Run>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done };
}

function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe.skipIf(!existsSync(AGX))("dist/agx.js login wiring", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-login-"));
		mock = await startMockIndexServer();
	});
	afterAll(async () => {
		await mock?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("exit 7 prints exactly one actionRequired JSON object on stdout", async () => {
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--profile", "e2e");
		expect(run.code, run.stderr).toBe(7);
		const lines = run.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			actionRequired: expect.objectContaining({
				reason: "LOGIN_APPROVAL_REQUIRED",
				userCode: "WDJB-MJHT",
				url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
			}),
		});
		expect(existsSync(join(home, "profiles", "e2e", "pending-login.json"))).toBe(true);
	});

	it("the re-run after approval exits 0; --profile after the subcommand picks the profile", async () => {
		mock.approve();
		// Real time here: the resume waits out the 5 s interval before its poll.
		const run = await agx("login", "--no-wait", "--json", "--profile", "e2e", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ loggedIn: true, profile: "e2e" });
		const who = await agx("whoami", "--json", "--profile", "e2e");
		expect(who.code, who.stderr).toBe(0);
		expect(JSON.parse(who.stdout)).toMatchObject({ verified: true, organization: { slug: "acme-robotics" } });
		const nobody = await agx("whoami", "--json", "-p", "nobody");
		expect(nobody.code).toBe(4);
		expect(JSON.parse(nobody.stdout)).toEqual({ loggedIn: false, profile: "nobody" });
	}, 20_000);

	it("a gated publish exits 7 with the URL on the mock's origin", async () => {
		const run = await agx("--profile", "e2e", "listing", "publish", "l_7", "--json");
		expect(run.code).toBe(7);
		expect(JSON.parse(run.stdout).actionRequired.url).toBe(`${mock.origin}/elladex/listings/l_7?org=acme-robotics`);
	});

	it("SIGTERM during a blocking login releases the poll lock, keeps the code and exits 130", async () => {
		const profileDir = join(home, "profiles", "term");
		const lock = join(profileDir, "pending-login.lock");
		const { child, done } = start("login", "--json", "--api-base-url", mock.origin, "--profile", "term");
		// The lock is taken once the hand-off is out and the first wait begins.
		await until(() => existsSync(lock), 10_000);
		child.kill("SIGTERM");
		const run = await done;
		expect(run.code, run.stderr).toBe(130);
		expect(existsSync(lock)).toBe(false);
		expect(existsSync(join(profileDir, "pending-login.json"))).toBe(true);
	}, 20_000);

	it("commander's own errors keep their exit status", async () => {
		expect((await agx("login", "--no-such-flag")).code).toBe(1);
		expect((await agx("--version")).code).toBe(0);
	});

	it("config set apiKey records the key's id before exiting; a key whose owner left its organization is exit 4 for whoami", async () => {
		const manual = mock.addKey();
		expect((await agx("--profile", "manual", "config", "set", "apiBaseUrl", mock.origin)).code).toBe(0);
		// A positional key (deprecated, but stdin is not available to this harness).
		const set = await agx("--profile", "manual", "config", "set", "apiKey", manual.key);
		expect(set.code, set.stderr).toBe(0);
		const credentials = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"));
		expect(credentials.profiles.manual).toMatchObject({ source: "manual", apiKeyId: manual.id });

		manual.member = false;
		const who = await agx("whoami", "--json", "--profile", "manual");
		expect(who.code).toBe(4);
		expect(JSON.parse(who.stdout)).toMatchObject({ verified: true, organization: null, apiKey: { id: manual.id } });
		expect(who.stderr).toMatch(/no longer a member of its organization/);
		expect(`${who.stdout}${who.stderr}`).not.toContain(manual.key);
	});
});
