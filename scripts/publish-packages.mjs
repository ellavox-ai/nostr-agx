#!/usr/bin/env node
/**
 * Publish every package to npm, in dependency order, with provenance.
 *
 *   node scripts/publish-packages.mjs v0.3.2             # what .github/workflows/publish.yml runs
 *   node scripts/publish-packages.mjs v0.3.2 --dry-run   # locally: pack and check, publish nothing
 *
 * Packed with pnpm, because only pnpm rewrites the `workspace:` versions, and
 * published with npm, because pnpm has no provenance flag and no npm Trusted
 * Publishing (OIDC). n8n requires community nodes to carry provenance, and it
 * lets anyone check that a package was built by this repository's workflow
 * from a given commit.
 *
 * The tag must match every package's version: the packages release together.
 * A version already on npm is skipped, so a run that failed part-way can be run
 * again.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
/** `nostr` depends on `core`; the CLI and the n8n nodes bundle both. */
const ORDER = ["core", "nostr", "cli", "n8n-nodes-agx"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args.find((arg) => !arg.startsWith("--"));
if (!tag) {
	console.error("Usage: node scripts/publish-packages.mjs <tag, e.g. v0.3.2> [--dry-run]");
	process.exit(2);
}
const version = tag.replace(/^v/, "");

const packages = ORDER.map((dir) => {
	const manifest = JSON.parse(
		readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
	);
	return { dir, name: manifest.name, version: manifest.version };
});
const mismatched = packages.filter((pkg) => pkg.version !== version);
if (mismatched.length > 0) {
	console.error(
		`Tag ${tag} does not match ${mismatched.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}. Bump every package to ${version} (see RELEASING.md), or tag v${packages[0].version}.`,
	);
	process.exit(1);
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, { encoding: "utf8", ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${commandArgs.join(" ")} failed:\n${result.stderr || result.stdout}`,
		);
	}
	return result.stdout;
}

function isPublished(pkg) {
	const result = spawnSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], {
		encoding: "utf8",
	});
	return result.status === 0 && result.stdout.trim() === pkg.version;
}

const out = mkdtempSync(join(tmpdir(), "publish-packages-"));
try {
	for (const pkg of packages) {
		const label = `${pkg.name}@${pkg.version}`;
		if (isPublished(pkg)) {
			console.log(`${label}: already on npm, skipped`);
			continue;
		}
		const before = new Set(readdirSync(out));
		run("pnpm", ["pack", "--pack-destination", out], {
			cwd: join(root, "packages", pkg.dir),
		});
		const tarball = readdirSync(out).find((file) => !before.has(file));
		const publishArgs = ["publish", join(out, tarball), "--access", "public"];
		// Provenance is attested by the CI provider, so only a real CI publish
		// can ask for it.
		publishArgs.push(dryRun ? "--dry-run" : "--provenance");
		run("npm", publishArgs, { stdio: ["ignore", "pipe", "pipe"] });
		console.log(`${label}: ${dryRun ? "would publish" : "published"} (${tarball})`);
	}
} finally {
	rmSync(out, { recursive: true, force: true });
}
