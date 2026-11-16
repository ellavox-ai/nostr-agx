import {
	AgxClient,
	type AgxLogger,
	type AgxTransport,
	type TaskStatusUpdate,
} from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";

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
 * workflow returns. This client keeps its replay records in memory, never
 * dispatches anything but results, and polls only while a request waits; after
 * an idle spell longer than the NIP-59 backdate, the next request starts a
 * fresh client from now instead of reading everything since.
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
	) {
		this.client = this.newClient();
	}

	private newClient(): AgxClient {
		return new AgxClient({
			transport: this.transport,
			logger: this.logger,
			startCursor: nowSec(),
		});
	}

	/** Send a task and wait for its result; rejects as `AgxClient.request` does,
	 * or when `signal` aborts (the API client went away), which stops polling
	 * for it. */
	async request(
		peer: string,
		capability: string,
		payload: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		onTaskStatus?: (update: TaskStatusUpdate) => void | Promise<void>,
	): Promise<unknown> {
		if (this.waiting === 0 && nowSec() - this.lastPolledSec > MAX_WRAP_BACKDATE_SEC) {
			this.client = this.newClient();
			this.lastPolledSec = nowSec();
		}
		const result = this.client.request(peer, capability, payload, {
			timeoutMs,
			onTaskStatus,
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

	stop(): void {
		this.stopped = true;
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
