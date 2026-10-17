import {
	DEFAULT_CONTENT_TYPE,
	matchesCapability,
	randomId,
} from "@nostr-agx/core";
import {
	fetchNip05Pubkey,
	type NostrTransport,
	parseNip05,
	resolvePeerCardWithStatus,
	resolvePeerRelays,
	toNpub,
} from "@nostr-agx/nostr";
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	NodeOperationError,
} from "n8n-workflow";
import {
	autoReplyGuard,
	DEFAULT_AUTO_REPLY_LIMITS,
} from "../shared/auto-reply-guard";
import { type AgxIdentity, agxLogger } from "../shared/identity";
import { MAX_WAIT_SEC, numberOption } from "../shared/numbers";
import { parsePeer } from "../shared/peers";
import { Requester } from "../shared/requester";

/** The largest `contextId` the AGX payload schema accepts. A longer one would
 * make the recipient discard the whole message as malformed. */
const MAX_CONTEXT_ID = 200;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run `work` for every item, keeping n8n's continue-on-fail contract: a
 * failing item becomes `{ error }` in the output instead of failing the node. */
async function perItem(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	work: (itemIndex: number) => Promise<IDataObject>,
): Promise<INodeExecutionData[]> {
	const out: INodeExecutionData[] = [];
	for (let i = 0; i < items.length; i++) {
		try {
			out.push({ json: await work(i), pairedItem: { item: i } });
		} catch (error) {
			if (ctx.continueOnFail()) {
				out.push({ json: { error: messageOf(error) }, pairedItem: { item: i } });
				continue;
			}
			throw error instanceof NodeOperationError
				? error
				: new NodeOperationError(ctx.getNode(), error as Error, {
						itemIndex: i,
					});
		}
	}
	return out;
}

function parsePayload(
	ctx: IExecuteFunctions,
	value: unknown,
	itemIndex: number,
): unknown {
	if (typeof value !== "string") {
		return value ?? {};
	}
	if (!value.trim()) {
		return {};
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Payload is not valid JSON: ${messageOf(error)}`,
			{ itemIndex },
		);
	}
}

/** Agent → Get Own Identity. Local: no relay is contacted. */
export function getIdentity(
	items: INodeExecutionData[],
	identity: AgxIdentity,
): INodeExecutionData[] {
	return items.map((_, i) => ({
		json: {
			npub: identity.npub,
			pubkey: identity.publicKey,
			relays: identity.relays,
			org: identity.org,
			nip05: identity.nip05,
		},
		pairedItem: { item: i },
	}));
}

/**
 * Task → Request. Every item's request goes out at once, through the
 * identity's shared requester (see `Requester`), which polls this agent's inbox
 * until each has its result or times out: n items cost one wait, not n.
 */
export async function requestTasks(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	identity: AgxIdentity,
): Promise<INodeExecutionData[]> {
	const requester = await Requester.for(identity, agxLogger(ctx.logger));

	const request = async (i: number): Promise<IDataObject> => {
		const peer = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const npub = toNpub(peer);
		const capability = (ctx.getNodeParameter("capability", i) as string).trim();
		if (!capability) {
			throw new NodeOperationError(ctx.getNode(), "Capability is empty", {
				itemIndex: i,
			});
		}
		const payload = parsePayload(ctx, ctx.getNodeParameter("payload", i, "{}"), i);
		const options = ctx.getNodeParameter("options", i, {}) as {
			checkCard?: boolean;
			timeout?: unknown;
		};
		const timeoutSec = numberOption(options.timeout, "Timeout (Seconds)", 30, {
			min: 1,
			max: MAX_WAIT_SEC,
		});

		if (options.checkCard) {
			const { card, reachable } = await resolvePeerCardWithStatus(
				peer,
				identity.relays,
				identity.signer,
			);
			if (!reachable) {
				throw new NodeOperationError(
					ctx.getNode(),
					`No relay answered (${identity.relays.join(", ")}), so ${npub}'s card could not be read`,
					{
						itemIndex: i,
						description:
							"Check the credential's relays. Whether the agent advertises the capability is unknown until one of them answers.",
					},
				);
			}
			if (!card) {
				throw new NodeOperationError(
					ctx.getNode(),
					`No Agent Card found for ${npub}`,
					{
						itemIndex: i,
						description:
							"Not every agent advertises one. Turn off Check Agent Card First to send the request anyway.",
					},
				);
			}
			if (!matchesCapability(card.capabilities, capability)) {
				throw new NodeOperationError(
					ctx.getNode(),
					`${card.displayName ?? npub} does not advertise "${capability}"`,
					{
						itemIndex: i,
						description: `Its card lists: ${card.capabilities.join(", ") || "no capabilities"}.`,
					},
				);
			}
		}

		let output: unknown;
		try {
			output = await requester.request(peer, capability, payload, timeoutSec * 1000);
		} catch (error) {
			const message = messageOf(error);
			if (message.startsWith("AGX request timed out")) {
				throw new NodeOperationError(
					ctx.getNode(),
					`No result from ${npub} within ${timeoutSec} seconds`,
					{
						itemIndex: i,
						description: `AGX denies by default and a denied request gets no reply, so first check that the agent has allowed this one (${identity.npub}). Then check that it is running, serves "${capability}", and shares a relay with this agent or advertises its relays.`,
					},
				);
			}
			if (message.startsWith("AGX request:")) {
				throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
			}
			// Anything else is the peer's own failure report: an `AgxPublicError`
			// message, or `handler failed` for an error it kept to itself.
			throw new NodeOperationError(
				ctx.getNode(),
				`${npub} reported that the task failed: ${message}`,
				{ itemIndex: i },
			);
		}
		return { peer: npub, capability, status: "completed", output: output as IDataObject };
	};

	// Settled results, so one item failing does not leave the others' requests
	// unanswered behind a thrown error.
	const outcomes = await Promise.all(
		items.map((_, i) =>
			request(i).then(
				(json) => ({ ok: true as const, json }),
				(error: unknown) => ({ ok: false as const, error }),
			),
		),
	);
	const out: INodeExecutionData[] = [];
	for (const [i, outcome] of outcomes.entries()) {
		if (outcome.ok) {
			out.push({ json: outcome.json, pairedItem: { item: i } });
		} else if (ctx.continueOnFail()) {
			out.push({
				json: { error: messageOf(outcome.error) },
				pairedItem: { item: i },
			});
		} else {
			throw outcome.error instanceof NodeOperationError
				? outcome.error
				: new NodeOperationError(ctx.getNode(), outcome.error as Error, {
						itemIndex: i,
					});
		}
	}
	return out;
}

/**
 * Message → Send. `AgxClient` has no plain-message send — the task lifecycle is
 * its surface — so this publishes through the transport, as `agx send` does.
 */
export async function sendMessages(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	transport: NostrTransport,
	identity: AgxIdentity,
): Promise<INodeExecutionData[]> {
	return perItem(ctx, items, async (i) => {
		const to = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const text = ctx.getNodeParameter("text", i) as string;
		const options = ctx.getNodeParameter("options", i, {}) as {
			autoDepth?: unknown;
			contextId?: string;
			maxAutoDepth?: unknown;
			maxPerConversation?: unknown;
			maxPerHour?: unknown;
			subject?: string;
		};
		// Checked rather than coerced: an expression that yields NaN must not
		// quietly become depth 0, which would pass an automated reply off as one a
		// person wrote and skip every loop bound below.
		const depth = numberOption(options.autoDepth, "Automated Reply Depth", 0, {
			min: 0,
			max: 255,
			integer: true,
		});
		const limits = {
			maxDepth: numberOption(
				options.maxAutoDepth,
				"Max Automated Reply Depth",
				DEFAULT_AUTO_REPLY_LIMITS.maxDepth,
				{ min: 1, max: 255, integer: true },
			),
			perConversation: numberOption(
				options.maxPerConversation,
				"Max Automated Replies per Conversation",
				DEFAULT_AUTO_REPLY_LIMITS.perConversation,
				{ min: 1, max: 1_000_000, integer: true },
			),
			perPeerPerHour: numberOption(
				options.maxPerHour,
				"Max Automated Replies per Agent per Hour",
				DEFAULT_AUTO_REPLY_LIMITS.perPeerPerHour,
				{ min: 1, max: 1_000_000, integer: true },
			),
		};
		// A new conversation gets its id here rather than from the transport, so
		// the guard counts the conversation this message really starts — not one
		// shared bucket for every send that left the field empty.
		const contextId = options.contextId?.trim() || randomId();
		if (contextId.length > MAX_CONTEXT_ID) {
			throw new NodeOperationError(
				ctx.getNode(),
				`Conversation ID is longer than ${MAX_CONTEXT_ID} characters`,
				{ itemIndex: i },
			);
		}

		const admission = autoReplyGuard.admit(
			{ from: identity.publicKey, to, contextId, depth },
			limits,
		);
		if (admission.refused !== null) {
			throw new NodeOperationError(
				ctx.getNode(),
				"Automated reply not sent (loop protection)",
				{ itemIndex: i, description: `Not sent because ${admission.refused}` },
			);
		}

		let res: Awaited<ReturnType<NostrTransport["publishMessage"]>>;
		try {
			res = await transport.publishMessage(to, {
				text,
				subject: options.subject?.trim() || null,
				contextId,
				contentType: DEFAULT_CONTENT_TYPE,
				// Declared only on an automated reply; 0 is the same as absent.
				autoDepth: depth > 0 ? depth : undefined,
			});
		} catch (error) {
			admission.release();
			throw new NodeOperationError(ctx.getNode(), error as Error, { itemIndex: i });
		}
		if (!res.ok) {
			// Not delivered, so it does not count against the loop bounds.
			admission.release();
			const detail =
				res.rejected.length > 0
					? res.rejected.map((r) => `${r.relay} (${r.error})`).join("; ")
					: res.errors.join("; ") || "unknown error";
			// The same three cases `agx send` tells apart: refused before any
			// relay was contacted (too large), refused by every relay the
			// recipient reads, or not accepted by any relay at all.
			const message =
				res.total === 0
					? detail
					: res.accepted > 0 && res.deliveredToPeer === false
						? `Every relay ${toNpub(to)} reads from refused the message, so they will not see it: ${detail}`
						: `No relay accepted the message: ${detail}`;
			throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
		}
		return {
			to: toNpub(to),
			eventId: res.eventId,
			contextId: res.contextId,
			autoDepth: depth,
			relaysAccepted: res.accepted,
			relaysTotal: res.total,
			// null: the recipient advertises no relays we could resolve, so
			// whether it reached a relay they read is unknown.
			deliveredToPeer: res.deliveredToPeer ?? null,
			rejected: res.rejected,
		};
	});
}

/** Whether the domain a card's NIP-05 claim names maps that name back to the
 * agent: `true`, `false` when it names another key or the claim is malformed,
 * and `null` when it could not be told — `fetchNip05Pubkey` answers null both
 * for a domain it could not read and for a name the domain does not list, and a
 * passing outage is not evidence of impersonation. */
async function verifyNip05(claim: string, pubkey: string): Promise<boolean | null> {
	const parsed = parseNip05(claim);
	if (!parsed) {
		return false;
	}
	const published = await fetchNip05Pubkey(parsed.name, parsed.domain);
	return published === null ? null : published === pubkey;
}

/** Agent → Get Card. */
export async function getCards(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	identity: AgxIdentity,
): Promise<INodeExecutionData[]> {
	return perItem(ctx, items, async (i) => {
		const peer = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const options = ctx.getNodeParameter("options", i, {}) as {
			capability?: string;
			verifyNip05?: boolean;
		};
		const [{ card, reachable }, relays] = await Promise.all([
			resolvePeerCardWithStatus(peer, identity.relays, identity.signer),
			resolvePeerRelays(peer, identity.relays, identity.signer).catch(
				() => [] as string[],
			),
		]);
		if (!reachable) {
			throw new NodeOperationError(
				ctx.getNode(),
				`No relay answered (${identity.relays.join(", ")})`,
				{
					itemIndex: i,
					description:
						"Whether the agent has a card is unknown until a relay can be read.",
				},
			);
		}
		// Verified against the card just read, not a second fetch of it, so the
		// verdict is about the claim this output shows.
		const nip05Verified =
			card?.nip05 && options.verifyNip05 !== false
				? await verifyNip05(card.nip05, peer)
				: null;
		const capability = options.capability?.trim();
		return {
			npub: toNpub(peer),
			pubkey: peer,
			found: card !== null,
			org: card?.displayName ?? null,
			capabilities: card?.capabilities ?? [],
			nip05: card?.nip05 ?? null,
			nip05Verified,
			relays,
			...(capability
				? {
						capability,
						supportsCapability: matchesCapability(
							card?.capabilities ?? [],
							capability,
						),
					}
				: {}),
		};
	});
}
