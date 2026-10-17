import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig } from "tsup";

/**
 * n8n loads a community package's nodes with `require`, from the paths listed
 * under `n8n` in package.json, so each node and credential is built to its own
 * CommonJS file at exactly that path.
 *
 * Everything but `n8n-workflow` is bundled in, `ws` included, so the published
 * package has no runtime dependencies: n8n's installer has nothing to resolve, and
 * `@noble/hashes` (ESM-only, pulled in by `@nostr-agx/nostr`) never has to be
 * `require`d. `n8n-workflow` stays external because n8n supplies its own copy,
 * and node classes must share it (error classes are checked with instanceof).
 */
export default defineConfig({
	entry: {
		"credentials/AgxApi.credentials": "credentials/AgxApi.credentials.ts",
		"nodes/Agx/Agx.node": "nodes/Agx/Agx.node.ts",
		"nodes/AgxTrigger/AgxTrigger.node": "nodes/AgxTrigger/AgxTrigger.node.ts",
	},
	format: ["cjs"],
	// n8n requires Node.js 24; the runtime itself is never older than this.
	target: "node22",
	platform: "node",
	outDir: "dist",
	outExtension: () => ({ js: ".js" }),
	// `pnpm build` empties dist first.
	clean: false,
	sourcemap: false,
	splitting: false,
	dts: false,
	// `ws` tries these optional native add-ons and carries on without them.
	external: ["n8n-workflow", "bufferutil", "utf-8-validate"],
	noExternal: [/^(?!n8n-workflow$|bufferutil$|utf-8-validate$).*/],
	onSuccess: async () => {
		await mkdir("dist/icons", { recursive: true });
		for (const icon of ["agx.svg", "agx.dark.svg"]) {
			await copyFile(`icons/${icon}`, `dist/icons/${icon}`);
		}
		// The codex files sit next to the node files they describe.
		await copyFile("nodes/Agx/Agx.node.json", "dist/nodes/Agx/Agx.node.json");
		await copyFile(
			"nodes/AgxTrigger/AgxTrigger.node.json",
			"dist/nodes/AgxTrigger/AgxTrigger.node.json",
		);
	},
});
