import {
	AgxPendingRequestStoreError,
	AgxRequestUnknownError,
	AgxTaskFailedError,
	type AutoReplyGuard,
	DEFAULT_AUTO_REPLY_LIMITS,
	DEFAULT_CONTENT_TYPE,
	matchesCapability,
	randomId,
} from "@nostr-agx/core";
import {
	type AgxSigner,
	fetchNip05Pubkey,
	type NostrTransport,
	normalizePubkey,
	parseNip05,
	resolvePeerCardWithStatus,
	resolvePeerRelays,
	toNpub,
} from "@nostr-agx/nostr";
import type { NewOutboundMessage } from "../store/types.js";
import { ApiError, integer, isRecord, text } from "./http.js";
import type { RecoveredTaskOperation } from "./idempotency.js";
import type { Requester } from "./requester.js";

/**
 * What the gateway does for an API client, one function per route: the same
 * checks and answers as the AGX node's operations, so a workflow behaves the
 * same whichever way it reaches AGX.
 */

/** The longest a `POST /v1/tasks` call waits for its result. The HTTP request
 * stays open the whole time. */
export const MAX_TASK_TIMEOUT_SEC = 3600;
/** The largest `contextId` the AGX payload schema accepts. */
const MAX_CONTEXT_ID = 200;
const MAX_CAPABILITY_CHARS = 200;

export interface OperationDeps {
	npub: string;
	relays: string[];
	signer: AgxSigner;
	publicKey: string;
	transport: NostrTransport;
	requester: Requester;
	guard: AutoReplyGuard;
	/** Keeps a sent message in the profile's history, as `agx send` does. */
	recordSent?: (message: NewOutboundMessage) => void;
}

function body(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ApiError(400, "invalid_request", "The request body must be a JSON object");
	}
	return value;
}

function peerOf(value: unknown): string {
	const input = text(value).trim();
	const hex = normalizePubkey(input);
	if (!hex) {
		throw new ApiError(400, "invalid_peer", `The agent must be an npub1… key or a 64-character hex public key, not "${input}"`);
	}
	return hex;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface TaskRequest {
	peer: string;
	npub: string;
	capability: string;
	payload: unknown;
	timeoutSec: number;
	checkCard: boolean;
	background: boolean;
}

export function parseTaskRequest(input: unknown): TaskRequest {
	const req = body(input);
	const peer = peerOf(req.peer);
	const npub = toNpub(peer);
	const capability = text(req.capability).trim();
	if (!capability) {
		throw new ApiError(400, "invalid_request", "Capability is empty");
	}
	if (capability.length > MAX_CAPABILITY_CHARS) {
		throw new ApiError(400, "invalid_request", `Capability names can be at most ${MAX_CAPABILITY_CHARS} characters`);
	}
	if (req.background !== undefined && typeof req.background !== "boolean") {
		throw new ApiError(400, "invalid_request", "background must be true or false");
	}
	return {
		peer,
		npub,
		capability,
		payload: req.payload === undefined ? {} : req.payload,
		timeoutSec: integer(req.timeoutSec, "timeoutSec", 30, { min: 1, max: MAX_TASK_TIMEOUT_SEC }),
		checkCard: req.checkCard === true,
		background: req.background === true,
	};
}

async function awaitTaskResult(
	deps: OperationDeps,
	req: TaskRequest,
	result: Promise<unknown>,
	recovered = false,
): Promise<Record<string, unknown>> {
	let output: unknown;
	try {
		output = await result;
	} catch (error) {
		const message = messageOf(error);
		// By type or code only: a remote peer's failure is a plain Error carrying the
		// peer's own text, so matching text would let it pose as a local condition.
		const code = (error as { code?: unknown } | null)?.code;
		if (error instanceof AgxRequestUnknownError || code === "result_unknown") {
			throw new ApiError(
				409,
				"result_unknown",
				"The gateway stopped before this task's outcome was recorded",
				"The remote agent may have executed the task. Check its effects before submitting new work.",
			);
		}
		if (error instanceof AgxPendingRequestStoreError || code === "pending_request_store_failed") {
			throw new ApiError(
				500,
				"idempotency_store_failed",
				"The task's pending correlation could not be stored",
				(error as { mayHavePublished?: unknown }).mayHavePublished === false
					? "Nothing was sent to the remote agent. Retry with a new key once the gateway can write its task store."
					: "Do not retry with a different key until you have checked whether the remote agent executed the task.",
			);
		}
		if (message.startsWith("AGX task requires input")) {
			throw new ApiError(
				422,
				"input_required",
				`${req.npub} requires interactive input to continue this task`,
				"This gateway task endpoint cannot answer interactive prompts. Use an input-capable AGX client.",
			);
		}
		// The peer's own failure report: an `AgxPublicError` message, or `handler
		// failed` for an error it kept to itself. Its text never reaches the checks
		// below, which are for this client's own errors: a peer's "AGX request:
		// encoded payload exceeds..." would get the retryable 413, free the
		// idempotency key, and let a retry send the task again. (The input check
		// above does read peer text, as a peer refuses input it cannot ask for that
		// way; 422 is not retryable, so the key stays.)
		if (error instanceof AgxTaskFailedError) {
			throw new ApiError(502, "task_failed", `${req.npub} reported that the task failed: ${message}`);
		}
		if (message.startsWith("AGX request timed out")) {
			throw new ApiError(
				504,
				"timeout",
				recovered
					? `No result from ${req.npub} by its original deadline`
					: `No result from ${req.npub} within ${req.timeoutSec} seconds`,
				`AGX denies by default and a denied request gets no reply, so first check that the agent has allowed this one (${deps.npub}). Then check that it is running, serves "${req.capability}", and shares a relay with this agent or advertises its relays.`,
			);
		}
		if (message.startsWith("AGX request: encoded payload exceeds")) {
			throw new ApiError(413, "payload_too_large", message);
		}
		if (message.startsWith("AGX request:")) {
			throw new ApiError(502, "publish_failed", message);
		}
		throw new ApiError(502, "task_failed", `${req.npub} reported that the task failed: ${message}`);
	}
	return { peer: req.npub, capability: req.capability, status: "completed", output };
}

export async function runTaskRequest(
	deps: OperationDeps,
	req: TaskRequest,
	signal?: AbortSignal,
	storageKey?: string,
): Promise<Record<string, unknown>> {
	if (req.checkCard) {
		const { card, reachable } = await resolvePeerCardWithStatus(req.peer, deps.relays, deps.signer);
		if (!reachable) {
			throw new ApiError(
				503,
				"relays_unreachable",
				`No relay answered (${deps.relays.join(", ")}), so ${req.npub}'s card could not be read`,
				"Check the gateway's relays. Whether the agent advertises the capability is unknown until one of them answers.",
			);
		}
		if (!card) {
			throw new ApiError(404, "no_card", `No Agent Card found for ${req.npub}`, "Not every agent advertises one. Send without the card check to request anyway.");
		}
		if (!matchesCapability(card.capabilities, req.capability)) {
			throw new ApiError(
				422,
				"capability_not_advertised",
				`${card.displayName ?? req.npub} does not advertise "${req.capability}"`,
				`Its card lists: ${card.capabilities.join(", ") || "no capabilities"}.`,
			);
		}
	}

	return awaitTaskResult(
		deps,
		req,
		deps.requester.request(req.peer, req.capability, req.payload, req.timeoutSec * 1000, signal, storageKey),
	);
}

export async function runRecoveredTaskRequest(
	deps: OperationDeps,
	operation: RecoveredTaskOperation,
): Promise<Record<string, unknown>> {
	return awaitTaskResult(deps, {
		peer: operation.peer,
		npub: toNpub(operation.peer),
		capability: operation.capability,
		payload: {},
		timeoutSec: 0,
		checkCard: false,
		background: true,
	}, operation.result, true);
}

/** `POST /v1/messages`: send an encrypted message. */
export async function sendMessage(deps: OperationDeps, input: unknown): Promise<Record<string, unknown>> {
	const req = body(input);
	const to = peerOf(req.peer);
	const messageText = text(req.text);
	if (!messageText.trim()) {
		throw new ApiError(400, "invalid_request", "Text is empty");
	}
	// Present but empty is an error, not depth 0: `{{ $json.replyAutoDepth }}` on
	// an item that lost the field would otherwise pass an automated reply off as
	// one a person wrote, and skip every loop bound below.
	if ("autoDepth" in req && (req.autoDepth === undefined || req.autoDepth === null || req.autoDepth === "")) {
		throw new ApiError(
			400,
			"invalid_request",
			"Automated Reply Depth is empty",
			"Set it to the trigger's replyAutoDepth for an automated reply, or to 0 for a message a person wrote.",
		);
	}
	const depth = integer(req.autoDepth, "autoDepth", 0, { min: 0, max: 255 });
	const limits = {
		maxDepth: integer(req.maxAutoDepth, "maxAutoDepth", DEFAULT_AUTO_REPLY_LIMITS.maxDepth, { min: 1, max: 255 }),
		perConversation: integer(req.maxPerConversation, "maxPerConversation", DEFAULT_AUTO_REPLY_LIMITS.perConversation, { min: 1, max: 1_000_000 }),
		perPeerPerHour: integer(req.maxPerHour, "maxPerHour", DEFAULT_AUTO_REPLY_LIMITS.perPeerPerHour, { min: 1, max: 1_000_000 }),
	};
	const contextId = text(req.contextId).trim() || randomId();
	if (contextId.length > MAX_CONTEXT_ID) {
		throw new ApiError(400, "invalid_request", `Conversation ID is longer than ${MAX_CONTEXT_ID} characters`);
	}
	const admission = deps.guard.admit({ from: deps.publicKey, to, contextId, depth }, limits);
	if (admission.refused !== null) {
		throw new ApiError(429, "loop_protection", "Automated reply not sent (loop protection)", `Not sent because ${admission.refused}`);
	}
	const subject = text(req.subject).trim() || null;
	let res: Awaited<ReturnType<NostrTransport["publishMessage"]>>;
	try {
		res = await deps.transport.publishMessage(to, {
			text: messageText,
			subject,
			contextId,
			contentType: DEFAULT_CONTENT_TYPE,
			// Declared only on an automated reply; 0 is the same as absent.
			autoDepth: depth > 0 ? depth : undefined,
		});
	} catch (error) {
		admission.release();
		throw new ApiError(502, "publish_failed", messageOf(error));
	}
	if (!res.ok) {
		// Not delivered, so it does not count against the loop bounds.
		admission.release();
		const detail =
			res.rejected.length > 0
				? res.rejected.map((r) => `${r.relay} (${r.error})`).join("; ")
				: res.errors.join("; ") || "unknown error";
		if (res.total === 0) {
			throw new ApiError(400, "message_rejected", detail);
		}
		throw new ApiError(
			502,
			"publish_failed",
			res.accepted > 0 && res.deliveredToPeer === false
				? `Every relay ${toNpub(to)} reads from refused the message, so they will not see it: ${detail}`
				: `No relay accepted the message: ${detail}`,
		);
	}
	deps.recordSent?.({
		id: res.eventId,
		peer: toNpub(to),
		subject,
		contextId: res.contextId ?? contextId,
		text: messageText,
		at: new Date().toISOString(),
		deliveryStatus: "sent",
	});
	return {
		to: toNpub(to),
		eventId: res.eventId,
		contextId: res.contextId,
		autoDepth: depth,
		relaysAccepted: res.accepted,
		relaysTotal: res.total,
		deliveredToPeer: res.deliveredToPeer ?? null,
		rejected: res.rejected,
	};
}

/** Whether the domain a card's NIP-05 claim names maps it back to the agent:
 * null when it could not be told. */
async function verifyNip05(claim: string, pubkey: string): Promise<boolean | null> {
	const parsed = parseNip05(claim);
	if (!parsed) {
		return false;
	}
	const published = await fetchNip05Pubkey(parsed.name, parsed.domain);
	return published === null ? null : published === pubkey;
}

/** `GET /v1/agents/:peer`: an agent's card, its relays, and whether it serves a capability. */
export async function readCard(
	deps: OperationDeps,
	peerInput: string,
	query: URLSearchParams,
): Promise<Record<string, unknown>> {
	const peer = peerOf(peerInput);
	const [{ card, reachable }, relays] = await Promise.all([
		resolvePeerCardWithStatus(peer, deps.relays, deps.signer),
		resolvePeerRelays(peer, deps.relays, deps.signer).catch(() => [] as string[]),
	]);
	if (!reachable) {
		throw new ApiError(
			503,
			"relays_unreachable",
			`No relay answered (${deps.relays.join(", ")})`,
			"Whether the agent has a card is unknown until a relay can be read.",
		);
	}
	const nip05Verified =
		card?.nip05 && query.get("verifyNip05") !== "false" ? await verifyNip05(card.nip05, peer) : null;
	const capability = (query.get("capability") ?? "").trim();
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
			? { capability, supportsCapability: matchesCapability(card?.capabilities ?? [], capability) }
			: {}),
	};
}
