import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Everything the CLI prints leaves through a few writers in `lib/output.ts`, and each of them scrubs a
// secret key out of the text first. This test reads the source and lists every place that writes to
// the terminal at all, so a new `console.log` or `process.stdout.write` somewhere else, which would go
// out unscrubbed, fails here instead of being found later by a leak.
//
// What it reads: the source files under `packages/cli/src`, as text. What it looks for: a call of
// `console`, any other use of the word `console` (an alias, `const { log } = console`, `console["log"]`),
// `process.stdout` and `process.stderr` (so an alias of them too), `process[...]` and a destructured
// `process`, `writeSync(` (the file descriptors 1 and 2 are the terminal), the paths `/dev/stdout`,
// `/dev/stderr` and `/dev/fd/...`, and `"inherit"` (a child process that shares our streams).
//
// Not covered, on purpose: tests, the browser code under `ui-client`, the web UI's and the gateway's
// HTTP answers (the gateway's `sendJson` is tested in `gateway/gateway-scrub.test.ts`), the packages
// outside `packages/cli` (a child process they start, such as the Tailscale launcher, is not read here),
// and the canary, whose injected-leak check sees `process.stdout.write` and `process.stderr.write` but
// not a write to the file descriptor.

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every non-test `.ts` file under `src`, as a path relative to it with `/` separators. */
function sources(dir = SRC): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "test" && entry.name !== "ui-client") {
				out.push(...sources(path));
			}
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
			out.push(relative(SRC, path).split(sep).join("/"));
		}
	}
	return out.sort();
}

/**
 * Every way a source file can write to the terminal, or to a stream the terminal shares, that the
 * scan knows. Listed one per line so a form can be added or taken out on its own.
 */
const WRITES = new RegExp(
	[
		String.raw`\bconsole\.\w+\s*\(`, // console.log(...)
		String.raw`\bconsole\b(?!\.\w+\s*\()`, // an alias, a destructure, console["log"], console.log.bind(console)
		String.raw`\bprocess\.std(?:out|err)\.write\b`, // process.stdout.write(...)
		String.raw`\bprocess\.std(?:out|err)\b(?!\.isTTY)`, // any other use of process.stdout, such as an alias
		String.raw`\bprocess\s*\[`, // process["stdout"]
		String.raw`\}\s*=\s*process\b(?!\.)`, // const { stdout } = process
		String.raw`\bwriteSync\s*\(`, // fs.writeSync(1, ...) and writeSync(2, ...)
		String.raw`/dev/(?:stdout|stderr|fd/)`, // a write to the terminal as a file
		String.raw`["']inherit["']`, // stdio: "inherit": a child that writes to our streams
	].join("|"),
	"g",
);

/** The writes `code` holds, with a comment that names one left out: a comment is not a call. */
function writesInText(text: string): string[] {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	return [...code.matchAll(WRITES)].map((match) => match[0].replace(/\s+/g, " "));
}

function writesIn(file: string): string[] {
	return writesInText(readFileSync(join(SRC, file), "utf8"));
}

describe("what the scan of the source sees", () => {
	it.each([
		["a console call", 'console.log("x");'],
		["a console alias", "const log = console.log;"],
		["a destructured console", 'const { log } = console;\nlog("x");'],
		["console by name", 'console["log"]("x");'],
		["a bound console method", "const log = console.error.bind(console);"],
		["process.stdout.write", 'process.stdout.write("x");'],
		["an alias of process.stdout", 'const out = process.stdout;\nout.write("x");'],
		["process.stderr.write", 'process.stderr.write("x");'],
		["process by name", 'process["stdout"].write("x");'],
		["a destructured process", "const { stdout } = process;"],
		["fs.writeSync to descriptor 1", 'fs.writeSync(1, "x");'],
		["writeSync to descriptor 2", 'writeSync(2, "x");'],
		["a write to /dev/stdout", 'writeFileSync("/dev/stdout", "x");'],
		["a write to /dev/fd/2", 'appendFileSync("/dev/fd/2", "x");'],
		["a child that inherits our streams", 'spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });'],
		["an import of node:console, which holds the word console", 'import { Console } from "node:console";'],
	])("%s", (_name, code) => {
		expect(writesInText(code)).not.toEqual([]);
	});

	it.each([
		["a comment that names one", '// console.log("x")\n/* process.stdout.write("x") */'],
		["process.stdout.isTTY", "if (process.stdout.isTTY) {}"],
		["the environment and the exit code", "process.env.HOME; process.exit(1); process.argv.slice(2);"],
		["a child that is not shared", 'spawn(command, args, { stdio: "ignore" }); spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });'],
	])("and leaves alone %s", (_name, code) => {
		expect(writesInText(code)).toEqual([]);
	});
});

describe("the places the CLI writes to the terminal", () => {
	it("are the writers in output.ts, the one deliberate print of agx identity export, one fixed sentence in lock.ts, and a lock file in device-flow.ts", () => {
		const found: Record<string, string[]> = {};
		for (const file of sources()) {
			const writes = writesIn(file);
			if (writes.length > 0) {
				found[file] = writes;
			}
		}
		const { "lib/output.ts": writers, ...elsewhere } = found;
		expect(writers?.length).toBeGreaterThan(0);
		expect(elsewhere).toEqual({
			"commands/identity.ts": ["console.log("],
			"lib/device-flow.ts": ["writeSync("],
			"lib/lock.ts": ["process.stderr.write"],
		});
	});

	it("has the deliberate print in the export command, after its own check for a terminal", () => {
		const text = readFileSync(join(SRC, "commands/identity.ts"), "utf8");
		const start = text.indexOf("export function identityExportCommand");
		const end = text.indexOf("export async function identitySignCommand");
		const body = text.slice(start, end);
		expect(body.indexOf("Refusing to print a secret key to a terminal")).toBeGreaterThan(-1);
		expect(body.indexOf("Refusing to print a secret key to a terminal")).toBeLessThan(body.indexOf("console.log("));
		expect(body.match(/console\.log\(/g)?.length).toBe(1);
	});

	it("writes in device-flow.ts only to the poll lock file it has just opened, never to a terminal", () => {
		const text = readFileSync(join(SRC, "lib/device-flow.ts"), "utf8");
		expect(text.match(/\bwriteSync\s*\(/g)?.length).toBe(1);
		expect(text).toMatch(/const fd = openSync\(path, "wx", 0o600\);\s*try \{\s*writeSync\(fd, JSON\.stringify\(lockRecord\(token, nextGapMs\)\)\);/);
	});

	it("keeps the fixed sentence in lock.ts free of anything a person or a peer typed", () => {
		const text = readFileSync(join(SRC, "lib/lock.ts"), "utf8");
		expect(text).toMatch(/process\.stderr\.write\("agx: lost the profile lock to another process; stopping so two writers do not overwrite each other\.\\n"\)/);
	});
});
