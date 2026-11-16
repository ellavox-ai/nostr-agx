import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./http.js";
import type { TaskEventStreams } from "./task-events.js";

/** Open `/events` connections per API credential. One per running background
 * task covers a single-key deployment at full background concurrency. */
export const MAX_TASK_STREAMS_PER_CREDENTIAL = 64;
/** Open `/events` connections across the gateway: the same as the task
 * requests that may wait for results, so both pools together leave half of
 * the server's connections for everything else. */
export const MAX_TASK_STREAMS = 256;
/** How often an open stream rechecks its task record. */
export const TASK_STREAM_REVALIDATE_MS = 5_000;

/** Counts open task event streams, per credential and in total. */
export class TaskStreamSlots {
	private readonly perCredential: number;
	private readonly total: number;
	private readonly byCredential = new Map<string, number>();
	private openTotal = 0;

	constructor(limits: { perCredential?: number; total?: number } = {}) {
		this.perCredential = limits.perCredential ?? MAX_TASK_STREAMS_PER_CREDENTIAL;
		this.total = limits.total ?? MAX_TASK_STREAMS;
	}

	tryAcquire(credential: string): "ok" | "credential_full" | "gateway_full" {
		const held = this.byCredential.get(credential) ?? 0;
		if (held >= this.perCredential) {
			return "credential_full";
		}
		if (this.openTotal >= this.total) {
			return "gateway_full";
		}
		this.byCredential.set(credential, held + 1);
		this.openTotal += 1;
		return "ok";
	}

	release(credential: string): void {
		const held = this.byCredential.get(credential) ?? 0;
		if (held <= 0) {
			return;
		}
		if (held === 1) {
			this.byCredential.delete(credential);
		} else {
			this.byCredential.set(credential, held - 1);
		}
		this.openTotal -= 1;
	}

	open(credential?: string): number {
		return credential === undefined ? this.openTotal : (this.byCredential.get(credential) ?? 0);
	}
}

export interface TaskEventRoute {
	/** The public background task ID. */
	id: string;
	/** The API credential, as sent. */
	credential: string;
	/** The task's stored view for this credential, or null if there is none. */
	getView: () => Record<string, unknown> | null;
	/** Whether the credential is still a valid API key. */
	stillAuthorized: () => boolean;
	streams: TaskEventStreams;
	slots: TaskStreamSlots;
	heartbeatMs: number;
	revalidateMs: number;
}

const isTerminalView = (view: Record<string, unknown> | null) =>
	view?.status === "completed" || view?.status === "failed";

/** `GET /v1/tasks/:id/events`: buffered and live `working` updates, then one
 * terminal event read from the operation store. Events are written as they
 * are pushed; a slow timer only rechecks the task record. */
export function serveTaskEvents(
	req: IncomingMessage,
	res: ServerResponse,
	route: TaskEventRoute,
): void {
	const { id, getView, streams } = route;
	const initial = getView();
	if (initial === null) {
		throw new ApiError(404, "not_found", "No background task with that ID for this credential");
	}
	const stream = streams.ensure(id);
	const parsedLastId = Number(req.headers["last-event-id"] ?? 0);
	let lastId = Number.isSafeInteger(parsedLastId) && parsedLastId > 0 ? parsedLastId : 0;
	if (isTerminalView(initial)) {
		// A stream lost to a restart or eviction gets its terminal ID after the
		// client's, so the client is never told it already has an event it missed.
		stream.markTerminal(lastId + 1);
	}
	const knownTerminalId = stream.getTerminalId();
	if (knownTerminalId !== undefined && lastId >= knownTerminalId) {
		// Any non-200 answer stops a browser EventSource from reconnecting.
		res.writeHead(204);
		res.end();
		return;
	}
	const slot = route.slots.tryAcquire(route.credential);
	if (slot === "credential_full") {
		res.setHeader("retry-after", "5");
		throw new ApiError(
			429,
			"too_many_streams",
			"This API key has too many task event streams open",
			"Close a stream you no longer read, then try again.",
		);
	}
	if (slot === "gateway_full") {
		throw new ApiError(503, "busy", "The gateway has too many task event streams open", "Try again shortly.");
	}
	let finished = false;
	let unsubscribe: (() => void) | undefined;
	let revalidateTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const cleanup = () => {
		if (finished) {
			return;
		}
		finished = true;
		if (revalidateTimer) {
			clearInterval(revalidateTimer);
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
		}
		unsubscribe?.();
		route.slots.release(route.credential);
	};
	const finish = () => {
		cleanup();
		res.end();
	};
	const writeEvent = (eventId: number, event: string, data: Record<string, unknown>) => {
		res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify({ taskId: id, ...data })}\n\n`);
		lastId = eventId;
	};
	const flush = () => {
		if (finished) {
			return;
		}
		try {
			for (const event of stream.after(lastId)) {
				writeEvent(event.id, event.event, event.data);
			}
			const terminalId = stream.getTerminalId();
			if (terminalId === undefined) {
				return;
			}
			// The store owns the outcome; the stream keeps only the terminal ID.
			const view = getView();
			if (isTerminalView(view)) {
				writeEvent(terminalId, view?.status as string, view as Record<string, unknown>);
			}
			finish();
		} catch {
			// Runs inside the stream's notify and the store's settle callback:
			// end this connection rather than throw into them.
			finish();
		}
	};

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store, no-transform",
		"connection": "keep-alive",
		"x-accel-buffering": "no",
		"x-content-type-options": "nosniff",
	});
	res.write("retry: 1000\n: connected\n\n");
	res.on("close", cleanup);
	unsubscribe = stream.subscribe(flush);
	// The key is checked once per request, so recheck it and the task record
	// while the stream stays open: a revoked key or an evicted record ends it.
	revalidateTimer = setInterval(() => {
		try {
			if (!route.stillAuthorized()) {
				finish();
				return;
			}
			const view = getView();
			if (view === null) {
				finish();
			} else if (isTerminalView(view)) {
				stream.markTerminal();
			}
		} catch {
			finish();
		}
	}, route.revalidateMs);
	heartbeatTimer = setInterval(() => {
		if (!res.writableEnded) {
			res.write(": heartbeat\n\n");
		}
	}, route.heartbeatMs);
	flush();
}
