/**
 * Two AGX agents over a relay that is only reachable on a tailnet, with a key
 * minted through an OAuth client-credentials exchange.
 *
 * One Tailscale node is started from `oauthAuthKey()`, and its loopback SOCKS5
 * address is passed to both transports as a borrowed `relayProxy`. The client
 * secret stays in this process: it is exchanged for a short-lived, tagged,
 * single-use auth key that is handed to the launcher through its environment.
 * For a key supplied directly, see `two-agents-auth-key.ts`.
 *
 * From the repository root, with the secret kept out of argv and shell history:
 *
 *   pnpm install && pnpm build
 *   printf %s "$CLIENT_SECRET" | \
 *     pnpm --filter @nostr-agx/tailscale example:two-agents-oauth -- \
 *       --relay wss://relay.my-tailnet.ts.net \
 *       --client-id "$CLIENT_ID" \
 *       --client-secret-stdin
 *
 * A fresh temporary Tailscale state directory is used for each run so the
 * one-off key's tags are actually applied; an existing state directory makes
 * tsnet ignore the key. Use --state-dir to keep state across runs.
 *
 * `--relay` falls back to AGX_RELAY. OAuth settings also read
 * AGX_TAILSCALE_OAUTH_CLIENT_ID, AGX_TAILSCALE_OAUTH_CLIENT_SECRET (prefer
 * stdin), AGX_TAILSCALE_OAUTH_URL, AGX_TAILSCALE_OAUTH_SCOPE,
 * AGX_TAILSCALE_TAILNET, AGX_TAILSCALE_OAUTH_API_BASE_URL,
 * AGX_TAILSCALE_OAUTH_TOKEN_AUTH, and AGX_TAILSCALE_TAGS (comma-separated).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TAILSCALE_OAUTH_TAGS,
	oauthAuthKey,
	startTailscaleRelayProxy,
	TailscaleError,
	type TailscaleOAuthOptions,
} from "../src/index";
import { requiredRelay, runAgents } from "./run-agents";

interface Options {
	clientId?: string;
	clientSecret?: string;
	clientSecretStdin: boolean;
	tokenUrl?: string;
	tokenAuth?: "basic" | "post";
	scope?: string;
	tailnet?: string;
	apiBaseUrl?: string;
	tags: string[];
	relay?: string;
	hostname: string;
	stateDir?: string;
	help: boolean;
}

const USAGE = `Usage: example:two-agents-oauth -- --client-id <id> --client-secret-stdin --relay <wss-url> [options]

  --client-id <id>        OAuth client id (or AGX_TAILSCALE_OAUTH_CLIENT_ID)
  --client-secret-stdin   Read the secret from stdin (recommended)
  --client-secret <s>     Provide the secret inline (visible in shell history)
  --relay <url>           Private Nostr relay, e.g. wss://relay.my-tailnet.ts.net (or AGX_RELAY)
  --tag <tag>             ACL tag for the minted key; repeatable (default: tag:agx-agent)
  --token-url <url>       OAuth token endpoint (default <api-base-url>/oauth/token)
  --token-auth <method>   basic or post (default: basic)	
  --scope <scope>         OAuth scope, e.g. auth_keys
  --tailnet <name>        Tailnet for the key, or - for the token's own (default: -)
  --api-base-url <url>    Tailscale API base used to mint a key
  --hostname <name>       Tailnet node name (default: agx-two-agents-oauth)
  --state-dir <path>      Tailscale state dir (default: fresh temporary dir per run)
  --help                  Show this message

The client secret is never printed or passed to the node. It is exchanged for a
one-off, short-lived key. One Tailscale node is shared by both agents.`;

function envValue(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function parseArgs(argv: string[]): Options {
	const envTags = (envValue("AGX_TAILSCALE_TAGS") ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	const opts: Options = {
		clientId: envValue("AGX_TAILSCALE_OAUTH_CLIENT_ID"),
		clientSecret: envValue("AGX_TAILSCALE_OAUTH_CLIENT_SECRET"),
		clientSecretStdin: false,
		tokenUrl: envValue("AGX_TAILSCALE_OAUTH_URL"),
		tokenAuth: parseTokenAuth(envValue("AGX_TAILSCALE_OAUTH_TOKEN_AUTH")),
		scope: envValue("AGX_TAILSCALE_OAUTH_SCOPE"),
		tailnet: envValue("AGX_TAILSCALE_TAILNET"),
		apiBaseUrl: envValue("AGX_TAILSCALE_OAUTH_API_BASE_URL"),
		tags: envTags.length > 0 ? envTags : [...DEFAULT_TAILSCALE_OAUTH_TAGS],
		relay: envValue("AGX_RELAY"),
		hostname: "agx-two-agents-oauth",
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
		} else if (arg === "--client-id") {
			opts.clientId = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--client-id=")) {
			opts.clientId = arg.slice("--client-id=".length);
		} else if (arg === "--client-secret-stdin") {
			opts.clientSecretStdin = true;
		} else if (arg === "--client-secret") {
			opts.clientSecret = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--client-secret=")) {
			opts.clientSecret = arg.slice("--client-secret=".length);
		} else if (arg === "--tag") {
			opts.tags.push(valueFor(arg, i));
			i += 1;
		} else if (arg.startsWith("--tag=")) {
			opts.tags.push(arg.slice("--tag=".length));
		} else if (arg === "--token-url") {
			opts.tokenUrl = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--token-url=")) {
			opts.tokenUrl = arg.slice("--token-url=".length);
		} else if (arg === "--token-auth") {
			opts.tokenAuth = parseTokenAuth(valueFor(arg, i));
			i += 1;
		} else if (arg.startsWith("--token-auth=")) {
			opts.tokenAuth = parseTokenAuth(arg.slice("--token-auth=".length));
		} else if (arg === "--scope") {
			opts.scope = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--scope=")) {
			opts.scope = arg.slice("--scope=".length);
		} else if (arg === "--tailnet") {
			opts.tailnet = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--tailnet=")) {
			opts.tailnet = arg.slice("--tailnet=".length);
		} else if (arg === "--api-base-url") {
			opts.apiBaseUrl = valueFor(arg, i);
			i += 1;
		} else if (arg.startsWith("--api-base-url=")) {
			opts.apiBaseUrl = arg.slice("--api-base-url=".length);
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

function parseTokenAuth(value: string | undefined): "basic" | "post" | undefined {
	if (value === undefined) return undefined;
	if (value === "basic" || value === "post") return value;
	throw new Error(`--token-auth must be basic or post, got ${value}`);
}

async function readSecretFromStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		throw new Error(
			"--client-secret-stdin needs piped input, e.g. printf %s \"$CLIENT_SECRET\" | pnpm ... example:two-agents-oauth -- --client-secret-stdin",
		);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	const secret = Buffer.concat(chunks).toString("utf8").trim();
	if (!secret) {
		throw new Error("No OAuth client secret was available on stdin.");
	}
	return secret;
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.info(USAGE);
		return;
	}
	const relay = requiredRelay(opts.relay);
	if (!opts.clientId) {
		throw new Error(
			"Pass --client-id or set AGX_TAILSCALE_OAUTH_CLIENT_ID.",
		);
	}
	const clientSecret = opts.clientSecretStdin
		? await readSecretFromStdin()
		: opts.clientSecret;
	if (!clientSecret) {
		throw new Error(
			"Pass --client-secret-stdin (recommended), --client-secret, or set AGX_TAILSCALE_OAUTH_CLIENT_SECRET.",
		);
	}

	// oauthAuthKey is a provider: the exchange happens only when the transport
	// actually needs a key. The secret is captured here and never logged.
	const oauthOptions: TailscaleOAuthOptions = {
		clientId: opts.clientId,
		clientSecret,
		tokenUrl: opts.tokenUrl,
		tokenAuth: opts.tokenAuth,
		scope: opts.scope,
		tailnet: opts.tailnet,
		apiBaseUrl: opts.apiBaseUrl,
		tags: opts.tags,
	};
	// tsnet ignores the auth key when the state directory already has an
	// enrolled node. A fresh state dir makes the one-off key's tags take effect.
	const temporaryStateDir = opts.stateDir
		? undefined
		: await mkdtemp(join(tmpdir(), "agx-tailscale-oauth-"));
	const stateDir = opts.stateDir ?? temporaryStateDir!;
	let tailscale: Awaited<ReturnType<typeof startTailscaleRelayProxy>> | undefined;
	try {
		tailscale = await startTailscaleRelayProxy({
			authKey: oauthAuthKey(oauthOptions),
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
