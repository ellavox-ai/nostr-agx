import { existsSync, readFileSync } from "node:fs";
import {
	type AgxSigner,
	bytesToHex,
	generateKeypair,
	hexToBytes,
	localSigner,
	publicKeyFromSecret,
	toNpub,
} from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { z } from "zod";
import { AgxCliError, configError, EXIT, usageError } from "./errors.js";
import { identityPath, isTooPermissive, writePrivateJson } from "./paths.js";

/**
 * The agent's secp256k1 identity. Stored as hex — that is the form every call
 * site wants, and it keeps the file diffable; `agx identity export --nsec`
 * produces the portable NIP-19 form on demand. `@nostr-agx/core`/`@nostr-agx/nostr`
 * deliberately expose no nsec codec, so `nostr-tools`' `nip19` is used directly.
 */

const identityFileSchema = z.object({
	version: z.literal(1),
	secretKeyHex: z.string().length(64),
	publicKey: z.string().length(64),
	npub: z.string(),
	createdAt: z.string(),
	source: z.enum(["generated", "imported"]),
});

export type IdentityFile = z.infer<typeof identityFileSchema>;

export interface Identity {
	/** Everything that signs or decrypts goes through this; the raw key stays in
	 * the identity file and is only read back out by `agx identity export`. */
	signer: AgxSigner;
	publicKey: string;
	npub: string;
}

export function createIdentity(
	source: "generated" | "imported" = "generated",
): IdentityFile {
	const { secretKey, publicKey } = generateKeypair();
	return {
		version: 1,
		secretKeyHex: bytesToHex(secretKey),
		publicKey,
		npub: toNpub(publicKey),
		createdAt: new Date().toISOString(),
		source,
	};
}

export function identityFromSecret(
	secretKey: Uint8Array,
	source: "generated" | "imported",
): IdentityFile {
	let publicKey: string;
	try {
		publicKey = publicKeyFromSecret(secretKey);
	} catch {
		throw usageError(SECRET_IS_NOT_USABLE);
	}
	return {
		version: 1,
		secretKeyHex: bytesToHex(secretKey),
		publicKey,
		npub: toNpub(publicKey),
		createdAt: new Date().toISOString(),
		source,
	};
}

/** Printed for every nsec that does not decode. Fixed text, never built from the
 * input or from the decoder's own message: nostr-tools quotes its whole input in
 * it ("Invalid checksum in nsec1…"), and the secret key must not be printed. */
const NSEC_DOES_NOT_DECODE =
	"Could not decode that nsec: it is not a valid secret key (a character is wrong or missing). It is not shown here.";

/** Printed for a key that decodes but cannot be a secret key: all zeros, not below
 * the curve order, or not 32 bytes. Fixed text, never built from the input or from
 * the curve library's own message. */
const SECRET_IS_NOT_USABLE =
	"Could not use that secret key: it decodes, but it is not a valid secret key (for example all zeros, out of range, or not 32 bytes long). It is not shown here.";

/** Accept either an `nsec1…` (also in capitals, or behind `nostr:`) or a bare 64-char hex secret. */
export function parseSecretInput(input: string): Uint8Array {
	const trimmed = input.trim();
	const unprefixed = trimmed.replace(/^nostr:/i, "");
	if (/^nsec1/i.test(unprefixed)) {
		try {
			const decoded = nip19.decode(unprefixed);
			if (decoded.type !== "nsec") {
				throw new Error(`expected an nsec, got ${decoded.type}`);
			}
			return decoded.data as Uint8Array;
		} catch {
			throw usageError(NSEC_DOES_NOT_DECODE);
		}
	}
	if (/^[0-9a-f]{64}$/i.test(trimmed)) {
		return hexToBytes(trimmed.toLowerCase());
	}
	throw usageError(
		"Expected an `nsec1…` key or a 64-character hex secret key.",
	);
}

export function toNsec(secretKey: Uint8Array): string {
	return nip19.nsecEncode(secretKey);
}

/**
 * Write the identity file. Unless `replace` is set, the file is created only if
 * nothing is there when it is written, and `PrivateFileExistsError` is thrown
 * when something is: a look at `identityExists` a moment earlier does not stop a
 * second writer, and a secret key must not be replaced by accident.
 */
export function saveIdentity(
	profile: string,
	identity: IdentityFile,
	options?: { replace?: boolean },
): void {
	writePrivateJson(identityPath(profile), identity, {
		exclusive: !options?.replace,
	});
}

export function identityExists(profile: string): boolean {
	return existsSync(identityPath(profile));
}

export function loadIdentityFile(
	profile: string,
	options?: { allowInsecurePerms?: boolean },
): IdentityFile {
	const path = identityPath(profile);
	if (!existsSync(path)) {
		throw configError(
			`Profile "${profile}" has no identity.`,
			"agx identity new",
		);
	}
	if (!options?.allowInsecurePerms && isTooPermissive(path)) {
		throw new AgxCliError(
			`${path} is readable by other users and holds your secret key.`,
			{
				exitCode: EXIT.config,
				remediation: `chmod 600 ${path}\n  (or run: agx doctor --fix-perms)`,
			},
		);
	}
	const parsed = identityFileSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		throw configError(
			`${path} is not a valid agx identity file.`,
			`Back it up and regenerate: mv ${path} ${path}.bak && agx identity new`,
		);
	}
	return parsed.data;
}

export function loadIdentity(
	profile: string,
	options?: { allowInsecurePerms?: boolean },
): Identity {
	const file = loadIdentityFile(profile, options);
	return {
		signer: localSigner(hexToBytes(file.secretKeyHex)),
		publicKey: file.publicKey,
		npub: file.npub,
	};
}
