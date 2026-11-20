import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	target: "es2022",
	platform: "node",
	outDir: "dist",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	// The tsnet launcher is bundled in this package (src/launcher.ts + bin/).
	// Only the host's transport stays external; it is a type-only dependency.
	external: ["@nostr-agx/nostr"],
});
