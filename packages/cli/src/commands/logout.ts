import { createApiClient, isKeyRejected, toCliError } from "../lib/api.js";
import {
	getProfile,
	loadConfig,
	resolveProfileName,
	updateProfile,
} from "../lib/config.js";
import {
	type CredentialEntry,
	getCredential,
	listCredentials,
	originOf,
	removeCredential,
} from "../lib/credentials.js";
import { removePendingLogin } from "../lib/device-flow.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { json, notice, ok, warn } from "../lib/output.js";
import { isWellFormedApiKey } from "../lib/secrets.js";

/**
 * `agx logout`: revoke the profile's key on the server, then forget it.
 *
 * A key is revoked against the origin it was issued for, never the current
 * `apiBaseUrl`, through the self-revoke `prm.apiKeys.delete`
 * (LOGIN-CONTRACT.md §1.6). A key
 * the server refuses as invalid or expired (401 `API_KEY_INVALID` or
 * `API_KEY_EXPIRED`, or an older server's exact "Invalid API key", see
 * {@link isKeyRejected}) is simply forgotten. Any other failure — the server
 * unreachable, a 404 because it has no self-revoke, any other 401 — keeps the
 * key, so it can still be revoked, unless `--local`.
 */

export interface LogoutOptions {
	profile?: string;
	all?: boolean;
	local?: boolean;
}

export type LogoutReason =
	/** Revoked on the server, then forgotten. */
	| "revoked"
	/** The server refused the key as invalid or expired
	 * ({@link isKeyRejected}); forgotten. */
	| "already-invalid"
	/** `--local`: the server could not revoke it; forgotten anyway. */
	| "not-revoked-local"
	/** The server could not revoke it; KEPT, so it can be retried. */
	| "revoke-failed"
	/** A 0.3 key: forgotten, never revoked. */
	| "legacy-key-cleared"
	| "not-logged-in";

export interface LogoutRow {
	profile: string;
	revoked: boolean;
	reason: LogoutReason;
}

type RevokeResult = "revoked" | "already-invalid";

/** Revoke one stored key against its own origin. Throws on anything other
 * than success, or the server refusing the key itself ({@link isKeyRejected}). */
async function revoke(entry: CredentialEntry): Promise<RevokeResult> {
	const origin = originOf(entry.apiBaseUrl);
	if (!origin) {
		return "already-invalid";
	}
	const client = createApiClient({ baseUrl: origin, apiKey: entry.apiKey });
	const classify = (error: unknown, context: string): RevokeResult => {
		if (isKeyRejected(error)) {
			return "already-invalid";
		}
		throw toCliError(error, context, origin);
	};

	let apiKeyId = entry.apiKeyId;
	if (!apiKeyId) {
		// A key stored without its id (`config set apiKey` could not look it
		// up, or an older agx stored it): ask the server first. It answers even
		// when the key's owner has left the key's organization
		// (`organization: null`, LOGIN-CONTRACT.md §1.5), so the id is known.
		let principal: { apiKey?: { id?: string } | null };
		try {
			principal = (await client.account.principal.get({})) as typeof principal;
		} catch (error) {
			return classify(error, "account.principal.get");
		}
		apiKeyId = principal.apiKey?.id ?? null;
		if (!apiKeyId) {
			// The key works (the call succeeded), so it is NOT invalid.
			throw new AgxCliError(
				"account.principal.get: the server did not say which key this is, so agx cannot revoke it.",
				{ exitCode: EXIT.remote },
			);
		}
	}
	try {
		await client.prm.apiKeys.delete({ apiKeyId });
		return "revoked";
	} catch (error) {
		return classify(error, "prm.apiKeys.delete");
	}
}

async function logoutProfile(
	profileName: string,
	options: LogoutOptions,
): Promise<{ row: LogoutRow; failure: AgxCliError | null }> {
	const entry = getCredential(profileName);
	const legacyKey = getProfile(profileName).apiKey;
	removePendingLogin(profileName);

	if (!entry && !legacyKey) {
		return {
			row: { profile: profileName, revoked: false, reason: "not-logged-in" },
			failure: null,
		};
	}

	let row: LogoutRow;
	let failure: AgxCliError | null = null;
	if (entry && !isWellFormedApiKey(entry.apiKey)) {
		// Spaces or control characters: no server can accept it as a key, and
		// sending it would only get it quoted back in an error. Forget it.
		removeCredential(profileName);
		row = { profile: profileName, revoked: false, reason: "already-invalid" };
		notice(
			`The key stored for profile "${profileName}" was malformed, so no server could accept it; forgot it without sending it anywhere.`,
		);
	} else if (entry && (entry.source === "login" || entry.source === "manual")) {
		try {
			const result = await revoke(entry);
			removeCredential(profileName);
			row = { profile: profileName, revoked: result === "revoked", reason: result };
		} catch (error) {
			const cli =
				error instanceof AgxCliError
					? error
					: toCliError(error, "prm.apiKeys.delete", entry.apiBaseUrl);
			if (options.local) {
				removeCredential(profileName);
				row = { profile: profileName, revoked: false, reason: "not-revoked-local" };
				notice(
					`Forgot the key of profile "${profileName}" without revoking it (${cli.message}). It stays valid until it expires${entry.expiresAt ? ` on ${entry.expiresAt.slice(0, 10)}` : ""}; revoke it in Settings → API keys.`,
				);
			} else {
				row = { profile: profileName, revoked: false, reason: "revoke-failed" };
				failure = new AgxCliError(
					`Could not revoke the key of profile "${profileName}": ${cli.message} The key was kept.`,
					{
						exitCode: cli.exitCode,
						remediation:
							cli.exitCode === EXIT.network
								? "Retry when the server is reachable, or forget the key on this machine only:\n    agx logout --local"
								: "This server could not revoke it. Revoke it in Settings → API keys, then forget it on this machine:\n    agx logout --local",
					},
				);
				return { row, failure };
			}
		}
	} else {
		// A 0.3 key (still in config.json, or migrated out of it): agx never
		// learned what it is for, so it is cleared, not revoked.
		if (entry) {
			removeCredential(profileName);
		}
		row = { profile: profileName, revoked: false, reason: "legacy-key-cleared" };
		notice(
			`Cleared the pre-login API key of profile "${profileName}" on this machine. It was NOT revoked: revoke it in Settings → API keys.`,
		);
	}
	if (legacyKey) {
		updateProfile(profileName, { apiKey: null });
	}
	return { row, failure };
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
	const profiles = options.all
		? [
				...new Set([
					...Object.keys(listCredentials()),
					...Object.entries(loadConfig().profiles)
						.filter(([, profile]) => profile.apiKey)
						.map(([name]) => name),
				]),
			]
		: [resolveProfileName(options.profile)];

	const rows: LogoutRow[] = [];
	const failures: AgxCliError[] = [];
	for (const profileName of profiles) {
		const { row, failure } = await logoutProfile(profileName, options);
		rows.push(row);
		if (failure) {
			failures.push(failure);
			continue;
		}
		switch (row.reason) {
			case "revoked":
				ok(`Logged out of profile "${row.profile}"; the key was revoked.`);
				break;
			case "already-invalid":
				ok(
					`Logged out of profile "${row.profile}"; the server already refused the key as invalid or expired.`,
				);
				break;
			case "not-logged-in":
				ok(`Profile "${row.profile}" was not logged in.`);
				break;
			default:
				ok(`Logged out of profile "${row.profile}" on this machine.`);
		}
	}
	if (process.env.AGX_API_KEY) {
		warn(
			"AGX_API_KEY is still set in this shell, so agx commands keep using it. Unset it:  unset AGX_API_KEY",
		);
	}
	json({ loggedOut: rows });
	if (failures.length > 0) {
		throw failures.length === 1
			? failures[0]
			: new AgxCliError(failures.map((f) => f.message).join("\n"), {
					exitCode: failures[0]?.exitCode ?? EXIT.network,
					remediation: failures[0]?.remediation ?? null,
				});
	}
}
