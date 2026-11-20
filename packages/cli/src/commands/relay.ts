import kleur from "kleur";
import { heading, info, kv, say, warn } from "../lib/output.js";
import { ensureRelayCert, writeRelayMeta } from "../relay/cert.js";
import { startRelay } from "../relay/server.js";

export interface RelayOptions {
	profile?: string;
	port?: string;
	verbose?: boolean;
	tls?: boolean;
	tlsPort?: string;
	regenerateCert?: boolean;
}

const KIND_NAMES: Record<number, string> = {
	1: "note",
	5: "deletion (NIP-09)",
	1059: "gift wrap (NIP-59)",
	10002: "relay list (NIP-65)",
	11337: "agent card",
};

export async function relayCommand(options: RelayOptions): Promise<void> {
	const port = Number(options.port ?? 7447);
	const tlsPort = Number(options.tlsPort ?? port + 1);
	const cert = options.tls
		? ensureRelayCert({ force: options.regenerateCert })
		: null;

	const relay = await startRelay({
		port,
		...(cert
			? { tls: { cert: cert.cert, key: cert.key, port: tlsPort } }
			: {}),
		onEvent: (event) => {
			if (!options.verbose) {
				return;
			}
			const label = KIND_NAMES[event.kind] ?? `kind ${event.kind}`;
			say(
				`${kleur.green("EVENT")} ${kleur.bold(label.padEnd(20))} ${kleur.dim(
					`author ${event.pubkey.slice(0, 8)}  id ${event.id.slice(0, 8)}`,
				)}`,
			);
		},
		onRequest: (_filters, matched) => {
			if (options.verbose) {
				say(kleur.dim(`REQ   → ${matched} event(s)`));
			}
		},
	});

	// Record what we are serving (in ~/.agx/relay) so a co-located client can
	// discover the ports and scheme without being told.
	writeRelayMeta({
		plainPort: relay.port,
		tlsPort: relay.tlsPort,
		certPath: cert?.certPath ?? null,
		startedAt: new Date().toISOString(),
	});

	heading("agx relay");
	kv("listening", relay.addresses.join(", "));
	kv("CLI transport", `ws://127.0.0.1:${relay.port}`);
	kv("wss:// form", `wss://localhost:${relay.port}`);
	if (cert && relay.tlsPort) {
		kv("real TLS", `wss://localhost:${relay.tlsPort}`);
		kv("certificate", cert.certPath);
	}
	say("");
	info(
		"The wss:// form is for indexes that only accept wss:// relays. The plain port has no TLS, so a client must downgrade it to ws:// (for localhost only).",
	);
	if (cert && relay.tlsPort) {
		say("");
		heading("To let a TLS-only client reach this relay");
		say(
			"  A client that dials wss:// for real, with no localhost downgrade, needs the",
		);
		say("  TLS port and must trust this certificate:");
		say("");
		say(kleur.cyan(`    wss://localhost:${relay.tlsPort}`));
		say(
			kleur.cyan(
				`    NODE_EXTRA_CA_CERTS=${cert.certPath} <your client command>`,
			),
		);
		say("");
		say(
			kleur.dim(
				"  Both listeners share one event store, so the CLI can keep using ws:// on\n  the plain port and still see everything published over TLS.",
			),
		);
		if (cert.created) {
			say("");
			info(
				"Generated a fresh self-signed certificate (localhost SANs only, so it cannot authenticate any real host).",
			);
		}
	} else {
		say("");
		info(
			"Plain ws only. A client that dials wss:// for real, with no localhost downgrade, needs real TLS — restart with `agx relay --tls`.",
		);
	}
	warn(
		"Events are held in memory — restarting this relay discards every published Agent Card.",
	);
	say(kleur.dim("\nCtrl-C to stop\n"));

	await new Promise<void>((resolve) => {
		const stop = () => {
			say("");
			void relay.close().then(resolve);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
}
