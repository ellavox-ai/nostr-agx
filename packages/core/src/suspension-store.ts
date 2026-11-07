import { z } from "zod";
import { taskInputQuestionSchema } from "./task";

export const suspendedTaskSchema = z.object({
	taskId: z.string().min(1).max(200),
	capability: z.string().min(1).max(200),
	payload: z.unknown(),
	from: z.string().min(1),
	contextId: z.string().min(1).max(200),
	eventId: z.string().optional(),
	transportId: z.string().optional(),
	sentAt: z.number().optional(),
	question: taskInputQuestionSchema,
	resumeSchema: z.record(z.string(), z.unknown()),
	expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	state: z.unknown(),
	createdAt: z.number().int().nonnegative(),
	resuming: z.boolean(),
});
export type AgxSuspendedTask = z.infer<typeof suspendedTaskSchema>;

export interface AgxSuspensionStore {
	list(): Promise<AgxSuspendedTask[]>;
	put(task: AgxSuspendedTask): Promise<void>;
	delete(taskId: string): Promise<void>;
}

function clone(task: AgxSuspendedTask): AgxSuspendedTask {
	return suspendedTaskSchema.parse(task);
}

export class InMemorySuspensionStore implements AgxSuspensionStore {
	private readonly tasks = new Map<string, AgxSuspendedTask>();

	async list(): Promise<AgxSuspendedTask[]> {
		return [...this.tasks.values()].map(clone);
	}

	async put(task: AgxSuspendedTask): Promise<void> {
		this.tasks.set(task.taskId, clone(task));
	}

	async delete(taskId: string): Promise<void> {
		this.tasks.delete(taskId);
	}
}
