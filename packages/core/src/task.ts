import { z } from "zod";

/**
 * AGX task semantics — the layer that lets a runtime only decide *what to do with
 * a task*. A task is a capability-keyed request that a peer handles and answers
 * with a result. Task envelopes ride inside the message payload's text, labelled
 * by {@link TASK_CONTENT_TYPE}, so the transport carries them like any message
 * while `AgxClient` interprets the lifecycle + correlation.
 */

/** Task lifecycle states (A2A-aligned). Terminal states use the result envelope;
 * `working` and `input-required` use status updates. */
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

const taskStatusBase = {
	t: z.literal("status"),
	taskId: z.string().min(1).max(200),
	seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

/** Nonterminal progress for a pending task. */
export const taskWorkingSchema = z.object({
	...taskStatusBase,
	status: z.literal("working"),
	message: z.string().max(2000).optional(),
});
export type TaskWorkingEnvelope = z.infer<typeof taskWorkingSchema>;

export const taskInputQuestionSchema = z
	.object({
		kind: z.enum(["text", "choice", "confirmation"]),
		prompt: z.string().min(1).max(2000),
		options: z.array(z.string().min(1).max(200)).max(16).optional(),
	})
	.strict()
	.superRefine((question, context) => {
		if (question.kind === "choice" && !question.options?.length) {
			context.addIssue({ code: "custom", message: "choice questions need options" });
		}
		if (question.kind !== "choice" && question.options !== undefined) {
			context.addIssue({ code: "custom", message: "options belong only to choice questions" });
		}
	});
export type TaskInputQuestion = z.infer<typeof taskInputQuestionSchema>;

export const taskInputRequiredSchema = z.object({
	...taskStatusBase,
	status: z.literal("input-required"),
	question: taskInputQuestionSchema,
	resumeSchema: z.record(z.string(), z.unknown()),
	expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type TaskInputRequiredEnvelope = z.infer<typeof taskInputRequiredSchema>;

export const taskStatusSchema = z.discriminatedUnion("status", [
	taskWorkingSchema,
	taskInputRequiredSchema,
]);
export type TaskStatusEnvelope = z.infer<typeof taskStatusSchema>;
export type TaskStatusUpdate =
	| Omit<TaskWorkingEnvelope, "t">
	| Omit<TaskInputRequiredEnvelope, "t">;

export const taskResumeSchema = z.object({
	t: z.literal("resume"),
	taskId: z.string().min(1).max(200),
	seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	payload: z.unknown(),
});
export type TaskResumeEnvelope = z.infer<typeof taskResumeSchema>;

export const taskEnvelopeSchema = z.discriminatedUnion("t", [
	taskRequestSchema,
	taskResultSchema,
	taskStatusSchema,
	taskResumeSchema,
]);
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

export interface TaskInputRequiredOptions {
	question: TaskInputQuestion;
	resumeSchema: Record<string, unknown>;
	/** JSON host state persisted locally for the resume handler. Never use secrets. */
	state?: unknown;
	/** Seconds until this question expires. Default 300; maximum 86400. */
	timeoutSec?: number;
}

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
	/** JSON host state restored for a resume handler. */
	state?: unknown;
	/** Publish a best-effort public `working` update. Client-created tasks always
	 * provide this; optional for host-created task fixtures. */
	report?: (message?: string) => Promise<void>;
	/** Pause for typed public input and continue through the registered resume
	 * handler. Client-created tasks provide this when a resume handler exists. */
	requireInput?: (options: TaskInputRequiredOptions) => Promise<unknown>;
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
