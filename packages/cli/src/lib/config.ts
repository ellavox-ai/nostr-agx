import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
	type CredentialEntry,
	type CredentialSource,
	getCredential,
	isExpired,
	originOf,
	setCredential,
} from "./credentials.js";
import {
	AgxCliError,
	authError,
	configError,
	EXIT,
	type ExitCode,
	usageError,
} from "./errors.js";
import { notice } from "./output.js";
import { configPath, writePrivateJson } from "./paths.js";
import { runtime } from "./runtime.js";
import {
	isWellFormedApiKey,
	malformedApiKeyError,
	rememberSecret,
} from "./secrets.js";

/**
 * Profile store. A profile is one (identity, API credential, organization,
 * relay set, peer allowlist) tuple — so "the same agent seen by another org" and
 * "a second agent on the same relay" are both just a second profile, which is
 * what makes the cross-org discovery step of the walkthrough runnable at all.
 */

/** Where a new profile, and `agx login`, point by default. */
export const DEFAULT_API_BASE_URL = "https://app.ellaworks.ai";

/** The 0.3 default. A profile that still stores it is treated as "never set"
 * by `agx login` only; every other command keeps using what is stored. */
export const LEGACY_DEFAULT_API_BASE_URL = "http://localhost:3000";

export const profileSchema = z.object({
	apiBaseUrl: z.string().default(DEFAULT_API_BASE_URL),
	/** 0.3 kept the API key here. 0.4 never writes one; a stored one is still
	 * read (lowest precedence) and is moved to `credentials.json` on the next
	 * config write. */
	apiKey: z.string().nullable().default(null),
	orgSlug: z.string().nullable().default(null),
	relays: z.array(z.string()).default(["ws://127.0.0.1:7447"]),
	/** Display label advertised on the Agent Card. */
	org: z.string().nullable().default(null),
	nip05: z.string().nullable().default(null),
	/** Hex pubkeys this agent will accept task requests from. Default-deny: an
	 * empty list means nobody, which is the SPEC's required posture. */
	allow: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof profileSchema>;

export const configSchema = z.object({
	version: z.literal(1).default(1),
	currentProfile: z.string().default("default"),
	profiles: z.record(z.string(), profileSchema).default({}),
});

export type AgxConfig = z.infer<typeof configSchema>;

const EMPTY_PROFILE: Profile = profileSchema.parse({});

export function loadConfig(): AgxConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return configSchema.parse({});
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw configError(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			`Fix or delete the file, then re-run: rm ${path}`,
		);
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw configError(
			`${path} does not match the expected shape.`,
			`Fix or delete the file, then re-run: rm ${path}`,
		);
	}
	return parsed.data;
}

export function saveConfig(config: AgxConfig): void {
	writePrivateJson(configPath(), migrateLegacyKeys(config, storedConfig()));
}

/** `config.json` as it is on disk right now, or null if there is none (or it
 * cannot be read, in which case there is nothing on disk to migrate from). */
function storedConfig(): AgxConfig | null {
	try {
		return existsSync(configPath()) ? loadConfig() : null;
	} catch {
		return null;
	}
}

/**
 * Move every 0.3 `config.json` key into `credentials.json` now, before
 * anything else changes the profile. A caller about to change `apiBaseUrl`
 * runs this first, so the key is bound (and any mismatch reported) against
 * the server it was used with.
 */
export function migrateLegacyKeysNow(): void {
	const config = storedConfig();
	if (config && Object.values(config.profiles).some((p) => p.apiKey)) {
		saveConfig(config);
	}
}

/**
 * Move every 0.3 `config.json` key into `credentials.json` (as
 * `source: "migrated"`) before `config.json` is written again. The credential
 * is written first, so a crash between the two writes leaves the key in both
 * files, never in neither.
 *
 * The key is bound to the `apiBaseUrl` stored NEXT TO IT on disk — the server
 * it was used with — never to one this very write is about to set: otherwise
 * `agx config set apiBaseUrl <other>` would hand an old key to the new server.
 */
function migrateLegacyKeys(
	config: AgxConfig,
	stored: AgxConfig | null,
): AgxConfig {
	for (const [name, profile] of Object.entries(config.profiles)) {
		if (!profile.apiKey) {
			continue;
		}
		if (getCredential(name)) {
			notice(
				`Removed the API key of profile "${name}" from config.json: credentials.json already holds this profile's credential, which takes precedence.`,
			);
		} else {
			const before = stored?.profiles[name];
			const usedWith =
				before?.apiKey === profile.apiKey
					? before.apiBaseUrl
					: profile.apiBaseUrl;
			const origin = originOf(usedWith);
			if (!origin) {
				// Cannot bind it to an origin; leave it where it is rather than
				// lose it. `agx doctor` reports the bad apiBaseUrl.
				continue;
			}
			setCredential(name, {
				apiBaseUrl: origin,
				apiKey: profile.apiKey,
				apiKeyId: null,
				source: "migrated",
				clientId: null,
				organization: null,
				user: null,
				scopes: null,
				expiresAt: null,
				createdAt: new Date(runtime().now()).toISOString(),
			});
			notice(
				`Moved the API key of profile "${name}" from config.json to credentials.json; it is now only ever sent to ${origin}.`,
			);
		}
		profile.apiKey = null;
	}
	return config;
}

/** Resolve the active profile name: flag, then env, then the stored default. */
export function resolveProfileName(flag?: string): string {
	return flag ?? process.env.AGX_PROFILE ?? loadConfig().currentProfile;
}

export function getProfile(name: string): Profile {
	const config = loadConfig();
	return config.profiles[name] ?? { ...EMPTY_PROFILE };
}

export function saveProfile(name: string, profile: Profile): void {
	const config = loadConfig();
	config.profiles[name] = profile;
	if (!config.profiles[config.currentProfile]) {
		config.currentProfile = name;
	}
	saveConfig(config);
}

export function updateProfile(name: string, patch: Partial<Profile>): Profile {
	const next = { ...getProfile(name), ...patch };
	saveProfile(name, next);
	return next;
}

/** Environment overrides are applied per-read rather than persisted, so a
 * one-off `AGX_API_KEY=… agx search` never mutates the stored profile. */
export function effectiveProfile(name: string): Profile {
	const stored = getProfile(name);
	return {
		...stored,
		apiBaseUrl: process.env.AGX_API_URL ?? stored.apiBaseUrl,
		apiKey: process.env.AGX_API_KEY ?? stored.apiKey,
		orgSlug: process.env.AGX_ORG ?? stored.orgSlug,
		relays: process.env.AGX_RELAY
			? process.env.AGX_RELAY.split(",").map((r) => r.trim())
			: stored.relays,
	};
}

export interface ApiCredentials {
	baseUrl: string;
	apiKey: string;
	orgSlug: string;
}

/** Where a key came from, in precedence order. */
export type ApiKeySource = "env" | CredentialSource | "legacy-config";

export interface ResolvedApiKey {
	profileName: string;
	/** The effective API base, already checked by {@link assertApiBaseUrl}. */
	baseUrl: string;
	apiKey: string;
	source: ApiKeySource;
	/** The `credentials.json` entry the key came from, if it came from one. */
	entry: CredentialEntry | null;
}

export interface ResolvedApiCredentials extends ApiCredentials, ResolvedApiKey {}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

/**
 * Check a base URL before any credential is sent to it, and normalise it (no
 * trailing slash).
 *
 * - `https:`, or `http:` only for localhost / 127.0.0.1 / ::1: a key sent over
 *   plain http to anything else is readable by every hop in between;
 * - no user name or password, query or fragment: none of them belong in a base
 *   URL, and each is a way to smuggle a lookalike past a reader.
 */
export function assertApiBaseUrl(
	raw: string,
	options?: { exitCode?: ExitCode; label?: string },
): string {
	const exitCode = options?.exitCode ?? EXIT.config;
	const label = options?.label ?? "apiBaseUrl";
	const fail = (problem: string, shown: string) =>
		new AgxCliError(`${label} ${shown} ${problem}`, {
			exitCode,
			remediation: `Use the server's origin, for example ${DEFAULT_API_BASE_URL}, or http://localhost:3000 for a local stack.`,
		});
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw fail("is not a URL.", JSON.stringify(raw));
	}
	if (url.username || url.password) {
		// Never echo it: the password is the part that would be printed.
		throw fail("must not contain a user name or password.", "(redacted)");
	}
	const shown = JSON.stringify(raw);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw fail("must be an https:// URL.", shown);
	}
	if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
		throw fail("must not contain a query or fragment.", shown);
	}
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
		throw fail(
			"uses plain http, which is only allowed for localhost, 127.0.0.1 and ::1.",
			shown,
		);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The API base every API command talks to: `AGX_API_URL`, else the profile's. */
export function effectiveApiBaseUrl(profileName: string): {
	raw: string;
	label: string;
} {
	const env = process.env.AGX_API_URL;
	return env
		? { raw: env, label: "AGX_API_URL" }
		: {
				raw: getProfile(profileName).apiBaseUrl,
				label: `apiBaseUrl of profile "${profileName}"`,
			};
}

/**
 * Whether someone chose the server {@link effectiveApiBaseUrl} names:
 * `AGX_API_URL` is set, or the profile stores an `apiBaseUrl` on another
 * origin than a built-in default. A stored default says nothing either way:
 * config.json records {@link DEFAULT_API_BASE_URL} the first time anything
 * writes the profile, and every 0.3 profile stored
 * {@link LEGACY_DEFAULT_API_BASE_URL} without anyone choosing it.
 */
export function apiBaseUrlWasChosen(profileName: string): boolean {
	if (process.env.AGX_API_URL) {
		return true;
	}
	const origin = originOf(getProfile(profileName).apiBaseUrl);
	return (
		origin !== null &&
		origin !== originOf(DEFAULT_API_BASE_URL) &&
		origin !== originOf(LEGACY_DEFAULT_API_BASE_URL)
	);
}

/**
 * The extra way out for a key that was stored by hand (`manual`) or moved out
 * of a 0.3 `config.json` (`migrated`): such a key is bound to whatever server
 * the profile named when it was stored, so a Settings key stored BEFORE
 * `apiBaseUrl` was set is bound to the default server. If it really belongs to
 * `targetOrigin`, storing it again binds it there. agx never rebinds a key on
 * its own: that would undo the binding.
 */
export function rebindHint(
	source: CredentialSource,
	targetOrigin: string,
): string {
	if (source === "login") {
		return "";
	}
	return `\n  or, if this is a Settings key minted on ${targetOrigin}, store it again now that the profile points there:\n    printf %s "$KEY" | agx config set apiKey --stdin`;
}

/**
 * Find the API key for a profile, in precedence order:
 *
 *   1. `AGX_API_KEY` (the caller supplied both key and target; no binding);
 *   2. the profile's `credentials.json` entry, which is refused outright when
 *      its origin is not the effective base's origin (exit 3, nothing sent) and
 *      when it has expired (exit 4);
 *   3. a 0.3 key still in `config.json`.
 *
 * None of them: exit 3 with `agx login`.
 */
export function resolveApiKey(profileName: string): ResolvedApiKey {
	const base = effectiveApiBaseUrl(profileName);
	const baseUrl = assertApiBaseUrl(base.raw, { label: base.label });

	const envKey = process.env.AGX_API_KEY;
	if (envKey) {
		if (!isWellFormedApiKey(envKey)) {
			throw malformedApiKeyError("AGX_API_KEY", {
				remediation:
					"Set AGX_API_KEY to the key alone (no spaces or line breaks), or unset it to use this profile's own credential:\n    unset AGX_API_KEY",
			});
		}
		rememberSecret(envKey);
		return {
			profileName,
			baseUrl,
			apiKey: envKey,
			source: "env",
			entry: null,
		};
	}

	const entry = getCredential(profileName);
	if (entry) {
		const keyOrigin = originOf(entry.apiBaseUrl);
		const targetOrigin = originOf(baseUrl);
		if (!keyOrigin || keyOrigin !== targetOrigin) {
			throw configError(
				`The credential of profile "${profileName}" was issued for ${keyOrigin ?? entry.apiBaseUrl}, but this command would send it to ${targetOrigin}. Nothing was sent.`,
				`A key is only ever sent to the server that issued it. Either go back to that server:\n    agx config set apiBaseUrl ${keyOrigin ?? entry.apiBaseUrl}${process.env.AGX_API_URL ? "\n  (and unset AGX_API_URL)" : ""}\n  or log in to this one:\n    agx login --api-base-url ${targetOrigin}${rebindHint(entry.source, targetOrigin ?? baseUrl)}`,
			);
		}
		if (isExpired(entry, runtime().now())) {
			throw authError(
				`The login of profile "${profileName}" expired on ${entry.expiresAt}.`,
				"Log in again:\n    agx login",
			);
		}
		if (!isWellFormedApiKey(entry.apiKey)) {
			throw malformedApiKeyError(
				`The API key stored for profile "${profileName}" in credentials.json`,
			);
		}
		rememberSecret(entry.apiKey);
		return {
			profileName,
			baseUrl,
			apiKey: entry.apiKey,
			source: entry.source,
			entry,
		};
	}

	const stored = getProfile(profileName);
	if (stored.apiKey) {
		if (!isWellFormedApiKey(stored.apiKey)) {
			throw malformedApiKeyError(
				`The 0.3 API key of profile "${profileName}" in config.json`,
			);
		}
		rememberSecret(stored.apiKey);
		return {
			profileName,
			baseUrl,
			apiKey: stored.apiKey,
			source: "legacy-config",
			entry: null,
		};
	}

	throw configError(
		`Profile "${profileName}" is not logged in.`,
		"agx login\n  (CI: printf %s \"$KEY\" | agx config set apiKey --stdin)",
	);
}

/**
 * Everything an Agent Index call needs: {@link resolveApiKey} plus the
 * organization, from `--org` > `AGX_ORG` > the profile's `orgSlug` > the
 * login's own organization.
 *
 * A login key is bound to one organization, so asking it to act on another is
 * refused here (exit 4) rather than by a 403 from the server.
 */
export function resolveApiCredentials(
	profileName: string,
	options?: { org?: string },
): ResolvedApiCredentials {
	const key = resolveApiKey(profileName);
	const loginOrg = key.entry?.organization?.slug ?? null;
	const orgSlug =
		options?.org ??
		process.env.AGX_ORG ??
		getProfile(profileName).orgSlug ??
		loginOrg;
	if (!orgSlug) {
		throw configError(
			`Profile "${profileName}" has no organization slug.`,
			"agx login   (or: agx config set orgSlug <slug>)",
		);
	}
	if (loginOrg && orgSlug !== loginOrg) {
		throw authError(
			`This login is for organization "${loginOrg}", not "${orgSlug}".`,
			`A login key acts on one organization. Log in to the other one in its own profile:\n    agx --profile ${orgSlug} login --org ${orgSlug}`,
		);
	}
	return { ...key, orgSlug };
}

const SETTABLE = [
	"apiBaseUrl",
	"apiKey",
	"orgSlug",
	"relays",
	"org",
	"nip05",
] as const;

export type SettableKey = (typeof SETTABLE)[number];

export function assertSettableKey(key: string): SettableKey {
	if (!(SETTABLE as readonly string[]).includes(key)) {
		throw usageError(
			`Unknown config key "${key}".`,
			`Settable keys: ${SETTABLE.join(", ")}`,
		);
	}
	return key as SettableKey;
}

export function coerceSettableValue(
	key: SettableKey,
	value: string,
): Partial<Profile> {
	if (key === "relays") {
		return {
			relays: value
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean),
		};
	}
	return { [key]: value } as Partial<Profile>;
}
