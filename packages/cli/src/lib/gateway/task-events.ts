import type { TaskStatusUpdate } from "@nostr-agx/core";

export interface TaskStreamEvent {
	id: number;
	event: "working" | "completed" | "failed";
	data: Record<string, unknown>;
}

const MAX_EVENTS_PER_TASK = 128;
const MAX_STREAMS = 1_000;
const STREAM_RETENTION_MS = 24 * 60 * 60 * 1000;

export class TaskEventStream {
	private readonly events: TaskStreamEvent[] = [];
	private nextId = 1;
	private terminal = false;
	private touchedAt = Date.now();

	push(update: TaskStatusUpdate): void {
		if (this.terminal) {
			return;
		}
		this.append("working", {
			status: update.status,
			seq: update.seq,
			...(update.message === undefined ? {} : { message: update.message }),
		});
	}

	complete(view: Record<string, unknown>): void {
		if (this.terminal || (view.status !== "completed" && view.status !== "failed")) {
			return;
		}
		this.append(view.status, view);
	}

	after(lastEventId: number): TaskStreamEvent[] {
		this.touchedAt = Date.now();
		return this.events.filter((event) => event.id > lastEventId);
	}

	isTerminal(): boolean {
		return this.terminal;
	}

	terminalEvent(): TaskStreamEvent | undefined {
		const event = this.events.at(-1);
		return event?.event === "working" ? undefined : event;
	}

	touched(): number {
		return this.touchedAt;
	}

	private append(
		event: TaskStreamEvent["event"],
		data: Record<string, unknown>,
	): void {
		this.events.push({ id: this.nextId, event, data });
		this.nextId += 1;
		this.terminal = event === "completed" || event === "failed";
		this.touchedAt = Date.now();
		if (this.events.length > MAX_EVENTS_PER_TASK) {
			this.events.splice(0, this.events.length - MAX_EVENTS_PER_TASK);
		}
	}
}

export class TaskEventStreams {
	private readonly streams = new Map<string, TaskEventStream>();

	ensure(id: string, initial?: TaskEventStream): TaskEventStream {
		this.prune();
		const existing = this.streams.get(id);
		if (existing) {
			return existing;
		}
		while (this.streams.size >= MAX_STREAMS) {
			const oldest = this.streams.keys().next().value as string | undefined;
			if (oldest === undefined) {
				break;
			}
			this.streams.delete(oldest);
		}
		const created = initial ?? new TaskEventStream();
		this.streams.set(id, created);
		return created;
	}

	get(id: string): TaskEventStream | undefined {
		this.prune();
		return this.streams.get(id);
	}

	private prune(): void {
		const cutoff = Date.now() - STREAM_RETENTION_MS;
		for (const [id, stream] of this.streams) {
			if (stream.touched() <= cutoff) {
				this.streams.delete(id);
			}
		}
	}
}
