import { AgxCliError, EXIT, type ExitCode } from "./errors.js";

/**
 * Two guards for the API key, which is a bearer secret:
 *
 * 1. Its SHAPE is checked wherever a key enters agx (`AGX_API_KEY`, `config set
 *    apiKey`, a 0.3 `config.json`, `credentials.json`, a login's token
 *    response) and again before any request carries it. A key with a CR, LF or
 *    NUL in it is not a key, and undici refuses it as a header value with an
 *    error that quotes it in full — which the CLI would then print.
 * 2. Every key agx is about to send is remembered, and {@link redactSecrets}
 *    removes them from any text before it is printed: the last line of
 *    defence for error messages agx does not write itself.
 *
 * Neither ever puts the value in an error message.
 */

/** Printable ASCII without spaces, 1–512 characters. Real keys are `ela_` plus
 * 64 letters; this only rules out what can never be a header-safe key. */
const API_KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;

export function isWellFormedApiKey(value: unknown): value is string {
	return typeof value === "string" && API_KEY_SHAPE.test(value);
}

/**
 * A key that cannot be sent as a header. Never quotes the value. `where`
 * names its source, e.g. "AGX_API_KEY" or "The stored API key of profile …".
 */
export function malformedApiKeyError(
	where: string,
	options?: { exitCode?: ExitCode; remediation?: string },
): AgxCliError {
	return new AgxCliError(
		`${where} is not a valid API key: it contains spaces or control characters, or is longer than 512 characters. It was not sent anywhere.`,
		{
			exitCode: options?.exitCode ?? EXIT.config,
			remediation:
				options?.remediation ??
				'Log in again, or pipe a Settings key in on one line:\n    agx login\n    printf %s "$KEY" | agx config set apiKey --stdin',
		},
	);
}

/** Shorter values are not worth redacting (and would mangle ordinary text). */
const MIN_REDACTED_LENGTH = 8;

const remembered = new Set<string>();

/** Remember a secret so {@link redactSecrets} removes it from printed text. */
export function rememberSecret(value: string | null | undefined): void {
	if (typeof value === "string" && value.length >= MIN_REDACTED_LENGTH) {
		remembered.add(value);
	}
}

/** Every way a secret may appear in an error message: as is, JSON-escaped, and
 * each run of it between control characters or spaces. Longest first. */
function forms(secret: string): string[] {
	const all = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
	for (const part of secret.split(/[\x00-\x20\x7f]+/)) {
		if (part.length >= MIN_REDACTED_LENGTH) {
			all.add(part);
		}
	}
	return [...all].sort((a, b) => b.length - a.length);
}

/** `text` with every remembered secret replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const secret of remembered) {
		for (const form of forms(secret)) {
			if (form && out.includes(form)) {
				out = out.split(form).join("[redacted]");
			}
		}
	}
	return out;
}
