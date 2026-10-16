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
		console.error(error);
		process.exit(1);
	},
);
