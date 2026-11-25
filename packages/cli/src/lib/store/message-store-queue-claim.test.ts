import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore, SPOOL_DIR } from "./message-store";
import type { NewMessage } from "./types";

/**
 * What the process that holds the profile lock takes over from `spool.d`: in what order it
 * applies the queued changes, and which queued files it removes once the history is saved.
 */

const MALLORY = "npub1mallorymallorymallorymallorymallorymallorymallorymallory00";
const CLOCK = new Date("2026-10-07T12:00:00.000Z");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-store-queue-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function message(overrides: Partial<NewMessage> = {}): NewMessage {
	return {
		id: "u1",
		peer: "npub1bobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobqqqqqq",
		subject: null,
		contextId: "fresh",
		text: "hi",
		at: "2026-10-07T10:00:00.000Z",
		...overrides,
	};
}

/** The queued files still waiting, by name. */
function queued(): string[] {
	const folder = join(dir, SPOOL_DIR);
	return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".json")).sort() : [];
}

/** Queue a change under a chosen name, so the order the files are read in is known. */
function queueAs(name: string, change: unknown): void {
	mkdirSync(join(dir, SPOOL_DIR), { recursive: true });
	writeFileSync(join(dir, SPOOL_DIR, name), JSON.stringify(change));
}

/** A history with one unread message, "u1", in the thread "fresh". */
function seedUnread(): void {
	const store = new MessageStore(dir, () => CLOCK);
	store.addInbound(message());
	store.flush();
}

describe("the lock holder and the queued changes", () => {
	it("applies them in file-name order, so the last decision on a sender wins", () => {
		const first = new MessageStore(dir, () => CLOCK);
		first.hold(MALLORY, message({ id: "h1", peer: MALLORY }));
		first.flush();
		queueAs("000000000000001-1-aaaaaaaa.json", { kind: "decision", action: "ignore", npub: MALLORY });
		queueAs("000000000000002-1-aaaaaaaa.json", { kind: "decision", action: "block", npub: MALLORY });
		// A reader applies them in that order ...
		expect(new MessageStore(dir, () => CLOCK).heldStatus(MALLORY)).toBe("blocked");
		// ... and so does the lock holder, whose result is what gets saved.
		new MessageStore(dir, () => CLOCK, { claimSpool: true }).flush();
		expect(new MessageStore(dir, () => CLOCK).heldStatus(MALLORY)).toBe("blocked");
		expect(queued()).toEqual([]);
	});

	it("keeps a queued change it could not apply, and takes it over on the next pass", () => {
		seedUnread();
		MessageStore.spool(dir, { kind: "read", contextId: "fresh" });
		const failing = vi.spyOn(MessageStore.prototype, "markRead").mockImplementation(() => {
			throw new Error("cannot apply");
		});
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		writer.flush();
		// Not applied, so not removed: the file waits for the next pass.
		expect(queued()).toHaveLength(1);
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.readAt)).toEqual([null]);
		failing.mockRestore();
		writer.absorbSpool();
		writer.flush();
		expect(queued()).toEqual([]);
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.readAt !== null)).toEqual([true]);
	});

	it("does not apply a change it already took over a second time", () => {
		seedUnread();
		MessageStore.spool(dir, { kind: "read", contextId: "fresh" });
		// Takes over the mark-read: "u1" is read.
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		// A message arrives in that thread before the save ...
		writer.addInbound(message({ id: "u2", at: "2026-10-07T11:00:00.000Z" }));
		// ... and the next pass over the queue finds the same file, which is only removed by the save.
		writer.absorbSpool();
		writer.flush();
		const thread = new MessageStore(dir, () => CLOCK).getThread("fresh");
		expect(thread.map((m) => [m.id, m.readAt !== null])).toEqual([
			["u1", true],
			["u2", false],
		]);
	});
});
