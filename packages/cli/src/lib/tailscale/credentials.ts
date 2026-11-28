import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { assertFileLockHeld, withFileLock } from "../config-lock.js";
import { AgxCliError, configError, EXIT } from "../errors.js";
import {
	isTooPermissive,
	removePrivateFile,
	tailscaleSecretsPath,
	writePrivateJson,
} from "../paths.js";

/**
 * Tailscale auth material, kept out of `config.json` and written 0600 beside the
 * profile's identity:
 *
 *   { "version": 1, "authKey": "tskey-…" | null,
 *     "oauthClientSecret": "…" | null, "updatedAt": "…" }
 *
 * Both values are bearer secrets. `agx tailscale status` never prints them.
 *
 * The file is read, changed and written back whole, so a save and a forget hold a lock beside it
 * (`tailscale.json.lock`, see config-lock.ts) for that time: two commands that overlap each add their
 * key instead of one dropping the other's. A read never takes the lock; the write is a rename, so a
 * read sees the old file or the new one, never half of one.
 */

const SECRETS_LOCK = "Tailscale secrets";

const tailscaleSecretSchema = z.object({
	version: z.literal(1),
	authKey: z.string().nullable().default(null),
	oauthClientSecret: z.string().nullable().default(null),
	updatedAt: z.string(),
});

export type TailscaleSecret = z.infer<typeof tailscaleSecretSchema>;

const EMPTY: TailscaleSecret = {
	version: 1,
	authKey: null,
	oauthClientSecret: null,
	updatedAt: new Date(0).toISOString(),
};

export function loadTailscaleSecret(profile: string): TailscaleSecret {
	const path = tailscaleSecretsPath(profile);
	if (!existsSync(path)) {
		return { ...EMPTY };
	}
	if (isTooPermissive(path)) {
		throw new AgxCliError(
			`${path} is readable by other users and holds Tailscale credentials.`,
			{
				exitCode: EXIT.config,
				remediation: `chmod 600 ${path}\n  (or run: agx doctor --fix-perms)`,
			},
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Never echo the parse error: it can quote the file, which holds secrets.
		throw configError(
			`${path} is not valid JSON.`,
			`Move it aside and configure Tailscale again:\n    mv ${path} ${path}.broken && agx tailscale enable`,
		);
	}
	const parsed = tailscaleSecretSchema.safeParse(raw);
	if (!parsed.success) {
		throw configError(
			`${path} does not match the expected shape.`,
			`Move it aside and configure Tailscale again:\n    mv ${path} ${path}.broken && agx tailscale enable`,
		);
	}
	return parsed.data;
}

export function saveTailscaleSecret(
	profile: string,
	patch: Partial<Pick<TailscaleSecret, "authKey" | "oauthClientSecret">>,
): TailscaleSecret {
	const path = tailscaleSecretsPath(profile);
	return withFileLock(path, SECRETS_LOCK, () => {
		const previous = loadTailscaleSecret(profile);
		const next: TailscaleSecret = {
			...previous,
			...patch,
			version: 1,
			updatedAt: new Date().toISOString(),
		};
		writePrivateJson(path, next, {
			beforePublish: () => assertFileLockHeld(path, SECRETS_LOCK),
		});
		return next;
	});
}

/** Remove the profile's Tailscale secrets. Returns whether a file was there. */
export function forgetTailscaleSecret(profile: string): boolean {
	const path = tailscaleSecretsPath(profile);
	// A profile with no folder has no secrets, and the lock would make the folder.
	if (!existsSync(dirname(path))) {
		return false;
	}
	return withFileLock(path, SECRETS_LOCK, () => removePrivateFile(path));
}
