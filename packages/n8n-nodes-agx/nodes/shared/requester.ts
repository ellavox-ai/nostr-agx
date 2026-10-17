import { AgxClient, type AgxLogger } from "@nostr-agx/core";
import { sleep } from "n8n-workflow";
import { type AgxIdentity, createTransport } from "./identity";

/** How often an identity with requests waiting polls its inbox for results. */
const RESULT_POLL_MS = 1_000;

/** Requesters by identity and relay set. */
const requesters = new Map<string, Promise<Requester>>();

/**
 * One requesting client per identity and relay set, shared by every Task →
 * Request this n8n process runs.
 *
 * Shared because of what a client keeps. Its replay store records every wrap it
 * has opened, so with one client per execution each request would first decrypt
 * the whole two-day poll window of the inbox — two ECDHs per wrap, on every
 * call an AI Agent makes — before its own result could be seen. And it has to
 * be one client, not one store shared by several: results are matched to
 * requests inside a client, by task id, and a client that is not waiting for a
 * result records it as handled anyway, so it would take another execution's.
 *
 * The client polls only while a request is waiting.
 */
export class Requester {
	private waiting = 0;
	private polling = false;

	private constructor(
		private readonly client: AgxClient,
		private readonly logger: AgxLogger,
	) {}

	static for(identity: AgxIdentity, logger: AgxLogger): Promise<Requester> {
		const key = `${identity.publicKey}|${[...identity.relays].sort().join(",")}`;
		let requester = requesters.get(key);
		if (!requester) {
			requester = createTransport(identity, logger).then(
				(transport) =>
					new Requester(
						new AgxClient({
							transport,
							logger,
							// From now: the poll still reaches back the full NIP-59 backdate
							// (two days), which is all a result sent from now on can be
							// dated, instead of reading the whole retained inbox from zero.
							startCursor: Math.floor(Date.now() / 1000),
						}),
						logger,
					),
			);
			requester.catch(() => requesters.delete(key));
			requesters.set(key, requester);
		}
		return requester;
	}

	/** Send a task and wait for its result; rejects as `AgxClient.request` does. */
	async request(
		peer: string,
		capability: string,
		payload: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		// Registers the pending request before it returns, so the poll below
		// cannot miss a result that arrives early.
		const result = this.client.request(peer, capability, payload, { timeoutMs });
		this.waiting += 1;
		this.poll();
		try {
			return await result;
		} finally {
			this.waiting -= 1;
		}
	}

	private poll(): void {
		if (this.polling) {
			return;
		}
		this.polling = true;
		void (async () => {
			try {
				while (this.waiting > 0) {
					await sleep(RESULT_POLL_MS);
					await this.client.pump().catch((error) =>
						this.logger.warn?.("AGX: inbox poll failed; retrying", {
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			} finally {
				this.polling = false;
			}
		})();
	}
}

/** Test-only: drop the cached requesters. */
export function __resetRequestersForTests(): void {
	requesters.clear();
}
