import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Code without comments, so a comment that names a forbidden API doesn't trip the check. */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("front end stays inert for hostile text", () => {
	const app = stripComments(read("../../ui-client/app.ts"));
	const html = read("../../ui-client/index.html");

	it("never parses peer text as HTML", () => {
		for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "createContextualFragment", "srcdoc", "eval(", "new Function", "setTimeout(\""]) {
			expect(app, forbidden).not.toContain(forbidden);
		}
	});

	it("never builds links or markdown from message text", () => {
		expect(app).not.toMatch(/createElement\(["']a["']\)/);
		expect(app).not.toMatch(/\bmarked\b|\bmarkdown\b/i);
		expect(app).not.toMatch(/href\s*[:=]/);
	});

	it("loads nothing from outside this server", () => {
		expect(html).not.toMatch(/https?:\/\//);
		expect(app).not.toMatch(/https?:\/\//);
	});

	it("has no inline script, style or event-handler attribute in the page", () => {
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
		expect(html).not.toMatch(/<style/);
		expect(html).not.toMatch(/\son[a-z]+=/i);
		expect(html).not.toMatch(/style="/);
	});

	it("respects reduced motion and dark mode", () => {
		const css = read("../../ui-client/app.css");
		expect(css).toContain("prefers-reduced-motion: reduce");
		expect(css).toContain("prefers-color-scheme: dark");
	});
});
