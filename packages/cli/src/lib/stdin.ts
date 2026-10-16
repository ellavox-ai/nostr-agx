import { Readable } from "node:stream";
import { usageError } from "./errors.js";

let override: { stream: Readable; isTTY: boolean } | null = null;

/** The stream commands read from: `process.stdin`, unless a test replaced it. */
export function stdinStream(): Readable {
	return override?.stream ?? process.stdin;
}

/** Whether stdin is a terminal (so there is nothing piped to read). */
export function stdinIsTTY(): boolean {
	return override ? override.isTTY : Boolean(process.stdin.isTTY);
}

/** Tests only: feed `input` as stdin (or a terminal with nothing piped when
 * `input` is null). Returns a function that restores the real stdin. */
export function setStdinForTests(input: string | null): () => void {
	const previous = override;
	override =
		input === null
			? { stream: Readable.from([]), isTTY: true }
			: { stream: Readable.from([Buffer.from(input)]), isTTY: false };
	return () => {
		override = previous;
	};
}

/** Read all of stdin as UTF-8. */
export async function readStdin(
	stream: Readable = stdinStream(),
): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read one secret from stdin: the input trimmed, which must be a single line.
 *
 * `printf %s "$KEY" | agx config set apiKey --stdin` keeps the secret out of
 * argv (and so out of shell history and `ps`). Anything with a second line is
 * refused rather than guessed at, because "the first line" of a pasted blob is
 * rarely the key.
 */
export async function readSecretLine(
	what: string,
	stream: Readable = stdinStream(),
): Promise<string> {
	const value = (await readStdin(stream)).trim();
	if (!value) {
		throw usageError(
			`No ${what} on stdin.`,
			`printf %s "$VALUE" | agx config set <key> --stdin`,
		);
	}
	if (/[\r\n]/.test(value)) {
		throw usageError(
			`Expected a single line on stdin for the ${what}, got several.`,
			"Pipe exactly one line, for example:  printf %s \"$VALUE\" | agx config set <key> --stdin",
		);
	}
	return value;
}
