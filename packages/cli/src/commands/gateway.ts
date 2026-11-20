import kleur from "kleur";
import { resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import { DEFAULT_GATEWAY_PORT, startGateway } from "../lib/gateway/gateway.js";
import {
	createGatewayKey,
	GATEWAY_KEY_ENV,
	gatewayKeysConfigured,
	listGatewayKeys,
	MIN_ENV_KEY_CHARS,
	revokeGatewayKey,
} from "../lib/gateway/keys.js";
import { SubscriptionStore } from "../lib/gateway/subscriptions.js";
import { heading, info, json, kv, say, table, warn } from "../lib/output.js";
import { makeLogger } from "../lib/transport.js";

/**
 * `agx gateway`: run this profile's agent behind an HTTP API, so a tool that
 * can make HTTP calls but cannot speak Nostr — n8n Cloud, Make, Zapier — can
 * request tasks, send messages, and answer tasks through a webhook.
 */

export interface GatewayCommandOptions {
	profile?: string;
	host?: string;
	port?: string;
	pollInterval?: string;
	verbose?: boolean;
	tailscale?: boolean;
	withoutTailscale?: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function portOf(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_GATEWAY_PORT;
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw usageError(`--port must be a port number, not "${value}".`);
	}
	return port;
}

export async function gatewayCommand(options: GatewayCommandOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const host = options.host ?? "127.0.0.1";
	const pollIntervalMs = Number(options.pollInterval ?? "3000");
	if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500) {
		throw usageError("--poll-interval must be at least 500 milliseconds.");
	}
	const envKey = process.env[GATEWAY_KEY_ENV];
	if (envKey !== undefined && envKey.length < MIN_ENV_KEY_CHARS) {
		throw usageError(
			`${GATEWAY_KEY_ENV} must be at least ${MIN_ENV_KEY_CHARS} characters, such as the output of: openssl rand -base64 32`,
		);
	}
	const port = portOf(options.port);
	const gateway = await startGateway({
		profile: profileName,
		host,
		port,
		pollIntervalMs,
		tailscale: options.tailscale,
		withoutTailscale: options.withoutTailscale,
		logger: makeLogger(options.verbose ?? false),
		log: (line) => say(`${kleur.dim(new Date().toISOString())} ${line}`),
	});

	// Tailscale is transport-only: the SDK proxy is owned by the gateway's
	// NostrTransport. The HTTP API itself stays on loopback.
	heading("agx gateway");
	kv("profile", profileName);
	kv("npub", gateway.npub);
	kv("listening", gateway.url);
	kv("subscriptions", new SubscriptionStore(profileName).list().length);
	if (!gatewayKeysConfigured(profileName)) {
		warn(`No API key yet, so every request will be refused. Create one with:\n    agx gateway key new --label n8n`);
	}
	if (LOOPBACK.has(host)) {
		info(
			"Listening on this machine only. For n8n Cloud or another hosted tool, publish it at an https:// URL through a reverse proxy or tunnel.",
		);
	} else {
		warn(
			`Listening on ${host} over plain HTTP. API keys and task payloads cross the network in the clear unless a TLS proxy sits in front.`,
		);
	}
	say(kleur.dim("\nCtrl-C to stop\n"));

	let stopping = false;
	const stop = async () => {
		if (stopping) {
			process.exit(EXIT.interrupted);
		}
		stopping = true;
		info("stopping…");
		await gateway.close().catch(() => undefined);
		process.exit(EXIT.ok);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}

export function gatewayKeyNewCommand(options: { profile?: string; label?: string }): void {
	const profileName = resolveProfileName(options.profile);
	const label = (options.label ?? "").trim() || "default";
	const created = createGatewayKey(profileName, label);
	json({ id: created.id, label: created.label, createdAt: created.createdAt, key: created.key });
	heading("New gateway API key");
	kv("id", created.id);
	kv("label", created.label);
	say(`\n  ${kleur.bold(created.key)}\n`);
	info("This is the only time the key is shown. Paste it into the tool's gateway credential.");
}

export function gatewayKeyListCommand(options: { profile?: string }): void {
	const profileName = resolveProfileName(options.profile);
	const keys = listGatewayKeys(profileName);
	json({ keys, env: Boolean(process.env[GATEWAY_KEY_ENV]) });
	if (keys.length === 0) {
		info(`No gateway API keys. Create one with \`agx gateway key new\`${process.env[GATEWAY_KEY_ENV] ? ` (${GATEWAY_KEY_ENV} is also set)` : ""}.`);
		return;
	}
	table(
		keys.map((key) => [key.id, key.label, key.createdAt]),
		["id", "label", "created"],
	);
}

export function gatewayKeyRevokeCommand(id: string, options: { profile?: string }): void {
	const profileName = resolveProfileName(options.profile);
	if (!revokeGatewayKey(profileName, id)) {
		throw new AgxCliError(`No gateway API key with id ${id}.`, {
			exitCode: EXIT.usage,
			remediation: "List them with `agx gateway key list`.",
		});
	}
	json({ revoked: id });
	info(`Revoked gateway API key ${id}. A running gateway refuses it from its next request.`);
}
