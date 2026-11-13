import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../../test/helpers.js";
import { gatewayTaskOperationsPath, writePrivateJson, writePrivateText } from "../paths.js";
import { ApiError } from "./http.js";
import {
	MAX_BACKGROUND_TASK_OUTCOME_BYTES,
	MAX_IDEMPOTENCY_KEY_CHARS,
	MAX_TASK_OUTCOME_BYTES,
	parseIdempotencyKey,
	TASK_IDEMPOTENCY_RETENTION_MS,
	TaskOperationStore,
} from "./idempotency.js";

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("parseIdempotencyKey", () => {
	it("accepts a visible ASCII key and rejects missing, empty, long or whitespace keys", () => {
		expect(parseIdempotencyKey(undefined)).toBeNull();
		expect(parseIdempotencyKey("request-123:_~")).toBe("request-123:_~");
		for (const value of ["", "has space", "x".repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1)]) {
			expect(() => parseIdempotencyKey(value)).toThrowError(
				expect.objectContaining({ status: 400, code: "invalid_idempotency_key" }),
			);
		}
	});
});

describe("TaskOperationStore", () => {
	it("shares concurrent work and replays a canonically identical completed request", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed", output: { run: runs } };
		};
		const first = store.execute("credential-a", "key-1", { b: 2, a: 1 }, operation);
		const second = store.execute("credential-a", "key-1", { a: 1, b: 2 }, operation);
		expect(runs).toBe(1);
		release?.();
		await expect(first).resolves.toEqual({ status: "completed", output: { run: 1 } });
		await expect(second).resolves.toEqual({ status: "completed", output: { run: 1 } });
		await expect(store.execute("credential-a", "key-1", { a: 1, b: 2 }, operation)).resolves.toEqual({
			status: "completed",
			output: { run: 1 },
		});
		expect(runs).toBe(1);
		await expect(store.execute("credential-a", "key-1", { a: 1, b: 3 }, operation)).rejects.toMatchObject({
			status: 409,
			code: "idempotency_key_reused",
		});
		expect(runs).toBe(1);
	});

	it("replays a public task failure without executing again", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			throw new ApiError(502, "task_failed", "The peer reported failure", "Try again later.");
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(store.execute("credential-a", "key-1", {}, operation)).rejects.toMatchObject({
				status: 502,
				code: "task_failed",
				message: "The peer reported failure",
				description: "Try again later.",
			});
		}
		expect(runs).toBe(1);
	});

	it("scopes a key to its credential", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await expect(store.execute("credential-a", "shared-key", {}, operation)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-b", "shared-key", {}, operation)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
	});

	it("restores completed outcomes and makes unresolved work explicitly unknown", async () => {
		const completed = new TaskOperationStore("test");
		await completed.execute("credential-a", "completed", {}, async () => ({ status: "completed", output: { ok: true } }));
		completed.close();
		const restored = new TaskOperationStore("test");
		await expect(
			restored.execute("credential-a", "completed", {}, async () => {
				throw new Error("must not execute");
			}),
		).resolves.toEqual({ status: "completed", output: { ok: true } });

		let release: (() => void) | undefined;
		const pending = restored.execute("credential-a", "pending", {}, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed" };
		});
		restored.close();
		const restarted = new TaskOperationStore("test");
		await expect(restarted.execute("credential-a", "pending", {}, async () => ({ rerun: true }))).rejects.toMatchObject({
			status: 409,
			code: "result_unknown",
		});
		release?.();
		await expect(pending).resolves.toEqual({ status: "completed" });
		restarted.close();
	});

	it("keeps waiting request correlation across store reconstruction and shutdown", async () => {
		const store = new TaskOperationStore("test");
		let release: (() => void) | undefined;
		store.submit("credential-a", "waiting", {}, async (operationId: string) => {
			const base = {
				key: operationId,
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.waiting",
				deadlineAt: Date.now() + 60_000,
			};
			store.save({ ...base, phase: "publishing" });
			store.save({ ...base, phase: "waiting" });
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed" };
		});
		store.close();

		const restarted = new TaskOperationStore("test");
		expect(restarted.list()).toEqual([
			expect.objectContaining({
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.waiting",
				phase: "waiting",
			}),
		]);
		restarted.close();
		const third = new TaskOperationStore("test");
		expect(third.list()).toEqual([expect.objectContaining({ taskId: "agx-task-1", phase: "waiting" })]);
		release?.();
		third.close();
	});

	it("rejects correlation changes and a waiting-to-publishing regression", async () => {
		const store = new TaskOperationStore("test");
		await store.execute("credential-a", "guarded", {}, async (operationId: string) => {
			const base = {
				key: operationId,
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.guarded",
				deadlineAt: Date.now() + 60_000,
			};
			store.save({ ...base, phase: "publishing" });
			for (const changed of [
				{ taskId: "agx-task-2" },
				{ peer: "b".repeat(64) },
				{ capability: "invoice.other" },
				{ deadlineAt: base.deadlineAt + 1 },
			]) {
				expect(() => store.save({ ...base, ...changed, phase: "waiting" })).toThrow(/correlation/i);
			}
			store.save({ ...base, phase: "waiting" });
			expect(() => store.save({ ...base, phase: "publishing" })).toThrow(/phase|publishing/i);
			return { status: "completed" };
		});
		store.close();
	});

	it("writes a file an older gateway still reads, so it degrades waiting work to result_unknown", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		await store.execute("credential-a", "done", {}, async () => ({ run: ++runs }));
		const background = store.submit("credential-a", null, {}, async (operationId: string) => {
			const base = {
				key: operationId,
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.waiting",
				deadlineAt: Date.now() + 60_000,
			};
			store.save({ ...base, phase: "publishing" });
			store.save({ ...base, phase: "waiting" });
			return new Promise<Record<string, unknown>>(() => undefined);
		});
		store.close();
		const path = gatewayTaskOperationsPath("test");
		const file = JSON.parse(readFileSync(path, "utf8")) as { version: number; operations: Array<Record<string, unknown>> };
		// Gateways before durable correlation accept only version 1 and quarantine
		// anything else, which would forget completed keys and run them again.
		expect(file.version).toBe(1);
		expect(file.operations.some((operation) => operation.request)).toBe(true);

		// Such a gateway drops the unknown request block when it reads and rewrites the file.
		for (const operation of file.operations) delete operation.request;
		writeFileSync(path, JSON.stringify(file));
		const older = new TaskOperationStore("test");
		expect(existsSync(`${path}.corrupt`)).toBe(false);
		expect(older.list()).toEqual([]);
		await expect(older.execute("credential-a", "done", {}, async () => ({ run: ++runs }))).resolves.toEqual({ run: 1 });
		expect(runs).toBe(1);
		expect(older.get("credential-a", background.id as string)).toMatchObject({
			status: "failed",
			error: { code: "result_unknown" },
		});
		older.close();
	});

	it("loads stored waiting work over every operation limit without throwing or dropping it", async () => {
		const store = new TaskOperationStore("test");
		const keys: string[] = [];
		for (let index = 0; index < 4; index++) {
			store.submit("credential-a", `waiting-${index}`, {}, async (operationId: string) => {
				keys.push(operationId);
				const base = {
					key: operationId,
					taskId: `agx-task-${index}`,
					peer: "a".repeat(64),
					capability: "invoice.waiting",
					deadlineAt: Date.now() + 60_000,
				};
				store.save({ ...base, phase: "publishing" });
				store.save({ ...base, phase: "waiting" });
				return new Promise<Record<string, unknown>>(() => undefined);
			});
		}
		store.close();
		// Limits lowered since the work was admitted. Recoverable work is never trimmed,
		// and restore must not throw: the gateway would then fail on every start.
		const restarted = new TaskOperationStore("test", {
			maxOperationsPerCredential: 3,
			maxOperations: 3,
			maxInFlight: 1,
			maxBackgroundInFlight: 1,
		});
		expect(restarted.list().map((record) => record.key).sort()).toEqual([...keys].sort());
		restarted.close();
	});

	it("refuses to remove waiting correlation once closed, so a restart can still recover it", async () => {
		const store = new TaskOperationStore("test");
		let operationKey = "";
		store.submit("credential-a", "waiting", {}, async (operationId: string) => {
			operationKey = operationId;
			const base = {
				key: operationId,
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.waiting",
				deadlineAt: Date.now() + 60_000,
			};
			store.save({ ...base, phase: "publishing" });
			store.save({ ...base, phase: "waiting" });
			return new Promise<Record<string, unknown>>(() => undefined);
		});
		store.close();
		expect(() => store.remove(operationKey)).toThrow(/stopping/);
		const restarted = new TaskOperationStore("test");
		expect(restarted.list()).toEqual([expect.objectContaining({ key: operationKey, phase: "waiting" })]);
		restarted.close();
	});

	it("rejects correlation the reader would refuse before writing it", async () => {
		const logs: string[] = [];
		const store = new TaskOperationStore("test", { log: (line) => logs.push(line) });
		await store.execute("credential-a", "invalid", {}, async (operationId: string) => {
			const base = {
				key: operationId,
				taskId: "agx-task-1",
				peer: "a".repeat(64),
				capability: "invoice.invalid",
				deadlineAt: Date.now() + 60_000,
				phase: "publishing" as const,
			};
			for (const invalid of [
				{ peer: "A".repeat(64) },
				{ capability: "x".repeat(201) },
				{ taskId: "" },
				{ deadlineAt: -1 },
			]) {
				expect(() => store.save({ ...base, ...invalid })).toThrow(/correlation/i);
			}
			return { status: "completed" };
		});
		store.close();
		const restarted = new TaskOperationStore("test", { log: (line) => logs.push(line) });
		expect(logs).toEqual([]);
		expect(existsSync(`${gatewayTaskOperationsPath("test")}.corrupt`)).toBe(false);
		restarted.close();
	});

	it("retries failures that prove no task was published", async () => {
		const store = new TaskOperationStore("test");
		const failures = [
			[400, "invalid_request"],
			[400, "invalid_peer"],
			[413, "payload_too_large"],
			[503, "relays_unreachable"],
			[404, "no_card"],
			[422, "capability_not_advertised"],
		] as const;
		for (const [status, code] of failures) {
			let runs = 0;
			const operation = async (): Promise<Record<string, unknown>> => {
				runs += 1;
				throw new ApiError(status, code, "Try again");
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(store.execute("credential-a", code, {}, operation)).rejects.toMatchObject({ status, code });
			}
			expect(runs).toBe(2);
		}
		store.close();
	});

	it("retains publish failures because a relay may have stored the task", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			throw new ApiError(502, "publish_failed", "Relay delivery is uncertain");
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(store.execute("credential-a", "publish", {}, operation)).rejects.toMatchObject({
				status: 502,
				code: "publish_failed",
			});
		}
		expect(runs).toBe(1);
		store.close();
	});

	it("retains timeouts because remote execution is uncertain", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			throw new ApiError(504, "timeout", "No result arrived");
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(store.execute("credential-a", "timeout", {}, operation)).rejects.toMatchObject({
				status: 504,
				code: "timeout",
			});
		}
		expect(runs).toBe(1);
		store.close();
	});

	it("returns an oversized outcome once and retains an explicit marker", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const output = { large: "x".repeat(MAX_TASK_OUTCOME_BYTES) };
		const operation = async () => ({ status: "completed", output, run: ++runs });
		await expect(store.execute("credential-a", "large", {}, operation)).resolves.toEqual({
			status: "completed",
			output,
			run: 1,
		});
		await expect(store.execute("credential-a", "large", {}, operation)).rejects.toMatchObject({
			status: 409,
			code: "outcome_not_retained",
		});
		expect(runs).toBe(1);
		store.close();

		const restored = new TaskOperationStore("test");
		await expect(restored.execute("credential-a", "large", {}, operation)).rejects.toMatchObject({
			status: 409,
			code: "outcome_not_retained",
		});
		expect(runs).toBe(1);
		expect(Buffer.byteLength(readFileSync(gatewayTaskOperationsPath("test"), "utf8"))).toBeLessThan(
			MAX_TASK_OUTCOME_BYTES * 2,
		);
		restored.close();
	});

	it("evicts the oldest settled outcome instead of imposing a daily submission cap", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 1 });
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await expect(store.execute("credential-a", "first", {}, operation)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-a", "second", {}, operation)).resolves.toEqual({ run: 2 });
		await expect(store.execute("credential-a", "first", {}, operation)).resolves.toEqual({ run: 3 });
		await expect(store.execute("credential-b", "first", {}, operation)).resolves.toEqual({ run: 4 });
		store.close();
	});

	it("keeps running operations when retained capacity is full", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 1 });
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		};
		const first = store.execute("credential-a", "first", {}, operation);
		await expect(store.execute("credential-a", "second", {}, operation)).rejects.toMatchObject({
			status: 503,
			code: "idempotency_store_full",
		});
		const joined = store.execute("credential-a", "first", {}, operation);
		release?.();
		await expect(first).resolves.toEqual({ run: 1 });
		await expect(joined).resolves.toEqual({ run: 1 });
		expect(runs).toBe(1);
		store.close();
	});

	it("limits running keyed operations even after their callers leave", async () => {
		const store = new TaskOperationStore("test", { maxInFlight: 1 });
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		};
		const first = store.execute("credential-a", "first", {}, operation);
		await expect(store.execute("credential-a", "second", {}, operation)).rejects.toMatchObject({
			status: 503,
			code: "busy",
		});
		const joined = store.execute("credential-a", "first", {}, operation);
		release?.();
		await expect(first).resolves.toEqual({ run: 1 });
		await expect(joined).resolves.toEqual({ run: 1 });
		const second = store.execute("credential-a", "second", {}, operation);
		release?.();
		await expect(second).resolves.toEqual({ run: 2 });
		store.close();
	});

	it("restores operations written before per-credential quotas", async () => {
		const written = new TaskOperationStore("test");
		await written.execute("credential-a", "legacy", {}, async () => ({ run: 1 }));
		written.close();
		const path = gatewayTaskOperationsPath("test");
		const raw = JSON.parse(readFileSync(path, "utf8")) as { operations: Record<string, unknown>[] };
		delete raw.operations[0]!.credential;
		writePrivateJson(path, raw);

		const restored = new TaskOperationStore("test");
		let runs = 0;
		await expect(restored.execute("credential-a", "legacy", {}, async () => ({ run: ++runs + 1 }))).resolves.toEqual({
			run: 1,
		});
		expect(runs).toBe(0);
		restored.close();
	});

	it("quarantines unreadable stores and starts with an empty one", async () => {
		for (const profile of ["broken-json", "broken-schema"]) {
			const path = gatewayTaskOperationsPath(profile);
			if (profile === "broken-json") {
				writePrivateText(path, "{not json");
			} else {
				writePrivateJson(path, { version: 1, operations: [{ invalid: true }] });
			}
			const lines: string[] = [];
			const store = new TaskOperationStore(profile, { log: (line) => lines.push(line) });
			expect(existsSync(path)).toBe(false);
			expect(existsSync(`${path}.corrupt`)).toBe(true);
			expect(lines.join("\n")).toContain(`${path}.corrupt`);
			await expect(store.execute("credential-a", "after-recovery", {}, async () => ({ ok: true }))).resolves.toEqual({
				ok: true,
			});
			store.close();
		}
	});

	it("expires retained outcomes", async () => {
		let now = 1_000_000;
		const store = new TaskOperationStore("test", {
			now: () => now,
			retentionMs: TASK_IDEMPOTENCY_RETENTION_MS,
		});
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await store.execute("credential-a", "key-1", {}, operation);
		now += TASK_IDEMPOTENCY_RETENTION_MS + 1;
		await expect(store.execute("credential-a", "key-1", {}, operation)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
		store.close();
	});
});

async function waitForStatus(
	store: TaskOperationStore,
	credential: string,
	id: string,
	status: string,
): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const view = store.get(credential, id);
		if (view?.status === status) {
			return view;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Task ${id} did not reach ${status}`);
}

describe("TaskOperationStore background tasks", () => {
	it("returns a handle before completion and restores the result only for its credential", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		let release: (() => void) | undefined;
		const accepted = store.submit("credential-a", null, { background: true }, async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed", output: { run: runs } };
		});
		const id = accepted.id as string;
		expect(accepted).toMatchObject({ id, status: "running" });
		expect(id).toMatch(/^task_[0-9a-f-]{36}$/);
		expect(runs).toBe(1);
		expect(store.get("credential-a", id)).toMatchObject({ id, status: "running" });
		expect(store.get("credential-b", id)).toBeNull();

		release?.();
		const completed = await waitForStatus(store, "credential-a", id, "completed");
		expect(completed).toMatchObject({
			id,
			result: { status: "completed", output: { run: 1 } },
		});
		store.close();
		const restored = new TaskOperationStore("test");
		expect(restored.get("credential-a", id)).toEqual(completed);
		expect(restored.get("credential-b", id)).toBeNull();
		restored.close();
	});

	it("shares idempotent background submissions without executing again", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed", output: { run: runs } };
		};
		const first = store.submit("credential-a", "background-1", { background: true, a: 1 }, operation);
		const concurrent = store.submit("credential-a", "background-1", { a: 1, background: true }, operation);
		expect(concurrent).toMatchObject({ id: first.id, status: "running" });
		expect(runs).toBe(1);
		expect(() => store.submit("credential-a", "background-1", { background: true, a: 2 }, operation)).toThrowError(
			expect.objectContaining({ status: 409, code: "idempotency_key_reused" }),
		);
		release?.();
		const completed = await waitForStatus(store, "credential-a", first.id as string, "completed");
		expect(store.submit("credential-a", "background-1", { background: true, a: 1 }, operation)).toEqual(completed);
		expect(runs).toBe(1);
		store.close();
	});

	it("retains failures and marks interrupted background work unknown after restart", async () => {
		const store = new TaskOperationStore("test");
		const failed = store.submit("credential-a", null, { background: true }, async (): Promise<Record<string, unknown>> => {
			throw new ApiError(502, "task_failed", "The peer reported failure", "Try again later.");
		});
		const failure = await waitForStatus(store, "credential-a", failed.id as string, "failed");
		expect(failure).toMatchObject({
			status: "failed",
			error: { code: "task_failed", message: "The peer reported failure", description: "Try again later." },
		});
		store.close();
		const restored = new TaskOperationStore("test");
		expect(restored.get("credential-a", failed.id as string)).toEqual(failure);

		let release: (() => void) | undefined;
		const pending = restored.submit("credential-a", null, { background: true }, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed" };
		});
		restored.close();
		const restarted = new TaskOperationStore("test");
		expect(restarted.get("credential-a", pending.id as string)).toMatchObject({
			status: "failed",
			error: { code: "result_unknown" },
		});
		release?.();
		restarted.close();
	});

	it("keeps a failed public ID while freeing its key after a pre-publish failure", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			if (runs === 1) {
				throw new ApiError(404, "no_card", "No Agent Card was found");
			}
			return { status: "completed", output: { run: runs } };
		};
		const first = store.submit("credential-a", "background-retry", { background: true }, operation);
		const failure = await waitForStatus(store, "credential-a", first.id as string, "failed");
		expect(failure).toMatchObject({ error: { code: "no_card", message: "No Agent Card was found" } });

		const second = store.submit("credential-a", "background-retry", { background: true }, operation);
		expect(second.id).not.toBe(first.id);
		await expect(waitForStatus(store, "credential-a", second.id as string, "completed")).resolves.toMatchObject({
			result: { status: "completed", output: { run: 2 } },
		});
		expect(store.get("credential-a", first.id as string)).toEqual(failure);
		expect(runs).toBe(2);
		store.close();
	});

	it("does not free a background key after an uncertain publish failure", async () => {
		const store = new TaskOperationStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			throw new ApiError(502, "publish_failed", "Relay delivery is uncertain");
		};
		const first = store.submit("credential-a", "background-publish", { background: true }, operation);
		const failure = await waitForStatus(store, "credential-a", first.id as string, "failed");
		expect(failure).toMatchObject({ error: { code: "publish_failed" } });
		expect(store.submit("credential-a", "background-publish", { background: true }, operation)).toEqual(failure);
		expect(runs).toBe(1);
		store.close();
	});

	it("evicts settled background outcomes instead of imposing a daily submission cap", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 1 });
		const first = store.submit("credential-a", null, { background: true }, async () => ({ owner: "a" }));
		await waitForStatus(store, "credential-a", first.id as string, "completed");
		const second = store.submit("credential-a", null, { background: true }, async () => ({ owner: "a" }));
		await waitForStatus(store, "credential-a", second.id as string, "completed");
		expect(store.get("credential-a", first.id as string)).toBeNull();

		const other = store.submit("credential-b", null, { background: true }, async () => ({ owner: "b" }));
		await expect(waitForStatus(store, "credential-b", other.id as string, "completed")).resolves.toMatchObject({
			result: { owner: "b" },
		});
		store.close();
	});

	it("limits running background tasks independently of retained outcomes", async () => {
		const store = new TaskOperationStore("test", { maxBackgroundInFlight: 1 });
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { run: runs };
		};
		const first = store.submit("credential-a", "background-first", { background: true }, operation);
		expect(store.submit("credential-a", "background-first", { background: true }, operation)).toMatchObject({
			id: first.id,
			status: "running",
		});
		expect(() => store.submit("credential-a", "background-second", { background: true }, operation)).toThrowError(
			expect.objectContaining({ status: 503, code: "busy" }),
		);
		release?.();
		await waitForStatus(store, "credential-a", first.id as string, "completed");
		const second = store.submit("credential-a", "background-second", { background: true }, operation);
		release?.();
		await expect(waitForStatus(store, "credential-a", second.id as string, "completed")).resolves.toMatchObject({
			result: { run: 2 },
		});
		store.close();
	});

	it("retains background outcomes larger than the synchronous limit", async () => {
		const store = new TaskOperationStore("test");
		const output = { large: "x".repeat(MAX_TASK_OUTCOME_BYTES) };
		const accepted = store.submit("credential-a", null, { background: true }, async () => ({
			status: "completed",
			output,
		}));
		const completed = await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		expect(completed).toMatchObject({ result: { status: "completed", output } });
		store.close();

		const restored = new TaskOperationStore("test");
		expect(restored.get("credential-a", accepted.id as string)).toEqual(completed);
		restored.close();
	});

	it("retains an explicit marker for an outcome over the background limit", async () => {
		const store = new TaskOperationStore("test");
		const accepted = store.submit("credential-a", null, { background: true }, async () => ({
			status: "completed",
			output: { large: "x".repeat(MAX_BACKGROUND_TASK_OUTCOME_BYTES) },
		}));
		const failed = await waitForStatus(store, "credential-a", accepted.id as string, "failed");
		expect(failed).toMatchObject({ error: { code: "outcome_not_retained" } });
		expect(Buffer.byteLength(readFileSync(gatewayTaskOperationsPath("test"), "utf8"))).toBeLessThan(
			MAX_BACKGROUND_TASK_OUTCOME_BYTES * 2,
		);
		store.close();

		const restored = new TaskOperationStore("test");
		expect(restored.get("credential-a", accepted.id as string)).toEqual(failed);
		restored.close();
	});

	it("evicts old settled outcomes to bound the total store size", async () => {
		const store = new TaskOperationStore("test", { maxStoreBytes: 4096 });
		const first = store.submit("credential-a", null, { background: true }, async () => ({
			output: "x".repeat(2000),
		}));
		await waitForStatus(store, "credential-a", first.id as string, "completed");
		const second = store.submit("credential-a", null, { background: true }, async () => ({
			output: "y".repeat(2000),
		}));
		await waitForStatus(store, "credential-a", second.id as string, "completed");
		expect(store.get("credential-a", first.id as string)).toBeNull();
		expect(store.get("credential-a", second.id as string)).toMatchObject({ status: "completed" });
		expect(Buffer.byteLength(readFileSync(gatewayTaskOperationsPath("test"), "utf8"))).toBeLessThanOrEqual(4097);
		store.close();
	});
});

describe("TaskOperationStore storage fairness", () => {
	it("evicts the credential holding the most bytes, not another credential's records", async () => {
		let clock = 1_000;
		const store = new TaskOperationStore("test", { maxStoreBytes: 9_000, now: () => (clock += 1) });
		let runs = 0;
		const small = async () => ({ run: ++runs });
		await store.execute("credential-b", "keyed", {}, small);
		const bystander = store.submit("credential-b", null, { background: true }, async () => ({ owner: "b" }));
		await waitForStatus(store, "credential-b", bystander.id as string, "completed");

		const heavy: string[] = [];
		for (let index = 0; index < 6; index++) {
			const accepted = store.submit("credential-a", null, { background: true }, async () => ({
				output: "x".repeat(3000),
			}));
			heavy.push(accepted.id as string);
			await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		}

		expect(store.get("credential-b", bystander.id as string)).toMatchObject({ status: "completed" });
		await expect(store.execute("credential-b", "keyed", {}, small)).resolves.toEqual({ run: 1 });
		expect(runs).toBe(1);
		expect(store.get("credential-a", heavy[0] as string)).toBeNull();
		expect(store.get("credential-a", heavy[5] as string)).toMatchObject({ status: "completed" });
		store.close();
	});

	it("evicts from the credential holding the most records when the profile cap is reached", async () => {
		let clock = 1_000;
		const store = new TaskOperationStore("test", { maxOperations: 4, now: () => (clock += 1) });
		let runs = 0;
		const work = async () => ({ run: ++runs });
		await store.execute("credential-b", "keyed", {}, work);
		for (const key of ["one", "two", "three"]) {
			await store.execute("credential-a", key, {}, work);
		}
		await store.execute("credential-a", "four", {}, work);
		expect(runs).toBe(5);

		await expect(store.execute("credential-b", "keyed", {}, work)).resolves.toEqual({ run: 1 });
		expect(runs).toBe(5);
		await store.execute("credential-a", "one", {}, work);
		expect(runs).toBe(6);
		store.close();
	});

	it("keeps the byte counts exact across failed writes and key release", async () => {
		const path = gatewayTaskOperationsPath("test");
		const store = new TaskOperationStore("test");
		const work = async () => ({ output: "x".repeat(500) });
		await store.execute("credential-a", "first", {}, work);
		const done = store.submit("credential-b", null, { background: true }, work);
		await waitForStatus(store, "credential-b", done.id as string, "completed");

		rmSync(path, { force: true });
		mkdirSync(path);
		writeFileSync(join(path, "keep"), "blocks the final rename");
		await expect(store.execute("credential-a", "second", {}, work)).rejects.toThrow();
		expect(() => store.submit("credential-a", "third", { background: true }, work)).toThrow();
		rmSync(path, { recursive: true });

		const retry = store.submit("credential-a", "retry", { background: true }, async () => {
			throw new ApiError(400, "invalid_request", "bad request");
		});
		await waitForStatus(store, "credential-a", retry.id as string, "failed");
		await store.execute("credential-b", "last", {}, work);

		const live = store as unknown as { totalBytes: number; credentialBytes: Map<string, number> };
		const reloaded = new TaskOperationStore("test");
		const fresh = reloaded as unknown as { totalBytes: number; credentialBytes: Map<string, number> };
		expect(live.totalBytes).toBe(fresh.totalBytes);
		expect([...live.credentialBytes].sort()).toEqual([...fresh.credentialBytes].sort());
		expect(live.totalBytes).toBeGreaterThanOrEqual(Buffer.byteLength(readFileSync(path, "utf8")));
		reloaded.close();
		store.close();
	});

	it("tracks stored bytes instead of re-serializing the whole store for each eviction", async () => {
		const store = new TaskOperationStore("test", { maxStoreBytes: 60_000 });
		for (let index = 0; index < 30; index++) {
			const accepted = store.submit("credential-a", null, { background: true }, async () => ({
				output: "x".repeat(1500),
			}));
			await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		}
		const stringify = vi.spyOn(JSON, "stringify");
		let wholeStoreCalls = 0;
		try {
			const big = store.submit("credential-a", null, { background: true }, async () => ({
				output: "y".repeat(40_000),
			}));
			await waitForStatus(store, "credential-a", big.id as string, "completed");
			wholeStoreCalls = stringify.mock.calls.filter(
				([value]) => typeof value === "object" && value !== null && "operations" in value,
			).length;
		} finally {
			stringify.mockRestore();
		}
		expect(wholeStoreCalls).toBeLessThanOrEqual(3);
		expect(Buffer.byteLength(readFileSync(gatewayTaskOperationsPath("test"), "utf8"))).toBeLessThanOrEqual(60_000);
		store.close();
	});

	it("keeps unkeyed background results out of the idempotency pool", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 2 });
		let runs = 0;
		const keyed = async () => ({ run: ++runs });
		await store.execute("credential-a", "one", {}, keyed);
		await store.execute("credential-a", "two", {}, keyed);
		const results: string[] = [];
		for (let index = 0; index < 5; index++) {
			const accepted = store.submit("credential-a", null, { background: true }, async () => ({ index }));
			results.push(accepted.id as string);
			await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		}
		await expect(store.execute("credential-a", "one", {}, keyed)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-a", "two", {}, keyed)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
		expect(store.get("credential-a", results[0] as string)).toBeNull();
		expect(store.get("credential-a", results[4] as string)).toMatchObject({ status: "completed" });
		store.close();
	});

	it("does not let running unkeyed background tasks block keyed requests", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 1 });
		let release: (() => void) | undefined;
		store.submit("credential-a", null, { background: true }, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return {};
		});
		await expect(store.execute("credential-a", "key", {}, async () => ({ ok: true }))).resolves.toEqual({
			ok: true,
		});
		release?.();
		store.close();
	});

	// A keyed background task that fails before anything is published frees its key and keeps its
	// record as an unkeyed one. That record joins the unkeyed pool, so it has to fit that pool's limits.
	const releasedByNoCard = async (): Promise<Record<string, unknown>> => {
		throw new ApiError(404, "no_card", "No Agent Card was found");
	};

	it("keeps a released background key's record within the per-credential limit of unkeyed results", async () => {
		let clock = 0;
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 2, now: () => (clock += 1) });
		const unkeyed: string[] = [];
		for (let index = 0; index < 2; index++) {
			const accepted = store.submit("credential-a", null, { background: true }, async () => ({ index }));
			unkeyed.push(accepted.id as string);
			await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		}
		const released = store.submit("credential-a", "released", { background: true }, releasedByNoCard);
		await waitForStatus(store, "credential-a", released.id as string, "failed");

		const kept = [...unkeyed, released.id as string].filter((id) => store.get("credential-a", id) !== null);
		expect(kept).toEqual([unkeyed[1], released.id]);
		store.close();
	});

	it("keeps a released background key's record within the store-wide limit of unkeyed results", async () => {
		let clock = 0;
		const store = new TaskOperationStore("test", { maxOperations: 2, now: () => (clock += 1) });
		const unkeyed: string[] = [];
		for (const credential of ["credential-a", "credential-b"]) {
			const accepted = store.submit(credential, null, { background: true }, async () => ({ credential }));
			unkeyed.push(accepted.id as string);
			await waitForStatus(store, credential, accepted.id as string, "completed");
		}
		const released = store.submit("credential-c", "released", { background: true }, releasedByNoCard);
		await waitForStatus(store, "credential-c", released.id as string, "failed");

		expect(store.get("credential-a", unkeyed[0] as string)).toBeNull();
		expect(store.get("credential-b", unkeyed[1] as string)).toMatchObject({ status: "completed" });
		expect(store.get("credential-c", released.id as string)).toMatchObject({ status: "failed" });
		store.close();
	});

	it("puts back the unkeyed result it made room by evicting when the released record cannot be saved", async () => {
		const path = gatewayTaskOperationsPath("test");
		let clock = 0;
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 2, now: () => (clock += 1) });
		const unkeyed: string[] = [];
		for (let index = 0; index < 2; index++) {
			const accepted = store.submit("credential-a", null, { background: true }, async () => ({ index }));
			unkeyed.push(accepted.id as string);
			await waitForStatus(store, "credential-a", accepted.id as string, "completed");
		}
		let fail: () => void = () => undefined;
		const released = store.submit(
			"credential-a",
			"released",
			{ background: true },
			() =>
				new Promise<Record<string, unknown>>((_resolve, reject) => {
					fail = () => reject(new ApiError(404, "no_card", "No Agent Card was found"));
				}),
		);
		rmSync(path, { force: true });
		mkdirSync(path);
		writeFileSync(join(path, "keep"), "blocks the final rename");
		fail();

		await waitForStatus(store, "credential-a", released.id as string, "failed");
		expect(store.get("credential-a", released.id as string)).toMatchObject({ error: { code: "result_unknown" } });
		// The disk still holds the evicted result, so memory gets it back. The released record keeps its
		// new place, so for now the pool is one over its limit; the next unkeyed submission trims it.
		expect(store.get("credential-a", unkeyed[0] as string)).toMatchObject({ status: "completed" });
		rmSync(path, { recursive: true });
		store.close();
	});

	it("keeps the unkeyed pool within its limit when the same key is released again and again", async () => {
		let clock = 0;
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 2, now: () => (clock += 1) });
		const ids: string[] = [];
		for (let round = 0; round < 5; round++) {
			const released = store.submit("credential-a", "released", { background: true }, releasedByNoCard);
			ids.push(released.id as string);
			await waitForStatus(store, "credential-a", released.id as string, "failed");
		}

		expect(ids.filter((id) => store.get("credential-a", id) !== null)).toEqual(ids.slice(-2));
		store.close();
	});

	it("still frees the key of a task that failed before publishing when every unkeyed result is still running", async () => {
		const store = new TaskOperationStore("test", { maxOperationsPerCredential: 1 });
		let finish: () => void = () => undefined;
		store.submit(
			"credential-a",
			null,
			{ background: true },
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					finish = () => resolve({});
				}),
		);
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			if (runs === 1) {
				throw new ApiError(404, "no_card", "No Agent Card was found");
			}
			return { status: "completed", output: { run: runs } };
		};
		const first = store.submit("credential-a", "released", { background: true }, operation);
		await expect(waitForStatus(store, "credential-a", first.id as string, "failed")).resolves.toMatchObject({
			error: { code: "no_card" },
		});

		const second = store.submit("credential-a", "released", { background: true }, operation);
		expect(second.id).not.toBe(first.id);
		await waitForStatus(store, "credential-a", second.id as string, "completed");
		expect(runs).toBe(2);
		finish();
		store.close();
	});
});
