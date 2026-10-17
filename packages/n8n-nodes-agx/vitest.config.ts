import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Resolve the sibling AGX packages from source, as the CLI's tests do, so unit
 * tests run without `pnpm build` first.
 *
 * `n8n-workflow` resolves to its CommonJS build: that is what n8n `require`s,
 * and its ESM build uses extensionless imports that Node will not load.
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^n8n-workflow$/,
				replacement: createRequire(import.meta.url).resolve("n8n-workflow"),
			},
			{
				find: "@nostr-agx/core",
				replacement: fileURLToPath(
					new URL("../core/src/index.ts", import.meta.url),
				),
			},
			{
				find: "@nostr-agx/nostr",
				replacement: fileURLToPath(
					new URL("../nostr/src/index.ts", import.meta.url),
				),
			},
		],
	},
	test: {
		// Relay round trips include NIP-13 mining on every wrap.
		testTimeout: 30_000,
	},
});
