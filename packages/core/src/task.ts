import { z } from "zod";

/**
 * AGX task semantics — the layer that lets a runtime only decide *what to do with
 * a task*. A task is a capability-keyed request that a peer handles and answers
 * with a result. Task envelopes ride inside the message payload's text, labelled
 * by {@link TASK_CONTENT_TYPE}, so the transport carries them like any message
 * while `AgxClient` interprets the lifecycle + correlation.
 */

/** Task lifecycle states (A2A-aligned). v1 drives the terminal states via the
 * result envelope; `working` / `input-required` are reserved for status updates. */
export type TaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled";

/** Terminal states a result envelope can carry. */
export type TaskTerminalStatus = "completed" | "failed";

/** Wire envelope for a task request. `payload` is arbitrary JSON the handler
 * interprets (payload-agnostic). */
export const taskRequestSchema = z.object({
	t: z.literal("req"),
	taskId: z.string().min(1).max(200),
	capability: z.string().min(1).max(200),
	payload: z.unknown(),
});
export type TaskRequestEnvelope = z.infer<typeof taskRequestSchema>;

/** Wire envelope for a task result. */
export const taskResultSchema = z.object({
	t: z.literal("res"),
	taskId: z.string().min(1).max(200),
	status: z.enum(["completed", "failed"]),
	output: z.unknown().optional(),
	error: z.string().max(2000).optional(),
});
export type TaskResultEnvelope = z.infer<typeof taskResultSchema>;

export const taskEnvelopeSchema = z.discriminatedUnion("t", [
	taskRequestSchema,
	taskResultSchema,
]);
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

/** A task as delivered to a capability handler. */
export interface Task<Payload = unknown> {
	taskId: string;
	capability: string;
	/** The request payload (already JSON-parsed). */
	payload: Payload;
	/** The sender's identity. */
	from: string;
	/** Conversation/correlation id (mirrors the transport contextId). */
	contextId: string;
	/** Durable id of the message the request arrived in — the replay key. A host
	 * that keeps its own record of handled tasks (to survive a restart) keys it
	 * on this. */
	eventId: string;
	/** The transport envelope's id, when it differs from `eventId`. */
	transportId?: string;
	/** When the sender says it sent the request (unix seconds), if the transport
	 * carries that. Sender-declared. */
	sentAt?: number;
}

/** Serialize a task envelope for the message text field. */
export function encodeTaskEnvelope(envelope: TaskEnvelope): string {
	return JSON.stringify(envelope);
}

/** Parse a task envelope from a message text field; null if not a valid task. */
export function parseTaskEnvelope(text: string): TaskEnvelope | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = taskEnvelopeSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}
