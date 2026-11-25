import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Several real processes call the real exclusive write on one target at the same
// moment. Exactly one of them gets the file; the others are told it exists; the
// file that results is the winner's, whole; and while all of this goes on the
// target is, whenever it is looked at, either absent or complete.
//
// The write comes from paths.ts itself, translated to plain JavaScript into a
// temporary folder, so the children run exactly its code. Before the final step
// each child waits until all of them have made their finished temp file and
// reached it (a barrier on files, with a time limit so a late child cannot hang
// the test), so every one of them really does attempt the step together: a write
// that checks first and replaces afterwards would let all of them succeed.
// Correctness never depends on the timing: if a child is late, the others still
// end with exactly one winner.

const CHILDREN = 6;
const ROUNDS = 3;
/** Big enough that a file that is created first and filled afterwards is half full for a few milliseconds. */
const SIZE = 8_000_000;

let work: string;

const CHILD = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const [, , modulePath, target, gate, count, index, size] = process.argv;
const arrived = { write: fs.writeFileSync, list: fs.readdirSync };
function wait() {
	arrived.write(path.join(gate, "arrived." + index), "");
	const until = Date.now() + 8000;
	while (Date.now() < until) {
		if (arrived.list(gate).filter((name) => name.startsWith("arrived.")).length >= Number(count)) {
			return;
		}
	}
}
for (const name of ["linkSync", "renameSync"]) {
	const real = fs[name];
	fs[name] = function (from, to) {
		if (to === target) {
			wait();
		}
		return real.apply(this, arguments);
	};
}
syncBuiltinESMExports();
const { writePrivateText, PrivateFileExistsError } = await import(modulePath);
const text = String.fromCharCode(97 + Number(index)).repeat(Number(size)) + "\\n";
let outcome;
try {
	writePrivateText(target, text, { exclusive: true });
	outcome = "won";
} catch (error) {
	outcome = error instanceof PrivateFileExistsError ? "exists" : "error:" + (error && error.code);
}
process.stdout.write(JSON.stringify({ index: Number(index), outcome }));
`;

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "agx-exclusive-race-"));
	const source = readFileSync(fileURLToPath(new URL("./paths.ts", import.meta.url)), "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	});
	writeFileSync(join(work, "paths.mjs"), outputText);
	writeFileSync(join(work, "child.mjs"), CHILD);
});

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

const textOf = (index: number) => `${String.fromCharCode(97 + index).repeat(SIZE)}\n`;
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

interface Child {
	done: Promise<{ index: number; outcome: string; code: number | null; stderr: string }>;
	finished: () => boolean;
}

function start(index: number, target: string, gate: string): Child {
	const child = spawn(
		process.execPath,
		[join(work, "child.mjs"), join(work, "paths.mjs"), target, gate, String(CHILDREN), String(index), String(SIZE)],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let out = "";
	let err = "";
	let over = false;
	child.stdout.on("data", (data) => {
		out += data;
	});
	child.stderr.on("data", (data) => {
		err += data;
	});
	const done = new Promise<{ index: number; outcome: string; code: number | null; stderr: string }>((resolve) => {
		child.on("close", (code) => {
			over = true;
			let outcome = "no answer";
			try {
				outcome = (JSON.parse(out) as { outcome: string }).outcome;
			} catch {
				// the failure shows in the assertions below
			}
			resolve({ index, outcome, code, stderr: err });
		});
	});
	return { done, finished: () => over };
}

describe("several processes calling the exclusive write on one target at once", () => {
	it(
		"leave exactly one winner, its whole content, no temp file, and a target that was never half written",
		async () => {
			const candidates = new Set(Array.from({ length: CHILDREN }, (_, index) => hash(textOf(index))));
			for (let round = 0; round < ROUNDS; round++) {
				const folder = join(work, `round-${round}`);
				const gate = join(work, `gate-${round}`);
				mkdirSync(folder, { recursive: true });
				mkdirSync(gate);
				const target = join(folder, "secret.json");
				const children = Array.from({ length: CHILDREN }, (_, index) => start(index, target, gate));

				// While they run, look at the target as often as possible: absent, or the whole size, and now and
				// then (a full read is slow) one whole candidate. A file that was created first and filled afterwards
				// shows up as too small.
				const seen = { reads: 0, wrong: 0 };
				const look = (whole: boolean) => {
					try {
						if (statSync(target).size !== SIZE + 1) {
							seen.wrong++;
							return;
						}
						seen.reads++;
						if (whole && !candidates.has(hash(readFileSync(target)))) {
							seen.wrong++;
						}
					} catch {
						// not there yet
					}
				};
				let looks = 0;
				while (!children.every((child) => child.finished())) {
					look(++looks % 20 === 0);
					await new Promise((resolve) => setImmediate(resolve));
				}
				const results = await Promise.all(children.map((child) => child.done));
				look(true);

				expect(results.map((r) => r.stderr).join("")).toBe("");
				expect(results.map((r) => r.code)).toEqual(Array(CHILDREN).fill(0));
				const winners = results.filter((r) => r.outcome === "won");
				expect(winners).toHaveLength(1);
				expect(results.filter((r) => r.outcome === "exists")).toHaveLength(CHILDREN - 1);
				expect(seen.wrong).toBe(0);
				expect(seen.reads).toBeGreaterThan(0);
				expect(hash(readFileSync(target)) === hash(textOf(winners[0].index))).toBe(true);
				expect(statSync(target).mode & 0o777).toBe(0o600);
				expect(readdirSync(folder)).toEqual(["secret.json"]);
				expect(existsSync(`${target}.tmp`)).toBe(false);
			}
		},
		60_000,
	);
});
