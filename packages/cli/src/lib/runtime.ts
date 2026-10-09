/**
 * The clock, the timer and the network, behind one seam.
 *
 * `agx login` waits minutes for a human and `--wait` loops poll every 15 s, so
 * their tests replace these three instead of waiting for real. Production code
 * reads them through `runtime()` at call time, never at import time, so a test
 * can swap them for one run and restore them afterwards.
 */

export interface Runtime {
	fetch: typeof fetch;
	/** Resolves after `ms`, or rejects with the signal's reason once aborted. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	/** Milliseconds since the epoch. */
	now(): number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const DEFAULT_RUNTIME: Runtime = {
	fetch: (...args) => globalThis.fetch(...args),
	sleep: defaultSleep,
	now: () => Date.now(),
};

let current: Runtime = DEFAULT_RUNTIME;

export function runtime(): Runtime {
	return current;
}

/** Tests only. Returns a function that restores the previous runtime. */
export function setRuntimeForTests(patch: Partial<Runtime>): () => void {
	const previous = current;
	current = { ...current, ...patch };
	return () => {
		current = previous;
	};
}

/**
 * A signal that fires on whichever comes first: `ms` elapsing or `signal`.
 * `AbortSignal.any` arrived in Node 20.3; `engines` allows 20.0, so fall back
 * to the timeout alone there.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	if (!signal) {
		return timeout;
	}
	const any = (
		AbortSignal as unknown as {
			any?: (signals: AbortSignal[]) => AbortSignal;
		}
	).any;
	return any ? any([timeout, signal]) : timeout;
}
