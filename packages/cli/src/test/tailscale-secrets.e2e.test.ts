import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the BUILT CLI (`pnpm build` first, then
// `E2E=1 pnpm exec vitest run src/test/tailscale-secrets.e2e.test.ts` in packages/cli): the lost update
// this guards against is two real processes writing one profile's Tailscale secrets file.

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
}

let home: string;

/** One `agx` command that can be started now and awaited later, with extra environment variables for it alone. */
function startAgx(extraEnv: Record<string, string>, ...args: string[]): { child: ChildProcess; done: Promise<Run> } {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	// Nothing here connects anywhere; a relay that refuses is set anyway.
	env.AGX_RELAY = "ws://127.0.0.1:9";
	Object.assign(env, extraEnv);
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	const done = new Promise<Run>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
	return { child, done };
}

function agx(...args: string[]): Promise<Run> {
	return startAgx({}, ...args).done;
}

const KEY = "tskey-auth-k1234567890CNTRL-abcdefghijklmnop";
const SEED = "tskey-auth-k0000000000CNTRL-seedseedseedseed";
const CLIENT_SECRET = "oauth-client-secret-value";
const secretsFile = (): string => join(home, "profiles", "default", "tailscale.json");

/** `enable` with an auth key: stores the key. */
const enableWithKey = (key: string): string[] => ["tailscale", "enable", "--no-up", "--auth-key", key];
/** `enable` on the OAuth route: stores the client secret (the two routes cannot be given in one command). */
const enableWithClientSecret = (secret: string): string[] => [
	"tailscale",
	"enable",
	"--no-up",
	"--oauth-url",
	"https://auth.example.test/token",
	"--oauth-client-secret",
	secret,
];

describe.skipIf(!existsSync(AGX))("overlapping writes of the Tailscale secrets file", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-tailscale-secrets-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	// A preload stands in for a slow disk: it holds each command back for a moment right after it has read
	// the secrets file, so that both commands have read the old file before either one writes. Without a
	// lock the later write drops the earlier command's key, whatever the machine's speed.
	it("keeps both secrets when two enable commands have both read the file before either writes", async () => {
		const preload = join(home, "pause-after-secrets-read.mjs");
		writeFileSync(
			preload,
			[
				'import fs from "node:fs";',
				'import { syncBuiltinESMExports } from "node:module";',
				"const real = fs.readFileSync;",
				"fs.readFileSync = function (path, ...rest) {",
				"  const out = real.call(this, path, ...rest);",
				'  if (String(path).endsWith("tailscale.json")) {',
				"    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PAUSE_AFTER_READ_MS));",
				"  }",
				"  return out;",
				"};",
				"syncBuiltinESMExports();",
				"",
			].join("\n"),
		);
		const slow = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PAUSE_AFTER_READ_MS: "1200" };
		// A file must exist for there to be a read to pause after.
		expect((await agx(...enableWithKey(SEED))).code).toBe(0);

		const first = startAgx(slow, ...enableWithKey(KEY));
		const second = startAgx(slow, ...enableWithClientSecret(CLIENT_SECRET));
		const runs = await Promise.all([first.done, second.done]);

		expect(runs.map((run) => run.code), runs.map((run) => run.stdout).join("\n")).toEqual([0, 0]);
		expect(JSON.parse(readFileSync(secretsFile(), "utf8"))).toMatchObject({
			version: 1,
			authKey: KEY,
			oauthClientSecret: CLIENT_SECRET,
		});
		expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
		// No lock and no temp file left behind.
		expect(readdirSync(join(home, "profiles", "default"))).toEqual(["tailscale.json"]);
	}, 60_000);

	// No pause here: the commands overlap as they happen to on this machine, 40 times.
	it("keeps both secrets when two enable commands overlap as they happen to, 40 times over", async () => {
		const result = { lost: 0, nonzeroExits: 0 };
		for (let round = 0; round < 40; round += 1) {
			rmSync(join(home, "profiles"), { recursive: true, force: true });
			const runs = await Promise.all([agx(...enableWithKey(KEY)), agx(...enableWithClientSecret(CLIENT_SECRET))]);
			result.nonzeroExits += runs.filter((run) => run.code !== 0).length;
			const stored = JSON.parse(readFileSync(secretsFile(), "utf8"));
			if (stored.authKey !== KEY || stored.oauthClientSecret !== CLIENT_SECRET) {
				result.lost += 1;
			}
		}
		expect(result).toEqual({ lost: 0, nonzeroExits: 0 });
	}, 300_000);
});
