import {
	BEST_EFFORT_RPC_TIMEOUT_MS,
	createApiClient,
	toCliError,
} from "../lib/api.js";
import {
	assertApiBaseUrl,
	assertSettableKey,
	coerceSettableValue,
	effectiveApiBaseUrl,
	effectiveProfile,
	getProfile,
	loadConfig,
	migrateLegacyKeysNow,
	rebindHint,
	resolveProfileName,
	saveConfig,
	updateProfile,
} from "../lib/config.js";
import {
	type CredentialEntry,
	getCredential,
	originOf,
	setCredential,
} from "../lib/credentials.js";
import { EXIT, usageError } from "../lib/errors.js";
import {
	heading,
	info,
	json,
	kv,
	maskKey,
	notice,
	ok,
	say,
} from "../lib/output.js";
import { configPath, credentialsPath } from "../lib/paths.js";
import { runtime } from "../lib/runtime.js";
import {
	isWellFormedApiKey,
	malformedApiKeyError,
	rememberSecret,
} from "../lib/secrets.js";
import { readSecretLine, stdinIsTTY } from "../lib/stdin.js";

export interface ConfigOptions {
	profile?: string;
	reveal?: boolean;
	stdin?: boolean;
}

/** What `config show` says about the credential, never the key itself. */
function credentialSummary(profileName: string): {
	source: string;
	origin: string | null;
	organization: string | null;
	expiresAt: string | null;
	key: string | null;
} | null {
	if (process.env.AGX_API_KEY) {
		return {
			source: "env (AGX_API_KEY)",
			origin: null,
			organization: null,
			expiresAt: null,
			key: maskKey(process.env.AGX_API_KEY),
		};
	}
	const entry = getCredential(profileName);
	if (entry) {
		return {
			source: entry.source,
			origin: entry.apiBaseUrl,
			organization: entry.organization?.slug ?? null,
			expiresAt: entry.expiresAt,
			key: maskKey(entry.apiKey),
		};
	}
	const legacy = getProfile(profileName).apiKey;
	if (legacy) {
		return {
			source: "legacy config.json key",
			origin: null,
			organization: null,
			expiresAt: null,
			key: maskKey(legacy),
		};
	}
	return null;
}

export function configShowCommand(options: ConfigOptions): void {
	if (options.reveal) {
		throw usageError(
			"`agx config show --reveal` was removed: agx no longer prints API keys.",
			"`agx whoami` shows what the key can do; Settings → API keys shows the key itself.",
		);
	}
	const profileName = resolveProfileName(options.profile);
	const { apiKey: _key, ...profile } = effectiveProfile(profileName);
	const credentials = credentialSummary(profileName);
	heading(`profile "${profileName}"`);
	kv("apiBaseUrl", profile.apiBaseUrl);
	kv(
		"credentials",
		credentials
			? `${credentials.source}${credentials.organization ? ` · org ${credentials.organization}` : ""}${credentials.expiresAt ? ` · expires ${credentials.expiresAt.slice(0, 10)}` : ""}${credentials.origin ? ` · ${credentials.origin}` : ""}`
			: "not logged in (agx login)",
	);
	kv("orgSlug", profile.orgSlug);
	kv("relays", profile.relays.join(", "));
	kv("org", profile.org);
	kv("nip05", profile.nip05);
	kv("allow", `${profile.allow.length} peer(s)`);
	kv("file", configPath());
	json({ profile: profileName, ...profile, credentials });
}

async function setApiKey(
	profileName: string,
	value: string | undefined,
	options: ConfigOptions,
): Promise<void> {
	let key: string;
	if (value !== undefined && !options.stdin) {
		notice(
			"Passing a key as an argument is deprecated: it lands in shell history and the process list. Use:\n    printf %s \"$KEY\" | agx config set apiKey --stdin",
		);
		key = value.trim();
	} else if (options.stdin || !stdinIsTTY()) {
		key = await readSecretLine("API key");
	} else {
		throw usageError(
			"No key given.",
			'Pipe it in, so it never appears in argv:\n    printf %s "$KEY" | agx config set apiKey --stdin\n  Or, for an interactive login:  agx login',
		);
	}
	if (!key) {
		throw usageError("The key is empty.");
	}
	if (!isWellFormedApiKey(key)) {
		throw malformedApiKeyError("The value given", {
			exitCode: EXIT.usage,
			remediation:
				'Pipe exactly the key, on one line:\n    printf %s "$KEY" | agx config set apiKey --stdin',
		});
	}
	rememberSecret(key);
	const base = effectiveApiBaseUrl(profileName);
	const baseUrl = assertApiBaseUrl(base.raw, { label: base.label });
	const origin = originOf(baseUrl) ?? baseUrl;
	const entry: CredentialEntry = {
		apiBaseUrl: origin,
		apiKey: key,
		apiKeyId: null,
		source: "manual",
		clientId: null,
		organization: null,
		user: null,
		scopes: null,
		expiresAt: null,
		createdAt: new Date(runtime().now()).toISOString(),
	};
	setCredential(profileName, entry);
	if (getProfile(profileName).apiKey) {
		updateProfile(profileName, { apiKey: null });
	}
	ok(
		`Stored the API key for profile "${profileName}" in ${credentialsPath()}; it is only ever sent to ${origin}.`,
	);

	// The key is stored whatever happens next. Recording its id now means a
	// later `agx logout` can revoke it without asking the server who it is.
	const apiKeyId = await lookUpKeyId(origin, key);
	if (apiKeyId && getCredential(profileName)?.apiKey === key) {
		setCredential(profileName, { ...entry, apiKeyId });
	}
}

/**
 * Best effort: the id of `apiKey` according to `account.principal.get` at its
 * own origin (LOGIN-CONTRACT.md §1.5), or null. Never throws: offline, a
 * timeout, a server without the procedure or one that refuses the key all
 * leave the key stored without an id, which `agx logout` looks up itself.
 * A refusal, or a key whose owner has left its organization, gets a notice.
 */
async function lookUpKeyId(
	origin: string,
	apiKey: string,
): Promise<string | null> {
	let principal: {
		authMethod?: unknown;
		organization?: unknown;
		apiKey?: { id?: unknown } | null;
	} | null;
	try {
		principal = (await createApiClient(
			{ baseUrl: origin, apiKey },
			{ timeoutMs: BEST_EFFORT_RPC_TIMEOUT_MS },
		).account.principal.get({})) as typeof principal;
	} catch (error) {
		const cli = toCliError(error, "account.principal.get", origin);
		if (cli.exitCode === EXIT.auth) {
			notice(
				`${origin} refused this key (${cli.message}). It is stored all the same; check it with:\n    agx whoami`,
			);
		}
		return null;
	}
	if (
		principal?.organization === null &&
		principal.authMethod !== "session"
	) {
		notice(
			"The account that owns this key is no longer a member of its organization, so the key cannot act on it.",
		);
	}
	const id = principal?.apiKey?.id;
	// It is stored and printed later: an identifier, never free text.
	return typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id)
		? id
		: null;
}

export async function configSetCommand(
	key: string,
	value: string | undefined,
	options: ConfigOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const settable = assertSettableKey(key);
	if (settable === "apiKey") {
		await setApiKey(profileName, value, options);
		return;
	}
	let raw = value;
	if (options.stdin) {
		raw = await readSecretLine(settable);
	}
	if (raw === undefined) {
		throw usageError(
			`No value given for ${settable}.`,
			`agx config set ${settable} <value>`,
		);
	}
	const patch = coerceSettableValue(settable, raw);
	if (settable === "apiBaseUrl" && patch.apiBaseUrl) {
		patch.apiBaseUrl = assertApiBaseUrl(patch.apiBaseUrl, {
			exitCode: EXIT.usage,
			label: "apiBaseUrl",
		});
		// A 0.3 key still in config.json belongs to the server it was used
		// with. Move it now, bound to that server, so the check below sees it.
		migrateLegacyKeysNow();
		const entry = getCredential(profileName);
		const target = originOf(patch.apiBaseUrl) ?? patch.apiBaseUrl;
		if (entry && originOf(entry.apiBaseUrl) !== target) {
			notice(
				`The stored credential of profile "${profileName}" belongs to ${entry.apiBaseUrl}, so API commands will refuse to send it to ${target}. Log in there:\n    agx login${rebindHint(entry.source, target)}`,
			);
		}
	}
	updateProfile(profileName, patch);
	ok(`Set ${settable} on profile "${profileName}".`);
}

export function configUseCommand(profileName: string): void {
	const config = loadConfig();
	if (!config.profiles[profileName]) {
		// Creating on switch is deliberate: a new profile is the supported way to
		// hold a second identity or a second organization's key.
		config.profiles[profileName] = getProfile(profileName);
		info(`Created profile "${profileName}".`);
	}
	config.currentProfile = profileName;
	saveConfig(config);
	ok(`Active profile is now "${profileName}".`);
}

export function configListCommand(): void {
	const config = loadConfig();
	const names = Object.keys(config.profiles);
	heading("profiles");
	if (names.length === 0) {
		say("  (none yet — `agx login` or `agx config set orgSlug acme` creates one)");
	}
	for (const name of names) {
		const marker = name === config.currentProfile ? "*" : " ";
		const profile = config.profiles[name];
		say(`${marker} ${name.padEnd(16)} ${profile?.orgSlug ?? "—"}`);
	}
	json({ current: config.currentProfile, profiles: names });
}

export function configPathCommand(): void {
	console.log(configPath());
}

export function assertConfigSubcommand(sub: string): void {
	const known = ["show", "set", "use", "list", "path"];
	if (!known.includes(sub)) {
		throw usageError(
			`Unknown config subcommand "${sub}".`,
			`Try one of: ${known.join(", ")}`,
		);
	}
}
