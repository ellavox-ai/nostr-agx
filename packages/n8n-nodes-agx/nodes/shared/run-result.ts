import { AgxPublicError } from "@nostr-agx/core";
import type { INodeExecutionData, IRun } from "n8n-workflow";

/** Which part of the last node's output becomes the task result. */
export type ResultMode = "firstItem" | "allItems";

export interface ResultOptions {
	mode: ResultMode;
	/** Send a failed execution's error message to the requester verbatim. Off,
	 * the requester reads only `handler failed` (SPEC "Error boundary"). */
	forwardErrors: boolean;
}

/** The items the last executed node returned on its first non-empty output, as
 * the Webhook node's "When Last Node Finishes" response reads them. */
function lastNodeItems(run: IRun): INodeExecutionData[] {
	const result = run.data.resultData;
	const last = result.lastNodeExecuted;
	const runs = last ? result.runData[last] : undefined;
	const outputs = runs?.[runs.length - 1]?.data?.main ?? [];
	for (const output of outputs) {
		if (output && output.length > 0) {
			return output;
		}
	}
	return [];
}

/**
 * The task output for a finished workflow execution. Throws when the execution
 * did not succeed: an `AgxPublicError` (whose message `AgxClient` forwards) only
 * when the node is set to forward errors, otherwise a plain `Error`, which
 * `AgxClient` logs here and reports to the peer as `handler failed` — an n8n
 * error routinely carries URLs, hostnames and response bodies, none of which
 * should cross to another organization by default.
 */
export function taskOutputFromRun(
	run: IRun | undefined,
	options: ResultOptions,
): unknown {
	const fail = (message: string): never => {
		throw options.forwardErrors
			? new AgxPublicError(message)
			: new Error(message);
	};
	if (!run) {
		return fail("the workflow did not run");
	}
	const error = run.data.resultData.error;
	if (error) {
		return fail(error.message || "the workflow failed");
	}
	// `waiting` (a Wait node), `canceled`, `crashed`: no result to send.
	if (run.status && run.status !== "success") {
		return fail(`the workflow ended with status "${run.status}"`);
	}
	const items = lastNodeItems(run);
	if (options.mode === "allItems") {
		return items.map((item) => item.json);
	}
	return items[0]?.json ?? {};
}

/** Resolves like `promise`, or rejects once `ms` pass. The rejection is a
 * public error: "it did not finish in time" tells the requester nothing about
 * this side. `AbortSignal.timeout` rather than a timer n8n would have us
 * cancel with `sleepWithAbort`, which is newer than the n8n-workflow current
 * n8n ships: its timer does not keep the process alive, and once the race is
 * decided its firing changes nothing. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	const signal = AbortSignal.timeout(ms);
	const timeout = new Promise<never>((_, reject) => {
		signal.addEventListener(
			"abort",
			() => reject(new AgxPublicError("the workflow did not finish in time")),
			{ once: true },
		);
	});
	return Promise.race([promise, timeout]);
}

/**
 * Wait for the execution a task started and turn it into the task output. A
 * run that does not settle within `timeoutMs` fails the task publicly; a run
 * n8n could not start fails it like a failed execution.
 */
export async function awaitTaskOutput(
	execution: Promise<IRun>,
	options: ResultOptions & { timeoutMs: number },
): Promise<unknown> {
	const run = await withTimeout(execution, options.timeoutMs).catch(
		(error: unknown) => {
			throw error instanceof AgxPublicError || !options.forwardErrors
				? error
				: new AgxPublicError(error instanceof Error ? error.message : String(error));
		},
	);
	return taskOutputFromRun(run, options);
}
