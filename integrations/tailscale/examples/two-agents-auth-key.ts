/**
 * Two AGX agents over a relay that is only reachable on a tailnet, using an
 * auth key passed as an argument (or the environment).
 *
 * One Tailscale node is started from `--auth-key`, and its loopback SOCKS5
 * address is passed to both transports as a borrowed `relayProxy`. The node is
 * stopped once at the end. AGX still speaks Nostr; Tailscale only carries the
 * WebSocket dials. For OAuth-issued keys, see `two-agents-oauth.ts`.
 *
 * From the repository root:
 *
 *   pnpm install && pnpm build
 *   pnpm --filter @nostr-agx/tailscale example:two-agents-auth-key -- \
 *     --auth-key tskey-auth-... \
 *     --relay wss://relay.my-tailnet.ts.net
 *
 * `--auth-key` falls back to TS_AUTHKEY / AGX_TAILSCALE_AUTH_KEY, and `--relay`
 * to AGX_RELAY. Prefer an environment variable in shells that record history.
 * A fresh temporary Tailscale state directory is used per run so the key's
 * tags are applied; use --state-dir to keep state across runs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	startTailscaleRelayProxy,
	TailscaleError,
} from "../src/index";
import { requiredRelay, runAgents } from "./run-agents";

interface Options {
	authKey?: string;
	relay?: string;
	hostname: string;
	stateDir?: string;
	help: boolean;
}

const USAGE = `Usage: example:two-agents-auth-key -- --auth-key <key> --relay <wss-url> [--hostname <name>]

  --auth-key <key>   Tailscale auth key (or TS_AUTHKEY / AGX_TAILSCALE_AUTH_KEY)
  --relay <url>      Private Nostr relay, e.g. wss://relay.my-tailnet.ts.net (or AGX_RELAY)
  --hostname <name>  Tailnet node name (default: agx-two-agents)
  --state-dir <path> Tailscale state dir (default: fresh temporary dir per run)
  --help             Show this message

The key is never printed. One Tailscale node is shared by both agents.`;

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		authKey: process.env.TS_AUTHKEY ?? process.env.AGX_TAILSCALE_AUTH_KEY,
		relay: process.env.AGX_RELAY,
		hostname: "agx-two-agents",
		stateDir: undefined,
		help: false,
	};

	const valueFor = (flag: string, index: number): string => {
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`${flag} needs a value`);
		}
		return value;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (arg === "--") {
			// pnpm forwards the separator when calling `pnpm ... script -- args`.
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			opts.help = true;
		} else if (arg === "--auth-key") {
			opts.authKey = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--auth-key=")) {
			opts.authKey = arg.slice("--auth-key=".length);
		} else if (arg === "--relay") {
			opts.relay = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--relay=")) {
			opts.relay = arg.slice("--relay=".length);
		} else if (arg === "--hostname") {
			opts.hostname = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--hostname=")) {
			opts.hostname = arg.slice("--hostname=".length);
		} else if (arg === "--state-dir") {
			opts.stateDir = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--state-dir=")) {
			opts.stateDir = arg.slice("--state-dir=".length);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.info(USAGE);
		return;
	}
	const relay = requiredRelay(opts.relay);
	if (!opts.authKey) {
		throw new Error(
			"Pass --auth-key tskey-... or set TS_AUTHKEY / AGX_TAILSCALE_AUTH_KEY.",
		);
	}

	// A fresh state dir ensures the supplied key is actually used: tsnet ignores
	// auth keys when it finds an already-enrolled node in the state directory.
	const temporaryStateDir = opts.stateDir
		? undefined
		: await mkdtemp(join(tmpdir(), "agx-tailscale-auth-key-"));
	const stateDir = opts.stateDir ?? temporaryStateDir!;
	let tailscale: Awaited<ReturnType<typeof startTailscaleRelayProxy>> | undefined;
	try {
		// Start once. Both transports borrow this URL (a bare string), so neither
		// stops the node — `tailscale.stop()` below is the single owner.
		tailscale = await startTailscaleRelayProxy({
			authKey: opts.authKey,
			hostname: opts.hostname,
			stateDir,
			ephemeral: true,
		});
		console.info(`tailnet node ${opts.hostname} ready; relay proxy ${tailscale.url}`);
		console.info(`relay ${relay}`);
		await runAgents({ relay, relayProxy: tailscale.url });
	} finally {
		if (tailscale) {
			await tailscale.stop();
			console.info("tailnet node stopped");
		}
		if (temporaryStateDir) {
			await rm(temporaryStateDir, { recursive: true, force: true });
		}
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		if (error instanceof TailscaleError) {
			console.error(`${error.code}: ${error.message}`);
			if (error.remediation) console.error(error.remediation);
		} else {
			console.error(error instanceof Error ? error.message : error);
		}
		process.exit(1);
	},
);
