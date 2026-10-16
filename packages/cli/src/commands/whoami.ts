import {
	createApiClient,
	OWNER_NOT_MEMBER_REMEDIATION,
	toCliError,
} from "../lib/api.js";
import {
	getProfile,
	type ResolvedApiKey,
	resolveApiKey,
	resolveProfileName,
} from "../lib/config.js";
import { getCredential } from "../lib/credentials.js";
import { AgxCliError, authError, EXIT } from "../lib/errors.js";
import { heading, json, kv, maskEmail, say, warn } from "../lib/output.js";

/**
 * `agx whoami`: who the stored credential acts as, according to the server
 * (`account.principal.get`, LOGIN-CONTRACT.md §1.5). Never prints the key.
 *
 * A key whose owner has left the key's organization is answered with
 * `organization: null`: whoami prints that (exit 4, after the `--json`
 * document), never the organization agx remembers from the login.
 */

export interface WhoamiOptions {
	profile?: string;
}

/** The LOGIN-CONTRACT.md §1.5 output, as loosely as the CLI needs it.
 * Timestamps may arrive as ISO strings (the contract) or, from an older
 * serializer, as `Date`s. */
interface Principal {
	authMethod?: string;
	user?: { id: string; emailMasked?: string | null } | null;
	organization?: {
		id: string;
		slug: string;
		name: string;
		role?: string | null;
	} | null;
	apiKey?: {
		id: string;
		name?: string | null;
		scoped?: boolean;
		scopes?: string[];
		clientId?: string | null;
		hostLabel?: string | null;
		expiresAt?: string | Date | null;
	} | null;
}

export function toIsoString(value: unknown): string | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** True when nothing at all would authenticate this profile. */
export function isLoggedOut(profileName: string): boolean {
	return (
		!process.env.AGX_API_KEY &&
		!getCredential(profileName) &&
		!getProfile(profileName).apiKey
	);
}

export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	if (isLoggedOut(profileName)) {
		json({ loggedIn: false, profile: profileName });
		throw authError(
			`Profile "${profileName}" is not logged in.`,
			"agx login",
		);
	}
	const key: ResolvedApiKey = resolveApiKey(profileName);
	const entry = key.entry;

	let principal: Principal | null = null;
	try {
		principal = (await createApiClient(key).account.principal.get(
			{},
		)) as Principal;
	} catch (error) {
		const err = error as {
			status?: number;
			code?: string;
			data?: { code?: unknown };
		};
		const oldServer =
			(err?.status === 404 || err?.code === "NOT_FOUND") &&
			typeof err?.data?.code !== "string";
		if (!oldServer) {
			throw toCliError(error, "account.principal.get", key.baseUrl);
		}
	}

	const verified = principal !== null;
	// Once the server has answered, its word on the organization stands: an
	// API key with `organization: null` belongs to an account that is no
	// longer a member of the key's organization (LOGIN-CONTRACT.md §1.5).
	const ownerLeftOrg =
		principal !== null &&
		principal.organization === null &&
		principal.authMethod !== "session";
	const result = {
		loggedIn: true,
		verified,
		profile: profileName,
		apiBaseUrl: key.baseUrl,
		source: key.source,
		user: principal?.user
			? {
					id: principal.user.id,
					email: maskEmail(principal.user.emailMasked ?? null),
				}
			: entry?.user
				? { id: entry.user.id, email: maskEmail(entry.user.email) }
				: null,
		organization: principal
			? principal.organization
				? {
						id: principal.organization.id,
						slug: principal.organization.slug,
						name: principal.organization.name,
						role: principal.organization.role ?? null,
					}
				: null
			: entry?.organization
				? { ...entry.organization, role: null }
				: null,
		apiKey: principal?.apiKey
			? {
					id: principal.apiKey.id,
					name: principal.apiKey.name ?? null,
					scoped: principal.apiKey.scoped ?? false,
					scopes: principal.apiKey.scopes ?? [],
					clientId: principal.apiKey.clientId ?? null,
					hostLabel: principal.apiKey.hostLabel ?? null,
					expiresAt: toIsoString(principal.apiKey.expiresAt),
				}
			: entry
				? {
						id: entry.apiKeyId,
						name: null,
						scoped: entry.clientId === "agx",
						scopes: entry.scopes ?? [],
						clientId: entry.clientId,
						hostLabel: null,
						expiresAt: entry.expiresAt,
					}
				: null,
	};

	heading(`profile "${profileName}"`);
	kv("user", result.user?.email ?? result.user?.id ?? null);
	kv(
		"organization",
		result.organization
			? `${result.organization.slug}${result.organization.role ? ` (${result.organization.role})` : ""}`
			: null,
	);
	kv(
		"scopes",
		result.apiKey?.scoped
			? result.apiKey.scopes.join(", ")
			: "full access (unscoped key)",
	);
	kv("expires", result.apiKey?.expiresAt ?? "never");
	kv("source", key.source);
	kv("server", key.baseUrl);
	if (!verified) {
		say("");
		warn(
			"This server has no whoami endpoint; the details above are agx's local record, not confirmed by the server.",
		);
	}
	json(result);
	if (ownerLeftOrg) {
		const slug = entry?.organization?.slug;
		throw new AgxCliError(
			`Profile "${profileName}": the account that owns this key is no longer a member of its organization${slug ? ` (${slug})` : ""}, so the key cannot act on it.`,
			{ exitCode: EXIT.auth, remediation: OWNER_NOT_MEMBER_REMEDIATION },
		);
	}
}
