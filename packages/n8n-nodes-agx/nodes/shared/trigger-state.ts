import {
	DEFAULT_POLL_OVERLAP_SEC,
	InMemorySeenStore,
	MAX_FUTURE_SKEW_SEC,
	type SeenStore,
} from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import type { IDataObject } from "n8n-workflow";

/**
 * Replay state for the AGX Trigger.
 *
 * AGX re-delivers its whole poll window on every poll — the poll overlap plus
 * the two-day NIP-59 backdate lookback — and n8n restarts a trigger every time
 * its workflow is saved. Replay protection that lived only in memory would run
 * every task of the last two days again on each save, so the trigger keeps
 * durable state in the workflow's static data.
 *
 * n8n saves static data when the trigger EMITS (and on activation), not when
 * it changes. So the trigger CLAIMS an event — records its ids here — just
 * before emitting it: the save that goes with the emit carries the claim, and a
 * restarted trigger skips it. That gives at-most-once execution per task across
 * restarts; a crash mid-execution means no result, which the requester's
 * timeout covers, rather than the workflow running twice.
 *
 * Claims are also shared, in process memory, by every instance of the same
 * trigger node: the active one, the one it replaces when the workflow is
 * saved, and test runs. Two of them can poll the same inbox at once, and
 * {@link TriggerState.tryClaim} lets exactly one take each event.
 *
 * Only claimed ids are kept durably. Everything else the client records — wraps
 * it could not open, events it handled without running the workflow (a denied
 * task, an ignored message) — stays in memory, so the static data, which n8n
 * writes in full on every save, grows only with executions.
 */

/** What is stored in the workflow's static data, per trigger node. */
interface StoredState {
	v: 1;
	/** The identity this state belongs to; a credential with another key starts over. */
	pubkey: string;
	/** Events their sender says were sent before this (unix seconds) are not
	 * delivered: a trigger starts from the inbox as it was when it was turned on. */
	since: number;
	/** The inbox cursor (unix seconds) after the last complete poll. */
	cursor: number;
	/** Event or envelope id -> unix seconds when it was handed to an execution. */
	claimed: Record<string, number>;
}

/** Which trigger a state belongs to. The node's id, not its name, so renaming
 * the node keeps its state. */
export interface TriggerScope {
	workflowId: string;
	nodeId: string;
	pubkey: string;
}

/** How far before the trigger was turned on a sender may date an event and
 * still have it delivered: clock skew, or a test message sent just before
 * listening. */
export const START_GRACE_SEC = 300;

/** Memory and static-data guard. Pruning by the cursor (below) is the
 * retention policy; this only caps a pathological backlog. */
const MAX_CLAIMS = 50_000;

/** Claims every instance of a trigger node in this process sees, keyed by
 * {@link liveKey}. */
const liveClaims = new Map<string, Record<string, number>>();

function liveKey(scope: TriggerScope): string {
	return `${scope.workflowId}:${scope.nodeId}:${scope.pubkey}`;
}

function stateKey(scope: TriggerScope): string {
	return `agx:${scope.nodeId}`;
}

function isStoredState(value: unknown, pubkey: string): value is StoredState {
	if (!value || typeof value !== "object") {
		return false;
	}
	const s = value as Partial<StoredState>;
	return (
		s.v === 1 &&
		s.pubkey === pubkey &&
		typeof s.since === "number" &&
		typeof s.cursor === "number" &&
		typeof s.claimed === "object" &&
		s.claimed !== null
	);
}

function liveClaimsFor(scope: TriggerScope): Record<string, number> {
	let live = liveClaims.get(liveKey(scope));
	if (!live) {
		live = {};
		liveClaims.set(liveKey(scope), live);
	}
	return live;
}

function mergeInto(
	target: Record<string, number>,
	source: Record<string, number>,
): void {
	for (const [id, at] of Object.entries(source)) {
		target[id] ??= at;
	}
}

export class TriggerState {
	private constructor(
		private readonly stored: StoredState,
		private readonly live: Record<string, number>,
		/** Marks the static data changed, so n8n saves it with the next emit;
		 * undefined for a test run, which n8n does not save. */
		private readonly markChanged?: () => void,
	) {}

	/**
	 * State kept in the workflow's static data, for an active workflow.
	 * `fresh` is for a deliberate activation (not a restart or a save): the
	 * trigger then starts from the inbox as it is now, instead of delivering
	 * everything that arrived while the workflow was off.
	 */
	static forActiveWorkflow(
		workflowStaticData: IDataObject,
		scope: TriggerScope,
		nowSec: number,
		options: { fresh: boolean },
	): TriggerState {
		const key = stateKey(scope);
		const existing = workflowStaticData[key];
		const stored: StoredState = isStoredState(existing, scope.pubkey)
			? existing
			: { v: 1, pubkey: scope.pubkey, since: 0, cursor: 0, claimed: {} };
		if (options.fresh || stored.since === 0) {
			stored.since = nowSec - START_GRACE_SEC;
			stored.cursor = nowSec;
		}
		const live = liveClaimsFor(scope);
		mergeInto(live, stored.claimed);
		// Assigning the key is what marks n8n's static data changed: it only
		// proxies objects that existed when it was loaded, so mutating a nested
		// object created since then would go unnoticed and unsaved.
		const markChanged = () => {
			workflowStaticData[key] = stored as unknown as IDataObject;
		};
		markChanged();
		return new TriggerState(stored, live, markChanged);
	}

	/** State for a manual test run: it starts from now, like listening for a
	 * test event should. It sees the claims the active trigger saved and the
	 * ones every instance of this node made in this process; its own go to the
	 * latter only, since n8n does not save a test run's static data. */
	static forManualRun(
		workflowStaticData: IDataObject,
		scope: TriggerScope,
		nowSec: number,
	): TriggerState {
		const live = liveClaimsFor(scope);
		const saved = workflowStaticData[stateKey(scope)];
		if (isStoredState(saved, scope.pubkey)) {
			mergeInto(live, saved.claimed);
		}
		return new TriggerState(
			{
				v: 1,
				pubkey: scope.pubkey,
				since: nowSec - START_GRACE_SEC,
				cursor: nowSec,
				claimed: {},
			},
			live,
		);
	}

	/** Events dated before this are not delivered. */
	get since(): number {
		return this.stored.since;
	}

	get cursor(): number {
		return this.stored.cursor;
	}

	/** Record the cursor after a complete poll. Not saved by itself: it goes out
	 * with the next claim, together with the claims it was pruned against. */
	setCursor(cursor: number): void {
		if (cursor > this.stored.cursor) {
			this.stored.cursor = cursor;
		}
	}

	isClaimed(id: string): boolean {
		return this.live[id] !== undefined || this.stored.claimed[id] !== undefined;
	}

	/**
	 * Claim an event's ids for one execution, unless any of them is claimed
	 * already — by this trigger, the one it replaced, or a test run. Returns
	 * whether this caller now has the event. Call BEFORE emitting.
	 */
	tryClaim(ids: string[], nowSec: number): boolean {
		if (ids.some((id) => this.isClaimed(id))) {
			return false;
		}
		for (const id of ids) {
			this.live[id] = nowSec;
			this.stored.claimed[id] = nowSec;
		}
		if (this.markChanged) {
			// Persist what other instances in this process claimed too (a test
			// run, say), so a restart does not run those again either.
			mergeInto(this.stored.claimed, this.live);
		}
		this.prune();
		this.markChanged?.();
		return true;
	}

	/**
	 * Drop the saved claims no future poll can reach. A poll reads from
	 * `cursor - overlap - backdate`, and an event claimed at time `t` was dated
	 * at most `t + MAX_FUTURE_SKEW_SEC`; once that is before the earliest poll
	 * start, the event cannot be delivered again. Measured against the cursor
	 * saved WITH these claims, not the wall clock: a trigger restarted after a
	 * quiet week resumes from the cursor it saved, and must still know every
	 * claim that cursor's window can reach. The in-memory claims are pruned by
	 * the same horizon, from whichever instance is claiming; an active instance
	 * whose cursor is older still checks its own saved claims.
	 */
	private prune(): void {
		const horizon =
			this.stored.cursor -
			DEFAULT_POLL_OVERLAP_SEC -
			MAX_WRAP_BACKDATE_SEC -
			MAX_FUTURE_SKEW_SEC;
		for (const claims of [this.stored.claimed, this.live]) {
			for (const [id, at] of Object.entries(claims)) {
				if (at < horizon) {
					delete claims[id];
				}
			}
			const kept = Object.entries(claims);
			if (kept.length > MAX_CLAIMS) {
				kept.sort((a, b) => a[1] - b[1]);
				for (const [id] of kept.slice(0, kept.length - MAX_CLAIMS)) {
					delete claims[id];
				}
			}
		}
	}

	/** The replay store to give `AgxClient`: claimed ids durably, the rest in
	 * memory for this run of the trigger. */
	seenStore(): SeenStore {
		const memory = new InMemorySeenStore();
		return {
			has: (id) => memory.has(id) || this.isClaimed(id),
			hasMany: (ids) => {
				const out = memory.hasMany(ids);
				for (const id of ids) {
					if (this.isClaimed(id)) {
						out.add(id);
					}
				}
				return out;
			},
			add: (id) => memory.add(id),
			addMany: (ids) => memory.addMany(ids),
			recordFailure: (id) => memory.recordFailure(id),
		};
	}
}

/** Test-only: forget the in-process claims between cases. */
export function __resetLiveClaimsForTests(): void {
	liveClaims.clear();
}
