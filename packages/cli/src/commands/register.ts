import { toNpub } from "@nostr-agx/nostr";
import kleur from "kleur";
import { type AgxApiClient, createApiClient, toCliError } from "../lib/api.js";
import {
	effectiveProfile,
	resolveApiCredentials,
	resolveProfileName,
} from "../lib/config.js";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { heading, info, json, kv, ok, say, step, warn } from "../lib/output.js";
import { signNonceEvent } from "../lib/proof.js";
import { relaysForListing } from "../lib/relays.js";
import { updateState } from "../lib/state.js";

export interface RegisterOptions {
	profile?: string;
	org?: string;
	slug?: string;
	displayName?: string;
	capability?: string[];
	summary?: string;
	description?: string;
	useCases?: string;
	category?: string[];
	tag?: string[];
	runtime?: string;
	visibility?: string;
	handle?: string;
	domainId?: string;
	/** Deliberately skip the proof, to demonstrate the 403 it produces. */
	skipProof?: boolean;
}

function titleCase(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((word) => word[0]?.toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * Register this CLI's keypair as an EXTERNAL listing, through the real
 * anti-squatting flow:
 *
 *   createKeyChallenge → sign a Nostr event carrying the nonce → submitKeyProof
 *   → createListing
 *
 * Without a recorded proof, `createListing` refuses with 403 — which is the whole
 * point of the control, and what `--skip-proof` exists to demonstrate.
 *
 * Idempotent: when this organization already owns a listing for this key, a
 * re-run reports it instead of burning a challenge and failing with 409. A
 * 409 that names this organization's own live listing is resumed the same way.
 */
export async function registerCommand(options: RegisterOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const creds = resolveApiCredentials(profileName, { org: options.org });
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const client = createApiClient(creds);

	const slug = options.slug;
	if (!slug) {
		throw usageError(
			"--slug is required.",
			'agx register --slug invoice-bot --display-name "Invoice Bot" --capability invoice.review',
		);
	}
	const capabilities = options.capability ?? [];
	if (capabilities.length === 0) {
		warn(
			"No --capability given. A listing must declare at least one before it can be published.",
		);
	}
	if (options.handle && !options.domainId) {
		throw usageError(
			"--handle requires --domain-id.",
			"Claim a domain first:\n    agx domain add example.com\n    agx domain list",
		);
	}

	const npub = toNpub(identity.publicKey);
	const totalSteps = options.skipProof ? 2 : 4;

	heading(`registering ${npub} in org "${creds.orgSlug}"`);

	const existingId = await ownedListingId(
		client,
		creds.orgSlug,
		npub,
		creds.baseUrl,
	);
	if (existingId) {
		await reportExisting(
			client,
			creds.orgSlug,
			existingId,
			profileName,
			creds.baseUrl,
		);
		return;
	}

	// After the heading: `relaysForListing` warns as a side effect, and with a
	// stock profile (`ws://127.0.0.1:7447`) those warnings would otherwise open
	// the run above its own header, reading as if it failed before starting.
	const relays = relaysForListing(profile.relays);

	if (!options.skipProof) {
		step(1, totalSteps, "requesting a key challenge…");
		let challenge: { nonce: string; expiresAt: string; pubkey: string };
		try {
			challenge = await client.agentIndex.createKeyChallenge({
				orgSlug: creds.orgSlug,
				pubkey: npub,
			});
		} catch (error) {
			throw toCliError(error, "createKeyChallenge", creds.baseUrl);
		}
		kv("nonce", `${challenge.nonce.slice(0, 16)}…`);
		kv("expires", challenge.expiresAt);

		step(2, totalSteps, "signing the nonce with the local key…");
		const signedEvent = await signNonceEvent(
			identity.signer,
			challenge.nonce,
		);
		kv("event id", `${signedEvent.id.slice(0, 16)}…`);

		step(3, totalSteps, "submitting the proof…");
		try {
			await client.agentIndex.submitKeyProof({
				orgSlug: creds.orgSlug,
				pubkey: npub,
				nonce: challenge.nonce,
				signedEvent,
			});
		} catch (error) {
			const cli = toCliError(error, "submitKeyProof", creds.baseUrl);
			throw new AgxCliError(cli.message, {
				exitCode: cli.exitCode,
				// The challenge row is consumed atomically BEFORE verification, so a
				// failed proof burns the nonce. Without saying so, a retry that
				// re-uses it looks like a flaky server.
				remediation:
					"The nonce was consumed by this attempt, even though it failed — challenges are single-use. Simply re-run the command to start from a fresh challenge:\n    agx register --slug " +
					slug,
			});
		}
		ok(
			"Possession of the key is proven and recorded for this organization.",
		);
	} else {
		warn(
			"--skip-proof: creating the listing with no recorded proof. This is expected to fail with 403.",
		);
	}

	step(totalSteps, totalSteps, "creating the listing…");
	let listing: {
		id: string;
		relays: string[];
		slug: string;
		source: string;
		status: string;
		visibility: string;
		npub: string;
		capabilities: string[];
	};
	try {
		listing = await client.agentIndex.createListing({
			orgSlug: creds.orgSlug,
			slug,
			pubkey: npub,
			displayName: options.displayName ?? titleCase(slug),
			...(options.summary ? { summary: options.summary } : {}),
			...(options.description
				? { description: options.description }
				: {}),
			...(options.useCases ? { useCases: options.useCases } : {}),
			...(capabilities.length > 0 ? { capabilities } : {}),
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
		const data = (error as { data?: { code?: unknown; listingId?: unknown } })
			?.data;
		if (
			data?.code === "LISTING_ADDRESS_LIVE" &&
			typeof data.listingId === "string"
		) {
			// Live in THIS organization (the server only names the listing when
			// it is ours): a previous run got this far. Resume it.
			await reportExisting(
				client,
				creds.orgSlug,
				data.listingId,
				profileName,
				creds.baseUrl,
			);
			return;
		}
		throw toCliError(error, "createListing", creds.baseUrl);
	}

	updateState(profileName, {
		listingId: listing.id,
		listingSlug: listing.slug,
	});

	heading("listing created");
	kv("id", listing.id);
	kv("slug", listing.slug);
	kv("source", listing.source);
	kv("status", listing.status);
	kv("visibility", listing.visibility);
	kv("npub", listing.npub);
	kv("relays", listing.relays.join(", ") || "—");
	kv("capabilities", listing.capabilities.join(", ") || "—");
	say("");
	info(
		"Listings are born as drafts. Publishing is a separate, explicit act:  agx listing publish",
	);
	if (listing.visibility !== "public") {
		warn(
			`Visibility is "${listing.visibility}" — a directory search only ever returns public + listed entries, so other organizations will not find it.`,
		);
		say(kleur.dim("  agx listing set-visibility public"));
	}
	json({ listing });
}

export const REGISTER_EXIT_HINT = EXIT.remote;

/**
 * The id of this organization's own listing for `npub`, or null. A NOT_FOUND
 * (no listing, or a server that predates the lookup) means "register it".
 */
async function ownedListingId(
	client: AgxApiClient,
	orgSlug: string,
	npub: string,
	baseUrl: string,
): Promise<string | null> {
	try {
		const owned = (await client.agentIndex.getOwnedListingByAddress({
			orgSlug,
			address: npub,
		})) as { listingId?: string } | null;
		return owned?.listingId ?? null;
	} catch (error) {
		const err = error as {
			status?: number;
			code?: string;
			data?: { code?: unknown };
		};
		if (
			(err?.status === 404 || err?.code === "NOT_FOUND") &&
			typeof err?.data?.code !== "string"
		) {
			return null;
		}
		throw toCliError(error, "getOwnedListingByAddress", baseUrl);
	}
}

async function reportExisting(
	client: AgxApiClient,
	orgSlug: string,
	listingId: string,
	profileName: string,
	baseUrl: string,
): Promise<void> {
	let result: {
		listing: {
			id: string;
			slug: string;
			status: string;
			visibility: string;
			npub: string;
			relays?: string[];
			capabilities: string[];
		};
	};
	try {
		result = await client.agentIndex.getListing({ orgSlug, listingId });
	} catch (error) {
		throw toCliError(error, "getListing", baseUrl);
	}
	const listing = result.listing;
	updateState(profileName, {
		listingId: listing.id,
		listingSlug: listing.slug,
	});
	ok(
		"This key is already registered in this organization; nothing was created.",
	);
	kv("id", listing.id);
	kv("slug", listing.slug);
	kv("status", listing.status);
	kv("visibility", listing.visibility);
	kv("npub", listing.npub);
	kv("capabilities", listing.capabilities.join(", ") || "—");
	say("");
	info(
		listing.status === "listed"
			? `Change it with:  agx listing set-visibility <level> ${listing.id}`
			: `Publish it with:  agx listing publish ${listing.id}`,
	);
	json({ listing, resumed: true });
}
