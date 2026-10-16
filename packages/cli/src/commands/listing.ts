import { normalizePubkey } from "@nostr-agx/nostr";
import kleur from "kleur";
import { createApiClient, toCliError } from "../lib/api.js";
import {
	effectiveProfile,
	resolveApiCredentials,
	resolveProfileName,
} from "../lib/config.js";
import {
	AgxCliError,
	EXIT,
	HumanActionRequiredError,
	usageError,
} from "../lib/errors.js";
import { loadIdentityFile } from "../lib/identity.js";
import {
	heading,
	info,
	json,
	kv,
	ok,
	say,
	shortNpub,
	table,
	warn,
} from "../lib/output.js";
import { relaysForListing } from "../lib/relays.js";
import { runtime } from "../lib/runtime.js";
import { loadState, updateState } from "../lib/state.js";
import {
	announceActionRequired,
	parseDuration,
	WAIT_POLL_MS,
} from "../lib/wait.js";

export interface ListingOptions {
	profile?: string;
	org?: string;
	visibility?: string;
	capability?: string[];
	autoAllow?: boolean;
	dailyCap?: string;
	limit?: string;
	yes?: boolean;
	// `listing create` only
	slug?: string;
	team?: string;
	pubkey?: string;
	displayName?: string;
	summary?: string;
	description?: string;
	category?: string[];
	tag?: string[];
	runtime?: string;
	handle?: string;
	domainId?: string;
	/** `listing create --pubkey` only: the relays that key listens on. */
	relay?: string[];
	/** `listing publish` only: wait for a human to confirm a public listing. */
	wait?: boolean;
	timeout?: string;
}

/** How long `listing publish --wait` waits for a human by default. */
const DEFAULT_PUBLISH_WAIT = "30m";

interface PublicListing {
	id: string;
	slug: string;
	displayName: string;
	handle: string | null;
	npub: string;
	verified: boolean;
	capabilities: string[];
	visibility: string;
	status: string;
	summary?: string | null;
	/** What the index stored and advertises (a team listing: its team's). */
	relays: string[];
}

/** "invoice-bot" → "Invoice Bot", so --display-name can be optional. */
function titleCase(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((word) => word[0]?.toUpperCase() + word.slice(1))
		.join(" ");
}

function ctx(options: ListingOptions) {
	const profileName = resolveProfileName(options.profile);
	const creds = resolveApiCredentials(profileName, { org: options.org });
	const profile = effectiveProfile(profileName);
	return { profileName, profile, creds, client: createApiClient(creds) };
}

/**
 * Fall back to the listing this profile registered, so the common case needs no
 * id. An explicitly-given id is remembered, so a listing created in one shell
 * (or before a state reset) becomes the profile's default for later commands and
 * for `agx doctor`'s listing check.
 */
function resolveListingId(
	explicit: string | undefined,
	profileName: string,
): string {
	const stored = loadState(profileName).listingId;
	const id = explicit ?? stored;
	if (!id) {
		throw usageError(
			"No listing id given and none stored for this profile.",
			"agx listing list        # find the id\n  agx listing publish <id>",
		);
	}
	if (explicit && explicit !== stored) {
		updateState(profileName, { listingId: explicit });
	}
	return id;
}

/**
 * `handle` is null in every public projection until the NIP-05 claim is verified
 * — an unverified handle is withheld on purpose, so rendering a blank there is
 * correct rather than a missing field.
 */
function renderHandle(listing: PublicListing): string {
	if (listing.handle) {
		return listing.verified
			? listing.handle
			: `${listing.handle} (unverified)`;
	}
	return "—";
}

/**
 * Create a listing of either kind.
 *
 * A listing addresses exactly one key: a TEAM the index already holds a key for
 * (`--team`), or an EXTERNAL key you hold yourself (`--pubkey`). Exactly one, and
 * the address is immutable afterwards.
 *
 * For `--pubkey`, prefer `agx register`: it runs the proof-of-possession flow
 * first, which `createListing` requires. This command is the lower-level form and
 * will surface the 403 if no proof is on record for that key.
 */
export async function listingCreateCommand(
	options: ListingOptions,
): Promise<void> {
	const { profileName, profile, creds, client } = ctx(options);
	if (!options.slug) {
		throw usageError(
			"--slug is required.",
			'agx listing create --team <teamId> --slug payables --display-name "Payables"',
		);
	}
	if (Boolean(options.team) === Boolean(options.pubkey)) {
		throw usageError(
			"Pass exactly one of --team or --pubkey.",
			"A listing addresses either a team the index holds a key for, or an external key you hold:\n    agx listing create --team <teamId>  --slug <slug> --display-name <name>\n    agx listing create --pubkey <npub>  --slug <slug> --display-name <name>\n  For an external key, `agx register` is easier — it proves possession first, which is required.",
		);
	}

	// Only an EXTERNAL listing carries its own relays; a team listing advertises
	// its team's, and the index refuses a relays field on one — so refuse here
	// too, rather than silently dropping what the user typed.
	if (options.team && options.relay?.length) {
		throw usageError(
			"--relay applies to --pubkey listings only.",
			"A team listing advertises its TEAM's relays. Change them in the team's Exchange settings.",
		);
	}
	const relays = options.pubkey
		? externalListingRelays(options, profileName, profile.relays)
		: [];

	let listing: PublicListing & { source: string };
	try {
		listing = await client.agentIndex.createListing({
			orgSlug: creds.orgSlug,
			slug: options.slug,
			...(options.team ? { teamId: options.team } : {}),
			...(options.pubkey ? { pubkey: options.pubkey } : {}),
			displayName: options.displayName ?? titleCase(options.slug),
			...(options.summary ? { summary: options.summary } : {}),
			...(options.description
				? { description: options.description }
				: {}),
			...(options.capability?.length
				? { capabilities: options.capability }
				: {}),
			...(options.category?.length
				? { categories: options.category }
				: {}),
			...(options.tag?.length ? { tags: options.tag } : {}),
			...(options.runtime ? { runtime: options.runtime } : {}),
			...(options.visibility ? { visibility: options.visibility } : {}),
			...(options.handle ? { handleName: options.handle } : {}),
			...(options.domainId ? { domainId: options.domainId } : {}),
			...(relays.length > 0 ? { relays } : {}),
		});
	} catch (error) {
		throw toCliError(error, "createListing", creds.baseUrl);
	}

	// Only remember an EXTERNAL listing as this profile's default: a team listing
	// belongs to a team, not to the key this profile holds, and making it the
	// implicit target of `agx listing publish` would be surprising.
	if (listing.source === "external") {
		updateState(profileName, {
			listingId: listing.id,
			listingSlug: listing.slug,
		});
	}

	ok(`Created listing ${listing.id}`);
	kv("slug", listing.slug);
	kv("source", listing.source);
	kv("status", listing.status);
	kv("visibility", listing.visibility);
	kv("capabilities", listing.capabilities.join(", ") || "—");
	if (options.pubkey) {
		// The server's answer, as `agx register` prints it, not the local list.
		kv("relays", listing.relays.join(", ") || "—");
	}
	say("");
	info(
		`Listings are born as drafts. Publish it with:  agx listing publish ${listing.id}`,
	);
	if (listing.capabilities.length === 0) {
		warn(
			"No capabilities declared — publishing will be refused until at least one is set.",
		);
	}
	json({ listing });
}

/**
 * Which relays an external listing should advertise, already filtered by
 * {@link relaysForListing}.
 *
 * `--pubkey` names ANY key this org has proven, not necessarily this profile's
 * identity, so the profile's relays are the key's address only when the key IS
 * the profile's own. Anything else needs `--relay`; guessing would publish an
 * address that may be wrong.
 */
function externalListingRelays(
	options: ListingOptions,
	profileName: string,
	profileRelays: readonly string[],
): string[] {
	if (options.relay?.length) {
		return relaysForListing(options.relay, PASS_RELAY_HINT);
	}
	const listed = normalizePubkey(options.pubkey ?? "");
	let own: string | null = null;
	try {
		// Only the PUBLIC key is read here, so a too-permissive identity file is
		// not this call's problem; without the opt-out its `chmod 600` error
		// would be swallowed and misreported as "not this profile's own key".
		own = loadIdentityFile(profileName, {
			allowInsecurePerms: true,
		}).publicKey;
	} catch {
		own = null;
	}
	if (listed && own && listed === own.toLowerCase()) {
		return relaysForListing(profileRelays);
	}
	warn(
		"--pubkey is not this profile's own key, so its relays are unknown and none will be advertised.",
	);
	return relaysForListing([], PASS_RELAY_HINT);
}

const PASS_RELAY_HINT =
	"Pass the relays this key listens on with:  --relay wss://… (repeatable)";

export async function listingListCommand(
	options: ListingOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	let result: { listings: PublicListing[]; total: number };
	try {
		result = await client.agentIndex.searchListings({
			orgSlug: creds.orgSlug,
			mine: true,
			limit: Number(options.limit ?? 50),
		});
	} catch (error) {
		throw toCliError(error, "searchListings", creds.baseUrl);
	}
	heading(`listings owned by "${creds.orgSlug}"`);
	table(
		result.listings.map((l) => [
			l.id,
			l.slug,
			l.status,
			l.visibility,
			l.capabilities.join(","),
		]),
		["ID", "SLUG", "STATUS", "VISIBILITY", "CAPABILITIES"],
	);
	json(result);
}

export async function listingGetCommand(
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	let result: { listing: PublicListing; verificationEvents: unknown[] };
	try {
		result = await client.agentIndex.getListing({
			orgSlug: creds.orgSlug,
			listingId: id,
		});
	} catch (error) {
		throw toCliError(error, "getListing", creds.baseUrl);
	}
	const l = result.listing;
	heading(l.displayName);
	kv("id", l.id);
	kv("slug", l.slug);
	kv("npub", l.npub);
	kv("handle", renderHandle(l));
	kv("verified", l.verified ? "yes" : "no");
	kv("status", l.status);
	kv("visibility", l.visibility);
	kv("capabilities", l.capabilities.join(", ") || "—");
	kv("summary", l.summary ?? null);
	if (l.status === "listed" && l.visibility !== "public") {
		warn(
			`Listed, but visibility is "${l.visibility}" — directory search returns public entries only, so nobody else can find it.`,
		);
	}
	json(result);
}

export async function listingPublishCommand(
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	const timeoutMs = options.wait
		? parseDuration(options.timeout ?? DEFAULT_PUBLISH_WAIT)
		: 0;

	// PATCH, then POST, as in 0.3: when a server gates "going public" on a
	// human, the PATCH stages the visibility and the human's one Publish click
	// finishes the job.
	if (options.visibility) {
		try {
			await client.agentIndex.updateListing({
				orgSlug: creds.orgSlug,
				listingId: id,
				visibility: options.visibility,
			});
			ok(`Visibility set to "${options.visibility}".`);
		} catch (error) {
			const cli = toCliError(error, "updateListing", creds.baseUrl);
			if (options.wait && cli instanceof HumanActionRequiredError) {
				await waitUntilPublic(client, creds.orgSlug, id, cli, timeoutMs);
				return;
			}
			throw cli;
		}
	}

	let result: {
		listing: PublicListing & { source: string };
		cardPublished: boolean;
	};
	try {
		result = await client.agentIndex.publishListing({
			orgSlug: creds.orgSlug,
			listingId: id,
		});
	} catch (error) {
		const cli = toCliError(error, "publishListing", creds.baseUrl);
		if (options.wait && cli instanceof HumanActionRequiredError) {
			await waitUntilPublic(client, creds.orgSlug, id, cli, timeoutMs);
			return;
		}
		throw cli;
	}

	ok(`Listing is now "${result.listing.status}".`);
	kv("visibility", result.listing.visibility);
	kv("capabilities", result.listing.capabilities.join(", ") || "—");

	// An EXTERNAL listing has no server-signed Agent Card — the index never holds
	// its key. Reporting "card published" here would be a lie.
	if (result.cardPublished) {
		kv("agent card", "published to the team's relays");
	} else if (result.listing.source === "external") {
		info(
			"No Agent Card was published by the index, and none was expected: the index never holds an external agent's key. Sign and publish your own with `agx serve --advertise`.",
		);
	} else if (result.listing.visibility === "public") {
		// A platform listing that is public + listed SHOULD have published a card,
		// so a false here is a relay problem, not a policy one. Locally it usually
		// means the index could not dial the relay — it dials the stored `wss://` URL
		// for real, while `agx relay` serves plain ws.
		warn(
			"The index did not publish an Agent Card. For a team listing that is public and listed, this means the relay could not be reached.",
		);
		say(
			kleur.dim(
				"  Locally this is expected: the index dials the stored wss:// URL for real, and `agx relay` serves plain ws.\n  Publishing a hosted agent's card needs a relay that terminates TLS (`agx relay --tls`); the message path is unaffected.",
			),
		);
	}
	if (result.listing.visibility !== "public") {
		warn(
			`Visibility is "${result.listing.visibility}" — a directory search returns only public + listed entries, so other organizations still cannot find it.`,
		);
		say(kleur.dim("  agx listing set-visibility public"));
	}
	json(result);
}

/**
 * `listing publish --wait` after the server asked for a human: say so once,
 * then read the listing every 15 s until it is listed and public. Running out
 * of time is still exit 7: the human has not acted yet.
 */
async function waitUntilPublic(
	client: ReturnType<typeof createApiClient>,
	orgSlug: string,
	listingId: string,
	pending: HumanActionRequiredError,
	timeoutMs: number,
): Promise<void> {
	const rt = runtime();
	announceActionRequired(
		pending.actionRequired,
		"An organization admin has to confirm this listing in the browser before it goes public:",
	);
	const deadline = rt.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - rt.now();
		if (remaining <= 0) {
			throw pending;
		}
		await rt.sleep(Math.min(WAIT_POLL_MS, remaining));
		let listing: PublicListing;
		try {
			({ listing } = (await client.agentIndex.getListing({
				orgSlug,
				listingId,
			})) as { listing: PublicListing });
		} catch (error) {
			const cli = toCliError(error, "getListing");
			if (cli instanceof AgxCliError && cli.exitCode === EXIT.network) {
				continue; // a blip while waiting is not a reason to give up
			}
			throw cli;
		}
		if (listing.status === "listed" && listing.visibility === "public") {
			ok("The listing is public and listed.");
			kv("visibility", listing.visibility);
			kv("capabilities", listing.capabilities.join(", ") || "—");
			json({ listing, confirmed: true });
			return;
		}
	}
}

export async function listingSetVisibilityCommand(
	visibility: string,
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	if (!["public", "unlisted", "private"].includes(visibility)) {
		throw usageError(
			`Unknown visibility "${visibility}".`,
			"One of: public, unlisted, private",
		);
	}
	let result: PublicListing & { cardRetractionRequested?: boolean };
	try {
		result = await client.agentIndex.updateListing({
			orgSlug: creds.orgSlug,
			listingId: id,
			visibility,
		});
	} catch (error) {
		throw toCliError(error, "updateListing", creds.baseUrl);
	}
	ok(`Visibility is now "${result.visibility}".`);
	reportRetraction(result.cardRetractionRequested);
	json(result);
}

export async function listingDelistCommand(
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	let result: { listing: PublicListing; cardRetractionRequested: boolean };
	try {
		result = await client.agentIndex.delistListing({
			orgSlug: creds.orgSlug,
			listingId: id,
		});
	} catch (error) {
		throw toCliError(error, "delistListing", creds.baseUrl);
	}
	ok(`Listing is now "${result.listing.status}".`);
	reportRetraction(result.cardRetractionRequested);
	json(result);
}

export async function listingDeleteCommand(
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	if (!options.yes) {
		throw usageError(
			"Deleting a listing is irreversible.",
			`Confirm with:  agx listing delete ${id} --yes`,
		);
	}
	let result: { ok: true; cardRetractionRequested: boolean };
	try {
		result = await client.agentIndex.deleteListing({
			orgSlug: creds.orgSlug,
			listingId: id,
		});
	} catch (error) {
		throw toCliError(error, "deleteListing", creds.baseUrl);
	}
	ok("Listing deleted.");
	reportRetraction(result.cardRetractionRequested);
	if (loadState(profileName).listingId === id) {
		updateState(profileName, { listingId: null, listingSlug: null });
	}
	json(result);
}

export async function listingSetPolicyCommand(
	listingId: string | undefined,
	options: ListingOptions,
): Promise<void> {
	const { profileName, creds, client } = ctx(options);
	const id = resolveListingId(listingId, profileName);
	let result: PublicListing & {
		autoAllowContact?: boolean;
		autoAllowCapabilities?: string[];
		autoAllowDailyCap?: number;
	};
	try {
		result = await client.agentIndex.updateListing({
			orgSlug: creds.orgSlug,
			listingId: id,
			...(options.autoAllow !== undefined
				? { autoAllowContact: options.autoAllow }
				: {}),
			...(options.capability?.length
				? { autoAllowCapabilities: options.capability }
				: {}),
			...(options.dailyCap !== undefined
				? { autoAllowDailyCap: Number(options.dailyCap) }
				: {}),
		});
	} catch (error) {
		throw toCliError(error, "updateListing", creds.baseUrl);
	}
	ok("Auto-allow policy updated.");
	kv("autoAllowContact", String(result.autoAllowContact));
	kv("capabilities", (result.autoAllowCapabilities ?? []).join(", ") || "—");
	kv("dailyCap", result.autoAllowDailyCap ?? null);
	if (
		result.autoAllowContact &&
		(result.autoAllowCapabilities ?? []).length === 0
	) {
		warn(
			"Auto-allow is on but the capability list is empty, which admits nobody — a half-configured policy is inert rather than open.",
		);
	}
	json(result);
}

/** A de-list sends a NIP-09 kind-5 deletion. Relays are not obliged to honour it,
 * so this is always reported as requested — never as removed. */
function reportRetraction(requested: boolean | undefined): void {
	if (requested === undefined) {
		return;
	}
	if (requested) {
		info(
			"Card retraction REQUESTED (a NIP-09 kind-5 deletion was published). Relays are not obliged to honour a deletion, so the card may persist.",
		);
	}
}

export function renderListingRows(listings: PublicListing[]): string[][] {
	return listings.map((l) => [
		l.displayName,
		shortNpub(l.npub),
		renderHandle(l),
		l.verified ? "yes" : "—",
		l.capabilities.join(","),
	]);
}
