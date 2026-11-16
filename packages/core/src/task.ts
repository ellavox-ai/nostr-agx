import { z } from "zod";

/**
 * AGX task semantics — the layer that lets a runtime only decide *what to do with
 * a task*. A task is a capability-keyed request that a peer handles and answers
 * with a result. Task envelopes ride inside the message payload's text, labelled
 * by {@link TASK_CONTENT_TYPE}, so the transport carries them like any message
 * while `AgxClient` interprets the lifecycle + correlation.
 */

/** Task lifecycle states (A2A-aligned). */
export type TaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled";

/** Terminal task states. */
export type TaskTerminalStatus = "completed" | "failed";

export const inputRequirementSchema = z.object({
	id: z.string().min(1).max(200).optional(),
	prompt: z.string().min(1).max(2000),
	inputSchema: z.unknown().optional(),
	timeoutMs: z.number().int().min(0).optional(),
});
export type InputRequirement = z.infer<typeof inputRequirementSchema>;

export const inputRequiredUpdateSchema = z.object({
	inputRequestId: z.string().min(1).max(200),
	requirement: inputRequirementSchema,
});
export type InputRequiredUpdate = z.infer<typeof inputRequiredUpdateSchema>;

/** Wire envelope for a task request. `payload` is arbitrary JSON the handler
 * interprets (payload-agnostic). */
export const taskRequestSchema = z.object({
	t: z.literal("req"),
	taskId: z.string().min(1).max(200),
	capability: z.string().min(1).max(200),
	payload: z.unknown(),
	supportsInput: z.boolean().optional(),
	/** Opt-in to nonterminal `working` updates; absent means false. */
	supportsWorking: z.boolean().optional(),
	timeoutMs: z.number().int().min(0).optional(),
});
export type TaskRequestEnvelope = z.infer<typeof taskRequestSchema>;

/** A non-terminal `working` update: public progress text from the handler,
 * ordered by `seq` (starting at 1) so a requester can drop duplicates and older
 * updates. Rides in the `res` envelope next to `input-required`. */
export const taskWorkingUpdateSchema = z.object({
	t: z.literal("res"),
	taskId: z.string().min(1).max(200),
	status: z.literal("working"),
	seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	message: z.string().max(2000).optional(),
});
export type TaskWorkingUpdate = z.infer<typeof taskWorkingUpdateSchema>;
/** A `working` update as handed to a requester callback (no wire tag). */
export type TaskStatusUpdate = Omit<TaskWorkingUpdate, "t">;

/** Wire envelope for a task status update or terminal result. */
export const taskResultSchema = z.discriminatedUnion("status", [
	taskWorkingUpdateSchema,
	z.object({
		t: z.literal("res"),
		taskId: z.string().min(1).max(200),
		status: z.literal("input-required"),
		inputRequestId: z.string().min(1).max(200),
		requirement: inputRequirementSchema,
	}),
	z.object({
		t: z.literal("res"),
		taskId: z.string().min(1).max(200),
		status: z.literal("completed"),
		output: z.unknown().optional(),
	}),
	z.object({
		t: z.literal("res"),
		taskId: z.string().min(1).max(200),
		status: z.literal("failed"),
		error: z.string().max(2000).optional(),
	}),
]);
export type TaskResultEnvelope = z.infer<typeof taskResultSchema>;

/** Cancel a task when its requester can no longer continue the conversation. */
export const taskCancelSchema = z.object({
	t: z.literal("cancel"),
	taskId: z.string().min(1).max(200),
});
export type TaskCancelEnvelope = z.infer<typeof taskCancelSchema>;

/** A continuation carrying an answer to a task's input requirement. */
export const taskInputSchema = z.object({
	t: z.literal("input"),
	taskId: z.string().min(1).max(200),
	inputRequestId: z.string().min(1).max(200),
	input: z.unknown(),
});
export type TaskInputEnvelope = z.infer<typeof taskInputSchema>;

export const taskEnvelopeSchema = z.discriminatedUnion("t", [
	taskRequestSchema,
	taskResultSchema,
	taskCancelSchema,
	taskInputSchema,
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
	 * on this. `AgxClient` always sets it; optional so code that builds a `Task`
	 * itself (a handler's unit test, say) need not. */
	eventId?: string;
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
