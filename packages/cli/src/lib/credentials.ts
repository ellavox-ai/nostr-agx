import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { configError } from "./errors.js";
import { credentialsPath, writePrivateJson } from "./paths.js";

/**
 * API keys live here, not in `config.json`, so the file `agx config show` reads
 * never holds one, and so each key carries the one origin it may be sent to.
 *
 *   { "version": 1, "profiles": { "<profile>": CredentialEntry } }
 *
 * Always written `0600` and atomically. Every write re-reads the file first, so
 * two processes (two terminals finishing `agx login` for different profiles)
 * do not drop each other's entries.
 *
 * Callers go through {@link CredentialStore}, so an OS keychain backend can
 * replace the file later without touching them.
 */

export const credentialSourceSchema = z.enum(["login", "manual", "migrated"]);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

export const credentialEntrySchema = z.object({
	/** The origin (scheme://host[:port]) this key was issued for. The ONLY
	 * origin it is ever sent to; a mismatch refuses the call before any
	 * request is made. */
	apiBaseUrl: z.string(),
	apiKey: z.string().min(1),
	apiKeyId: z.string().nullable(),
	source: credentialSourceSchema,
	clientId: z.literal("agx").nullable(),
	organization: z
		.object({ id: z.string(), slug: z.string(), name: z.string() })
		.nullable(),
	/** `email` is stored masked: nothing here needs the full address. */
	user: z.object({ id: z.string(), email: z.string().nullable() }).nullable(),
	scopes: z.array(z.string()).nullable(),
	/** ISO-8601, or null for a key that never expires. */
	expiresAt: z.string().nullable(),
	createdAt: z.string(),
});

export type CredentialEntry = z.infer<typeof credentialEntrySchema>;

const credentialsFileSchema = z.object({
	version: z.literal(1),
	profiles: z.record(z.string(), credentialEntrySchema),
});

type CredentialsFile = z.infer<typeof credentialsFileSchema>;

export interface CredentialStore {
	get(profile: string): CredentialEntry | null;
	set(profile: string, entry: CredentialEntry): void;
	/** Returns whether there was an entry to remove. */
	remove(profile: string): boolean;
	list(): Record<string, CredentialEntry>;
}

function readCredentialsFile(): CredentialsFile {
	const path = credentialsPath();
	if (!existsSync(path)) {
		return { version: 1, profiles: {} };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Never echo the parse error: it can quote the file, which holds keys.
		throw configError(
			`${path} is not valid JSON.`,
			`Move it aside and log in again:\n    mv ${path} ${path}.broken && agx login`,
		);
	}
	const parsed = credentialsFileSchema.safeParse(raw);
	if (!parsed.success) {
		throw configError(
			`${path} does not match the expected shape.`,
			`Move it aside and log in again:\n    mv ${path} ${path}.broken && agx login`,
		);
	}
	return parsed.data;
}

export const fileCredentialStore: CredentialStore = {
	get(profile) {
		return readCredentialsFile().profiles[profile] ?? null;
	},
	set(profile, entry) {
		const file = readCredentialsFile();
		file.profiles[profile] = credentialEntrySchema.parse(entry);
		writePrivateJson(credentialsPath(), file);
	},
	remove(profile) {
		const file = readCredentialsFile();
		if (!file.profiles[profile]) {
			return false;
		}
		delete file.profiles[profile];
		writePrivateJson(credentialsPath(), file);
		return true;
	},
	list() {
		return readCredentialsFile().profiles;
	},
};

let store: CredentialStore = fileCredentialStore;

export function credentialStore(): CredentialStore {
	return store;
}

/** Tests only. Returns a function that restores the previous store. */
export function setCredentialStoreForTests(next: CredentialStore): () => void {
	const previous = store;
	store = next;
	return () => {
		store = previous;
	};
}

export function getCredential(profile: string): CredentialEntry | null {
	return store.get(profile);
}

export function setCredential(profile: string, entry: CredentialEntry): void {
	store.set(profile, entry);
}

export function removeCredential(profile: string): boolean {
	return store.remove(profile);
}

export function listCredentials(): Record<string, CredentialEntry> {
	return store.list();
}

/** The origin of a URL, or null when it does not parse. */
export function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

export function isExpired(entry: CredentialEntry, now: number): boolean {
	if (!entry.expiresAt) {
		return false;
	}
	const at = Date.parse(entry.expiresAt);
	return Number.isFinite(at) && at <= now;
}
