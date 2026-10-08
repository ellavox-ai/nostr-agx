import { chmod, copyFile, mkdir } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { agx: "src/bin/agx.ts" },
		format: ["esm"],
		target: "node20",
		platform: "node",
		outDir: "dist",
		splitting: false,
		sourcemap: true,
		// `pnpm build` empties dist first; both configs write into it, so neither
		// may clean (they run in parallel).
		clean: false,
		shims: true,
		// Bundled so the published CLI is self-contained apart from its runtime deps.
		// That is why both sit in devDependencies: as `dependencies`, npm would still
		// try to fetch them on `npm i -g @nostr-agx/cli`. Every bare import left in
		// dist/agx.js must be listed in `dependencies`.
		noExternal: ["@nostr-agx/core", "@nostr-agx/nostr"],
		// `ws` is a real runtime dependency (the relay server needs WebSocketServer);
		// never bundle a native-ish socket implementation.
		external: ["ws"],
		banner: {
			js: "#!/usr/bin/env node",
		},
		// The shebang alone does not make the file executable; without this, a global
		// install resolves the bin and then fails with EACCES.
		onSuccess: async () => {
			await chmod("dist/agx.js", 0o755);
		},
	},
	{
		// The `agx ui` front end: one script for the browser, served from memory by
		// the local server (strict CSP: script-src 'self', no inline code).
		entry: { "ui/app": "src/ui-client/app.ts" },
		format: ["iife"],
		target: "es2022",
		platform: "browser",
		outDir: "dist",
		minify: true,
		sourcemap: false,
		// iife defaults to `.global.js`; the server serves `/app.js`.
		outExtension: () => ({ js: ".js" }),
		clean: false,
		dts: false,
		onSuccess: async () => {
			await mkdir("dist/ui", { recursive: true });
			await copyFile("src/ui-client/index.html", "dist/ui/index.html");
			await copyFile("src/ui-client/app.css", "dist/ui/app.css");
		},
	},
]);
