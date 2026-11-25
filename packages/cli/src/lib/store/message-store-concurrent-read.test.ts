import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "./message-store";
import type { NewMessage, NewOutboundMessage } from "./types";

/**
 * A reader (`agx thread`, `agx threads`, `agx held list`) takes no lock, so it can open the
 * store while the lock holder is saving. These tests run a writer's whole save right after
 * each file operation of a reader in turn, so every place a save can land is covered and
 * nothing depends on timing.
 */

// Every file operation the store makes goes through the hook, so a test can run another
// process's work at an exact point between a reader's (or a writer's) own steps.
const fsHooks = vi.hoisted(() => ({ after: null as ((name: string) => void) | null }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const watched = [
		"existsSync",
		"readFileSync",
		"readdirSync",
		"writeFileSync",
		"chmodSync",
		"openSync",
		"fsyncSync",
		"closeSync",
		"renameSync",
		"rmSync",
	] as const;
	const wrapped: Record<string, unknown> = {};
	for (const name of watched) {
		const original = actual[name] as (...args: unknown[]) => unknown;
		wrapped[name] = (...args: unknown[]) => {
			const result = original(...args);
			const hook = fsHooks.after;
			if (hook) {
				// What the hook itself does is not hooked again.
				fsHooks.after = null;
				try {
					hook(name);
				} finally {
					fsHooks.after = hook;
				}
			}
			return result;
		};
	}
	return { ...actual, ...wrapped };
});

const BOB = "npub1bobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobbobqqqqqq";
const MALLORY = "npub1mallorymallorymallorymallorymallorymallorymallorymallory00";
const CLOCK = new Date("2026-10-07T12:00:00.000Z");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-store-read-"));
});

afterEach(() => {
	fsHooks.after = null;
	rmSync(dir, { recursive: true, force: true });
});

/** An empty profile directory, for each place the save is made to land. */
function freshDir(): void {
	rmSync(dir, { recursive: true, force: true });
	dir = mkdtempSync(join(tmpdir(), "agx-store-read-"));
}

function message(overrides: Partial<NewMessage> = {}): NewMessage {
	return { id: "e1", peer: BOB, subject: null, contextId: "earlier", text: "hi", at: "2026-10-07T10:00:00.000Z", ...overrides };
}

function sent(overrides: Partial<NewOutboundMessage> = {}): NewOutboundMessage {
	return { ...message({ id: "sent1", contextId: "fresh", text: "sent text", at: "2026-10-07T11:00:00.000Z" }), deliveryStatus: "sent", ...overrides };
}

/** A history that already holds one earlier thread, so the file exists before anything is sent. */
function seedHistory(): void {
	const store = new MessageStore(dir, () => CLOCK);
	store.addInbound(message());
	store.flush();
}

/** A stranger's text kept for a decision, on top of an existing history. */
function seedHeldText(): void {
	seedHistory();
	const store = new MessageStore(dir, () => CLOCK);
	store.hold(MALLORY, message({ id: "h1", peer: MALLORY, contextId: "fresh" }));
	store.flush();
}

/** An unread message in "earlier" and one in "fresh", for a queued mark-read. */
function seedTwoUnreadThreads(): void {
	const store = new MessageStore(dir, () => CLOCK);
	store.addInbound(message());
	store.addInbound(message({ id: "u1", contextId: "fresh", at: "2026-10-07T10:30:00.000Z" }));
	store.flush();
}

/**
 * Open the store as a reader does. Right after the reader's `after`-th file operation
 * (counting from 0; -1 never) `between` runs. Returns the reader and how many file
 * operations opening it took.
 */
function openReader(after: number, between: () => void): { reader: MessageStore; operations: number } {
	let operations = 0;
	fsHooks.after = () => {
		if (operations === after) {
			between();
		}
		operations += 1;
	};
	try {
		const reader = new MessageStore(dir, () => CLOCK);
		return { reader, operations };
	} finally {
		fsHooks.after = null;
	}
}

/** Run `scenario` once for every place the writer's save can land among the reader's file operations. */
function forEveryLanding(
	scenario: (after: number) => { reader: MessageStore; operations: number },
	check: (reader: MessageStore, landing: string) => void,
): void {
	const operations = scenario(-1).operations;
	// A reader makes several file operations; if this ever counted none, the loop below would prove nothing.
	expect(operations).toBeGreaterThan(3);
	for (let after = 0; after < operations; after += 1) {
		const { reader } = scenario(after);
		check(reader, `the save landed after the reader's file operation ${after} of ${operations}`);
	}
}

describe("a reader that overlaps the writer's save", () => {
	/** A send is queued and the writer has taken it over; its save is still to come. */
	function pendingSend(after: number): { reader: MessageStore; operations: number } {
		MessageStore.spoolOutbound(dir, sent());
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		return openReader(after, () => writer.flush());
	}

	it("still shows a message sent just before, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHistory();
				return pendingSend(after);
			},
			(reader, landing) => {
				expect(reader.getThread("fresh").map((m) => m.id), landing).toEqual(["sent1"]);
				expect(reader.getThread("earlier").map((m) => m.id), landing).toEqual(["e1"]);
			},
		);
	});

	it("still shows the first message ever sent, when no history file exists yet", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				return pendingSend(after);
			},
			(reader, landing) => {
				expect(reader.getThread("fresh").map((m) => m.id), landing).toEqual(["sent1"]);
			},
		);
	});

	it("still shows a sender's text released by an allow decision, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHeldText();
				MessageStore.spool(dir, { kind: "decision", action: "allow", npub: MALLORY });
				const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
				return openReader(after, () => writer.flush());
			},
			(reader, landing) => {
				expect(reader.getThread("fresh").map((m) => m.id), landing).toEqual(["h1"]);
				expect(reader.listHeld(), landing).toEqual([]);
			},
		);
	});

	it("never loses a sender's text that the writer moves from the held list into the history", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHeldText();
				// The writer releases the text itself, with nothing queued for a reader to replay.
				const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
				writer.releaseHeld(MALLORY);
				return openReader(after, () => writer.flush());
			},
			(reader, landing) => {
				const inHistory = reader.getThread("fresh").length;
				const stillHeld = reader.listHeld().flatMap((h) => h.messages).length;
				expect(inHistory + stillHeld, landing).toBeGreaterThanOrEqual(1);
			},
		);
	});
});

describe("a reader that does not overlap the writer's save", () => {
	it("shows a sent message once before the save and once after it", () => {
		seedHistory();
		MessageStore.spoolOutbound(dir, sent());
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.id)).toEqual(["sent1"]);
		writer.flush();
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.id)).toEqual(["sent1"]);
	});

	it("shows a sender's released text once before the save and once after it", () => {
		seedHeldText();
		MessageStore.spool(dir, { kind: "decision", action: "allow", npub: MALLORY });
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.id)).toEqual(["h1"]);
		writer.flush();
		expect(new MessageStore(dir, () => CLOCK).getThread("fresh").map((m) => m.id)).toEqual(["h1"]);
	});
});

describe("a reader that opens while the writer is in the middle of saving", () => {
	it("sees the whole old history or the whole new one, never a missing or half-written file", () => {
		const first = new MessageStore(dir, () => CLOCK);
		for (const [index, id] of ["a", "b", "c"].entries()) {
			first.addInbound(message({ id, at: `2026-10-07T10:00:0${index + 1}.000Z` }));
		}
		first.flush();
		const writer = new MessageStore(dir, () => CLOCK);
		writer.addInbound(message({ id: "d", at: "2026-10-07T10:00:04.000Z" }));
		const sizesSeen = new Set<number>();
		let readers = 0;
		fsHooks.after = () => {
			readers += 1;
			sizesSeen.add(new MessageStore(dir, () => CLOCK).getThread("earlier").length);
		};
		try {
			writer.flush();
		} finally {
			fsHooks.after = null;
		}
		// Writing a temporary file, syncing it and renaming it takes several steps; a reader ran after each.
		expect(readers).toBeGreaterThan(5);
		expect([...sizesSeen].sort()).toEqual([3, 4]);
	});
});

describe("a reader that overlaps the writer's save of a queued mark-read, ignore or block", () => {
	/** A held decision is queued and the writer has taken it over; its save is still to come. */
	function pendingDecision(after: number, action: "ignore" | "block"): { reader: MessageStore; operations: number } {
		MessageStore.spool(dir, { kind: "decision", action, npub: MALLORY });
		const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
		return openReader(after, () => writer.flush());
	}

	it("still shows a thread as read after a queued mark-read, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedTwoUnreadThreads();
				MessageStore.spool(dir, { kind: "read", contextId: "fresh" });
				const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
				return openReader(after, () => writer.flush());
			},
			(reader, landing) => {
				expect(reader.getThread("fresh").map((m) => m.readAt !== null), landing).toEqual([true]);
				expect(reader.getThread("earlier").map((m) => m.readAt), landing).toEqual([null]);
			},
		);
	});

	it("still shows a held sender as ignored, and the text not released, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHeldText();
				return pendingDecision(after, "ignore");
			},
			(reader, landing) => {
				expect(reader.listHeld(), landing).toEqual([]);
				expect(reader.listSenderDecisions(), landing).toEqual([{ npub: MALLORY, status: "ignored" }]);
				expect(reader.getThread("fresh"), landing).toEqual([]);
			},
		);
	});

	it("still shows a held sender as blocked, and the text not released, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHeldText();
				return pendingDecision(after, "block");
			},
			(reader, landing) => {
				expect(reader.listHeld(), landing).toEqual([]);
				expect(reader.heldStatus(MALLORY), landing).toBe("blocked");
				expect(reader.getThread("fresh"), landing).toEqual([]);
			},
		);
	});

	it("still shows a block of a sender with nothing held, wherever the save lands", () => {
		forEveryLanding(
			(after) => {
				freshDir();
				seedHistory();
				return pendingDecision(after, "block");
			},
			(reader, landing) => {
				expect(reader.listSenderDecisions(), landing).toEqual([{ npub: MALLORY, status: "blocked" }]);
			},
		);
	});
});

describe("a known limit of reading the queue before the history", () => {
	it("a queued mark-read applied twice marks a message that arrived in the same poll, for that one read (known limit)", () => {
		const shownAsRead: string[] = [];
		forEveryLanding(
			(after) => {
				freshDir();
				seedTwoUnreadThreads();
				MessageStore.spool(dir, { kind: "read", contextId: "fresh" });
				const writer = new MessageStore(dir, () => CLOCK, { claimSpool: true });
				// The same poll: a message arrives in that thread after the writer took over the mark-read.
				writer.addInbound(message({ id: "u2", contextId: "fresh", at: "2026-10-07T11:00:00.000Z" }));
				return openReader(after, () => writer.flush());
			},
			(reader, landing) => {
				if (reader.getThread("fresh").some((m) => m.id === "u2" && m.readAt !== null)) {
					shownAsRead.push(landing);
				}
				// Whatever that one read showed, what is saved is right: "u2" is unread on disk.
				const saved = new MessageStore(dir, () => CLOCK).getThread("fresh");
				expect(saved.map((m) => [m.id, m.readAt !== null]), landing).toEqual([
					["u1", true],
					["u2", false],
				]);
			},
		);
		// A mark-read is not matched by id, so a reader that read the queued file and then a history that
		// already holds its effect applies it again. Queueing the ids it showed would end this. When that
		// is done this test is expected to fail: replace it with one that expects "u2" unread everywhere.
		expect(shownAsRead.length, "no place a save can land showed the message as read").toBeGreaterThan(0);
	});
});
