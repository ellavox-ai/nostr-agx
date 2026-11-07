import { existsSync, readFileSync } from "node:fs";
import {
	type AgxSuspendedTask,
	type AgxSuspensionStore,
	suspendedTaskSchema,
} from "@nostr-agx/core";
import { z } from "zod";
import { gatewayTaskSuspensionsPath, writePrivateJson } from "../paths.js";

const fileSchema = z.object({
	version: z.literal(1),
	suspensions: z.array(suspendedTaskSchema).max(128).default([]),
});

/** File-backed suspended tasks. The profile lock makes this a single-writer store. */
export class FileSuspensionStore implements AgxSuspensionStore {
	private readonly path: string;

	constructor(profile: string) {
		this.path = gatewayTaskSuspensionsPath(profile);
	}

	async list(): Promise<AgxSuspendedTask[]> {
		if (!existsSync(this.path)) {
			return [];
		}
		const parsed = fileSchema.safeParse(
			JSON.parse(readFileSync(this.path, "utf8")) as unknown,
		);
		if (!parsed.success) {
			throw new Error(`Invalid task suspension store: ${this.path}`);
		}
		return parsed.data.suspensions;
	}

	async put(task: AgxSuspendedTask): Promise<void> {
		const record = suspendedTaskSchema.parse(task);
		const suspensions = (await this.list()).filter(
			(candidate) => candidate.taskId !== task.taskId,
		);
		suspensions.push(record);
		if (suspensions.length > 128) {
			throw new Error("Task suspension store has 128 pending tasks");
		}
		this.persist(suspensions);
	}

	async delete(taskId: string): Promise<void> {
		const suspensions = await this.list();
		this.persist(suspensions.filter((task) => task.taskId !== taskId));
	}

	private persist(suspensions: AgxSuspendedTask[]): void {
		writePrivateJson(this.path, { version: 1, suspensions });
	}
}
