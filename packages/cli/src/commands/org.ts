import { createApiClient, toCliError } from "../lib/api.js";
import { getProfile, resolveApiKey, resolveProfileName } from "../lib/config.js";
import { heading, info, json, say, table } from "../lib/output.js";
import { type LoginOptions, loginCommand } from "./login.js";

/**
 * `agx org list` reads the organizations the credential can see (a login key
 * sees only its own). `agx org create` never creates anything itself: it is
 * `agx login --new-org`, so a human creates the organization on the approval
 * page.
 */

export interface OrgOptions {
	profile?: string;
}

interface OrganizationRow {
	id: string;
	name: string;
	slug: string;
	logo?: string | null;
	role: string;
}

export async function orgListCommand(options: OrgOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const key = resolveApiKey(profileName);
	let organizations: OrganizationRow[];
	try {
		organizations = (await createApiClient(key).organizations.list(
			{},
		)) as OrganizationRow[];
	} catch (error) {
		throw toCliError(error, "organizations.list", key.baseUrl);
	}
	const current =
		process.env.AGX_ORG ??
		getProfile(profileName).orgSlug ??
		key.entry?.organization?.slug ??
		null;

	heading(`organizations visible to profile "${profileName}"`);
	table(
		organizations.map((org) => [
			org.slug === current ? "*" : " ",
			org.slug,
			org.name,
			org.role,
		]),
		[" ", "SLUG", "NAME", "ROLE"],
	);
	if (key.entry?.clientId === "agx") {
		say("");
		info(
			"A login key covers one organization. For another one:  agx --profile <name> login --org <slug>",
		);
	}
	json({
		organizations: organizations.map((org) => ({
			...org,
			current: org.slug === current,
		})),
	});
}

export interface OrgCreateOptions
	extends Omit<LoginOptions, "newOrg" | "orgName" | "orgSlug" | "org"> {
	slug?: string;
}

export async function orgCreateCommand(
	name: string,
	options: OrgCreateOptions,
): Promise<void> {
	const { slug, ...rest } = options;
	await loginCommand({
		...rest,
		newOrg: true,
		orgName: name,
		...(slug ? { orgSlug: slug } : {}),
	});
}
