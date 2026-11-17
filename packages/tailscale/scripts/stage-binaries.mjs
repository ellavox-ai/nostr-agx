#!/usr/bin/env node
/**
 * Copy the cross-compiled launcher binaries from `launcher/dist/<platform>` to
 * the package's `bin/` tree, which is what ships in the npm tarball.
 *
 *   make -C launcher stage        # builds, then runs this script
 *   node scripts/stage-binaries.mjs
 */
import { chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptsDir);
const sourceDir = join(packageDir, "launcher", "dist");
const targetDir = join(packageDir, "bin");

const platforms = (await readdir(sourceDir, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

if (platforms.length === 0) {
	throw new Error(`No binaries found in ${sourceDir}. Run "make -C launcher build-all" first.`);
}

for (const platform of platforms) {
	const exe = platform.startsWith("win32-") ? "agx-tailscale.exe" : "agx-tailscale";
	const source = join(sourceDir, platform, exe);
	const destinationDir = join(targetDir, platform);
	const destination = join(destinationDir, exe);
	await mkdir(destinationDir, { recursive: true });
	await copyFile(source, destination);
	await chmod(destination, 0o755);
	console.log(`staged bin/${platform}/${exe}`);
}
