import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { gatewayTaskOperationsPath, writePrivateJson } from "../paths.js";
import { ApiError } from "./http.js";

export const TASK_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;
export const MAX_TASK_OUTCOME_BYTES = 16 * 1024;
export const MAX_TASK_OPERATIONS_PER_CREDENTIAL = 100;
export const MAX_TASK_OPERATIONS_IN_FLIGHT = 256;
const MAX_TASK_OPERATIONS = 1_000;
const RETRYABLE_TASK_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_peer",
	"payload_too_large",
	"relays_unreachable",
	"no_card",
	"capability_not_advertised",
]);

const outcomeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("success"),
		body: z.record(z.string(), z.unknown()),
	}),
	z.object({
		kind: z.literal("error"),
		status: z.number().int(),
		code: z.string(),
		message: z.string(),
		description: z.string().optional(),
	}),
]);
const operationSchema = z.object({
	id: z.string().regex(/^[0-9a-f]{64}$/),
	credential: z.string().regex(/^[0-9a-f]{64}$/).optional(),
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	outcome: outcomeSchema.nullable(),
});
const fileSchema = z.object({
	version: z.literal(1),
	operations: z.array(operationSchema).default([]),
});

type Outcome = z.infer<typeof outcomeSchema>;
type Operation = z.infer<typeof operationSchema>;

export interface TaskIdempotencyOptions {
	now?: () => number;
	retentionMs?: number;
	maxOperationsPerCredential?: number;
	maxInFlight?: number;
	log?: (line: string) => void;
}

function unknownOutcome(): Outcome {
	return {
		kind: "error",
		status: 409,
		code: "result_unknown",
		message: "The gateway stopped before this task's outcome was recorded",
		description: "The remote agent may have executed the task. Check its effects before submitting new work with a different idempotency key.",
	};
}

function errorOutcome(error: unknown): Outcome {
	if (error instanceof ApiError) {
		return {
			kind: "error",
			status: error.status,
			code: error.code,
			message: error.message,
			...(error.description ? { description: error.description } : {}),
		};
	}
	return {
		kind: "error",
		status: 500,
		code: "internal_error",
		message: "The gateway could not complete the request",
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseIdempotencyKey(value: string | string[] | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_IDEMPOTENCY_KEY_CHARS ||
		!/^[!-~]+$/.test(value)
	) {
		throw new ApiError(
			400,
			"invalid_idempotency_key",
			`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_CHARS} visible ASCII characters without whitespace`,
		);
	}
	return value;
}

/** Durable idempotent outcomes for POST /v1/tasks. The profile lock makes this
 * a single-writer store; callers sharing an operation also share its promise. */
export class TaskIdempotencyStore {
	private readonly path: string;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxOperationsPerCredential: number;
	private readonly maxInFlight: number;
	private readonly log: (line: string) => void;
	private readonly records: Map<string, Operation>;
	private readonly inFlight = new Map<string, Promise<Record<string, unknown>>>();
	private closed = false;

	constructor(profile: string, options: TaskIdempotencyOptions = {}) {
		this.path = gatewayTaskOperationsPath(profile);
		this.now = options.now ?? Date.now;
		this.retentionMs = options.retentionMs ?? TASK_IDEMPOTENCY_RETENTION_MS;
		this.maxOperationsPerCredential = options.maxOperationsPerCredential ?? MAX_TASK_OPERATIONS_PER_CREDENTIAL;
		this.maxInFlight = options.maxInFlight ?? MAX_TASK_OPERATIONS_IN_FLIGHT;
		this.log = options.log ?? (() => undefined);
		this.records = new Map(this.readOperations().map((operation) => [operation.id, operation]));
		let changed = this.prune();
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				changed = true;
			} else {
				const retained = this.retainedOutcome(operation.outcome);
				if (retained !== operation.outcome) {
					operation.outcome = retained;
					operation.updatedAt = this.now();
					changed = true;
				}
			}
		}
		if (changed) {
			this.persist();
		}
	}

	async execute(
		credential: string,
		key: string,
		body: unknown,
		operation: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		if (this.closed) {
			throw new ApiError(503, "gateway_stopping", "The gateway is stopping");
		}
		if (this.prune()) {
			this.persist();
		}
		const credentialHash = hash(credential);
		const id = hash(`POST /v1/tasks\0${credential}\0${key}`);
		const fingerprint = hash(canonicalJson(body));
		const existing = this.records.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new ApiError(
					409,
					"idempotency_key_reused",
					"This idempotency key was already used with a different task request",
					"Use a new key for different work, or the original request body to retrieve its outcome.",
				);
			}
			const running = this.inFlight.get(id);
			if (running) {
				return running;
			}
			if (existing.outcome === null) {
				existing.outcome = unknownOutcome();
				existing.updatedAt = this.now();
				this.persist();
			}
			return this.replay(existing);
		}
		if (this.inFlight.size >= this.maxInFlight) {
			throw new ApiError(
				503,
				"busy",
				`${this.maxInFlight} idempotent task operations are already running`,
				"Try again when an operation finishes.",
			);
		}
		const evicted = this.makeStorageRoom(credentialHash);
		const created = {
			id,
			credential: credentialHash,
			fingerprint,
			createdAt: this.now(),
			updatedAt: this.now(),
			outcome: null,
		} satisfies Operation;
		this.records.set(id, created);
		try {
			this.persist();
		} catch (error) {
			this.records.delete(id);
			for (const operation of evicted) {
				this.records.set(operation.id, operation);
			}
			throw error;
		}
		const running = this.perform(created, operation);
		this.inFlight.set(id, running);
		try {
			return await running;
		} finally {
			if (this.inFlight.get(id) === running) {
				this.inFlight.delete(id);
			}
		}
	}

	private makeStorageRoom(credentialHash: string): Operation[] {
		const evicted: Operation[] = [];
		let credentialOperations = 0;
		for (const record of this.records.values()) {
			if (record.credential === credentialHash) {
				credentialOperations += 1;
			}
		}
		try {
			while (credentialOperations >= this.maxOperationsPerCredential) {
				const oldest = this.oldestSettled(credentialHash);
				if (!oldest) {
					throw new ApiError(
						503,
						"idempotency_store_full",
						`This API credential already has ${this.maxOperationsPerCredential} task operations running`,
						"Retry when an operation finishes, or submit without an idempotency key if duplicate execution is safe.",
					);
				}
				this.records.delete(oldest.id);
				evicted.push(oldest);
				credentialOperations -= 1;
			}
			while (this.records.size >= MAX_TASK_OPERATIONS) {
				const oldest = this.oldestSettled();
				if (!oldest) {
					throw new ApiError(
						503,
						"idempotency_store_full",
						`The gateway already has ${MAX_TASK_OPERATIONS} task operations running`,
						"Retry when an operation finishes, or submit without an idempotency key if duplicate execution is safe.",
					);
				}
				this.records.delete(oldest.id);
				evicted.push(oldest);
			}
		} catch (error) {
			for (const operation of evicted) {
				this.records.set(operation.id, operation);
			}
			throw error;
		}
		return evicted;
	}

	private oldestSettled(credentialHash?: string): Operation | undefined {
		let oldest: Operation | undefined;
		for (const operation of this.records.values()) {
			if (operation.outcome === null || (credentialHash !== undefined && operation.credential !== credentialHash)) {
				continue;
			}
			if (!oldest || operation.updatedAt < oldest.updatedAt || (operation.updatedAt === oldest.updatedAt && operation.id < oldest.id)) {
				oldest = operation;
			}
		}
		return oldest;
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		let changed = false;
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				changed = true;
			}
		}
		if (changed) {
			this.persist();
		}
	}

	private readOperations(): Operation[] {
		if (!existsSync(this.path)) {
			return [];
		}
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (error) {
			this.quarantine(error);
			return [];
		}
		const parsed = fileSchema.safeParse(raw);
		if (!parsed.success) {
			this.quarantine(parsed.error);
			return [];
		}
		return parsed.data.operations;
	}

	private quarantine(reason: unknown): void {
		const corruptPath = `${this.path}.corrupt`;
		try {
			renameSync(this.path, corruptPath);
		} catch (error) {
			throw new Error(
				`${this.path} is unreadable and could not be moved to ${corruptPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.log(
			`Unreadable task-operation store moved to ${corruptPath}: ${reason instanceof Error ? reason.message : String(reason)}`,
		);
	}

	private async perform(
		operation: Operation,
		run: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		let outcome: Outcome;
		let unexpected: unknown;
		let failed = false;
		try {
			outcome = { kind: "success", body: await run() };
		} catch (error) {
			failed = true;
			unexpected = error;
			outcome = errorOutcome(error);
		}
		const retryable = failed && unexpected instanceof ApiError && RETRYABLE_TASK_ERROR_CODES.has(unexpected.code);
		operation.outcome = retryable ? null : this.retainedOutcome(outcome);
		operation.updatedAt = this.now();
		if (!this.closed && this.records.get(operation.id) === operation) {
			try {
				if (retryable) {
					this.records.delete(operation.id);
				}
				this.persist();
			} catch {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				this.records.set(operation.id, operation);
				throw new ApiError(
					500,
					"idempotency_store_failed",
					"The task finished, but its outcome could not be stored",
					"Do not retry with a different key until you have checked whether the remote agent executed the task.",
				);
			}
		}
		if (failed && !(unexpected instanceof ApiError)) {
			throw unexpected;
		}
		return this.replay(operation, outcome);
	}

	private retainedOutcome(outcome: Outcome): Outcome {
		let bytes: number;
		try {
			bytes = Buffer.byteLength(JSON.stringify(outcome, null, 2), "utf8");
		} catch {
			bytes = Number.POSITIVE_INFINITY;
		}
		if (bytes <= MAX_TASK_OUTCOME_BYTES) {
			return outcome;
		}
		return {
			kind: "error",
			status: 409,
			code: "outcome_not_retained",
			message: "The task finished, but its outcome was too large to retain",
			description: `The callers waiting for this run received its outcome. Stored outcomes are limited to ${MAX_TASK_OUTCOME_BYTES} bytes; check the remote agent before submitting new work with a different key.`,
		};
	}

	private replay(operation: Operation, actual?: Outcome): Record<string, unknown> {
		const outcome = actual ?? operation.outcome ?? unknownOutcome();
		if (outcome.kind === "success") {
			return outcome.body;
		}
		throw new ApiError(outcome.status, outcome.code, outcome.message, outcome.description);
	}

	private prune(): boolean {
		const cutoff = this.now() - this.retentionMs;
		let changed = false;
		for (const [id, operation] of this.records) {
			if (operation.updatedAt <= cutoff) {
				this.records.delete(id);
				changed = true;
			}
		}
		return changed;
	}

	private persist(): void {
		writePrivateJson(this.path, {
			version: 1,
			operations: Array.from(this.records.values()),
		});
	}
}
