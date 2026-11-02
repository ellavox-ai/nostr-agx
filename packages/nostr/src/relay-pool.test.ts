import type { Event, Filter } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The relay pool talks to an untrusted relay: it must re-enforce the REQ filter
// client-side and treat any timeout/page-cap/dense-cluster as `complete: false`
// (the cursor-safety argument rests on that). These tests mock the relay so we can
// feed it adversarial / dense responses without a network.

const mockVerify = vi.fn();
/** The event hash: by default the id the event claims. */
const mockHash = vi.fn((ev: Event) => ev.id);
/** Per-subscribe responder: given the REQ filter, return the events to emit and
 * whether to reach EOSE (false → the sub never eoses → reqPage times out). */
let responder: (filter: Filter) => {
	events: Event[];
	eose: boolean;
	/** Set to emit a CLOSED instead — what a relay sends when it REFUSES the
	 * subscription (filter validation, auth-required, a rate limit). */
	closed?: string;
};
/** Every REQ filter the pool sent, in order. The relay is configured with
 * `filterValidation`, so the exact shape is a production contract, not detail. */
let sentFilters: Filter[] = [];
/** Per-relay publish outcome. `publishToRelays` is the CLASSIFIER behind the
 * whole `deliveredToPeer` tri-state and had no direct test — nostr-transport
 * mocks it out and hands `kind` in by hand — which is exactly how a fix whose
 * entire purpose was the classification shipped with the classification wrong. */
let publisher: (url: string) => Promise<void> = async () => {};

vi.mock("nostr-tools", () => ({
	verifyEvent: (ev: Event) => mockVerify(ev),
	getEventHash: (ev: Event) => mockHash(ev),
	finalizeEvent: (ev: unknown) => ev,
}));
vi.mock("nostr-tools/relay", () => ({
	Relay: {
		connect: vi.fn(async (url: string) => ({
			onauth: undefined,
			close: vi.fn(),
			publish: (_ev: Event) => publisher(url),
			subscribe(
				filters: Filter[],
				h: {
					onevent: (e: Event) => void;
					oneose?: () => void;
					onclose?: (reason: string) => void;
				},
			) {
				sentFilters.push(filters[0]);
				const { events, eose, closed } = responder(filters[0]);
				queueMicrotask(() => {
					if (closed !== undefined) {
						h.onclose?.(closed);
						return;
					}
					for (const ev of events) {
						h.onevent(ev);
					}
					if (eose) {
						h.oneose?.();
					}
				});
				return { close: vi.fn() };
			},
		})),
	},
}));

import {
	GIFT_WRAP_KIND,
	MESSAGE_KIND,
	RECEIPT_KIND,
	RELAY_LIST_KIND,
} from "./kinds";
import {
	DEFAULT_POLL_LIMIT,
	fetchByAuthor,
	fetchByAuthorWithStatus,
	listenEvents,
	pollInbox,
	publishToRelays,
} from "./relay-pool";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

function ev(overrides: Partial<Event>): Event {
	return {
		id: Math.random().toString(36).slice(2),
		pubkey: OTHER,
		kind: GIFT_WRAP_KIND,
		created_at: 1000,
		tags: [["p", ME]],
		content: "x",
		sig: "sig",
		...overrides,
	} as Event;
}

beforeEach(() => {
	mockVerify.mockReset();
	mockVerify.mockReturnValue(true);
	mockHash.mockImplementation((ev: Event) => ev.id);
	responder = () => ({ events: [], eose: true });
	sentFilters = [];
	publisher = async () => {};
});
afterEach(() => {
	vi.useRealTimers();
});

describe("listenEvents", () => {
	it("subscribes once per relay for gift wraps addressed to the requested pubkey", async () => {
		const callback = vi.fn();
		const subscriptions = await listenEvents(
			undefined as never,
			["wss://a", "wss://b"],
			{ pubkey: ME },
			callback,
		);

		expect(subscriptions).toHaveLength(2);
		expect(sentFilters).toEqual([
			{ kinds: [GIFT_WRAP_KIND], "#p": [ME] },
			{ kinds: [GIFT_WRAP_KIND], "#p": [ME] },
		]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("returns no subscriptions when no relays are configured", async () => {
		await expect(
			listenEvents(undefined as never, [], { pubkey: ME }, vi.fn()),
		).resolves.toEqual([]);
		expect(sentFilters).toEqual([]);
	});
});

describe("pollInbox client-side filter re-enforcement (untrusted relay)", () => {
	it("keeps only in-window GIFT WRAPS addressed to us", async () => {
		const good = ev({ id: "good", created_at: 1500 });
		const goodToo = ev({ id: "good-too", created_at: 1600 });
		responder = () => ({
			events: [
				good,
				goodToo,
				ev({ id: "wrong-kind", kind: 1 }), // relay slipped in a kind-1 note
				// AGX rumor kinds are never valid BARE — only inside a wrap.
				ev({ id: "bare-message", kind: MESSAGE_KIND }),
				ev({ id: "bare-receipt", kind: RECEIPT_KIND }),
				ev({ id: "not-for-me", tags: [["p", OTHER]] }), // p-tags someone else
				ev({ id: "no-p-tag", tags: [] }), // no p tag at all
				ev({ id: "too-old", created_at: 500 }), // before `since`
			],
			eose: true,
		});
		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 1000,
		});
		expect(complete).toBe(true);
		expect(events.map((e) => e.id).sort()).toEqual(["good", "good-too"]);
	});

	it("drops events that fail signature verification", async () => {
		mockVerify.mockImplementation((e: Event) => e.id !== "forged");
		responder = () => ({
			events: [ev({ id: "forged" }), ev({ id: "real" })],
			eose: true,
		});
		const { events } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		expect(events.map((e) => e.id)).toEqual(["real"]);
	});
});

describe("pollInbox completeness semantics", () => {
	it("reports incomplete when a relay never reaches EOSE (timeout)", async () => {
		vi.useFakeTimers();
		responder = () => ({ events: [ev({ id: "x" })], eose: false });
		const promise = pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		await vi.advanceTimersByTimeAsync(8001); // past RELAY_OP_TIMEOUT_MS
		const { complete } = await promise;
		expect(complete).toBe(false);
	});

	it("reports incomplete when a relay dial rejects", async () => {
		const { Relay } = await import("nostr-tools/relay");
		vi.mocked(Relay.connect).mockRejectedValueOnce(
			new Error("dial failed"),
		);
		const { complete } = await pollInbox({
			relays: ["wss://down"],
			pubkey: ME,
			since: 0,
		});
		expect(complete).toBe(false);
	});
});

describe("pollInbox handles a REFUSED subscription", () => {
	it("treats a CLOSED as incomplete, so the caller still holds its cursor", async () => {
		responder = () => ({
			events: [],
			eose: false,
			closed: "bad req: filter validation failed: kind not allowed: 1059",
		});
		const { complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		expect(complete).toBe(false);
	});

	it("settles immediately rather than burning the 8s timeout", async () => {
		// THE POINT OF THE FIX. `complete:false` was already the verdict — it just
		// took RELAY_OP_TIMEOUT_MS to reach, per page, per relay, per tick, and
		// arrived indistinguishable from a slow relay. A refusal is a standing
		// condition: the same CLOSED comes back next tick. Resolving slowly is the
		// bug, so assert the speed, not just the verdict.
		responder = () => ({
			events: [],
			eose: false,
			closed: "auth-required",
		});
		const started = Date.now();
		await pollInbox({ relays: ["wss://r"], pubkey: ME, since: 0 });
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("reports the relay's own reason instead of a timeout", async () => {
		responder = () => ({
			events: [],
			eose: false,
			closed: "restricted: not authorized",
		});
		const warn = vi.fn();
		await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
			logger: { warn },
		});
		const logged = warn.mock.calls.map(
			([msg, ctx]) => `${msg} ${JSON.stringify(ctx)}`,
		);
		expect(logged.some((l) => l.includes("REFUSED"))).toBe(true);
		expect(
			logged.some((l) => l.includes("restricted: not authorized")),
		).toBe(true);
		// The misleading wording must NOT appear for a refusal.
		expect(logged.some((l) => l.includes("timed out"))).toBe(false);
	});
});

describe("fetchByAuthor client-side filter re-enforcement", () => {
	it("keeps only events from the requested author of the requested kinds", async () => {
		responder = () => ({
			events: [
				ev({ id: "mine", pubkey: OTHER, kind: RELAY_LIST_KIND }),
				ev({ id: "impostor", pubkey: ME, kind: RELAY_LIST_KIND }),
				ev({ id: "wrong-kind", pubkey: OTHER, kind: MESSAGE_KIND }),
			],
			eose: true,
		});
		const events = await fetchByAuthor({
			relays: ["wss://r"],
			author: OTHER,
			kinds: [RELAY_LIST_KIND],
		});
		expect(events.map((e) => e.id)).toEqual(["mine"]);
	});
});

describe("fetchByAuthorWithStatus tells an outage from an empty answer", () => {
	it("counts a relay that reached EOSE as answered, even with no events", async () => {
		responder = () => ({ events: [], eose: true });
		const r = await fetchByAuthorWithStatus({
			relays: ["wss://a", "wss://b"],
			author: OTHER,
			kinds: [RELAY_LIST_KIND],
		});
		expect(r).toEqual({ events: [], answered: 2 });
	});

	it("counts nothing when every relay stalls or refuses: unknown, not empty", async () => {
		vi.useFakeTimers();
		let n = 0;
		responder = () =>
			n++ === 0
				? { events: [], eose: false }
				: { events: [], eose: false, closed: "auth-required:" };
		const pending = fetchByAuthorWithStatus({
			relays: ["wss://stalls", "wss://refuses"],
			author: OTHER,
			kinds: [RELAY_LIST_KIND],
		});
		await vi.advanceTimersByTimeAsync(8001); // past RELAY_OP_TIMEOUT_MS
		const r = await pending;
		vi.useRealTimers();
		expect(r.answered).toBe(0);
		expect(r.events).toEqual([]);
	});
});

describe("pollInbox does not trust a relay's own page size", () => {
	// THE WORST FAILURE AVAILABLE IN THIS MODULE. The termination test used to be
	// `batch.length < limit` — "the relay sent fewer than I asked for, so the
	// window is drained". That infers an invariant from a number the RELAY
	// controls. An operator can pin a relay's maxFilterLimit >= DEFAULT_POLL_LIMIT
	// for relays they run, but pollInbox runs against `team.nostrRelays`:
	// any public wss:// host a team types in, whose IP `assertPublicUrl` vets and
	// whose config nothing vets at all.
	//
	// A relay clamping to 100 answered the first page short, the loop read that
	// as drained, `complete` came back TRUE, and the ingest advanced its cursor
	// past everything it had not read. Silent, permanent, and no counter moved.
	it("drains the whole window against a relay that clamps limit far below ours", async () => {
		const all = Array.from({ length: 1_200 }, (_, i) =>
			ev({ id: `e${i}`, created_at: 10_000 - i }),
		);
		const RELAY_CAP = 100;
		responder = (f) => ({
			events: all
				.filter((e) =>
					f.until === undefined ? true : e.created_at <= f.until,
				)
				// The clamp the relay applies, regardless of what we asked for.
				.slice(0, Math.min(f.limit ?? 500, RELAY_CAP)),
			eose: true,
		});

		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});

		// Both halves matter. Reporting `complete: true` is only safe if we
		// actually read the window — under the old test this returned 100 events
		// AND complete:true, which is what let the cursor jump the other 1,100.
		expect(events).toHaveLength(1_200);
		expect(complete).toBe(true);
		// It got there by paging, not by luck.
		expect(sentFilters.length).toBeGreaterThan(2);
	});

	it("still reports incomplete for a dense cluster it cannot page past", async () => {
		// The guard that the first draft of the clamp fix silently destroyed.
		// With termination keyed only on "no new ids", a full page of
		// already-seen events at one timestamp looks identical to a drained
		// window — so this reported complete:true and advanced the cursor past
		// c3. A FULL page carrying nothing new is the discriminator.
		const cluster = [
			ev({ id: "c1", created_at: 2000 }),
			ev({ id: "c2", created_at: 2000 }),
			ev({ id: "c3", created_at: 2000 }),
		];
		responder = (f) => ({
			events: cluster
				.filter((e) =>
					f.until === undefined ? true : e.created_at <= f.until,
				)
				.slice(0, f.limit ?? 500),
			eose: true,
		});
		const { complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
			limit: 2,
		});
		expect(complete).toBe(false);
	});
});

describe("the REQ filter pollInbox actually sends", () => {
	// A STRICT RELAY (e.g. strfry with `filterValidation`, `requireAuthorOrTag =
	// true` AND AN `allowedKinds` LIST). CI proves that an open filter is refused and that an
	// `authors`-based filter is accepted — but `pollInbox` sends NEITHER. It
	// sends two kinds, no author, and satisfies requireAuthorOrTag through a
	// `#p` tag. That is the one shape production depends on and the one shape
	// nothing asserted, which is exactly this PR's own thesis about settings
	// that read as working but are not: if the ingest filter ever stopped
	// conforming, the relay would CLOSED every poll and the inbox would stall.
	it("asks only for gift wraps, with a #p tag for us, the cursor, and the clamped limit", async () => {
		await pollInbox({ relays: ["wss://r"], pubkey: ME, since: 1234 });

		expect(sentFilters).toHaveLength(1);
		const [filter] = sentFilters;
		expect(filter.kinds).toEqual([GIFT_WRAP_KIND]);
		// The requireAuthorOrTag half. `authors` is NOT how we satisfy it — we are
		// asking for events OTHERS addressed to us, so there is no author to name.
		expect(filter["#p"]).toEqual([ME]);
		expect(filter.authors).toBeUndefined();
		expect(filter.since).toBe(1234);
		expect(filter.limit).toBe(DEFAULT_POLL_LIMIT);
		// First page is open-ended; `until` only appears when paging backward.
		expect(filter.until).toBeUndefined();
	});

	it("keeps that shape while paging backward, and never asks for more than the relay allows", async () => {
		// A second page must not drop the tag or the kinds — the relay validates
		// EVERY REQ, not just the first, so a page-2 filter that lost its `#p`
		// would refuse mid-drain and strand the oldest events in the window.
		const dense = Array.from({ length: 500 }, (_, i) =>
			ev({ id: `e${i}`, created_at: 5000 - i }),
		);
		responder = (f) => ({
			events: dense
				.filter((e) =>
					f.until === undefined ? true : e.created_at <= f.until,
				)
				.slice(0, f.limit ?? 500),
			eose: true,
		});

		await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
			// Over the cap on purpose: the clamp is what stops a caller from
			// turning a server-side truncation into a silent cursor advance.
			limit: 5000,
		});

		expect(sentFilters.length).toBeGreaterThan(1);
		for (const filter of sentFilters) {
			expect(filter.kinds).toEqual([GIFT_WRAP_KIND]);
			expect(filter["#p"]).toEqual([ME]);
			expect(filter.limit).toBe(DEFAULT_POLL_LIMIT);
		}
		expect(sentFilters[1].until).toBeDefined();
	});
});

describe("pollInbox tells a refusal apart from a dropped socket", () => {
	// `onclose` is NOT a refusal channel. nostr-tools routes a relay-sent CLOSED
	// and any hard socket close through the same callback — handleHardClose ->
	// closeAllSubscriptions supplies its own reasons. A relay on ONE machine restarts
	// on every deploy, which is a few seconds of exactly that. Reporting those as a
	// standing refusal that "will refuse again until this is addressed" would
	// raise an alarm on every release and train whoever reads the logs to ignore
	// the message that matters.
	async function warningsFor(closed: string): Promise<string[]> {
		responder = () => ({ events: [], eose: false, closed });
		const warn = vi.fn();
		await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
			logger: { warn },
		});
		return warn.mock.calls.map(
			([msg, ctx]) => `${msg} ${JSON.stringify(ctx)}`,
		);
	}

	it.each([
		"relay connection closed",
		"relay connection failed",
		"relay connection timed out",
		"relay connection closed by us",
	])(
		"does not call a dropped socket a standing refusal: %s",
		async (reason) => {
			const logged = await warningsFor(reason);
			// The reason still has to reach the log — it is the only clue available.
			expect(logged.some((l) => l.includes(reason))).toBe(true);
			expect(logged.some((l) => l.includes("REFUSED"))).toBe(false);
			expect(logged.some((l) => l.includes("will refuse again"))).toBe(
				false,
			);
		},
	);

	it.each([
		"auth-required: we only serve registered users",
		"restricted: not authorized",
		"blocked: pubkey is banned",
		"bad req: filter validation failed: kind not allowed: 1059",
		"rate-limited: slow down",
	])("still names a relay-sent refusal: %s", async (reason) => {
		const logged = await warningsFor(reason);
		expect(logged.some((l) => l.includes("REFUSED"))).toBe(true);
		expect(logged.some((l) => l.includes(reason))).toBe(true);
	});

	it("is case-insensitive about the prefix but not loose about it", async () => {
		expect(
			(await warningsFor("AUTH-REQUIRED: nope")).some((l) =>
				l.includes("REFUSED"),
			),
		).toBe(true);
		// No colon, so not the protocol's machine-readable form — a relay writing
		// prose gets the neutral treatment rather than a promise about the future.
		expect(
			(await warningsFor("restricted for now")).some((l) =>
				l.includes("REFUSED"),
			),
		).toBe(false);
	});
});

describe("publishToRelays classifies WHY a relay did not take an event", () => {
	// The gap that let the bug through. `deliveredToPeer` decides whether a send
	// is reported as failed, and per claude.md a reported failure pages a human —
	// but the tri-state's CONSUMER was thoroughly tested while its CLASSIFIER had
	// no coverage at all. So a version that labelled every publish rejection
	// "refused" passed every test.
	const EV = ev({ id: "pub1" });

	it("calls a NIP-01 rejection a REFUSAL", async () => {
		// The relay answered. `["OK", id, false, "invalid: …"]` surfaces from
		// nostr-tools as a rejection carrying the relay's own reason.
		publisher = async () => {
			throw new Error("invalid: event too large");
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.ok).toBe(false);
		expect(res.rejected[0].kind).toBe("refused");
		// Unwrapped: the stored reason must not read "Error: invalid: …".
		expect(res.rejected[0].error).toBe("invalid: event too large");
	});

	it.each([
		"relay connection closed",
		"relay connection failed",
		"relay connection timed out",
		"relay connection closed by us",
	])("calls a dropped socket UNREACHABLE: %s", async (reason) => {
		// THE REGRESSION. nostr-tools' closeAllSubscriptions rejects everything
		// pending in `openEventPublishes` when the socket drops, with these
		// strings — through the exact same channel as a real refusal. Labelling
		// them "refused" made a peer relay restarting during their deploy report
		// as a delivery failure, which pages someone.
		publisher = async () => {
			throw new Error(reason);
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].kind).toBe("unreachable");
	});

	it("does not let String(Error) smuggle everything into 'refused'", async () => {
		// The trap in the obvious fix. `String(new Error(m))` is `"Error: " + m`,
		// and "error:" is itself one of the NIP-01 prefixes — so classifying the
		// WRAPPED form marks every failure, socket drops included, as a standing
		// refusal. This asserts the unwrapping, not just the outcome, because the
		// two look identical for a genuine refusal.
		publisher = async () => {
			throw new Error("relay connection closed");
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].kind).toBe("unreachable");
		expect(res.rejected[0].error).not.toContain("Error:");
	});

	it("calls a failed dial UNREACHABLE", async () => {
		const { Relay } = await import("nostr-tools/relay");
		vi.mocked(Relay.connect).mockRejectedValueOnce(
			new Error("dns failure"),
		);
		const res = await publishToRelays(["wss://down"], EV);
		expect(res.rejected[0].kind).toBe("unreachable");
	});

	it("reports a mixed fan-out per relay, not as a count", async () => {
		publisher = async (url) => {
			if (url === "wss://refuses") {
				throw new Error("blocked: pubkey not allowed");
			}
			if (url === "wss://down") {
				throw new Error("relay connection failed");
			}
		};
		const res = await publishToRelays(
			["wss://ok", "wss://refuses", "wss://down"],
			EV,
		);
		expect(res.ok).toBe(true);
		expect(res.accepted).toBe(1);
		const byRelay = Object.fromEntries(
			res.rejected.map((r) => [r.relay, r.kind]),
		);
		expect(byRelay).toEqual({
			"wss://refuses": "refused",
			"wss://down": "unreachable",
		});
	});
});

describe("pollInbox drain-loop decision table", () => {
	// One case per cell, because the exit logic has been wrong three times and
	// each fix was verified against a single scenario while breaking another.
	// The two questions are: can the cursor still move, and if not, is that
	// drainage or truncation?
	//
	//   empty page                      -> drained          complete
	//   page all out-of-window          -> nothing learned   INCOMPLETE
	//   stuck + SHORT page              -> drained          complete
	//   stuck + FULL page               -> truncated        INCOMPLETE
	//   not stuck                       -> keep paging
	//
	/** A relay that honours `since`/`until` and returns newest-first. */
	function honestRelay(all: Event[], cap = DEFAULT_POLL_LIMIT) {
		return (f: Filter) => ({
			events: all
				.filter(
					(e) =>
						e.created_at >= (f.since ?? 0) &&
						(f.until === undefined || e.created_at <= f.until),
				)
				.sort((a, b) => b.created_at - a.created_at)
				.slice(0, Math.min(f.limit ?? DEFAULT_POLL_LIMIT, cap)),
			eose: true,
		});
	}

	it("DRAINED dense window: everything read, and the cursor may advance", async () => {
		// THE STUCK-CURSOR REGRESSION. 200 events share t=6000 and 400 share
		// t=5000. Page 0 fills at 500, so `until` lands on 5000. Page 1 returns
		// all 400 at 5000 — a SHORT page, so the relay has handed over the whole
		// cluster — but `oldest >= until`, which used to mean "dense cluster,
		// incomplete". Every event had been read; reporting incomplete made the
		// ingest hold its cursor, re-issue the same two pages every tick, and
		// re-verify ~900 signatures forever, under a warning that said the
		// opposite of what happened.
		const all = [
			...Array.from({ length: 200 }, (_, i) =>
				ev({ id: `hi${i}`, created_at: 6000 }),
			),
			...Array.from({ length: 400 }, (_, i) =>
				ev({ id: `lo${i}`, created_at: 5000 }),
			),
		];
		responder = honestRelay(all);
		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		expect(events).toHaveLength(600);
		expect(complete).toBe(true);
	});

	it("TRUNCATED cluster: a FULL page that cannot lower the cursor holds it", async () => {
		// The case the branch above must not swallow. 600 events share t=5000
		// with limit 500, so page 1 comes back FULL and 100 of them can never be
		// reached by lowering `until`. Short page vs full page is the only thing
		// separating this from the test above.
		const all = [
			...Array.from({ length: 200 }, (_, i) =>
				ev({ id: `hi${i}`, created_at: 6000 }),
			),
			...Array.from({ length: 600 }, (_, i) =>
				ev({ id: `lo${i}`, created_at: 5000 }),
			),
		];
		responder = honestRelay(all);
		const { complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		expect(complete).toBe(false);
	});

	it("EMPTY page is unambiguous drainage", async () => {
		responder = () => ({ events: [], eose: true });
		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 0,
		});
		expect(events).toHaveLength(0);
		expect(complete).toBe(true);
	});
});

describe("pollInbox will not let a relay poison its own cursor", () => {
	/** A relay that HONOURS since/until — the existing stubs ignore the filter,
	 * which is why this class of bug was invisible to them. */
	function honest(all: Event[], extra?: Event[]) {
		return (f: Filter) => {
			const since = f.since ?? 0;
			const until = f.until;
			const pool = all.filter(
				(e) =>
					e.created_at >= since &&
					(until === undefined || e.created_at <= until),
			);
			const page = pool.slice(0, f.limit ?? DEFAULT_POLL_LIMIT);
			// The poison rides along on page 0 only: one validly-signed event
			// dated below `since`, which the client will discard — after it has
			// already dragged the cursor.
			return {
				events:
					until === undefined && extra
						? [...page.slice(0, -1), ...extra]
						: page,
				eose: true,
			};
		};
	}

	it("ignores an out-of-window event when choosing the next page's `until`", async () => {
		// `oldest` used to be taken from the RAW batch, so one event at
		// created_at 1 set `until = 1`. The next REQ (since 1000, until 1) is an
		// empty range, an honest relay answers nothing, and the loop broke with
		// complete:true — cursor advanced past everything page 0 did not carry.
		// Simulated at 499 of 1500 events read, reported complete.
		const all = Array.from({ length: 1_200 }, (_, i) =>
			ev({ id: `e${i}`, created_at: 10_000 - i }),
		);
		const poison = ev({ id: "poison", created_at: 1 });

		responder = honest(all, [poison]);
		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 1_000,
		});

		// The poison event is discarded by the window check, and every real event
		// is still read.
		expect(events.map((e) => e.id)).not.toContain("poison");
		expect(events).toHaveLength(1_200);
		expect(complete).toBe(true);
	});

	it("ignores an IN-window event that is not ours when choosing `until`", async () => {
		// The half the first fix missed. Gating `oldest` on `>= since` stops an
		// event dated BELOW the window from moving the cursor, but an event
		// inside it that we then discard — wrong kind, no `p` tag naming us, or
		// an unverifiable signature — still set the next page's `until` before
		// the filter three lines down threw it away.
		//
		// One frame is enough against a single relay: page 0 returns it alone,
		// `until` drops to `since`, page 1 is a range the relay answers nothing
		// for, and the loop breaks with relayComplete still true. Measured on
		// the pre-fix code: 1 of 1500 events read, reported complete.
		const all = Array.from({ length: 800 }, (_, i) =>
			ev({ id: `e${i}`, created_at: 5_000 - i }),
		);
		// In-window (created_at >= since) but addressed to someone else.
		const foreign = ev({
			id: "foreign",
			created_at: 1_000,
			tags: [["p", OTHER]],
		});
		let page = 0;
		responder = (f) => {
			page++;
			if (page === 1) {
				return { events: [foreign], eose: true };
			}
			const since = f.since ?? 0;
			const until = f.until;
			return {
				events: all
					.filter(
						(e) =>
							e.created_at >= since &&
							(until === undefined || e.created_at <= until),
					)
					.sort((a, b) => b.created_at - a.created_at)
					.slice(0, f.limit ?? DEFAULT_POLL_LIMIT),
				eose: true,
			};
		};

		const { events, complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 1_000,
		});

		// Page 0 carried nothing we could accept, so we learned nothing about
		// the window: hold the cursor rather than advance past it.
		expect(complete).toBe(false);
		expect(events.map((e) => e.id)).not.toContain("foreign");
	});

	it("holds the cursor when a page carries no in-window event at all", async () => {
		// Leaves `oldest` at Infinity. JSON.stringify writes that as `null`, so
		// the next REQ would ship a filter with NO upper bound — paging forever
		// over the same events while looking like progress. We learned nothing
		// about the window, so `complete` must be false and the caller must keep
		// its cursor.
		let page = 0;
		responder = () => {
			page++;
			return page === 1
				? {
						events: Array.from(
							{ length: DEFAULT_POLL_LIMIT },
							(_, i) =>
								ev({ id: `p${i}`, created_at: 9_000 - i }),
						),
						eose: true,
					}
				: {
						// All below `since` — new ids, so the drain does not end
						// here, but nothing that may move the cursor.
						events: [
							ev({ id: "old1", created_at: 1 }),
							ev({ id: "old2", created_at: 2 }),
						],
						eose: true,
					};
		};

		const { complete } = await pollInbox({
			relays: ["wss://r"],
			pubkey: ME,
			since: 1_000,
		});
		expect(complete).toBe(false);
	});
});

describe("publishToRelays: an OK false is a refusal even without a prefix", () => {
	const EV = ev({ id: "pub2" });

	it.each(["pow: difficulty 28 required", "mute: muted pubkey"])(
		"classifies NIP-01 %s as a refusal",
		async (reason) => {
			// Both are in NIP-01's standardized set and were missing. On the
			// publish path that meant an OK false bucketed `unreachable`, so
			// deliveredToPeer stayed undefined and the send reported ok:true —
			// DELIVERED, for a message the peer's relay refused.
			publisher = async () => {
				throw new Error(reason);
			};
			const res = await publishToRelays(["wss://r"], EV);
			expect(res.rejected[0].kind).toBe("refused");
		},
	);

	it("classifies a BARE OK false reason as a refusal, not as unreachable", async () => {
		// The residual a prefix list cannot close: NIP-01 only says relays
		// SHOULD prefix their reasons. The publish path therefore identifies the
		// LOCAL failures — nostr-tools' own strings, a closed set — and treats
		// everything else as the OK false it is by construction. Without this a
		// relay answering "not accepted" still reported as delivered.
		publisher = async () => {
			throw new Error("not accepted");
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].kind).toBe("refused");
	});

	it("calls nostr-tools' OWN publish timer unreachable, not a refusal", async () => {
		// The one that was live. nostr-tools sets publishTimeout = 4400ms,
		// SHORTER than RELAY_OP_TIMEOUT_MS (8000), so on a relay that connects
		// and then stalls THIS is the reason that arrives. It matched neither
		// branch of isLocalTransportFailure, so it fell through to
		// RelayRefusedError: deliveredToPeer false, ok false, and
		// escalatePersistentToolBlockers paging a human for a relay that merely
		// went quiet.
		//
		// `auth timed out` is NOT tested alongside it, deliberately. It is the
		// same 4400ms budget but settles the AUTH promise — `auth()` keys its
		// handlers on the AUTH event's own id — so it cannot reach this catch.
		// Feeding it through `publisher` would assert on a string production
		// never produces, which is a test that looks like coverage and is not.
		publisher = async () => {
			throw new Error("publish timed out");
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].kind).toBe("unreachable");
	});

	it("calls a send on a dead socket unreachable, using the REAL error", async () => {
		// Constructed from nostr-tools' own exported class, not an Error with
		// `name` assigned by hand. Hand-setting it fabricates the exact property
		// the classifier keys on, so the test would stay green if a future
		// version stopped assigning `name` while the branch went dead in
		// production — the same trap this PR rejects for `auth timed out`.
		// (2.25.0 does assign it; the point is that this test, not the reading,
		// is what has to notice if that changes.)
		const { SendingOnClosedConnection } = await vi.importActual<
			typeof import("nostr-tools/abstract-relay")
		>("nostr-tools/abstract-relay");
		publisher = async () => {
			throw new SendingOnClosedConnection(
				'["EVENT",{"id":"pub2"}]',
				"wss://r",
			);
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].kind).toBe("unreachable");
	});

	it("says what happened without carrying any of the event", async () => {
		// The library message embeds the whole serialized event and puts the
		// cause AFTER it, so it is dropped rather than bounded — see the call
		// site. Asserted as an EQUALITY: the previous
		// `toContain("Tried to send message")` was the first 21 characters, so
		// it survived a front-anchored bound of any size >= 21, including one
		// that erased every word explaining the failure. It could not fail.
		const { SendingOnClosedConnection } = await vi.importActual<
			typeof import("nostr-tools/abstract-relay")
		>("nostr-tools/abstract-relay");
		const payload = "x".repeat(5000);
		publisher = async () => {
			throw new SendingOnClosedConnection(
				`["EVENT",{"id":"${EV.id}","content":"${payload}"}]`,
				"wss://r",
			);
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].error).toBe("send on a closed connection");
		// Pinned against the id and a SHORT slice of the payload: testing the
		// whole 5000-char string would pass while dozens of characters of
		// ciphertext survived at the front.
		expect(res.rejected[0].error).not.toContain(EV.id);
		expect(res.rejected[0].error).not.toContain(payload.slice(0, 20));
		expect(res.errors[0]).not.toContain(EV.id);
	});

	it("bounds a relay's own OK false reason, without misclassifying it", async () => {
		// boundReason's REMAINING job, once the closed-connection message is
		// dropped at the call site: an `OK false` reason is remote text of any
		// length, rendered into operator logs, the CLI, and the advice a model
		// reads. Without this the closed-connection fix would leave it unpinned
		// — measured, deleting boundReason failed nothing.
		publisher = async () => {
			throw new Error(`invalid: ${"x".repeat(5000)}`);
		};
		const res = await publishToRelays(["wss://r"], EV);
		expect(res.rejected[0].error.length).toBeLessThan(250);
		// Classified on the FULL string, not the bounded one: the NIP-01 prefix
		// happens to sit at the front here, but the ordering is what keeps a
		// bound from ever changing a verdict.
		expect(res.rejected[0].kind).toBe("refused");
	});

	it("still calls nostr-tools' own close strings unreachable", async () => {
		// The other side of the inversion: these must NOT become refusals, or a
		// peer relay restarting during their deploy pages a human.
		for (const reason of [
			"relay connection closed",
			"relay connection failed",
			"relay connection timed out",
			"relay connection closed by us",
		]) {
			publisher = async () => {
				throw new Error(reason);
			};
			const res = await publishToRelays(["wss://r"], EV);
			expect(res.rejected[0].kind).toBe("unreachable");
		}
	});
});

describe("pollInbox checks each signature once", () => {
	it("does not re-check a signature it passed, and still matches every copy to its id", async () => {
		const wrap = ev({ id: "verified-once", created_at: 1500, content: "original" });
		responder = () => ({ events: [wrap], eose: true });
		const poll = () => pollInbox({ relays: ["wss://r"], pubkey: ME, since: 1000, limit: 50 });

		expect((await poll()).events.map((e) => e.id)).toEqual(["verified-once"]);
		expect((await poll()).events.map((e) => e.id)).toEqual(["verified-once"]);
		// Two days of wraps come back on every poll: the signature is checked once.
		expect(mockVerify.mock.calls.filter(([e]) => e.id === "verified-once")).toHaveLength(1);

		// A relay replaying the known id with other content does not match its hash.
		const tampered = { ...wrap, content: "tampered" };
		mockHash.mockImplementation((e: Event) => (e.content === "original" ? e.id : "a-different-hash"));
		responder = () => ({ events: [tampered], eose: true });
		expect((await poll()).events).toHaveLength(0);
	});
});
