import {
	MessageType,
	type Event,
	type Filter,
	type BeforeHandleEventResult,
	type BeforeHandleEventPlugin,
	createOutgoingNoticeMessage
} from "@nostr-relay/common";
import { NostrRelay } from "@nostr-relay/core";
import { Validator } from "@nostr-relay/validator";
import { createServer, type Server } from "node:http";
import {
	createServer as createTlsServer,
	type Server as TlsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { isExpired } from "./utils";
import { InMemoryEventRepository } from "./in-memory-repository";

/**
 * An in-process Nostr relay for local development.
 *
 * Why not a real relay in Docker: a client that dials `wss://` only needs TLS,
 * and neither nostr-rs-relay nor strfry terminates it, so a real relay drags in a
 * proxy and a self-signed CA — infrastructure that tests transport security
 * rather than the exchange flow.
 * This serves plain `ws`; a host that requires `wss://` pairs it with a
 * WebSocket implementation that downgrades `wss://localhost` (localhost only, so
 * it cannot mask a scheme bug against a real host).
 *
 * Protocol handling and live subscriptions are provided by `@nostr-relay/core`.
 * Events remain in memory. NIP-40 expiration is enforced locally because the
 * relay packages do not apply that policy.
 */

export interface RelayOptions {
	port?: number;
	/** Also serve `wss://` on `tlsPort` using this key pair. */
	tls?: { cert: string; key: string; port: number };
	/** Called for every accepted event — powers `agx relay --verbose`. */
	onEvent?: (event: Event) => void;
	onRequest?: (filters: Filter[], matched: number) => void;
}

export interface RunningRelay {
	port: number;
	/** The `wss://` port, when TLS was requested and bound. */
	tlsPort: number | null;
	/** Addresses actually bound (127.0.0.1 always; ::1 when available). */
	addresses: string[];
	events: () => Event[];
	byAuthor: (pubkey: string, kind: number) => Event[];
	clear: () => void;
	close: () => Promise<void>;
}

function attach(
	server: Server | TlsServer,
	relay: NostrRelay,
	validator: Validator,
	options: RelayOptions,
): WebSocketServer {
	const wss = new WebSocketServer({ server });
	wss.on("connection", (socket) => {
		relay.handleConnection(socket);
		socket.on("close", () => relay.handleDisconnect(socket));
		socket.on("message", (raw) => {
			void (async () => {
				let message;
				try {
					message = await validator.validateIncomingMessage(raw);
				} catch (error) {
					const reason =
						error instanceof Error ? error.message : "invalid message";
					socket.send(JSON.stringify(createOutgoingNoticeMessage(reason)));
					return;
				}

				try {
					const result = await relay.handleMessage(socket, message);
					if (
						message[0] === MessageType.EVENT &&
						result?.messageType === MessageType.EVENT &&
						result.success
					) {
						options.onEvent?.(message[1]);
					} else if (
						message[0] === MessageType.REQ &&
						result?.messageType === MessageType.REQ
					) {
						options.onRequest?.(
							message.slice(2) as Filter[],
							result.events.length,
						);
					}
				} catch (error) {
					const reason =
						error instanceof Error ? error.message : "internal relay error";
					socket.send(JSON.stringify(createOutgoingNoticeMessage(reason)));
				}
			})();
		});
	});
	return wss;
}

/**
 * Bind, THEN attach the WebSocketServer — never the other way round.
 *
 * `ws` forwards the underlying server's `error` event onto the WebSocketServer.
 * Attached before the bind, a failed bind (`EAFNOSUPPORT` for `::1` on a host
 * with no IPv6) is re-emitted on a WebSocketServer with no listener, which
 * throws and kills the process — so the "best-effort" IPv6 listener took the
 * whole relay down on exactly the hosts it was meant to tolerate. Returns null
 * when the bind fails, leaving nothing attached to clean up.
 */
async function bindRelay(
	server: Server | TlsServer,
	port: number,
	host: string,
	relay: NostrRelay,
	validator: Validator,
	options: RelayOptions,
): Promise<WebSocketServer | null> {
	if (!(await listen(server, port, host))) {
		return null;
	}
	return attach(server, relay, validator, options);
}

function listen(
	server: Server | TlsServer,
	port: number,
	host: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const onError = () => {
			server.removeListener("error", onError);
			resolve(false);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			resolve(true);
		});
	});
}

/** A plugin that blocks expired events from being handled. */
class ExpirationPlugin implements BeforeHandleEventPlugin {
	beforeHandleEvent(event: Event): Promise<BeforeHandleEventResult> | BeforeHandleEventResult {
		if (isExpired(event)) {
			return {
				canHandle: false,
				message: "blocked: event expiration has passed",
			};
		}
		return { canHandle: true };
	}
}

/**
 * Start the relay on both loopback families.
 *
 * Binding only `127.0.0.1` is fine under a test runner that dials the literal
 * address, but a long-lived relay is dialed as `localhost`, which resolves to
 * `::1` first on many machines — producing an 8-second connect timeout rather
 * than a refusal, which is a genuinely confusing way to lose an afternoon.
 * The IPv6 listener is best-effort: hosts without IPv6 simply skip it.
 */
export async function startRelay(
	options: RelayOptions = {},
): Promise<RunningRelay> {
	const repository = new InMemoryEventRepository();
	const relay = new NostrRelay(repository);
	relay.register(new ExpirationPlugin());
	const validator = new Validator();
	const requested = options.port ?? 7447;
	const addresses: string[] = [];

	const v4 = createServer();
	const wssV4 = await bindRelay(
		v4,
		requested,
		"127.0.0.1",
		relay,
		validator,
		options,
	);
	if (!wssV4) {
		throw new Error(
			`Could not bind 127.0.0.1:${requested} — is another agx relay already running?`,
		);
	}
	const port = (v4.address() as AddressInfo).port;
	addresses.push(`127.0.0.1:${port}`);

	const v6 = createServer();
	const wssV6 = await bindRelay(v6, port, "::1", relay, validator, options);
	if (wssV6) {
		addresses.push(`[::1]:${port}`);
	}

	// The TLS listener shares the SAME event store, so a card published over
	// wss:// is immediately readable over ws:// and vice versa. That is the whole
	// point: a TLS client dials wss://, the CLI dials ws://, and they must see one relay.
	let tlsV4: TlsServer | null = null;
	let tlsWss: WebSocketServer | null = null;
	let tlsV6: TlsServer | null = null;
	let tlsWssV6: WebSocketServer | null = null;
	let tlsPort: number | null = null;
	if (options.tls) {
		tlsV4 = createTlsServer({
			cert: options.tls.cert,
			key: options.tls.key,
		});
		tlsWss = await bindRelay(
			tlsV4,
			options.tls.port,
			"127.0.0.1",
			relay,
			validator,
			options,
		);
		if (!tlsWss) {
			throw new Error(
				`Could not bind 127.0.0.1:${options.tls.port} for TLS — is the port already in use?`,
			);
		}
		tlsPort = (tlsV4.address() as AddressInfo).port;
		addresses.push(`127.0.0.1:${tlsPort} (wss)`);

		// Both loopback families, for the same reason as the plain listener — and
		// it matters MORE here: `localhost` resolves to `::1` first on macOS, so a
		// v4-only TLS listener refuses every `wss://localhost` dial while the plain
		// port keeps working, which looks like a TLS problem rather than a binding
		// one.
		tlsV6 = createTlsServer({
			cert: options.tls.cert,
			key: options.tls.key,
		});
		tlsWssV6 = await bindRelay(
			tlsV6,
			tlsPort,
			"::1",
			relay,
			validator,
			options,
		);
		if (tlsWssV6) {
			addresses.push(`[::1]:${tlsPort} (wss)`);
		}
	}

	return {
		port,
		tlsPort,
		addresses,
		events: () => [...repository.stored],
		byAuthor: (pubkey, kind) =>
			repository.stored
				.filter((e) => e.pubkey === pubkey && e.kind === kind)
				.sort((a, b) => b.created_at - a.created_at),
		clear: () => {
			repository.stored.length = 0;
		},
		close: async () => {
			// A null WebSocketServer is a listener whose bind failed — nothing to shut.
			const shut = (
				wss: WebSocketServer | null,
				http: Server | TlsServer | null,
			) =>
				new Promise<void>((resolve) => {
					if (!wss || !http) {
						resolve();
						return;
					}
					for (const client of wss.clients) {
						client.terminate();
					}
					wss.close(() => http.close(() => resolve()));
				});
			await Promise.all([
				shut(wssV4, v4),
				shut(wssV6, v6),
				shut(tlsWss, tlsV4),
				shut(tlsWssV6, tlsV6),
			]);
			await relay.destroy();
		},
	};
}
