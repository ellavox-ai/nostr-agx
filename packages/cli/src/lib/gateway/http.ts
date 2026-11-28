import type { IncomingMessage, ServerResponse } from "node:http";
import { scrubbedJson } from "../scrub.js";

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

/**
 * Every body the gateway sends leaves here, with a secret key in it replaced (see `../scrub.ts`).
 * The whole text is built before the status line goes out: a body that cannot be written throws
 * while nothing has been sent, so the caller can still answer with an error.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = body === undefined ? "" : scrubbedJson(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(text);
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
		throw new ApiError(400, "invalid_request", `${field} must be a whole number from ${range.min} to ${range.max}, not ${JSON.stringify(value)}`);
	}
	return n;
}
