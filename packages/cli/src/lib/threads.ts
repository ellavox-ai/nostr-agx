import { bodyLines, renderInboundLines } from "./inbound-lines.js";
import { shortNpub } from "./output.js";
import type { StoredMessage, ThreadSummary } from "./store/types.js";

export const HELD_SCHEMA = "agx.held/1";
export const THREADS_SCHEMA = "agx.threads/1";
export const THREAD_SCHEMA = "agx.thread/1";

export interface ThreadReport {
	schema: typeof THREAD_SCHEMA;
	contextId: string | null;
	contextIdWithheld: boolean;
	peer: string;
	subject: string | null;
	messages: StoredMessage[];
}

export function buildThreadReport(contextId: string, messages: StoredMessage[]): ThreadReport {
	const first = messages[0];
	return {
		schema: THREAD_SCHEMA,
		contextId,
		contextIdWithheld: messages.some((m) => m.contextIdWithheld),
		peer: first?.peer ?? "",
		subject: messages.find((m) => m.subject !== null)?.subject ?? null,
		messages,
	};
}

/** Rows for `agx threads`: peer, subject, messages, unread, last, thread id. */
export function threadRows(threads: ThreadSummary[], fullIds: boolean): string[][] {
	return threads.map((t) => [
		fullIds ? t.peer : shortNpub(t.peer),
		t.subject ?? "—",
		String(t.messages),
		String(t.unread),
		t.lastMessageAt,
		t.contextId ?? (t.contextIdWithheld ? "(withheld)" : "—"),
	]);
}

/** A thread as `serve` prints it: RECV for what arrived, SENT for what went out. */
export function renderThreadLines(report: ThreadReport, fullIds: boolean): string[] {
	const lines: string[] = [];
	for (const m of report.messages) {
		lines.push("");
		if (m.direction === "in") {
			lines.push(
				...renderInboundLines({
					fromNpub: m.peer,
					allowed: true,
					subject: m.subject,
					contextId: m.contextId,
					text: m.text,
					allowedOnly: false,
					fullIds,
				}),
			);
			continue;
		}
		const to = fullIds ? m.peer : shortNpub(m.peer);
		lines.push(`SENT  to ${to}  ${m.deliveryStatus ?? ""}`.trimEnd());
		lines.push(...bodyLines(m.text));
	}
	return lines;
}
