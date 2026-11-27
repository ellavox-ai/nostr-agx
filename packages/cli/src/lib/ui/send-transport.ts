import type { NostrTransport } from "@nostr-agx/nostr";
import type { Profile } from "../config.js";
import type { Identity } from "../identity.js";
import { createTransport, makeLogger } from "../transport.js";

/** After a failed start: the first pause, doubled for each further failure up to the longest. */
const FIRST_PAUSE_MS = 30_000;
const LONGEST_PAUSE_MS = 300_000;

/**
 * The UI's one long-lived transport, for sending and for pulling new messages.
 *
 * Creating a transport per send would start a fresh Tailscale launcher, join a
 * fresh tailnet node and mint a fresh OAuth key for every button press. This
 * holder creates it on first use and stops it when the UI shuts down.
 *
 * If the start fails, the next calls get that error at once for a while (30
 * seconds, doubling after each further failure, up to 5 minutes), then it is
 * tried again. Once a start works the transport is kept, so the pause is never
 * needed again.
 */
export interface UiSendTransport {
	get(): Promise<NostrTransport>;
	/** Whole seconds (rounded up) until a failed start is tried again; 0 when it is not waiting. */
	retryInSeconds(): number;
	close(): Promise<void>;
}

export function createUiSendTransport(
	profile: Profile,
	identity: Identity,
	options: { profileName: string; verbose: boolean },
): UiSendTransport {
	// Cache the promise, not the resolved value: two UI requests can arrive
	// while the first createTransport() is still starting the proxy.
	let pending: Promise<NostrTransport> | undefined;
	let closing: Promise<void> | undefined;
	let failures = 0;
	let retryAt = 0;
	let lastFailure: unknown;
	return {
		get(): Promise<NostrTransport> {
			if (!pending) {
				// While waiting out a failed start, give its error at once: a launcher
				// that keeps failing would otherwise be started (and, with OAuth, a key
				// minted) on every pull and every send.
				if (failures > 0 && performance.now() < retryAt) {
					return Promise.reject(lastFailure);
				}
				const attempt = createTransport(profile, identity, makeLogger(options.verbose), {
					profileName: options.profileName,
				});
				pending = attempt;
				// A failed start is not kept: once the pause is over the next call
				// tries again, so one bad start does not break every later send until
				// `agx ui` restarts.
				attempt.catch((error: unknown) => {
					pending = undefined;
					failures += 1;
					lastFailure = error;
					retryAt = performance.now() + Math.min(FIRST_PAUSE_MS * 2 ** (failures - 1), LONGEST_PAUSE_MS);
				});
			}
			return pending;
		},
		retryInSeconds(): number {
			return Math.max(0, Math.ceil((retryAt - performance.now()) / 1000));
		},
		close(): Promise<void> {
			closing ??= (async () => {
				const current = pending;
				pending = undefined;
				// If shutdown races creation, wait for it so its proxy is still
				// stopped rather than orphaned.
				const transport = await current?.catch(() => undefined);
				await transport?.stop().catch(() => undefined);
			})();
			return closing;
		},
	};
}
