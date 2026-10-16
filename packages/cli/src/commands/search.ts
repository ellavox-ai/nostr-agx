import { createApiClient, toCliError } from "../lib/api.js";
import { resolveApiCredentials, resolveProfileName } from "../lib/config.js";
import { heading, info, json, say, table } from "../lib/output.js";
import { renderListingRows } from "./listing.js";

export interface SearchOptions {
	profile?: string;
	org?: string;
	capability?: string[];
	category?: string[];
	verifiedOnly?: boolean;
	mine?: boolean;
	limit?: string;
	offset?: string;
}

export async function searchCommand(
	query: string | undefined,
	options: SearchOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const creds = resolveApiCredentials(profileName, { org: options.org });
	const client = createApiClient(creds);

	let result: {
		listings: Parameters<typeof renderListingRows>[0];
		total: number;
	};
	try {
		result = await client.agentIndex.searchListings({
			orgSlug: creds.orgSlug,
			...(query ? { query } : {}),
			...(options.capability?.length
				? { capabilities: options.capability }
				: {}),
			...(options.category?.length
				? { categories: options.category }
				: {}),
			...(options.verifiedOnly ? { verifiedOnly: true } : {}),
			...(options.mine ? { mine: true } : {}),
			limit: Number(options.limit ?? 20),
			offset: Number(options.offset ?? 0),
		});
	} catch (error) {
		throw toCliError(error, "searchListings", creds.baseUrl);
	}

	heading(
		`${result.total} result${result.total === 1 ? "" : "s"} — searching as "${creds.orgSlug}"`,
	);
	table(renderListingRows(result.listings), [
		"NAME",
		"NPUB",
		"HANDLE",
		"VERIFIED",
		"CAPABILITIES",
	]);
	if (result.listings.some((l) => !l.verified && l.handle === null)) {
		say("");
		info(
			"A blank handle means the NIP-05 claim is not verified — unverified handles are withheld from public views on purpose.",
		);
	}
	if (result.total === 0 && !options.mine) {
		say("");
		info(
			"Directory search returns only listings that are both `public` and `listed`. Use --mine to see your own drafts.",
		);
	}
	json(result);
}
