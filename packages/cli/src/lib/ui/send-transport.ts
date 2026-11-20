import type { NostrTransport } from "@nostr-agx/nostr";
import type { Profile } from "../config.js";
import type { Identity } from "../identity.js";
import { createTransport, makeLogger } from "../transport.js";

/**
 * The UI's one long-lived send transport.
 *
 * Creating a transport per send would start a fresh Tailscale launcher, join a
 * fresh tailnet node and mint a fresh OAuth key for every button press. This
 * holder creates it on first use and stops it when the UI shuts down.
 */
export interface UiSendTransport {
	get(): Promise<NostrTransport>;
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
	return {
		get(): Promise<NostrTransport> {
			pending ??= createTransport(profile, identity, makeLogger(options.verbose), {
				profileName: options.profileName,
			});
			return pending;
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
