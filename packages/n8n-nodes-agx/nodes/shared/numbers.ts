/**
 * A numeric option, checked. n8n's `minValue` only constrains the editor: an
 * expression, or an AI Agent filling a tool parameter, can still hand over 0,
 * a negative number or NaN — and a timeout of 0 means "never" to `AgxClient`
 * and to `setTimeout`, while one past 2^31 ms fires at once. Empty means the
 * default; anything else outside `[min, max]` throws with a message fit to
 * show the user.
 */
export function numberOption(
	value: unknown,
	label: string,
	fallback: number,
	range: { min: number; max: number; integer?: boolean },
): number {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const n = typeof value === "number" ? value : Number(value);
	if (
		!Number.isFinite(n) ||
		n < range.min ||
		n > range.max ||
		(range.integer === true && !Number.isInteger(n))
	) {
		throw new Error(
			`${label} must be ${range.integer ? "a whole number" : "a number"} from ${range.min} to ${range.max}, not ${JSON.stringify(value)}`,
		);
	}
	return n;
}

/** The longest wait the nodes accept, in seconds: a day, well inside what
 * `setTimeout` can schedule. */
export const MAX_WAIT_SEC = 24 * 60 * 60;

/** A sender-declared time (unix seconds) as ISO 8601. Null when absent, or when
 * it is not a date at all: it comes from the peer, and `toISOString` throws on
 * a value outside what a Date can hold. */
export function isoOrNull(sec: number | undefined): string | null {
	if (sec === undefined || !Number.isFinite(sec) || Math.abs(sec) > 8.64e12) {
		return null;
	}
	return new Date(sec * 1000).toISOString();
}
