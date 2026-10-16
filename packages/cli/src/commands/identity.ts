import kleur from "kleur";
import {
	effectiveProfile,
	getProfile,
	resolveProfileName,
	updateProfile,
} from "../lib/config.js";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import {
	createIdentity,
	identityExists,
	identityFromSecret,
	loadIdentity,
	loadIdentityFile,
	parseSecretInput,
	saveIdentity,
	toNsec,
} from "../lib/identity.js";
import { heading, info, json, kv, ok, say, warn } from "../lib/output.js";
import { identityPath } from "../lib/paths.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";
import { signNonceEvent } from "../lib/proof.js";
import { readStdin } from "../lib/stdin.js";

export interface IdentityOptions {
	profile?: string;
	force?: boolean;
	yes?: boolean;
	hex?: boolean;
	nsec?: boolean;
	stdin?: boolean;
}

export function identityNewCommand(options: IdentityOptions): void {
	const profileName = resolveProfileName(options.profile);
	if (identityExists(profileName) && !options.force) {
		throw new AgxCliError(
			`Profile "${profileName}" already has an identity.`,
			{
				exitCode: EXIT.config,
				remediation:
					"A listing's address is immutable, so replacing a key orphans any listing bound to it. To make a second agent, use another profile:\n    agx identity new --profile second\n  To replace this one anyway:\n    agx identity new --force",
			},
		);
	}
	const identity = createIdentity("generated");
	saveIdentity(profileName, identity);

	heading("identity created");
	kv("profile", profileName);
	kv("npub", identity.npub);
	kv("pubkey", identity.publicKey);
	kv("file", identityPath(profileName));
	say("");
	info(
		"Register it in an agent index with:  agx register --slug <slug> --display-name <name> --capability <key>",
	);
	json({ npub: identity.npub, pubkey: identity.publicKey });
}

export function identityShowCommand(options: IdentityOptions): void {
	const profileName = resolveProfileName(options.profile);
	const identity = loadIdentityFile(profileName);
	heading("identity");
	kv("profile", profileName);
	kv("npub", identity.npub);
	kv("pubkey", identity.publicKey);
	kv("created", identity.createdAt);
	kv("source", identity.source);
	kv("file", identityPath(profileName));
	json({
		npub: identity.npub,
		pubkey: identity.publicKey,
		createdAt: identity.createdAt,
	});
}

export async function identityImportCommand(
	secret: string | undefined,
	options: IdentityOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	if (identityExists(profileName) && !options.force) {
		throw new AgxCliError(
			`Profile "${profileName}" already has an identity.`,
			{
				exitCode: EXIT.config,
				remediation:
					"Import into a fresh profile:\n    agx identity import <nsec> --profile imported\n  Or overwrite:  agx identity import <nsec> --force",
			},
		);
	}
	let raw = secret;
	if (options.stdin || !raw) {
		raw = await readStdin();
	}
	if (!raw?.trim()) {
		throw usageError(
			"No secret key provided.",
			"agx identity import nsec1…    (or pipe it: echo nsec1… | agx identity import --stdin)",
		);
	}
	const identity = identityFromSecret(parseSecretInput(raw), "imported");
	saveIdentity(profileName, identity);
	ok(`Imported identity ${identity.npub} into profile "${profileName}".`);
	json({ npub: identity.npub, pubkey: identity.publicKey });
}

export function identityExportCommand(options: IdentityOptions): void {
	const profileName = resolveProfileName(options.profile);
	const identity = loadIdentityFile(profileName);
	if (process.stdout.isTTY && !options.yes) {
		throw new AgxCliError(
			"Refusing to print a secret key to a terminal without confirmation.",
			{
				exitCode: EXIT.usage,
				remediation:
					"Pipe it somewhere, or confirm explicitly:\n    agx identity export --yes\n    agx identity export > key.txt",
			},
		);
	}
	// Deliberately bypasses the output helpers: this is data, not a report, and
	// must survive `--json` and a non-TTY pipe unchanged.
	console.log(
		options.hex
			? identity.secretKeyHex
			: toNsec(Buffer.from(identity.secretKeyHex, "hex")),
	);
}

/**
 * Sign an index key-possession challenge and print the signed event.
 *
 * This is the manual half of what `agx register` does end to end. `register`
 * fetches a nonce, signs it and submits the proof over HTTP with an API key;
 * this prints the signed event so it can be pasted into the index's submit
 * wizard, where the browser holds no private key and never should.
 *
 * The verifier checks exactly three things — the event's pubkey matches the key
 * being claimed, the content carries the nonce, and the signature validates —
 * so any signed event carrying the nonce works. This produces the most legible
 * one.
 *
 * NOTE: the index consumes the challenge atomically BEFORE verifying, so a
 * rejected proof burns the nonce. Every retry needs a fresh challenge.
 */
export async function identitySignCommand(
	nonce: string | undefined,
	options: IdentityOptions,
): Promise<void> {
	if (!nonce?.trim()) {
		throw usageError(
			"A challenge nonce is required.",
			"Request one from the index first — on its submit page in the browser, or with `agx register`.\n    agx identity sign <nonce>",
		);
	}

	const profileName = resolveProfileName(options.profile);
	const identity = loadIdentity(profileName);
	const event = await signNonceEvent(identity.signer, nonce.trim());

	// Deliberately bypasses the output helpers, for the same reason
	// `identityExportCommand` does: this is data to be pasted or piped, and it
	// must survive `--json` and a non-TTY pipe byte for byte.
	console.log(JSON.stringify(event));
}

export function identityAllowCommand(
	peers: string[],
	options: IdentityOptions,
): void {
	const profileName = resolveProfileName(options.profile);
	const profile = getProfile(profileName);
	const next = new Set(profile.allow);
	for (const peer of peers) {
		next.add(toHexPubkey(peer, "peer"));
	}
	updateProfile(profileName, { allow: [...next] });
	for (const peer of peers) {
		ok(`Allowed ${toDisplayNpub(peer)}`);
	}
	info(
		"A running `agx serve` picks this up on its next restart. Task requests from anyone else stay denied.",
	);
}

export function identityDenyCommand(
	peers: string[],
	options: IdentityOptions,
): void {
	const profileName = resolveProfileName(options.profile);
	const profile = getProfile(profileName);
	const remove = new Set(peers.map((p) => toHexPubkey(p, "peer")));
	updateProfile(profileName, {
		allow: profile.allow.filter((hex) => !remove.has(hex)),
	});
	for (const peer of peers) {
		ok(`Removed ${toDisplayNpub(peer)} from the allowlist.`);
	}
}

export function identityAllowListCommand(options: IdentityOptions): void {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	heading(`allowlist (profile "${profileName}")`);
	if (profile.allow.length === 0) {
		warn(
			"Empty — authorization is default-deny, so every task request will be refused.",
		);
		say(kleur.dim("  agx identity allow <npub>"));
	}
	for (const hex of profile.allow) {
		say(`  ${toDisplayNpub(hex)}`);
	}
	json({ allow: profile.allow.map(toDisplayNpub) });
}
