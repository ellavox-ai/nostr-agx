import {
	AgxClient,
	AgxPendingRequestStoreError,
	type AgxLogger,
	type AgxTransport,
	type PendingRequestStore,
	type RecoveredPendingRequest,
} from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import { MAX_BACKGROUND_TASKS_IN_FLIGHT, MAX_TASK_OPERATIONS_IN_FLIGHT } from "./idempotency.js";

/** How often the inbox is polled for results while requests are waiting. */
const RESULT_POLL_MS = 1_000;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * The client the gateway sends task requests through.
 *
 * A second client on the same identity, apart from the one that serves the
 * inbox, because that one waits for a webhook while it runs a task: a workflow
 * answering a task that itself requests another agent's task through this
 * gateway would otherwise wait on a result that inbox cannot read until the
 * workflow returns. Stored operations use durable correlation; recovery still
 * starts from now, so results received while the gateway was fully down are not
 * guaranteed until the requester gets its own durable cursor (S-14b).
 */
export class Requester {
	private waiting = 0;
	private polling = false;
	private client: AgxClient;
	private lastPolledSec = nowSec();
	private stopped = false;

	constructor(
		private readonly transport: AgxTransport,
		private readonly logger?: AgxLogger,
		private readonly pendingRequests?: PendingRequestStore,
		private readonly maxRestoredRequests = MAX_TASK_OPERATIONS_IN_FLIGHT + MAX_BACKGROUND_TASKS_IN_FLIGHT,
	) {
		this.client = this.newClient();
	}

	private newClient(): AgxClient {
		return new AgxClient({
			transport: this.transport,
			logger: this.logger,
			startCursor: nowSec(),
			pendingRequests: this.pendingRequests,
			maxRestoredRequests: this.maxRestoredRequests,
		});
	}

	async restore(): Promise<RecoveredPendingRequest[]> {
		const recovered = await this.client.restorePendingRequests();
		if (recovered.length > 0) {
			this.waiting += recovered.length;
			for (const handle of recovered) {
				void handle.result.catch(() => undefined).finally(() => {
					this.waiting -= 1;
				});
			}
			this.poll();
		}
		return recovered;
	}

	/** Send a task and wait for its result; rejects as `AgxClient.request` does,
	 * or when `signal` aborts (the API client went away), which stops polling
	 * for it. `storageKey` is the existing local task-operation ID. */
	async request(
		peer: string,
		capability: string,
		payload: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		storageKey?: string,
	): Promise<unknown> {
		if (this.waiting === 0 && nowSec() - this.lastPolledSec > MAX_WRAP_BACKDATE_SEC) {
			this.client = this.newClient();
		}
		try {
			if ((await this.client.restorePendingRequests()).length > 0) {
				throw new Error("AGX gateway recovered requests must be attached before new work");
			}
		} catch (error) {
			// A local store problem, not the remote agent's failure, and nothing was
			// sent yet: report it by type so its text stays in the gateway's log.
			this.logger?.error?.("AGX gateway: stored requests could not be restored before new work", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw new AgxPendingRequestStoreError({ mayHavePublished: false });
		}
		const result = this.client.request(peer, capability, payload, {
			timeoutMs,
			storageKey: this.pendingRequests ? (storageKey ?? null) : undefined,
		});
		// Settled by its timeout even when nobody waits for it any more.
		result.catch(() => undefined);
		this.waiting += 1;
		this.poll();
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("AGX request abandoned: the caller went away"));
			if (signal?.aborted) {
				onAbort();
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		aborted.catch(() => undefined);
		try {
			return await Promise.race([result, aborted]);
		} finally {
			this.waiting -= 1;
			if (onAbort) {
				signal?.removeEventListener("abort", onAbort);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.client.stop({ preservePending: true });
	}

	private poll(): void {
		if (this.polling) {
			return;
		}
		this.polling = true;
		void (async () => {
			try {
				while (this.waiting > 0 && !this.stopped) {
					await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS));
					await this.client.pump().catch((error: unknown) =>
						this.logger?.warn?.("AGX gateway: result poll failed; retrying", {
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					this.lastPolledSec = nowSec();
				}
			} finally {
				this.polling = false;
			}
		})();
	}
}
