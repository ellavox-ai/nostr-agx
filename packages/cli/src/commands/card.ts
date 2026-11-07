import {
	type AgentSkill,
	CARD_KIND,
	fetchByAuthor,
	fetchNip05Pubkey,
	parseAgentCardMetadata,
	parseNip05,
	RELAY_LIST_KIND,
	verifyEvent,
} from "@nostr-agx/nostr";
import kleur from "kleur";
import { effectiveProfile, resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { heading, info, json, kv, say, warn } from "../lib/output.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";

/**
 * Read an agent's published Agent Card (kind 11337) and relay list (kind 10002)
 * off the relays.
 *
 * The card is the discovery half of the protocol and is deliberately
 * UNENCRYPTED — anyone who can reach the relay can read what an agent advertises.
 * Showing it plainly is the point: it is how a peer decides whether an agent can
 * service a capability before sending anything.
 *
 * Note a card is a CLAIM, not proof. The `nip05` on it is self-asserted; only a
 * NIP-05 round trip that maps the handle back to this pubkey verifies it, which
 * is why an unverified handle is withheld from the index's public projection.
 */

export interface CardOptions {
	profile?: string;
	relay?: string[];
	raw?: boolean;
	verify?: boolean;
	skill?: string;
}

type VerdictKind = "verified" | "mismatch" | "unreachable" | "none";

interface Nip05Verdict {
	kind: VerdictKind;
	domain: string | null;
	detail: string;
}

/**
 * Verify the card's claimed NIP-05 by doing the round trip ourselves.
 *
 * This is the ONLY honest way to get a verification badge in this model. A card
 * is signed by the agent's own key, so a `verified: true` field inside it would
 * prove nothing — the signature attests that this key published the claim, not
 * that the claim is true. Anyone could publish a card asserting any org and any
 * domain.
 *
 * What IS checkable: fetch `https://<domain>/.well-known/nostr.json?name=<name>`
 * and see whether the domain publishes THIS pubkey. Then the authority is the
 * domain owner's DNS + HTTPS, and any party can re-run the same check
 * independently — no issuer to trust, nothing to forge in the card itself.
 */
async function verifyCardNip05(
	claimed: string | null | undefined,
	pubkey: string,
): Promise<Nip05Verdict> {
	if (!claimed) {
		return {
			kind: "none",
			domain: null,
			detail: "the card claims no NIP-05 handle",
		};
	}
	const parsed = parseNip05(claimed);
	if (!parsed) {
		return {
			kind: "mismatch",
			domain: null,
			detail: `"${claimed}" is not a valid name@domain identifier`,
		};
	}
	const published = await fetchNip05Pubkey(parsed.name, parsed.domain);
	if (published === null) {
		// Deliberately not distinguished further: the resolver refuses non-public
		// hosts, redirects, oversize and malformed bodies alike, and reporting which
		// one would turn it into a probe oracle.
		return {
			kind: "unreachable",
			domain: parsed.domain,
			detail: `${parsed.domain} did not serve a usable mapping for "${parsed.name}"`,
		};
	}
	if (published !== pubkey) {
		return {
			kind: "mismatch",
			domain: parsed.domain,
			detail: `${parsed.domain} publishes ${published.slice(0, 16)}… for "${parsed.name}" — a DIFFERENT key`,
		};
	}
	return {
		kind: "verified",
		domain: parsed.domain,
		detail: `${parsed.domain} vouches for this key`,
	};
}

interface ParsedCard {
	v?: number;
	org?: string;
	npub?: string;
	nip05?: string | null;
	relays?: string[];
	capabilities?: string[];
	payloadTypes?: string[];
	encryption?: string[];
	version?: string;
}

function printSkill(skill: AgentSkill): void {
	say("");
	heading(`Skill — ${skill.id}`);
	kv("description", skill.description);
	kv("tags", skill.tags?.join(", ") || "—");
	kv("input modes", skill.inputModes?.join(", ") || "—");
	kv("output modes", skill.outputModes?.join(", ") || "—");
	kv("features", skill.features?.join(", ") || "—");
	if (skill.inputSchema) {
		say("");
		heading("Input schema");
		say(JSON.stringify(skill.inputSchema, null, 2));
	}
	if (skill.outputSchema) {
		say("");
		heading("Output schema");
		say(JSON.stringify(skill.outputSchema, null, 2));
	}
}

export async function cardCommand(
	peer: string,
	options: CardOptions,
): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const relays = options.relay?.length ? options.relay : profile.relays;
	if (relays.length === 0) {
		throw new AgxCliError("No relays configured.", {
			exitCode: EXIT.config,
			remediation:
				"agx config set relays ws://127.0.0.1:7447\n  and run one with:  agx relay",
		});
	}
	const pubkey = toHexPubkey(peer, "agent identity");

	const [cardEvents, relayEvents] = await Promise.all([
		fetchByAuthor({ relays, author: pubkey, kinds: [CARD_KIND], limit: 1 }),
		fetchByAuthor({
			relays,
			author: pubkey,
			kinds: [RELAY_LIST_KIND],
			limit: 1,
		}),
	]);

	const cardEvent = cardEvents[0];
	if (!cardEvent) {
		throw new AgxCliError(
			`No Agent Card found for ${toDisplayNpub(pubkey)} on ${relays.join(", ")}.`,
			{
				exitCode: EXIT.remote,
				remediation:
					"A card is published only when the agent advertises one:\n    an external agent — agx serve --advertise\n    a hosted agent — it must be BOTH enabled and Discoverable (listed)\n  Cards live in relay memory, so restarting `agx relay` discards them.",
			},
		);
	}

	// The signature is what makes a card trustworthy at all: it binds the claimed
	// capabilities to the key that will answer for them.
	const signatureValid = verifyEvent(cardEvent);

	let card: ParsedCard;
	try {
		card = JSON.parse(cardEvent.content) as ParsedCard;
	} catch {
		throw new AgxCliError(
			`The card published by ${toDisplayNpub(pubkey)} is not valid JSON.`,
			{ exitCode: EXIT.remote },
		);
	}

	const typedMetadata = parseAgentCardMetadata(card);
	const selectedSkill = options.skill
		? typedMetadata.skills?.find((skill) => skill.id === options.skill)
		: undefined;
	if (options.skill && !selectedSkill) {
		const warning = typedMetadata.warning
			? ` ${typedMetadata.warning.message}`
			: "";
		throw new AgxCliError(
			`No valid typed skill "${options.skill}" found on this Agent Card.${warning}`,
			{ exitCode: EXIT.remote },
		);
	}

	heading(card.org ? `Agent Card — ${card.org}` : "Agent Card");
	kv("npub", toDisplayNpub(pubkey));
	kv("capabilities", (card.capabilities ?? []).join(", ") || "—");
	kv("nip05 (claimed)", card.nip05 ?? null);
	kv("relays", (card.relays ?? []).join(", ") || "—");
	kv("payload types", (card.payloadTypes ?? []).join(", ") || "—");
	kv("encryption", (card.encryption ?? []).join(", ") || "—");
	kv("card version", card.version ?? null);
	kv("event id", cardEvent.id);
	kv("published", new Date(cardEvent.created_at * 1000).toISOString());
	kv(
		"signature",
		signatureValid ? "valid" : "INVALID — do not trust this card",
	);

	if (!signatureValid) {
		warn(
			"The signature does not verify. Anything on this card is unattributable.",
		);
	}
	if (typedMetadata.warning) {
		warn(typedMetadata.warning.message);
	}
	if (typedMetadata.skills?.length) {
		say("");
		heading("Skills");
		for (const skill of typedMetadata.skills) {
			say(`  ${skill.id} — ${skill.description}`);
		}
	}
	if (typedMetadata.extensions?.length) {
		say("");
		heading("Extensions");
		for (const extension of typedMetadata.extensions) {
			say(
				`  ${extension.uri} (${extension.required ? "required" : "optional"})`,
			);
		}
	}
	if (selectedSkill) {
		printSkill(selectedSkill);
	}

	let verdict: Nip05Verdict | null = null;
	if (options.verify) {
		verdict = await verifyCardNip05(card.nip05, pubkey);
		say("");
		heading("Domain verification (NIP-05)");
		switch (verdict.kind) {
			case "verified":
				say(
					`  ${kleur.green("VERIFIED")}  ${card.nip05}  —  ${verdict.detail}`,
				);
				say(
					kleur.dim(
						"  The authority is the domain owner, not this card and not any directory:\n  anyone can re-run this exact check and get the same answer.",
					),
				);
				break;
			case "mismatch":
				say(`  ${kleur.red("IMPOSTOR")}  ${verdict.detail}`);
				say(
					kleur.dim(
						"  The card claims a handle the domain does not back. Treat every claim on it as unfounded.",
					),
				);
				break;
			case "unreachable":
				say(`  ${kleur.yellow("UNVERIFIED")}  ${verdict.detail}`);
				say(
					kleur.dim(
						"  Verification needs a PUBLIC https host — the resolver blocks localhost and\n  private addresses with no bypass, because that guard is the control. For a\n  local run, expose your local index: cloudflared tunnel --url http://localhost:3000",
					),
				);
				break;
			case "none":
				say(`  ${kleur.dim("—")}  ${verdict.detail}`);
				break;
		}
	} else if (card.nip05) {
		say("");
		info(
			`The NIP-05 handle on a card is self-asserted — a card cannot certify itself. Check it with:  agx card ${toDisplayNpub(pubkey)} --verify`,
		);
	}

	const relayList = relayEvents[0];
	if (relayList) {
		const advertised = relayList.tags
			.filter((t) => t[0] === "r" && typeof t[1] === "string")
			.map((t) => t[1] as string);
		say("");
		heading("Relay list (NIP-65)");
		for (const url of advertised) {
			say(`  ${url}`);
		}
		if (
			advertised.some((u) => /^wss?:\/\/(localhost|127\.0\.0\.1)/.test(u))
		) {
			say("");
			info(
				"A peer filters advertised relays through an SSRF guard (public wss:// only), so a localhost relay here is ignored for routing — messaging still works when both sides configure the same relay themselves.",
			);
		}
	}

	if (options.raw) {
		say("");
		heading("Raw event");
		say(JSON.stringify(cardEvent, null, 2));
	}

	say("");
	say(
		kleur.dim(
			"This card is unencrypted: anyone who can reach the relay can read it. That is deliberate — it is how a peer decides whether this agent can service a capability.",
		),
	);

	json({
		card,
		typedMetadata,
		selectedSkill,
		event: cardEvent,
		signatureValid,
		nip05: verdict,
	});
}
