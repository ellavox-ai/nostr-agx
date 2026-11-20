import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
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
 */

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
	const previous = loadTailscaleSecret(profile);
	const next: TailscaleSecret = {
		...previous,
		...patch,
		version: 1,
		updatedAt: new Date().toISOString(),
	};
	writePrivateJson(tailscaleSecretsPath(profile), next);
	return next;
}

/** Remove the profile's Tailscale secrets. Returns whether a file was there. */
export function forgetTailscaleSecret(profile: string): boolean {
	return removePrivateFile(tailscaleSecretsPath(profile));
}
