import { createApiClient, toCliError } from "../lib/api.js";
import { resolveApiCredentials, resolveProfileName } from "../lib/config.js";
import { AgxCliError, usageError } from "../lib/errors.js";
import { heading, info, json, kv, ok, say, table } from "../lib/output.js";
import { toDisplayNpub } from "../lib/peer.js";

/**
 * The team-side trust controls, driven over the same public HTTP API.
 *
 * `allowlist` is the egress control: outbound is allowlist-only, so an agent can
 * never make first contact with a key nobody approved. It is also how an inbound
 * sender is accepted — both write the same peer row — which is why approving a
 * recipient means that peer's replies are delivered rather than quarantined.
 */

export interface PeerOptions {
	profile?: string;
	org?: string;
	team?: string;
	npub?: string;
	name?: string;
	peer?: string;
	reason?: string;
	status?: string;
}

function ctx(options: PeerOptions) {
	const profileName = resolveProfileName(options.profile);
	const creds = resolveApiCredentials(profileName, { org: options.org });
	if (!options.team) {
		throw usageError(
			"--team is required.",
			"Re-run with --team <teamId>, the id of a team in your organization.",
		);
	}
	return { creds, teamId: options.team, client: createApiClient(creds) };
}

export async function peersListCommand(options: PeerOptions): Promise<void> {
	const { creds, teamId, client } = ctx(options);
	let result: {
		peers: Array<{
			id: string;
			pubkey: string;
			status: string;
			displayName: string | null;
			nip05: string | null;
			nip05Verified?: boolean;
		}>;
	};
	try {
		result = await client.exchange.listPeers({
			orgSlug: creds.orgSlug,
			teamId,
		});
	} catch (error) {
		throw peersError(error, "listPeers", creds.baseUrl);
	}
	heading(`exchange peers for team ${teamId}`);
	table(
		result.peers.map((p) => [
			p.id,
			toDisplayNpub(p.pubkey).slice(0, 20),
			p.status,
			p.nip05 ?? "—",
			p.displayName ?? "",
		]),
		["PEER ID", "NPUB", "STATUS", "NIP-05", "NAME"],
	);
	say("");
	info(
		"`pending` means quarantined: the message is filed but invisible to the team's agents until an approver accepts it.",
	);
	json(result);
}

export async function peersAllowlistCommand(
	options: PeerOptions,
): Promise<void> {
	const { creds, teamId, client } = ctx(options);
	if (!options.npub) {
		throw usageError(
			"--npub is required.",
			"agx peers allowlist --team <id> --npub npub1…",
		);
	}
	let result: { status: string; pubkey: string };
	try {
		result = await client.exchange.allowlistPeer({
			orgSlug: creds.orgSlug,
			teamId,
			identity: options.npub,
			...(options.name ? { displayName: options.name } : {}),
		});
	} catch (error) {
		throw peersError(error, "allowlistPeer", creds.baseUrl);
	}
	ok(
		`${toDisplayNpub(result.pubkey)} is now "${result.status}" for this team.`,
	);
	say("");
	info(
		"This is one row, not two: the team may now message this peer, and messages FROM it are delivered rather than quarantined.",
	);
	json(result);
}

export async function peersDecideCommand(
	action: "accept" | "refuse" | "ignore" | "block",
	options: PeerOptions,
): Promise<void> {
	const { creds, teamId, client } = ctx(options);
	if (!options.peer) {
		throw usageError(
			"--peer <peerId> is required.",
			`Find it with:  agx peers list --team ${teamId}`,
		);
	}
	if (action === "refuse" && !options.reason) {
		throw usageError(
			"--reason is required when refusing.",
			'agx peers refuse --team <id> --peer <id> --reason "Not accepting requests"',
		);
	}
	const procedure = {
		accept: "acceptPeer",
		refuse: "refusePeer",
		ignore: "ignorePeer",
		block: "blockPeer",
	}[action];

	let result: { status: string; delivered?: number; total?: number };
	try {
		result = await client.exchange[procedure]({
			orgSlug: creds.orgSlug,
			teamId,
			peerId: options.peer,
			...(options.reason ? { reason: options.reason } : {}),
		});
	} catch (error) {
		throw peersError(error, procedure, creds.baseUrl);
	}
	ok(`Peer is now "${result.status}".`);
	if (result.delivered !== undefined) {
		kv(
			"released",
			`${result.delivered} of ${result.total} quarantined message(s) delivered`,
		);
	}
	json(result);
}

/**
 * A key from `agx login` covers Elladex listings and domains only; the
 * exchange procedures answer it with INSUFFICIENT_SCOPE. Say plainly what
 * works instead of the generic scope message.
 */
function peersError(
	error: unknown,
	procedure: string,
	baseUrl: string,
): AgxCliError {
	const cli = toCliError(error, procedure, baseUrl);
	const code = (error as { data?: { code?: unknown } })?.data?.code;
	if (code !== "INSUFFICIENT_SCOPE") {
		return cli;
	}
	return new AgxCliError(
		`${procedure}: \`agx peers\` manages a team's exchange trust, which a key from \`agx login\` does not cover (it covers Elladex listings and domains only).`,
		{
			exitCode: cli.exitCode,
			remediation:
				"Mint a key in Settings → API keys and use it from its own profile:\n    printf %s \"$KEY\" | agx --profile exchange config set apiKey --stdin\n    agx --profile exchange peers list --team <teamId>",
		},
	);
}
