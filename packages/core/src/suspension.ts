import { AgxPublicError, AgxTaskDeclined } from "./errors";
import { validateAgxJsonPayload, validateAgxJsonSchema } from "./json-schema";
import type { AgxLogger } from "./logger";
import {
	type AgxSuspendedTask,
	type AgxSuspensionStore,
	suspendedTaskSchema,
} from "./suspension-store";
import {
	type Task,
	type TaskInputRequiredOptions,
	type TaskResumeEnvelope,
	type TaskStatusEnvelope,
} from "./task";
import type { AgxIncomingMessage, AgxTransport } from "./transport";

export type AgxResumeHandler<Output = unknown> = (
	task: Task,
	input: unknown,
) => Output | Promise<Output>;

interface TaskResult {
	status: "completed" | "failed";
	output?: unknown;
	error?: string;
}

interface TaskRef {
	taskId: string;
	seq: number;
}

export class AgxResumeCompletion {
	constructor(
		readonly tasks: TaskRef[],
		readonly result: TaskResult,
	) {}
}

interface Continuation {
	resolve: (completion: AgxResumeCompletion) => void;
	reject: (error: Error) => void;
}

interface Entry {
	record: AgxSuspendedTask;
	continuation?: Continuation;
	timer?: ReturnType<typeof setTimeout>;
}

interface SuspensionManagerOptions {
	store: AgxSuspensionStore;
	transport: AgxTransport;
	logger: AgxLogger;
	normalizeId: (id: string) => string;
	resumeHandler: (capability: string) => AgxResumeHandler | undefined;
	validateResult: (
		capability: string,
		taskId: string,
		result: TaskResult,
	) => TaskResult;
	attachTask: (task: Task, seq: number) => void;
	sendStatus: (to: string, envelope: TaskStatusEnvelope) => Promise<void>;
	sendResult: (to: string, taskId: string, result: TaskResult) => Promise<void>;
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

export class AgxSuspensionManager {
	private readonly entries = new Map<string, Entry>();
	private ready?: Promise<void>;

	constructor(private readonly options: SuspensionManagerOptions) {}

	load(): Promise<void> {
		this.ready ??= this.restore();
		return this.ready;
	}

	async has(taskId: string): Promise<boolean> {
		await this.load();
		return this.entries.has(taskId);
	}

	async requireInput(
		task: Task,
		input: TaskInputRequiredOptions,
		seq: number,
	): Promise<unknown> {
		await this.load();
		if (!this.options.resumeHandler(task.capability)) {
			throw new Error(
				`AGX capability ${task.capability} has no resume handler`,
			);
		}
		const schemaProblem = validateAgxJsonSchema(input.resumeSchema);
		if (schemaProblem) {
			throw new Error(`AGX input-required resumeSchema: ${schemaProblem}`);
		}
		const state = input.state ?? null;
		const stateProblem = validateAgxJsonPayload({}, state);
		if (stateProblem) {
			throw new Error(`AGX input-required state: ${stateProblem}`);
		}
		const timeoutSec = input.timeoutSec ?? 300;
		if (
			!Number.isInteger(timeoutSec) ||
			timeoutSec < 1 ||
			timeoutSec > 86_400
		) {
			throw new Error("AGX input-required timeoutSec must be 1-86400");
		}
		const question = suspendedTaskSchema.shape.question.parse(input.question);
		const record: AgxSuspendedTask = {
			taskId: task.taskId,
			capability: task.capability,
			payload: task.payload,
			from: task.from,
			contextId: task.contextId,
			...(task.eventId === undefined ? {} : { eventId: task.eventId }),
			...(task.transportId === undefined
				? {}
				: { transportId: task.transportId }),
			...(task.sentAt === undefined ? {} : { sentAt: task.sentAt }),
			question,
			resumeSchema: input.resumeSchema,
			expiresAt: nowSec() + timeoutSec,
			seq,
			state,
			createdAt: nowSec(),
			resuming: false,
		};
		const continuationPromise = new Promise<AgxResumeCompletion>(
			(resolve, reject) => {
				const entry: Entry = {
					record,
					continuation: { resolve, reject },
				};
				this.entries.set(task.taskId, entry);
				this.schedule(entry);
			},
		);
		try {
			await this.options.store.put(record);
			await this.options.sendStatus(task.from, {
				t: "status",
				taskId: task.taskId,
				status: "input-required",
				seq,
				question,
				resumeSchema: input.resumeSchema,
				expiresAt: record.expiresAt,
			});
		} catch (error) {
			const entry = this.entries.get(task.taskId);
			if (entry?.record.seq === seq) {
				if (entry.timer) {
					clearTimeout(entry.timer);
				}
				this.entries.delete(task.taskId);
			}
			throw error;
		}
		return continuationPromise;
	}

	async resume(msg: AgxIncomingMessage, envelope: TaskResumeEnvelope): Promise<void> {
		await this.load();
		const entry = this.entries.get(envelope.taskId);
		if (!entry) {
			return;
		}
		if (this.options.normalizeId(msg.from) !== this.options.normalizeId(entry.record.from)) {
			this.options.logger.warn?.("AGX: resume from unexpected peer; dropping", {
				taskId: envelope.taskId,
				from: msg.from,
			});
			return;
		}
		if (entry.record.resuming || entry.record.seq !== envelope.seq) {
			this.options.logger.debug?.("AGX: duplicate or older resume; dropping", {
				taskId: envelope.taskId,
				seq: envelope.seq,
			});
			return;
		}
		if (entry.record.expiresAt <= nowSec()) {
			await this.settle(entry, {
				status: "failed",
				error: "input_required_expired",
			});
			return;
		}
		const problem = validateAgxJsonPayload(
			entry.record.resumeSchema,
			envelope.payload,
		);
		if (problem) {
			this.options.logger.info?.("AGX: resume payload failed validation", {
				taskId: envelope.taskId,
				error: problem,
			});
			await this.settle(entry, {
				status: "failed",
				error: "invalid_resume_input",
			});
			return;
		}

		entry.record.resuming = true;
		try {
			await this.options.store.put(entry.record);
		} catch (error) {
			this.options.logger.error?.("AGX: could not persist resume marker", {
				taskId: envelope.taskId,
				error: String(error),
			});
			await this.settle(entry, {
				status: "failed",
				error: "resume_state_failed",
			});
			return;
		}
		const resumeHandler = this.options.resumeHandler(entry.record.capability);
		if (!resumeHandler) {
			await this.settle(entry, {
				status: "failed",
				error: "resume_unavailable",
			});
			return;
		}
		void this.runResume(entry, envelope.payload, resumeHandler).catch((error) =>
			this.options.logger.error?.("AGX: resume continuation failed", {
				taskId: envelope.taskId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	private async runResume(
		entry: Entry,
		input: unknown,
		resumeHandler: AgxResumeHandler,
	): Promise<void> {
		const task: Task = {
			taskId: entry.record.taskId,
			capability: entry.record.capability,
			payload: entry.record.payload,
			from: entry.record.from,
			contextId: entry.record.contextId,
			eventId: entry.record.eventId,
			transportId: entry.record.transportId,
			sentAt: entry.record.sentAt,
			state: entry.record.state,
		};
		this.options.attachTask(task, entry.record.seq);
		try {
			const output = await resumeHandler(task, input);
			const completion = output instanceof AgxResumeCompletion ? output : undefined;
			const result = completion?.result ?? { status: "completed", output };
			await this.settle(
				entry,
				entry.continuation
					? result
					: this.options.validateResult(
						entry.record.capability,
						entry.record.taskId,
						result,
					),
				completion?.tasks,
			);
		} catch (error) {
			const isPublic = error instanceof AgxPublicError;
			if (!isPublic) {
				this.options.logger.error?.("AGX: resume handler threw", {
					taskId: entry.record.taskId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			await this.settle(entry, {
				status: "failed",
				error: isPublic ? error.message : "handler failed",
			});
		}
	}

	async finish(completion: AgxResumeCompletion): Promise<void> {
		for (const ref of completion.tasks) {
			const entry = this.entries.get(ref.taskId);
			if (entry?.record.seq === ref.seq) {
				await this.remove(entry);
			}
		}
	}

	stop(): void {
		for (const entry of this.entries.values()) {
			if (entry.timer) {
				clearTimeout(entry.timer);
			}
			entry.continuation?.reject(
				new AgxTaskDeclined("client stopped before task resume"),
			);
		}
	}

	private async restore(): Promise<void> {
		const records = await this.options.store.list();
		for (const stored of records) {
			const record = suspendedTaskSchema.parse(stored);
			const entry: Entry = { record };
			this.entries.set(record.taskId, entry);
			if (record.resuming) {
				await this.settle(entry, {
					status: "failed",
					error: "resume_interrupted",
				});
				continue;
			}
			if (record.expiresAt <= nowSec()) {
				await this.settle(entry, {
					status: "failed",
					error: "input_required_expired",
				});
				continue;
			}
			this.schedule(entry);
		}
	}

	private schedule(entry: Entry): void {
		const delay = Math.max(0, (entry.record.expiresAt - nowSec()) * 1000);
		entry.timer = setTimeout(() => {
			void this.settle(entry, {
				status: "failed",
				error: "input_required_expired",
			});
		}, delay);
	}

	private async settle(
		entry: Entry,
		result: TaskResult,
		chain: TaskRef[] = [],
	): Promise<void> {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		const completion = new AgxResumeCompletion(
			[
				{ taskId: entry.record.taskId, seq: entry.record.seq },
				...chain,
			],
			result,
		);
		if (entry.continuation) {
			entry.continuation.resolve(completion);
			return;
		}
		await this.options.sendResult(entry.record.from, entry.record.taskId, result);
		await this.finish(completion);
	}

	private async remove(entry: Entry): Promise<void> {
		if (entry.timer) {
			clearTimeout(entry.timer);
		}
		const current = this.entries.get(entry.record.taskId);
		if (!current || current.record.seq === entry.record.seq) {
			this.entries.delete(entry.record.taskId);
			await this.options.store.delete(entry.record.taskId);
		}
	}
}
