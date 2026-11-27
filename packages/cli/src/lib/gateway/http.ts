import type { IncomingMessage, ServerResponse } from "node:http";
import { isPastedSecretKey } from "../peer.js";

/** An API failure: the status, a stable code a client can branch on, and a
 * message (and optional remedy) fit to show its user. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly description?: string,
	) {
		super(message);
	}
}

/** Request bodies are small JSON: a task payload, a message. The transport
 * refuses anything larger than a relay accepts long before this. */
export const MAX_BODY_BYTES = 1024 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			throw new ApiError(413, "body_too_large", `Request bodies can be at most ${MAX_BODY_BYTES} bytes`);
		}
		chunks.push(chunk as Buffer);
	}
	if (size === 0) {
		return {};
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new ApiError(400, "invalid_json", "The request body is not valid JSON");
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(body === undefined ? "" : JSON.stringify(body));
}

export function sendError(res: ServerResponse, error: ApiError): void {
	sendJson(res, error.status, {
		error: {
			code: error.code,
			message: error.message,
			...(error.description ? { description: error.description } : {}),
		},
	});
}

/** How many layers of percent escapes {@link mayHoldSecretKey} looks through. */
const MAX_ESCAPE_LAYERS = 4;

/**
 * Text that is a pasted secret key, or would be once its percent escapes are
 * undone. A request path keeps an escape as it was written, so `%6Esec1…` holds
 * no `nsec1` as it stands, yet quoting it repeats the key. An escape can itself
 * be escaped (`%256E` is `%6E` is `n`): a few layers are looked through, and a
 * value escaped deeper than any client writes counts too, as it cannot be told
 * apart. `decodeURIComponent` throws on a bad escape (`%zz`), which must not
 * stop an answer being built, so the escapes are undone here.
 */
export function mayHoldSecretKey(value: string): boolean {
	let text = value;
	for (let layer = 0; layer <= MAX_ESCAPE_LAYERS; layer++) {
		if (isPastedSecretKey(text)) {
			return true;
		}
		const undone = text.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		if (undone === text) {
			return false;
		}
		text = undone;
	}
	return true;
}

/** What a gateway answer or log line says in place of a value that holds a secret key. */
export const HIDDEN_VALUE = "(a value with a secret key, not shown)";

/** A value as it may be quoted in an answer or a log line: never one that holds a secret key. */
export function shown(value: string): string {
	return mayHoldSecretKey(value) ? HIDDEN_VALUE : value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A text field: a string, or a number or boolean an expression produced. */
export function text(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A whole number within range, or the fallback when absent. */
export function integer(
	value: unknown,
	field: string,
	fallback: number,
	range: { min: number; max: number },
): number {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	if (!Number.isInteger(n) || n < range.min || n > range.max) {
		throw new ApiError(400, "invalid_request", `${field} must be a whole number from ${range.min} to ${range.max}, not ${shown(JSON.stringify(value))}`);
	}
	return n;
}
