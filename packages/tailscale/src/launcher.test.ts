import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledBinaryPath, startBundledTailscale } from "./launcher";

const posix = process.platform !== "win32";

async function fakeBinary(source: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(path, source, { mode: 0o755 });
	await chmod(path, 0o755);
	return { dir, path };
}

describe("bundledBinaryPath", () => {
	it("resolves the binary for the current platform", () => {
		const supported = new Set([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-x64",
		]);
		const platform = `${process.platform}-${process.arch}`;
		if (!supported.has(platform)) return;
		const binary = bundledBinaryPath();
		expect(binary).toContain(join("bin", platform));
		expect(binary).toMatch(/agx-tailscale(\.exe)?$/);
	});
});

describe("startBundledTailscale", () => {
	it.skipIf(!posix)("starts a child and reports its SOCKS5 address", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://127.0.0.1:43210\nexec cat >/dev/null\n",
		);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			expect(proxy).toMatchObject({
				url: "socks5://127.0.0.1:43210",
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
			'#!/bin/sh\nprintf "%s" "$TS_AUTHKEY" > "$KEY_FILE"\n' +
				"echo socks5://127.0.0.1:43211\nexec cat >/dev/null\n",
		);
		const previous = process.env.KEY_FILE;
		process.env.KEY_FILE = keyFile;
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-test-value");
		} finally {
			if (previous === undefined) delete process.env.KEY_FILE;
			else process.env.KEY_FILE = previous;
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty auth key", async () => {
		await expect(startBundledTailscale({ authKey: "" })).rejects.toThrow(
			/authKey must not be empty/,
		);
	});
});
