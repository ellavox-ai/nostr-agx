#!/usr/bin/env node
/**
 * Pack the CLI and the Tailscale package it depends on for the gateway image
 * test, with the CLI's Tailscale dependency pointing at the local tarball.
 *
 * `pnpm pack` turns `workspace:*` into a plain version, which npm then tries to
 * fetch from the public registry. `@nostr-agx/tailscale` is not there
 * until its first release, so the gateway image build would fail with a 404
 * before it can install the CLI. Everything else the CLI needs is published,
 * including Tailscale's peer `@nostr-agx/nostr`.
 *
 *   node scripts/prepare-gateway-package.mjs <output-dir> [base-url]
 *
 * The caller serves <output-dir> over HTTP at <base-url> while it builds the
 * image; the default matches .github/workflows/ci.yml.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = process.argv[2] && resolve(process.argv[2]);
const baseUrl = process.argv[3] ?? "http://127.0.0.1:8931";
if (!out) {
	console.error("Usage: node scripts/prepare-gateway-package.mjs <output-dir> [base-url]");
	process.exit(2);
}
mkdirSync(out, { recursive: true });

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
		);
	}
	return result.stdout;
}

function pack(dir) {
	const before = new Set(readdirSync(out));
	run("pnpm", ["pack", "--pack-destination", out], join(root, "packages", dir));
	const added = readdirSync(out).filter((file) => !before.has(file));
	if (added.length !== 1) {
		throw new Error(`Expected one tarball from ${dir}, got: ${added.join(", ") || "none"}`);
	}
	return added[0];
}

const tailscale = pack("tailscale");
const cli = pack("cli");
const tarball = join(out, cli);
const scratch = mkdtempSync(join(tmpdir(), "agx-gateway-pkg-"));
let rewritten = false;
try {
	run("tar", ["-xzf", tarball, "-C", scratch]);
	const manifestPath = join(scratch, "package", "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const dependency = manifest.dependencies?.["@nostr-agx/tailscale"];
	if (dependency !== undefined) {
		manifest.dependencies["@nostr-agx/tailscale"] = `${baseUrl}/${tailscale}`;
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		// Repack the same file name so the caller can keep using the version
		// from packages/cli/package.json to build its URL.
		run("tar", ["-czf", tarball, "-C", scratch, "package"]);
		rewritten = true;
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(
	rewritten
		? `${cli}: @nostr-agx/tailscale -> ${baseUrl}/${tailscale}`
		: `${cli}: no @nostr-agx/tailscale dependency to rewrite`,
);
