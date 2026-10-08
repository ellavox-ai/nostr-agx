import type { IncomingMessage } from "node:http";
import {
	archiveDraft,
	type Draft,
	listDrafts,
	MAX_BODY_CHARS,
	readDraft,
} from "./drafts.js";
import { scanForSecrets } from "./secrets-scan.js";
import type {
	HeldDecision,
	PeerRecord,
	PeerStatus,
	UiStore,
} from "./store.js";

/**
 * The JSON API behind `agx ui`. Pure request handling over `UiStore`: no
 * sockets, no key material. `handleApi` returns a status and a body; the
 * server adds the security headers.
 *
 * Nothing here can return the secret key: the only identity data it knows is
 * what `deps.identity` hands over (npub, profile name, relays).
 */
export const MAX_REQUEST_BYTES = 32 * 1024;

/** Sends in flight, by recipient and thread. */
const sending = new Set<string>();

export interface IdentityView {
	profile: string;
	npub: string;
	relays: string[];
	doctor: { status: "unknown" | "ok" | "warn" | "fail"; detail: string | null };
}

export interface AgentLookup {
	address: string;
	handle: string | null;
	verified: boolean;
	displayName: string | null;
	summary: string | null;
}

export interface SendRequest {
	to: string;
	subject?: string | null;
	contextId?: string | null;
	body: string;
}

export interface ApiDeps {
	store: UiStore;
	identity: () => IdentityView;
	draftsDir: string | null;
	/** The `--compose` draft, if any. */
	composeDraft: Draft | null;
	/** Publish a plain message through the same path as `agx send`. */
	send: (message: SendRequest) => Promise<{ ok: boolean; detail: string | null; eventId?: string | null; contextId?: string | null }>;
	/** Public Elladex lookup by handle or address. */
	lookupAgent: (query: string) => Promise<AgentLookup | null>;
	/** Normalise any npub/hex input to an npub, or throw. */
	toNpub: (input: string) => string;
}

export interface ApiResult {
	status: number;
	body: unknown;
}

const NPUB_RE = /^npub1[02-9ac-hj-np-z]{20,100}$/;

function fail(status: number, code: string, message: string, extra: object = {}): ApiResult {
	return { status, body: { error: { code, message, ...extra } } };
}

export class BodyTooLargeError extends Error {}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_REQUEST_BYTES) {
			throw new BodyTooLargeError();
		}
		chunks.push(chunk as Buffer);
	}
	if (size === 0) {
		return {};
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length <= max ? value : null;
}

export async function handleApi(
	deps: ApiDeps,
	method: string,
	url: URL,
	body: unknown,
): Promise<ApiResult> {
	const path = url.pathname;
	const { store } = deps;

	if (method === "GET" && path === "/api/identity") {
		return { status: 200, body: deps.identity() };
	}

	if (method === "GET" && (path === "/api/inbox" || path === "/api/sent")) {
		const direction = path === "/api/inbox" ? "in" : "out";
		const query = url.searchParams.get("q") ?? undefined;
		const rows = store.listMessages({
			direction,
			query: query && query.length <= 200 ? query : undefined,
			unreadOnly: url.searchParams.get("unread") === "1",
			limit: 200,
		});
		return {
			status: 200,
			body: { messages: rows.map((m) => withPeer(m, deps)) },
		};
	}

	if (method === "GET" && path === "/api/threads") {
		return { status: 200, body: { threads: store.listThreads() } };
	}

	const threadMatch = /^\/api\/threads\/([^/]+)(\/read)?$/.exec(path);
	if (threadMatch) {
		const id = decodeURIComponent(threadMatch[1] as string);
		if (method === "GET" && !threadMatch[2]) {
			const messages = store.getThread(id);
			return {
				status: 200,
				body: {
					contextId: id,
					messages: messages.map((m) => withPeer(m, deps)),
					awaitingReply: messages.at(-1)?.direction === "out",
				},
			};
		}
		if (method === "POST" && threadMatch[2]) {
			store.markThreadRead(id);
			return { status: 200, body: { ok: true } };
		}
	}

	if (method === "GET" && path === "/api/held") {
		return { status: 200, body: { held: store.listHeld() } };
	}

	const heldMatch = /^\/api\/held\/([^/]+)\/(allow|ignore|block)$/.exec(path);
	if (method === "POST" && heldMatch) {
		const npub = decodeURIComponent(heldMatch[1] as string);
		const decision = heldMatch[2] as HeldDecision;
		if (!NPUB_RE.test(npub)) {
			return fail(400, "bad_npub", "Not a valid npub.");
		}
		if (decision === "block" && !(isRecord(body) && body.confirm === true)) {
			return fail(409, "confirm_required", "Blocking needs confirmation.");
		}
		try {
			store.decideHeld(npub, decision);
		} catch (error) {
			return fail(404, "not_held", error instanceof Error ? error.message : "Not held.");
		}
		return { status: 200, body: { ok: true } };
	}

	if (method === "GET" && path === "/api/peers") {
		return { status: 200, body: { peers: store.listPeers() } };
	}

	if (method === "POST" && path === "/api/peers") {
		if (!isRecord(body)) {
			return fail(400, "bad_request", "Expected a JSON object.");
		}
		let npub: string;
		try {
			npub = deps.toNpub(String(body.npub ?? ""));
		} catch {
			return fail(400, "bad_npub", "Not a valid npub or hex key.");
		}
		const status = body.status;
		if (status !== "allowed" && status !== "ignored" && status !== "blocked") {
			return fail(400, "bad_status", "Status must be allowed, ignored or blocked.");
		}
		if (status === "blocked" && body.confirm !== true) {
			return fail(409, "confirm_required", "Blocking needs confirmation.");
		}
		// "Verified" is never taken from the client: ask the directory again and
		// require that it names this very address.
		const handle = str(body.handle, 200);
		let verified = false;
		if (body.verified === true && handle) {
			const found = await deps.lookupAgent(handle);
			verified = found?.verified === true && found.address === npub;
		}
		const record: PeerRecord = {
			npub,
			status: status as PeerStatus,
			label: str(body.label, 200),
			handle,
			verified,
		};
		store.setPeer(record);
		return { status: 200, body: { peer: record } };
	}

	const peerMatch = /^\/api\/peers\/([^/]+)$/.exec(path);
	if (method === "DELETE" && peerMatch) {
		const npub = decodeURIComponent(peerMatch[1] as string);
		if (!NPUB_RE.test(npub)) {
			return fail(400, "bad_npub", "Not a valid npub.");
		}
		store.removePeer(npub);
		return { status: 200, body: { ok: true } };
	}

	if (method === "GET" && path === "/api/lookup") {
		const query = str(url.searchParams.get("q"), 200);
		if (!query) {
			return fail(400, "bad_request", "Give a handle or address in q.");
		}
		const found = await deps.lookupAgent(query);
		return found
			? { status: 200, body: { agent: found } }
			: fail(404, "not_found", "No public Elladex listing for that.");
	}

	if (method === "GET" && path === "/api/drafts") {
		return {
			status: 200,
			body: {
				enabled: deps.draftsDir !== null,
				drafts: deps.draftsDir ? listDrafts(deps.draftsDir) : [],
			},
		};
	}

	if (method === "GET" && path === "/api/compose") {
		return { status: 200, body: { draft: deps.composeDraft } };
	}

	const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(path);
	if (method === "GET" && draftMatch && deps.draftsDir) {
		try {
			return { status: 200, body: { draft: readDraft(deps.draftsDir, decodeURIComponent(draftMatch[1] as string)) } };
		} catch (error) {
			return fail(400, "bad_draft", error instanceof Error ? error.message : "Bad draft.");
		}
	}

	if (method === "POST" && path === "/api/scan") {
		const text = isRecord(body) ? str(body.text, MAX_BODY_CHARS * 2) : null;
		return text === null
			? fail(400, "bad_request", "Give text.")
			: { status: 200, body: { findings: scanForSecrets(text) } };
	}

	if (method === "POST" && path === "/api/send") {
		return handleSend(deps, body);
	}

	return fail(404, "not_found", "No such endpoint.");
}

async function handleSend(deps: ApiDeps, body: unknown): Promise<ApiResult> {
	if (!isRecord(body)) {
		return fail(400, "bad_request", "Expected a JSON object.");
	}
	const text = str(body.body, MAX_BODY_CHARS);
	if (!text || text.trim() === "") {
		return fail(400, "bad_body", `The message must be 1 to ${MAX_BODY_CHARS} characters.`);
	}
	let to: string;
	try {
		to = deps.toNpub(String(body.to ?? ""));
	} catch {
		return fail(400, "bad_recipient", "The recipient is not a valid npub.");
	}
	// The user confirmed the exact text shown in the dialog; refuse anything else.
	let confirmedTo: string | null = null;
	try {
		confirmedTo = deps.toNpub(String(body.confirmedTo ?? ""));
	} catch {
		confirmedTo = null;
	}
	if (body.confirmedText !== text || confirmedTo !== to) {
		return fail(409, "confirm_required", "Confirm the exact recipient and text first.");
	}
	const peerStatus = deps.store.peerStatus(to);
	if (peerStatus === "blocked") {
		return fail(409, "blocked_peer", "This sender is blocked. Unblock them in Peers first.");
	}
	const subject = str(body.subject, 500);
	const contextId = str(body.contextId, 200);

	if (contextId && body.allowFollowUp !== true) {
		const thread = deps.store.getThread(contextId);
		if (thread.at(-1)?.direction === "out") {
			return fail(
				409,
				"follow_up_guard",
				"This thread has no reply to your last message. Etiquette: one follow-up at most, and only if you mean it.",
			);
		}
	}

	const findings = scanForSecrets(`${subject ?? ""}\n${text}`);
	if (findings.length > 0 && body.acknowledgeSecrets !== true) {
		return fail(422, "secrets_found", "The message looks like it contains a credential.", { findings });
	}

	// One send at a time per thread: a double click must not publish twice.
	const flightKey = `${to}|${contextId ?? ""}`;
	if (sending.has(flightKey)) {
		return fail(409, "send_in_progress", "This message is already being sent.");
	}
	sending.add(flightKey);
	let result: Awaited<ReturnType<ApiDeps["send"]>>;
	try {
		result = await deps.send({ to, subject, contextId, body: text });
	} finally {
		sending.delete(flightKey);
	}
	if (!result.ok) {
		return fail(502, "send_failed", result.detail ?? "No relay accepted the message.");
	}
	const stored = deps.store.recordOutbound({
		...(result.eventId ? { id: result.eventId } : {}),
		direction: "out",
		peer: to,
		subject,
		// A first message gets its thread id from the send itself.
		contextId: contextId ?? result.contextId ?? null,
		contextIdWithheld: false,
		text,
		at: new Date().toISOString(),
		deliveryStatus: "sent",
	});
	const draftName = str(body.draft, 200);
	if (draftName && deps.draftsDir) {
		try {
			archiveDraft(deps.draftsDir, draftName);
		} catch {
			// The message is sent; a draft that can't be moved is only left behind.
		}
	}
	return { status: 200, body: { ok: true, message: stored } };
}

function withPeer<T extends { peer: string }>(message: T, deps: ApiDeps): T & { peerStatus: PeerStatus | null; peerLabel: string | null; peerVerified: boolean } {
	const record = deps.store.listPeers().find((p) => p.npub === message.peer);
	return {
		...message,
		peerStatus: record?.status ?? null,
		peerLabel: record?.label ?? record?.handle ?? null,
		peerVerified: record?.verified ?? false,
	};
}
