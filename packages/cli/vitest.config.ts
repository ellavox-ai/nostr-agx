import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Resolve the sibling AGX packages from source, as `packages/api` does, so unit
 * tests run without `pnpm build` first (CI runs `test:unit` on a fresh
 * install, where `@nostr-agx/core`'s `dist` does not exist).
 */
export default defineConfig({
	test: {
		// Before any test module loads: a throwaway AGX_HOME and no inherited
		// AGX_* overrides, so no test can touch the real ~/.agx.
		setupFiles: ["./src/test/setup.ts"],
		// `*.e2e.test.ts` drive the BUILT CLI, so they only run on request
		// (`pnpm test:e2e:login`, after `pnpm build`), never in `test:unit`.
		exclude: [
			...configDefaults.exclude,
			...(process.env.E2E_LOGIN ? [] : ["**/*.e2e.test.ts"]),
		],
	},
	resolve: {
		alias: [
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
});
