import kleur from "kleur";
import { createApiClient, toCliError } from "../lib/api.js";
import { resolveApiCredentials, resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import { loadIdentityFile } from "../lib/identity.js";
import {
	heading,
	info,
	json,
	kv,
	ok,
	say,
	table,
	warn,
} from "../lib/output.js";
import { runtime } from "../lib/runtime.js";
import { parseDuration, WAIT_POLL_MS } from "../lib/wait.js";

export interface DomainOptions {
	profile?: string;
	org?: string;
	yes?: boolean;
	/** `domain add`: the handle the nostr.json body maps. */
	handle?: string;
	/** `domain verify`: poll until verified. */
	wait?: boolean;
	timeout?: string;
}

/** `domain verify --wait` gives up after this long by default. */
const DEFAULT_VERIFY_WAIT = "10m";

/** NIP-05 names: lowercase letters, digits, `-_.`. */
const HANDLE_RE = /^[a-z0-9._-]+$/;

/**
 * The exact `/.well-known/nostr.json` the domain has to serve for `handle` to
 * verify as this profile's key (NIP-05). Without an identity, the key is a
 * placeholder the person fills in.
 */
export function nostrJsonFor(
	domain: string,
	handle: string,
	pubkeyHex: string | null,
): { url: string; path: string; body: { names: Record<string, string> } } {
	return {
		url: `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(handle)}`,
		path: "/.well-known/nostr.json",
		body: { names: { [handle]: pubkeyHex ?? "<64-char hex public key>" } },
	};
}

interface SerializedDomain {
	id: string;
	domain: string;
	method: string;
	status: string;
	verified: boolean;
	verifiedAt: string | null;
	lastCheckedAt: string | null;
	consecutiveFailures: number;
	lastFailureReason: string | null;
}

function ctx(options: DomainOptions) {
	const profileName = resolveProfileName(options.profile);
	const creds = resolveApiCredentials(profileName, { org: options.org });
	return { profileName, creds, client: createApiClient(creds) };
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;

export async function domainAddCommand(
	domain: string,
	options: DomainOptions,
): Promise<void> {
	// Check the handle before claiming anything: a claim the server has
	// already made cannot be taken back by a usage error.
	if (options.handle !== undefined && !HANDLE_RE.test(options.handle)) {
		throw usageError(
			`--handle "${options.handle}" is not a valid NIP-05 name.`,
			"Use lowercase letters, digits, '-', '_' or '.', for example --handle invoice-desk",
		);
	}
	const { profileName, creds, client } = ctx(options);
	if (LOCAL_HOST_RE.test(domain)) {
		warn(
			"A localhost domain can never be verified. NIP-05 verification fetches https://<domain>/.well-known/nostr.json through an SSRF guard that blocks loopback and private addresses, deliberately with no bypass.",
		);
		say(
			"  Expose the index over public HTTPS instead:  cloudflared tunnel --url http://localhost:3000",
		);
	}
	let result: SerializedDomain;
	try {
		result = await client.agentIndex.createDomain({
			orgSlug: creds.orgSlug,
			domain,
		});
	} catch (error) {
		throw toCliError(error, "createDomain", creds.baseUrl);
	}
	const handle = options.handle ?? "<handle>";
	let pubkeyHex: string | null = null;
	try {
		pubkeyHex = loadIdentityFile(profileName, {
			allowInsecurePerms: true,
		}).publicKey;
	} catch {
		pubkeyHex = null;
	}
	const nostrJson = nostrJsonFor(result.domain, handle, pubkeyHex);

	ok(`Claimed ${result.domain}`);
	kv("id", result.id);
	kv("status", result.status);
	say("");
	say(
		`Serve this at ${kleur.bold(`https://${result.domain}${nostrJson.path}`)} (as JSON, with Access-Control-Allow-Origin: *):`,
	);
	say("");
	say(JSON.stringify(nostrJson.body, null, 2));
	say("");
	if (options.handle === undefined) {
		warn(
			"No --handle given, so <handle> above is a placeholder. Re-run with --handle <name> to print the exact file.",
		);
	}
	if (!pubkeyHex) {
		warn(
			"This profile has no identity yet, so the key above is a placeholder. Create one first:  agx identity new",
		);
	}
	info(
		`Then claim the handle and verify:\n    agx register --slug <slug> --handle ${handle} --domain-id ${result.id}\n    agx domain verify ${result.id} --wait`,
	);
	json({ ...result, nostrJson });
}

export async function domainListCommand(options: DomainOptions): Promise<void> {
	const { creds, client } = ctx(options);
	let result: { domains: SerializedDomain[] };
	try {
		result = await client.agentIndex.listDomains({
			orgSlug: creds.orgSlug,
		});
	} catch (error) {
		throw toCliError(error, "listDomains", creds.baseUrl);
	}
	heading(`domains claimed by "${creds.orgSlug}"`);
	table(
		result.domains.map((d) => [
			d.id,
			d.domain,
			d.status,
			d.verified ? "yes" : "—",
			d.lastFailureReason ?? "",
		]),
		["ID", "DOMAIN", "STATUS", "VERIFIED", "LAST FAILURE"],
	);
	json(result);
}

interface VerifyResult {
	domain: SerializedDomain;
	results: Array<{
		listingId: string;
		handle: string;
		ok: boolean;
		reason?: string;
	}>;
	checkedCount: number;
	totalCandidates: number;
}

export async function domainVerifyCommand(
	domainId: string,
	options: DomainOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	const rt = runtime();
	const timeoutMs = options.wait
		? parseDuration(options.timeout ?? DEFAULT_VERIFY_WAIT)
		: 0;
	const deadline = rt.now() + timeoutMs;
	const verify = async (): Promise<VerifyResult> => {
		try {
			return await client.agentIndex.verifyDomain({
				orgSlug: creds.orgSlug,
				domainId,
			});
		} catch (error) {
			throw toCliError(error, "verifyDomain", creds.baseUrl);
		}
	};

	let result = await verify();
	let attempt = 1;
	// Every call makes the index fetch the domain's nostr.json, so poll no
	// faster than every 15 s, and only while there is time left.
	while (options.wait && !result.domain.verified) {
		const remaining = deadline - rt.now();
		if (remaining <= 0) {
			break;
		}
		if (attempt === 1) {
			info(
				`Not verified yet; checking every ${WAIT_POLL_MS / 1000} s for up to ${Math.round(timeoutMs / 60_000)} min…`,
			);
		}
		await rt.sleep(Math.min(WAIT_POLL_MS, remaining));
		if (rt.now() >= deadline) {
			break;
		}
		result = await verify();
		attempt += 1;
	}

	heading(`verification of ${result.domain.domain}`);
	kv("status", result.domain.status);
	kv("verified", result.domain.verified ? "yes" : "no");
	kv("checked", `${result.checkedCount} of ${result.totalCandidates}`);
	if (options.wait) {
		kv("attempts", attempt);
	}
	table(
		result.results.map((r) => [
			r.handle,
			r.ok ? "pass" : "fail",
			r.reason ?? "",
		]),
		["HANDLE", "RESULT", "REASON"],
	);

	if (!result.domain.verified) {
		say("");
		info(
			"Verification fetches https://<domain>/.well-known/nostr.json?name=<handle> and requires it to map back to the listing's pubkey. It must be reachable over PUBLIC HTTPS — the SSRF guard blocks localhost and private addresses with no environment bypass, and the platform's own domain cannot be claimed because serving the claimant's own key would make verification circular.",
		);
		say(
			"  For a local run, expose your local index:  cloudflared tunnel --url http://localhost:3000",
		);
	}
	json(result);
	if (options.wait && !result.domain.verified) {
		throw new AgxCliError(
			`${result.domain.domain} was still not verified after ${attempt} attempt(s).`,
			{
				exitCode: EXIT.remote,
				remediation:
					"Check that the domain serves the nostr.json body `agx domain add` printed, then:\n    agx domain verify " +
					domainId +
					" --wait",
			},
		);
	}
}

export async function domainRemoveCommand(
	domainId: string,
	options: DomainOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	if (!options.yes) {
		throw usageError(
			"Removing a domain clears the handle and verification badge from every listing on it.",
			`Confirm with:  agx domain remove ${domainId} --yes`,
		);
	}
	try {
		await client.agentIndex.deleteDomain({
			orgSlug: creds.orgSlug,
			domainId,
		});
	} catch (error) {
		throw toCliError(error, "deleteDomain", creds.baseUrl);
	}
	ok("Domain removed; handles and badges on it were cleared.");
	json({ ok: true });
}
