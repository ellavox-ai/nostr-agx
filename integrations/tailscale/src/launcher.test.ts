import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { bundledBinaryPath, ensureExecutable, startBundledTailscale } from "./launcher";

const posix = process.platform !== "win32";
const supportedPlatforms = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64",
]);
const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "agx-tailscale.exe" : "agx-tailscale";
const hasBundledBinary =
	posix &&
	supportedPlatforms.has(platform) &&
	existsSync(fileURLToPath(new URL(`../bin/${platform}/${binaryName}`, import.meta.url)));

async function fakeBinary(source: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(path, source, { mode: 0o755 });
	await chmod(path, 0o755);
	return { dir, path };
}

describe("bundledBinaryPath", () => {
	it.skipIf(!hasBundledBinary)("resolves the binary for the current platform", () => {
		const binary = bundledBinaryPath();
		expect(binary).toContain(join("bin", platform));
		expect(binary).toMatch(/agx-tailscale(\.exe)?$/);
	});
});

describe("ensureExecutable", () => {
	it.skipIf(!posix)("restores the executable bit a packed launcher lost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		try {
			const path = join(dir, "agx-tailscale");
			await writeFile(path, "#!/bin/sh\n", { mode: 0o644 });
			await chmod(path, 0o644);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o755);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("leaves an executable launcher as it is", async () => {
		const { dir, path } = await fakeBinary("#!/bin/sh\n");
		try {
			await chmod(path, 0o700);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o700);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("startBundledTailscale", () => {
	it.skipIf(!posix)("starts a child and reports its authenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://agx:secret@127.0.0.1:43210\nexec cat >/dev/null\n",
		);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			expect(proxy).toMatchObject({
				url: "socks5://agx:secret@127.0.0.1:43210",
				address: "127.0.0.1:43210",
				host: "127.0.0.1",
				port: 43210,
			});
			await proxy.stop();
			await proxy.stop();
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes the auth key through the environment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		const keyFile = join(dir, "key.txt");
		const fake = await fakeBinary(
			'#!/bin/sh\nprintf "%s" "$TS_AUTHKEY" > ' + JSON.stringify(keyFile) +
				"\necho socks5://agx:secret@127.0.0.1:43211\nexec cat >/dev/null\n",
		);
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-test-value");
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not pass the parent environment to the launcher", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-env-test-"));
		const marker = join(dir, "parent-env-marker");
		const fake = await fakeBinary(
			`#!/bin/sh\nprintf '%s' "$AGX_TEST_PARENT_SECRET" > ${JSON.stringify(marker)}\necho socks5://agx:secret@127.0.0.1:43213\nexec cat >/dev/null\n`,
		);
		const previous = process.env.AGX_TEST_PARENT_SECRET;
		process.env.AGX_TEST_PARENT_SECRET = "parent-secret";
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(marker, "utf8")).toBe("");
		} finally {
			if (previous === undefined) delete process.env.AGX_TEST_PARENT_SECRET;
			else process.env.AGX_TEST_PARENT_SECRET = previous;
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("rejects an unauthenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://127.0.0.1:43212\nexec cat >/dev/null\n",
		);
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/unauthenticated SOCKS5/);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty auth key", async () => {
		await expect(startBundledTailscale({ authKey: "" })).rejects.toThrow(
			/authKey must not be empty/,
		);
	});
});

/** Throwaway SOCKS5 credentials, made fresh for every run. */
const RUN = Math.random().toString(16).slice(2, 10);
const USER = `user${RUN}`;
const PASS = `pass${Math.random().toString(16).slice(2, 10)}`;

/** Everything a person could see if the error were printed or logged. */
function shown(error: unknown): string {
	return `${error instanceof Error ? error.message : String(error)}\n${inspect(error, { depth: 4 })}`;
}

describe("startBundledTailscale: an address it refuses", () => {
	it.skipIf(!posix)("does not put the proxy credentials in the error for a bad port", async () => {
		// Port 0 is not a usable proxy port, so the address is refused.
		const fake = await fakeBinary(
			`#!/bin/sh\necho socks5://${USER}:${PASS}@127.0.0.1:0\nexec cat >/dev/null\n`,
		);
		try {
			const error = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(Error);
			expect(shown(error)).toMatch(/invalid SOCKS5 address/);
			expect(shown(error)).toContain("127.0.0.1");
			expect(shown(error)).not.toContain(USER);
			expect(shown(error)).not.toContain(PASS);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not put the proxy credentials in the error for an address that does not parse", async () => {
		const fake = await fakeBinary(
			`#!/bin/sh\necho socks5://${USER}:${PASS}@[not-an-ip:1080\nexec cat >/dev/null\n`,
		);
		try {
			const error = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(Error);
			expect(shown(error)).not.toContain(USER);
			expect(shown(error)).not.toContain(PASS);
			expect(shown(error)).toMatch(/invalid SOCKS5 address/);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	for (const [label, address] of [
		["does not parse", "[not-an-ip:1080"],
		["has a port that cannot be used", "127.0.0.1:0"],
	] as const) {
		it.skipIf(!posix)(`stops the launcher when the address ${label}`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "agx-launcher-pid-test-"));
			const pidFile = join(dir, "pid");
			const fake = await fakeBinary(
				`#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\necho socks5://${USER}:${PASS}@${address}\nexec cat >/dev/null\n`,
			);
			let pid = 0;
			try {
				await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }).catch(() => undefined);
				pid = Number((await readFile(pidFile, "utf8")).trim());
				expect(pid).toBeGreaterThan(1);
				const alive = (): boolean => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				};
				const deadline = Date.now() + 5_000;
				while (alive() && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				expect(alive(), "the launcher was left running").toBe(false);
			} finally {
				// Only the child this test started.
				if (pid > 1) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// already gone
					}
				}
				await rm(fake.dir, { recursive: true, force: true });
				await rm(dir, { recursive: true, force: true });
			}
		});
	}

	it.skipIf(!posix)("still hands back the real credentials in a good address", async () => {
		const fake = await fakeBinary(
			`#!/bin/sh\necho socks5://${USER}:${PASS}@127.0.0.1:43299\nexec cat >/dev/null\n`,
		);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			expect(proxy.url).toBe(`socks5://${USER}:${PASS}@127.0.0.1:43299`);
			expect(proxy.address).toBe("127.0.0.1:43299");
		} finally {
			await proxy.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});
});
