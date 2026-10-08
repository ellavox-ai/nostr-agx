import { AgxClient, DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { effectiveProfile, resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { fail, info, json, kv, ok, say, warn } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";

export interface SendOptions {
	profile?: string;
	subject?: string;
	contextId?: string;
	verbose?: boolean;
}

/**
 * Send a plain message to another agent.
 *
 * `AgxClient` has no `send()` for plain messages — the task lifecycle is its
 * surface — so this goes through the transport directly, which is exactly what
 * the platform's own egress does.
 */
export async function sendCommand(
	peer: string,
	message: string,
	options: SendOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const to = toHexPubkey(peer, "recipient");
	const transport = await createTransport(
		profile,
		identity,
		makeLogger(options.verbose ?? false),
	);

	const res = await transport.publishMessage(to, {
		text: message,
		subject: options.subject ?? null,
		contextId: options.contextId ?? null,
		contentType: DEFAULT_CONTENT_TYPE,
	});

	if (!res.ok) {
		// `ok` folds in THREE different failures now, and they need different
		// remediations.
		//
		// 1. The fan-out never happened at all (`total === 0`): publishMessage
		//    returned early for a reason local to THIS message — too long, too
		//    large once encrypted, or too large to encrypt in the first place
		//    (nostr-transport.ts's three early returns, all `accepted: 0, total:
		//    0, rejected: []`). No relay was ever contacted, so this is a usage
		//    error, not a network problem, and "check the relay is running"
		//    sends the operator to debug the one thing that was never touched.
		// 2. Every relay the RECIPIENT advertises refused it (`peerRefused`):
		//    our own relays are demonstrably fine.
		// 3. Everything else: genuinely could not reach / was refused by our
		//    own relays.
		if (res.total === 0) {
			const detail = (res.errors ?? []).join("; ") || "unknown error";
			throw new AgxCliError(detail, {
				exitCode: EXIT.usage,
				remediation: "Shorten the message and resend.",
			});
		}
		const refused = res.rejected ?? [];
		const peerRefused =
			(res.accepted ?? 0) > 0 && res.deliveredToPeer === false;
		const detail =
			refused.length > 0
				? refused.map((r) => `${r.relay} (${r.error})`).join("; ")
				: (res.errors ?? []).join("; ") || "unknown error";
		throw new AgxCliError(
			peerRefused
				? `Published, but every relay ${toDisplayNpub(to)} advertises refused it, so they will not see it: ${detail}`
				: `Could not publish to any relay: ${detail}`,
			{
				exitCode: EXIT.network,
				remediation: peerRefused
					? "Their relays rejected the event — most often it is too large for a default-configured relay, or they require authentication.\n  Shorten the message, or ask them to check their relay list (NIP-65)."
					: `Check the relay is running:\n    agx relay\n  Configured relays: ${profile.relays.join(", ")}`,
			},
		);
	}

	recordSent(profileName, toDisplayNpub(to), message, options.subject ?? null, res.contextId ?? null, res.eventId);
	ok(`Sent to ${toDisplayNpub(to)}`);
	kv("event", res.eventId);
	kv("contextId", res.contextId);
	kv("relays", `${res.accepted ?? "?"}/${res.total ?? "?"} accepted`);
	// A refusal used to be invisible here: `1/2 accepted` printed in the same
	// plain style as `2/2`, and the reason sat unread in `errors`. Name the
	// relay and the reason, because "the recipient's relay refused it" and "one
	// of ours was down" are the same two numbers.
	//
	// And say WHICH of the two. This printed "relay refused" for every entry,
	// including relays that simply timed out — collapsing the distinction
	// `publishToRelays` carries in `kind` right at the point a human reads it.
	// One means shorten the message or get authorized; the other means try
	// again later.
	for (const r of res.rejected ?? []) {
		warn(
			r.kind === "unreachable"
				? `relay unreachable: ${r.relay} — ${r.error}`
				: `relay refused: ${r.relay} — ${r.error}`,
		);
	}
	json({
		ok: true,
		eventId: res.eventId,
		contextId: res.contextId,
		to: toDisplayNpub(to),
		accepted: res.accepted,
		total: res.total,
		rejected: res.rejected ?? [],
	});
}

/** Keep the sent message in the local history. A failure here must not fail a send that went out. */
function recordSent(
	profileName: string,
	peer: string,
	text: string,
	subject: string | null,
	contextId: string | null,
	eventId: string,
): void {
	try {
		MessageStore.spoolOutbound(profileDir(profileName), {
			id: eventId,
			peer,
			subject,
			contextId,
			text,
			at: new Date().toISOString(),
			deliveryStatus: "sent",
		});
	} catch (error) {
		warn(`Sent, but could not record it in your history: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface RequestOptions extends SendOptions {
	payload?: string;
	timeout?: string;
}

/**
 * Invoke a capability on another agent and wait for the correlated result.
 *
 * Runs its own pump loop rather than `start()`'s interval so the process can exit
 * the moment the result lands. Note the peer must have allowlisted this key —
 * default-deny means an unauthorized request is dropped with no reply, so the
 * symptom of a missing allowlist entry is a timeout, which the error explains.
 */
export async function requestCommand(
	peer: string,
	capability: string,
	options: RequestOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const to = toHexPubkey(peer, "recipient");
	const timeoutMs = Number(options.timeout ?? 30_000);

	let payload: unknown = {};
	if (options.payload) {
		try {
			payload = JSON.parse(options.payload);
		} catch (error) {
			throw new AgxCliError(
				`--payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ exitCode: EXIT.usage },
			);
		}
	}

	const transport = await createTransport(
		profile,
		identity,
		makeLogger(options.verbose ?? false),
	);
	const client = new AgxClient({
		transport,
		logger: makeLogger(options.verbose ?? false),
	});
	await client.start({ pollIntervalMs: 0, advertise: false });

	info(`requesting ${capability} from ${toDisplayNpub(to)} …`);
	const pending = client.request(to, capability, payload, { timeoutMs });

	const deadline = Date.now() + timeoutMs;
	let settled = false;
	const result = pending
		.then((value) => {
			settled = true;
			return { ok: true as const, value };
		})
		.catch((error: unknown) => {
			settled = true;
			return {
				ok: false as const,
				error: error instanceof Error ? error.message : String(error),
			};
		});

	while (!settled && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await client.pump().catch(() => undefined);
	}
	const outcome = await result;
	await client.stop().catch(() => undefined);

	if (outcome.ok) {
		ok(`${capability} →`);
		say(JSON.stringify(outcome.value, null, 2));
		json({ ok: true, capability, result: outcome.value });
		return;
	}

	fail(`${capability} failed: ${outcome.error}`);
	json({ ok: false, capability, error: outcome.error });
	throw new AgxCliError(`Request to ${toDisplayNpub(to)} did not complete.`, {
		exitCode: EXIT.remote,
		remediation:
			"If this timed out, the peer may not have allowlisted this key. Authorization is default-deny, so an unauthorized request is dropped with NO reply — a timeout is the expected symptom. On the peer, run:\n    agx identity allow <your npub>",
	});
}
