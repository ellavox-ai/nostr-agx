import { errLine } from "../lib/output.js";
import { runCli } from "../program.js";

// The whole program lives in `program.ts`, so tests can drive the real command
// wiring in-process; this entry only turns its result into an exit status.
runCli(process.argv.slice(2)).then(
	(code) => {
		if (code !== 0) {
			process.exit(code);
		}
	},
	(error: unknown) => {
		// A bug in `runCli` itself, so there is no message of ours to show: what was thrown is printed, scrubbed.
		errLine(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	},
);
