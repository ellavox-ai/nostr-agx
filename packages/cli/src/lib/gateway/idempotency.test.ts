import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../../test/helpers.js";
import { gatewayTaskOperationsPath, writePrivateJson, writePrivateText } from "../paths.js";
import { ApiError } from "./http.js";
import {
	MAX_IDEMPOTENCY_KEY_CHARS,
	MAX_TASK_OUTCOME_BYTES,
	parseIdempotencyKey,
	TASK_IDEMPOTENCY_RETENTION_MS,
	TaskIdempotencyStore,
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

describe("TaskIdempotencyStore", () => {
	it("shares concurrent work and replays a canonically identical completed request", async () => {
		const store = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test");
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await expect(store.execute("credential-a", "shared-key", {}, operation)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-b", "shared-key", {}, operation)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
	});

	it("restores completed outcomes and makes unresolved work explicitly unknown", async () => {
		const completed = new TaskIdempotencyStore("test");
		await completed.execute("credential-a", "completed", {}, async () => ({ status: "completed", output: { ok: true } }));
		completed.close();
		const restored = new TaskIdempotencyStore("test");
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
		const restarted = new TaskIdempotencyStore("test");
		await expect(restarted.execute("credential-a", "pending", {}, async () => ({ rerun: true }))).rejects.toMatchObject({
			status: 409,
			code: "result_unknown",
		});
		release?.();
		await expect(pending).resolves.toEqual({ status: "completed" });
		restarted.close();
	});

	it("retries failures that prove no task was published", async () => {
		const store = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test");
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

		const restored = new TaskIdempotencyStore("test");
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
		const store = new TaskIdempotencyStore("test", { maxOperationsPerCredential: 1 });
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await expect(store.execute("credential-a", "first", {}, operation)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-a", "second", {}, operation)).resolves.toEqual({ run: 2 });
		await expect(store.execute("credential-a", "first", {}, operation)).resolves.toEqual({ run: 3 });
		await expect(store.execute("credential-b", "first", {}, operation)).resolves.toEqual({ run: 4 });
		store.close();
	});

	it("keeps running operations when retained capacity is full", async () => {
		const store = new TaskIdempotencyStore("test", { maxOperationsPerCredential: 1 });
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
		const store = new TaskIdempotencyStore("test", { maxInFlight: 1 });
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
		const written = new TaskIdempotencyStore("test");
		await written.execute("credential-a", "legacy", {}, async () => ({ run: 1 }));
		written.close();
		const path = gatewayTaskOperationsPath("test");
		const raw = JSON.parse(readFileSync(path, "utf8")) as { operations: Record<string, unknown>[] };
		delete raw.operations[0]!.credential;
		writePrivateJson(path, raw);

		const restored = new TaskIdempotencyStore("test");
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
			const store = new TaskIdempotencyStore(profile, { log: (line) => lines.push(line) });
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
		const store = new TaskIdempotencyStore("test", {
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
