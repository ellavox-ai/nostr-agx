import type { AgxLogger } from "@nostr-agx/core";
import {
	type AgxSigner,
	hexToBytes,
	localSigner,
	NostrTransport,
	publicKeyFromSecret,
	readSecretKeyInput,
	toNpub,
} from "@nostr-agx/nostr";
import type {
	ICredentialDataDecryptedObject,
	Logger,
	LogMetadata,
} from "n8n-workflow";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";

/**
 * The agent identity behind an "AGX Agent Identity" credential: the signer, the
 * relays it reads its inbox from and publishes to, and the metadata its Agent
 * Card advertises. Problems are thrown as plain errors whose messages are
 * written to be shown to the n8n user as they are.
 */

export interface AgxIdentity {
	/** Signs, encrypts and decrypts for this agent. The secret key stays in it. */
	signer: AgxSigner;
	publicKey: string;
	npub: string;
	relays: string[];
	org: string | null;
	nip05: string | null;
}

function decodeNsec(input: string): Uint8Array | null {
	try {
		const decoded = nip19.decode(input);
		return decoded.type === "nsec" ? decoded.data : null;
	} catch {
		return null;
	}
}

function urlProtocol(input: string): string | null {
	try {
		return new URL(input).protocol;
	} catch {
		return null;
	}
}

/** Accept an `nsec1…` key (also in capitals, or behind `nostr:`) or a bare 64-character
 * hex secret, as the CLI does: `@nostr-agx/nostr` says which of the two was typed.
 * It deliberately exposes no nsec codec, so `nostr-tools`' `nip19` is used directly. */
export function parseSecretKey(input: string): Uint8Array {
	const key = readSecretKeyInput(input);
	if (key?.kind === "nsec") {
		const secretKey = decodeNsec(key.bech32);
		if (!secretKey) {
			throw new Error("The secret key is not a valid nsec1… key.");
		}
		return secretKey;
	}
	if (key?.kind === "hex") {
		return hexToBytes(key.hex);
	}
	if (input.trim().startsWith("npub1")) {
		throw new Error(
			"That is a public key (npub1…). The credential needs the agent's secret key: nsec1… or 64 hex characters.",
		);
	}
	throw new Error(
		"The secret key must be an nsec1… key or 64 hexadecimal characters.",
	);
}

/** Relay URLs separated by commas, spaces or new lines. Only `ws:`/`wss:` URLs
 * are accepted; duplicates are dropped. These are the agent's OWN relays, so,
 * as in the CLI, they are not SSRF-guarded: a local `ws://127.0.0.1:7447` works. */
export function parseRelays(input: string): string[] {
	const relays: string[] = [];
	for (const entry of input.split(/[\s,]+/)) {
		if (!entry) {
			continue;
		}
		const protocol = urlProtocol(entry);
		if (protocol === null) {
			throw new Error(`"${entry}" is not a relay URL.`);
		}
		if (protocol !== "wss:" && protocol !== "ws:") {
			throw new Error(
				`Relay URLs start with wss:// (or ws:// for a local relay): "${entry}"`,
			);
		}
		if (!relays.includes(entry)) {
			relays.push(entry);
		}
	}
	if (relays.length === 0) {
		throw new Error(
			"Add at least one relay URL, such as wss://relay.example.com.",
		);
	}
	return relays;
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function identityFromCredentials(
	data: ICredentialDataDecryptedObject,
): AgxIdentity {
	const secretKey = parseSecretKey(String(data.secretKey ?? ""));
	const publicKey = publicKeyFromSecret(secretKey);
	return {
		signer: localSigner(secretKey),
		publicKey,
		npub: toNpub(publicKey),
		relays: parseRelays(String(data.relays ?? "")),
		org: optionalText(data.org),
		nip05: optionalText(data.nip05),
	};
}

export function createTransport(
	identity: AgxIdentity,
	logger?: AgxLogger,
): Promise<NostrTransport> {
	return NostrTransport.create({
		signer: identity.signer,
		relays: identity.relays,
		ws: WebSocket,
		logger,
	});
}

/** The library's logger, on top of n8n's. */
export function agxLogger(logger: Logger): AgxLogger {
	const meta = (value: unknown): LogMetadata | undefined => {
		if (value === undefined) {
			return undefined;
		}
		return value !== null && typeof value === "object"
			? (value as LogMetadata)
			: { detail: value };
	};
	return {
		debug: (message, value) => logger.debug(message, meta(value)),
		info: (message, value) => logger.info(message, meta(value)),
		warn: (message, value) => logger.warn(message, meta(value)),
		error: (message, value) => logger.error(message, meta(value)),
	};
}
