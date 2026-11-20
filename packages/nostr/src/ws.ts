import { useWebSocketImplementation } from "nostr-tools/relay";

/**
 * WebSocket injection. `NostrTransport` passes its implementation to every relay
 * dial, so two transports in one process can use different paths (for example
 * only one through Tailscale). The helper below is kept only for library callers
 * that dial `nostr-tools` relays directly.
 */

/** A WHATWG-compatible WebSocket constructor (e.g. the Node `ws` package's
 * default export, or the browser/edge global). nostr-tools' setter is untyped, so
 * this stays structural. */
export type WebSocketImpl = unknown;

let configured = false;

/** Configure nostr-tools' process-global WebSocket implementation.
 *
 * @deprecated `NostrTransport` no longer uses this: it injects its own WebSocket
 * per relay connection. Call this only when dialing `nostr-tools` directly. */
export function configureWebSocket(impl?: WebSocketImpl): void {
	if (impl) {
		useWebSocketImplementation(
			impl as Parameters<typeof useWebSocketImplementation>[0],
		);
		configured = true;
		return;
	}
	if (configured) {
		return;
	}
	if (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined"
	) {
		// A global WebSocket exists (browser/edge/Node 21+) — nostr-tools uses it.
		configured = true;
	}
}
