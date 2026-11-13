import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { gatewayTaskOperationsPath, writePrivateJson } from "../paths.js";
import { ApiError } from "./http.js";

export const TASK_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;
export const MAX_TASK_OUTCOME_BYTES = 16 * 1024;
export const MAX_BACKGROUND_TASK_OUTCOME_BYTES = 1024 * 1024;
export const MAX_TASK_OPERATION_STORE_BYTES = 16 * 1024 * 1024;
export const MAX_TASK_OPERATIONS_PER_CREDENTIAL = 100;
export const MAX_TASK_OPERATIONS_IN_FLIGHT = 256;
export const MAX_BACKGROUND_TASKS_IN_FLIGHT = 64;
const MAX_TASK_OPERATIONS = 1_000;
const RETRYABLE_TASK_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_peer",
	"payload_too_large",
	"relays_unreachable",
	"no_card",
	"capability_not_advertised",
]);
const PUBLIC_TASK_ID_PATTERN = /^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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
	publicId: z.string().regex(PUBLIC_TASK_ID_PATTERN).optional(),
	credential: z.string().regex(/^[0-9a-f]{64}$/).optional(),
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	background: z.boolean().default(false),
	keyed: z.boolean().default(false),
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
	maxOperations?: number;
	maxInFlight?: number;
	maxBackgroundInFlight?: number;
	maxStoreBytes?: number;
	log?: (line: string) => void;
}

function unknownOutcome(): Outcome {
	return {
		kind: "error",
		status: 409,
		code: "result_unknown",
		message: "The gateway stopped before this task's outcome was recorded",
		description: "The remote agent may have executed the task. Check its effects before submitting new work.",
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

/** Keyed requests and background tasks with a key need their record for replay. Unkeyed background
 * results do not, so they live in a separate pool for the count limits: filling one pool never
 * evicts or blocks the other. The byte budget is shared by every record. */
function holdsIdempotencyKey(operation: Operation): boolean {
	return !operation.background || operation.keyed;
}

// The file is pretty-printed and each operation sits one level inside "operations": four more
// spaces per line, plus the ",\n" between operations. The constant covers the surrounding wrapper.
const STORE_FILE_OVERHEAD_BYTES = 64;
function operationFileBytes(operation: Operation): number {
	const text = JSON.stringify(operation, null, 2);
	let lines = 1;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
		lines += 1;
	}
	return Buffer.byteLength(text, "utf8") + lines * 4 + 2;
}

function isOlder(a: Operation, b: Operation): boolean {
	return a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.id < b.id);
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

/** Durable task outcomes for POST /v1/tasks. The profile lock makes this a
 * single-writer store; callers sharing an operation also share its promise. */
export class TaskOperationStore {
	private readonly path: string;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxOperationsPerCredential: number;
	private readonly maxOperations: number;
	private readonly maxInFlight: number;
	private readonly maxBackgroundInFlight: number;
	private readonly maxStoreBytes: number;
	private readonly log: (line: string) => void;
	private readonly records: Map<string, Operation>;
	// Size of each stored record, kept in step with `records` so the byte budget never re-serializes.
	private readonly recordBytes = new Map<Operation, number>();
	private readonly credentialBytes = new Map<string, number>();
	private totalBytes = STORE_FILE_OVERHEAD_BYTES;
	private readonly inFlight = new Map<string, Promise<Record<string, unknown>>>();
	private readonly synchronousInFlight = new Set<string>();
	private readonly backgroundInFlight = new Set<string>();
	private closed = false;

	constructor(profile: string, options: TaskIdempotencyOptions = {}) {
		this.path = gatewayTaskOperationsPath(profile);
		this.now = options.now ?? Date.now;
		this.retentionMs = options.retentionMs ?? TASK_IDEMPOTENCY_RETENTION_MS;
		this.maxOperationsPerCredential = options.maxOperationsPerCredential ?? MAX_TASK_OPERATIONS_PER_CREDENTIAL;
		this.maxOperations = options.maxOperations ?? MAX_TASK_OPERATIONS;
		this.maxInFlight = options.maxInFlight ?? MAX_TASK_OPERATIONS_IN_FLIGHT;
		this.maxBackgroundInFlight = options.maxBackgroundInFlight ?? MAX_BACKGROUND_TASKS_IN_FLIGHT;
		this.maxStoreBytes = options.maxStoreBytes ?? MAX_TASK_OPERATION_STORE_BYTES;
		this.log = options.log ?? (() => undefined);
		this.records = new Map(this.readOperations().map((operation) => [operation.id, operation]));
		for (const operation of this.records.values()) {
			this.track(operation);
		}
		let changed = this.prune();
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				this.setOutcome(operation, unknownOutcome());
				changed = true;
			} else {
				const retained = this.retainedOutcome(operation.outcome, operation.background);
				if (retained !== operation.outcome) {
					this.setOutcome(operation, retained);
					changed = true;
				}
			}
		}
		if (this.enforceByteBudget().length > 0) {
			changed = true;
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
		this.assertOpen();
		if (this.prune()) {
			this.persist();
		}
		const credentialHash = hash(credential);
		const id = hash(`POST /v1/tasks\0${credential}\0${key}`);
		const fingerprint = hash(canonicalJson(body));
		const existing = this.records.get(id);
		if (existing) {
			this.checkFingerprint(existing, fingerprint);
			if (existing.background) {
				throw new ApiError(409, "idempotency_key_reused", "This idempotency key belongs to a background task");
			}
			const running = this.inFlight.get(id);
			if (running) {
				return running;
			}
			if (existing.outcome === null) {
				this.setOutcome(existing, unknownOutcome());
				this.persist();
			}
			return this.replay(existing);
		}
		if (this.synchronousInFlight.size >= this.maxInFlight) {
			throw new ApiError(
				503,
				"busy",
				`${this.maxInFlight} idempotent task operations are already running`,
				"Try again when an operation finishes.",
			);
		}
		const evicted = this.makeStorageRoom(credentialHash, true);
		const created = {
			id,
			credential: credentialHash,
			fingerprint,
			background: false,
			keyed: true,
			createdAt: this.now(),
			updatedAt: this.now(),
			outcome: null,
		} satisfies Operation;
		this.put(created);
		try {
			this.persist();
		} catch (error) {
			this.drop(created);
			for (const operation of evicted) {
				this.put(operation);
			}
			throw error;
		}
		const running = this.perform(created, operation);
		this.inFlight.set(id, running);
		this.synchronousInFlight.add(id);
		try {
			return await running;
		} finally {
			this.synchronousInFlight.delete(id);
			if (this.inFlight.get(id) === running) {
				this.inFlight.delete(id);
			}
		}
	}

	submit(
		credential: string,
		key: string | null,
		body: unknown,
		operation: () => Promise<Record<string, unknown>>,
		/** Called with the public ID once the outcome is stored. */
		onSettled?: (publicId: string) => void,
	): Record<string, unknown> {
		this.assertOpen();
		if (this.prune()) {
			this.persist();
		}
		const credentialHash = hash(credential);
		const publicId = `task_${randomUUID()}`;
		const id = hash(`POST /v1/tasks\0${credential}\0${key ?? publicId}`);
		const fingerprint = hash(canonicalJson(body));
		const existing = key === null ? undefined : this.records.get(id);
		if (existing) {
			this.checkFingerprint(existing, fingerprint);
			if (!existing.background || !existing.publicId) {
				throw new ApiError(409, "idempotency_key_reused", "This idempotency key belongs to a synchronous task");
			}
			if (existing.outcome === null && !this.inFlight.has(id)) {
				this.setOutcome(existing, unknownOutcome());
				this.persist();
			}
			return this.view(existing);
		}
		if (this.backgroundInFlight.size >= this.maxBackgroundInFlight) {
			throw new ApiError(
				503,
				"busy",
				`${this.maxBackgroundInFlight} background task operations are already running`,
				"Try again when a background task finishes.",
			);
		}
		const evicted = this.makeStorageRoom(credentialHash, key !== null);
		const created = {
			id,
			publicId,
			credential: credentialHash,
			fingerprint,
			background: true,
			keyed: key !== null,
			createdAt: this.now(),
			updatedAt: this.now(),
			outcome: null,
		} satisfies Operation;
		this.put(created);
		try {
			this.persist();
		} catch (error) {
			this.drop(created);
			for (const operation of evicted) {
				this.put(operation);
			}
			throw error;
		}
		const running = this.perform(created, operation);
		this.inFlight.set(id, running);
		this.backgroundInFlight.add(id);
		void running.catch(() => undefined).finally(() => {
			this.backgroundInFlight.delete(id);
			if (this.inFlight.get(id) === running) {
				this.inFlight.delete(id);
			}
			try {
				onSettled?.(publicId);
			} catch (error) {
				this.log(
					`Background task ${publicId} settle callback failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		return this.view(created);
	}

	get(credential: string, publicId: string): Record<string, unknown> | null {
		this.assertOpen();
		if (this.prune()) {
			this.persist();
		}
		if (!PUBLIC_TASK_ID_PATTERN.test(publicId)) {
			return null;
		}
		const credentialHash = hash(credential);
		const operation = Array.from(this.records.values()).find(
			(record) => record.publicId === publicId && record.credential === credentialHash,
		);
		if (!operation) {
			return null;
		}
		if (operation.outcome === null && !this.inFlight.has(operation.id)) {
			this.setOutcome(operation, unknownOutcome());
			this.persist();
		}
		return this.view(operation);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		let changed = false;
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				this.setOutcome(operation, unknownOutcome());
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

	private assertOpen(): void {
		if (this.closed) {
			throw new ApiError(503, "gateway_stopping", "The gateway is stopping");
		}
	}

	private makeStorageRoom(credentialHash: string, idempotency: boolean): Operation[] {
		const evicted: Operation[] = [];
		const samePool = (record: Operation) => holdsIdempotencyKey(record) === idempotency;
		let credentialOperations = 0;
		let poolOperations = 0;
		const poolCounts = new Map<string, number>();
		for (const record of this.records.values()) {
			if (samePool(record)) {
				poolOperations += 1;
				poolCounts.set(record.credential ?? "", (poolCounts.get(record.credential ?? "") ?? 0) + 1);
				if (record.credential === credentialHash) {
					credentialOperations += 1;
				}
			}
		}
		try {
			while (credentialOperations >= this.maxOperationsPerCredential) {
				const oldest = this.oldestSettled((record) => samePool(record) && record.credential === credentialHash);
				if (!oldest) {
					throw new ApiError(
						503,
						"idempotency_store_full",
						`This API credential already has ${this.maxOperationsPerCredential} task operations running`,
						"Retry when an operation finishes.",
					);
				}
				this.drop(oldest);
				evicted.push(oldest);
				credentialOperations -= 1;
				poolOperations -= 1;
			}
			while (poolOperations >= this.maxOperations) {
				const oldest = this.oldestOfHeaviest(
					(record) => samePool(record),
					(credential) => poolCounts.get(credential) ?? 0,
				);
				if (!oldest) {
					throw new ApiError(
						503,
						"idempotency_store_full",
						`The gateway already has ${this.maxOperations} task operations running`,
						"Retry when an operation finishes.",
					);
				}
				this.drop(oldest);
				evicted.push(oldest);
				poolOperations -= 1;
				poolCounts.set(oldest.credential ?? "", (poolCounts.get(oldest.credential ?? "") ?? 1) - 1);
			}
		} catch (error) {
			for (const operation of evicted) {
				this.put(operation);
			}
			throw error;
		}
		return evicted;
	}

	private oldestSettled(match: (operation: Operation) => boolean): Operation | undefined {
		let oldest: Operation | undefined;
		for (const operation of this.records.values()) {
			if (operation.outcome === null || !match(operation)) {
				continue;
			}
			if (!oldest || isOlder(operation, oldest)) {
				oldest = operation;
			}
		}
		return oldest;
	}

	/** Evicts settled records until the store fits its byte budget. The credential that holds the
	 * most bytes gives up its oldest settled record first, so one credential's large results never
	 * push out the records of a credential that stores less. */
	private enforceByteBudget(protectedId?: string): Operation[] {
		const evicted: Operation[] = [];
		while (this.totalBytes > this.maxStoreBytes) {
			const victim = this.oldestOfHeaviest(
				(record) => record.id !== protectedId,
				(credential) => this.credentialBytes.get(credential) ?? 0,
			);
			if (!victim) {
				break;
			}
			this.drop(victim);
			evicted.push(victim);
		}
		return evicted;
	}

	/** The oldest settled record of the credential with the largest `weight`, among records that
	 * `match`. Ties go to the oldest record overall. */
	private oldestOfHeaviest(
		match: (operation: Operation) => boolean,
		weight: (credential: string) => number,
	): Operation | undefined {
		let chosen: Operation | undefined;
		let chosenWeight = 0;
		for (const operation of this.records.values()) {
			if (operation.outcome === null || !match(operation)) {
				continue;
			}
			const candidateWeight = weight(operation.credential ?? "");
			if (!chosen || candidateWeight > chosenWeight || (candidateWeight === chosenWeight && isOlder(operation, chosen))) {
				chosen = operation;
				chosenWeight = candidateWeight;
			}
		}
		return chosen;
	}

	/** Every change to `records` goes through put/drop/setOutcome so the byte counts stay exact. */
	private put(operation: Operation): void {
		this.untrack(operation);
		this.records.set(operation.id, operation);
		this.track(operation);
	}

	private drop(operation: Operation): void {
		this.records.delete(operation.id);
		this.untrack(operation);
	}

	private setOutcome(operation: Operation, outcome: Outcome | null): void {
		const tracked = this.recordBytes.has(operation);
		if (tracked) {
			this.untrack(operation);
		}
		operation.outcome = outcome;
		operation.updatedAt = this.now();
		if (tracked) {
			this.track(operation);
		}
	}

	private track(operation: Operation): void {
		const bytes = operationFileBytes(operation);
		const owner = operation.credential ?? "";
		this.recordBytes.set(operation, bytes);
		this.totalBytes += bytes;
		this.credentialBytes.set(owner, (this.credentialBytes.get(owner) ?? 0) + bytes);
	}

	private untrack(operation: Operation): void {
		const bytes = this.recordBytes.get(operation);
		if (bytes === undefined) {
			return;
		}
		const owner = operation.credential ?? "";
		const remaining = (this.credentialBytes.get(owner) ?? 0) - bytes;
		this.recordBytes.delete(operation);
		this.totalBytes -= bytes;
		if (remaining > 0) {
			this.credentialBytes.set(owner, remaining);
		} else {
			this.credentialBytes.delete(owner);
		}
	}

	private checkFingerprint(operation: Operation, fingerprint: string): void {
		if (operation.fingerprint !== fingerprint) {
			throw new ApiError(
				409,
				"idempotency_key_reused",
				"This idempotency key was already used with a different task request",
				"Use a new key for different work, or the original request body to retrieve its outcome.",
			);
		}
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
		this.setOutcome(operation, retryable && !operation.background ? null : this.retainedOutcome(outcome, operation.background));
		if (!this.closed && this.records.get(operation.id) === operation) {
			let evicted: Operation[] = [];
			try {
				if (retryable) {
					if (operation.background) {
						evicted = this.releaseBackgroundKey(operation);
					} else {
						this.drop(operation);
					}
				}
				evicted = evicted.concat(this.enforceByteBudget(operation.id));
				this.persist();
			} catch {
				for (const settled of evicted) {
					this.put(settled);
				}
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				this.put(operation);
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

	/** The record leaves the keyed pool for the unkeyed one, so it needs room there first. */
	private releaseBackgroundKey(operation: Operation): Operation[] {
		if (!operation.keyed || !operation.publicId) {
			return [];
		}
		let evicted: Operation[] = [];
		try {
			evicted = this.makeStorageRoom(operation.credential ?? "", false);
		} catch (error) {
			// Every unkeyed record is still running, so none can go. Free the key all the same: failing
			// here would hide this task's own error. The pool stays over its limit until a running task
			// finishes and a later unkeyed submission trims it, and each release in that state adds a
			// record. The default limits keep this from happening: at most 63 other background tasks
			// run, against a per-credential limit of 100.
			if (!(error instanceof ApiError && error.code === "idempotency_store_full")) {
				throw error;
			}
		}
		this.drop(operation);
		operation.id = hash(`background task\0${operation.publicId}`);
		operation.keyed = false;
		this.put(operation);
		return evicted;
	}

	private retainedOutcome(outcome: Outcome, background: boolean): Outcome {
		const limit = background ? MAX_BACKGROUND_TASK_OUTCOME_BYTES : MAX_TASK_OUTCOME_BYTES;
		let bytes: number;
		try {
			bytes = Buffer.byteLength(JSON.stringify(outcome, null, 2), "utf8");
		} catch {
			bytes = Number.POSITIVE_INFINITY;
		}
		if (bytes <= limit) {
			return outcome;
		}
		return {
			kind: "error",
			status: 409,
			code: "outcome_not_retained",
			message: "The task finished, but its outcome was too large to retain",
			description: background
				? `Background tasks have no attached synchronous caller. Stored background outcomes are limited to ${limit} bytes; check the remote agent before submitting new work.`
				: `Synchronous callers attached to this run received its actual outcome. Stored outcomes are limited to ${limit} bytes; check the remote agent before submitting new work with a different key.`,
		};
	}

	private view(operation: Operation): Record<string, unknown> {
		const outcome = operation.outcome;
		const view: Record<string, unknown> = {
			id: operation.publicId,
			status: outcome === null ? "running" : outcome.kind === "success" ? "completed" : "failed",
			createdAt: new Date(operation.createdAt).toISOString(),
			updatedAt: new Date(operation.updatedAt).toISOString(),
		};
		if (outcome?.kind === "success") {
			view.result = outcome.body;
		}
		if (outcome?.kind === "error") {
			view.error = {
				code: outcome.code,
				message: outcome.message,
				...(outcome.description ? { description: outcome.description } : {}),
			};
		}
		return view;
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
		for (const operation of this.records.values()) {
			if (operation.updatedAt <= cutoff) {
				this.drop(operation);
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
