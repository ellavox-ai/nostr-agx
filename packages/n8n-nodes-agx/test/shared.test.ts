import { AgxPublicError } from "@nostr-agx/core";
import { bytesToHex, generateKeypair, MAX_WRAP_BACKDATE_SEC, toNpub } from "@nostr-agx/nostr";
import type { IDataObject } from "n8n-workflow";
import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";
import { AutoReplyGuard, DEFAULT_AUTO_REPLY_LIMITS } from "../nodes/shared/auto-reply-guard";
import { identityFromCredentials, parseRelays, parseSecretKey } from "../nodes/shared/identity";
import { parseCapabilities, parsePeer, parsePeerList } from "../nodes/shared/peers";
import { awaitTaskOutput, taskOutputFromRun } from "../nodes/shared/run-result";
import { isoOrNull, numberOption } from "../nodes/shared/numbers";
import { __resetLiveClaimsForTests, TriggerState } from "../nodes/shared/trigger-state";
import { finishedRun } from "./helpers";

describe("credential parsing", () => {
	it("accepts an nsec or 64 hex characters, and names an npub as the wrong key", () => {
		const { secretKey, publicKey } = generateKeypair();
		expect(parseSecretKey(nip19.nsecEncode(secretKey))).toEqual(secretKey);
		expect(parseSecretKey(` ${bytesToHex(secretKey).toUpperCase()} `)).toEqual(secretKey);
		expect(() => parseSecretKey(toNpub(publicKey))).toThrow(/public key/);
		expect(() => parseSecretKey("nope")).toThrow(/nsec1/);
	});

	it("reads relays separated by commas or new lines, ws:// and wss:// only", () => {
		expect(parseRelays("wss://a.example, ws://127.0.0.1:7447\nwss://a.example")).toEqual([
			"wss://a.example",
			"ws://127.0.0.1:7447",
		]);
		expect(() => parseRelays("https://a.example")).toThrow(/wss:\/\//);
		expect(() => parseRelays(" , ")).toThrow(/at least one relay/);
	});

	it("builds the identity the nodes act as", () => {
		const { secretKey, publicKey } = generateKeypair();
		const identity = identityFromCredentials({
			secretKey: bytesToHex(secretKey),
			relays: "wss://a.example",
			org: " Acme ",
			nip05: "",
		});
		expect(identity.publicKey).toBe(publicKey);
		expect(identity.npub).toBe(toNpub(publicKey));
		expect(identity.org).toBe("Acme");
		expect(identity.nip05).toBeNull();
	});
});

describe("peer parsing", () => {
	it("normalizes npub and hex to hex", () => {
		const { publicKey } = generateKeypair();
		expect(parsePeer(toNpub(publicKey))).toBe(publicKey);
		expect(parsePeer(publicKey.toUpperCase())).toBe(publicKey);
		expect(() => parsePeer("bob")).toThrow(/npub1/);
	});

	it("names every bad allowlist entry, since a dropped one would look like a denial", () => {
		const a = generateKeypair().publicKey;
		const b = generateKeypair().publicKey;
		expect(parsePeerList(`${toNpub(a)},\n${b} ${a}`)).toEqual([a, b]);
		expect(() => parsePeerList(`${a}, alice, npub1zzz`)).toThrow(/alice, npub1zzz/);
		expect(parsePeerList("")).toEqual([]);
	});

	it("splits capabilities", () => {
		expect(parseCapabilities("invoice.review, invoice.*\ninvoice.review")).toEqual([
			"invoice.review",
			"invoice.*",
		]);
	});
});

describe("AutoReplyGuard", () => {
	const send = { from: "me", to: "peer", contextId: "c1" };
	const refused = (admission: ReturnType<AutoReplyGuard["admit"]>) => admission.refused;

	it("never bounds a message a person wrote (depth 0)", () => {
		const guard = new AutoReplyGuard();
		for (let i = 0; i < 100; i++) {
			expect(refused(guard.admit({ ...send, depth: 0 }, DEFAULT_AUTO_REPLY_LIMITS))).toBeNull();
		}
	});

	it("refuses an automated reply over the depth ceiling", () => {
		const guard = new AutoReplyGuard();
		expect(refused(guard.admit({ ...send, depth: 8 }, DEFAULT_AUTO_REPLY_LIMITS))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 9 }, DEFAULT_AUTO_REPLY_LIMITS))).toMatch(
			/ceiling of 8/,
		);
	});

	it("bounds automated replies per conversation, and per peer across conversations", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 2, perPeerPerHour: 3 };
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toMatch(/this conversation/);
		// A fresh contextId resets the conversation count but not the peer's.
		expect(refused(guard.admit({ ...send, contextId: "c2", depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, contextId: "c3", depth: 1 }, limits))).toMatch(
			/last hour/,
		);
		// Another of our identities talking to the same peer is another agent.
		expect(
			refused(guard.admit({ ...send, from: "me2", contextId: "c3", depth: 1 }, limits)),
		).toBeNull();
	});

	it("forgets replies older than an hour", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 100, perPeerPerHour: 1 };
		const t0 = 1_000_000_000_000;
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0 + 1000))).not.toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0 + 3_600_001))).toBeNull();
	});

	it("takes back a reply that was not sent, once", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 1, perPeerPerHour: 1 };
		const admission = guard.admit({ ...send, depth: 1 }, limits);
		expect(refused(admission)).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).not.toBeNull();
		if (admission.refused === null) {
			admission.release();
			admission.release();
		}
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).not.toBeNull();
	});
});

describe("numberOption", () => {
	it("uses the default for an empty option and accepts what is in range", () => {
		expect(numberOption(undefined, "Timeout", 30, { min: 1, max: 60 })).toBe(30);
		expect(numberOption("", "Timeout", 30, { min: 1, max: 60 })).toBe(30);
		expect(numberOption("5", "Timeout", 30, { min: 1, max: 60 })).toBe(5);
	});

	it("rejects what an expression or a model could hand over: 0, NaN, too large, a fraction", () => {
		for (const value of [0, -1, Number.NaN, "soon", 61]) {
			expect(() => numberOption(value, "Timeout", 30, { min: 1, max: 60 })).toThrow(
				/Timeout must be a number from 1 to 60/,
			);
		}
		expect(() => numberOption(1.5, "Depth", 0, { min: 0, max: 255, integer: true })).toThrow(
			/whole number/,
		);
	});
});

describe("isoOrNull", () => {
	it("formats a sender's time, and gives null for one no Date can hold", () => {
		expect(isoOrNull(1_800_000_000)).toBe("2027-01-15T08:00:00.000Z");
		expect(isoOrNull(undefined)).toBeNull();
		expect(isoOrNull(1e300)).toBeNull();
		expect(isoOrNull(Number.NaN)).toBeNull();
	});
});

describe("taskOutputFromRun", () => {
	const firstItem = { mode: "firstItem" as const, forwardErrors: false };

	it("returns the last node's first item, or all of them", () => {
		const run = finishedRun([{ approved: true }, { approved: false }]);
		expect(taskOutputFromRun(run, firstItem)).toEqual({ approved: true });
		expect(taskOutputFromRun(run, { ...firstItem, mode: "allItems" })).toEqual([
			{ approved: true },
			{ approved: false },
		]);
		expect(taskOutputFromRun(finishedRun([]), firstItem)).toEqual({});
	});

	it("keeps a failed execution's message on this side unless told to forward it", () => {
		const run = finishedRun([], "connect ECONNREFUSED db.internal:5432");
		let thrown: unknown;
		try {
			taskOutputFromRun(run, firstItem);
		} catch (error) {
			thrown = error;
		}
		// A plain Error: AgxClient reports it to the peer as `handler failed`.
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(AgxPublicError);
		expect(() => taskOutputFromRun(run, { ...firstItem, forwardErrors: true })).toThrow(
			AgxPublicError,
		);
	});

	it("treats an execution that did not finish as a failure", () => {
		const run = { ...finishedRun([{ a: 1 }]), status: "waiting" } as ReturnType<typeof finishedRun>;
		expect(() => taskOutputFromRun(run, firstItem)).toThrow(/waiting/);
		expect(() => taskOutputFromRun(undefined, firstItem)).toThrow(/did not run/);
	});
});

describe("awaitTaskOutput", () => {
	const options = { mode: "firstItem" as const, forwardErrors: false, timeoutMs: 50 };

	it("returns the output of the execution once it finishes", async () => {
		await expect(
			awaitTaskOutput(Promise.resolve(finishedRun([{ ok: 1 }])), options),
		).resolves.toEqual({ ok: 1 });
	});

	it("fails publicly when the execution does not finish in time", async () => {
		await expect(awaitTaskOutput(new Promise(() => undefined), options)).rejects.toThrow(
			AgxPublicError,
		);
	});

	it("reports an execution n8n could not run like a failed one", async () => {
		const failed = () => Promise.reject(new Error("workflow has issues"));
		const kept = await awaitTaskOutput(failed(), options).catch((e: unknown) => e);
		expect(kept).toBeInstanceOf(Error);
		expect(kept).not.toBeInstanceOf(AgxPublicError);
		await expect(
			awaitTaskOutput(failed(), { ...options, forwardErrors: true }),
		).rejects.toThrow(AgxPublicError);
	});
});

describe("TriggerState", () => {
	beforeEach(() => __resetLiveClaimsForTests());
	const now = 1_800_000_000;
	const scope = { workflowId: "w1", nodeId: "n1", pubkey: "aa" };
	const active = (data: IDataObject, at = now, fresh = false, s = scope) =>
		TriggerState.forActiveWorkflow(data, s, at, { fresh });

	it("starts a new state from now, and starts over for another key", () => {
		const data: IDataObject = {};
		const state = active(data);
		expect(state.since).toBe(now - 300);
		expect(state.cursor).toBe(now);
		expect(state.tryClaim(["e1"], now)).toBe(true);
		__resetLiveClaimsForTests();
		expect(active(data, now + 10).isClaimed("e1")).toBe(true);
		expect(active(data, now + 10, false, { ...scope, pubkey: "bb" }).isClaimed("e1")).toBe(false);
	});

	it("keeps its state by node id, so renaming the node keeps it", () => {
		const data: IDataObject = {};
		active(data).tryClaim(["e1"], now);
		__resetLiveClaimsForTests();
		expect(Object.keys(data)).toEqual(["agx:n1"]);
		expect(active(data).isClaimed("e1")).toBe(true);
	});

	it("resumes after a restart, but starts from now when the workflow is turned on again", () => {
		const data: IDataObject = {};
		active(data).tryClaim(["e1"], now);
		const twoWeeks = now + 14 * 24 * 3600;
		const restarted = active(data, twoWeeks);
		expect(restarted.since).toBe(now - 300);
		expect(restarted.cursor).toBe(now);
		const reactivated = active(data, twoWeeks, true);
		expect(reactivated.since).toBe(twoWeeks - 300);
		expect(reactivated.cursor).toBe(twoWeeks);
	});

	it("lets exactly one instance of the trigger take an event", () => {
		const data: IDataObject = {};
		const replaced = active(data);
		const replacing = active(data);
		const test = TriggerState.forManualRun({}, scope, now);
		expect(replaced.tryClaim(["e1", "w1"], now)).toBe(true);
		expect(replacing.tryClaim(["e1", "w1"], now)).toBe(false);
		expect(test.tryClaim(["w1"], now)).toBe(false);
		// Another trigger node is another consumer.
		expect(TriggerState.forManualRun({}, { ...scope, nodeId: "n2" }, now).tryClaim(["e1"], now)).toBe(
			true,
		);
	});

	it("persists what a test run claimed, so a restart does not run it again", () => {
		const data: IDataObject = {};
		const live = active(data);
		TriggerState.forManualRun(data, scope, now).tryClaim(["from-test"], now);
		live.tryClaim(["from-active"], now);
		__resetLiveClaimsForTests();
		const restarted = active(data);
		expect(restarted.isClaimed("from-test")).toBe(true);
		expect(restarted.isClaimed("from-active")).toBe(true);
	});

	it("lets a test run see what the active trigger saved", () => {
		const data: IDataObject = {};
		active(data).tryClaim(["e1"], now);
		__resetLiveClaimsForTests();
		expect(TriggerState.forManualRun(data, scope, now).tryClaim(["e1"], now)).toBe(false);
	});

	it("assigns its key on a claim, which is what marks n8n's static data changed", () => {
		const assigned: string[] = [];
		const data = new Proxy<IDataObject>(
			{},
			{
				set(target, key, value) {
					assigned.push(String(key));
					return Reflect.set(target, key, value);
				},
			},
		);
		const state = active(data);
		assigned.length = 0;
		state.tryClaim(["e1"], now);
		expect(assigned).toEqual(["agx:n1"]);
	});

	it("keeps a claim for as long as a poll from the saved cursor can reach it", () => {
		const data: IDataObject = {};
		const state = active(data);
		state.tryClaim(["old"], now);
		__resetLiveClaimsForTests();
		const lookback = MAX_WRAP_BACKDATE_SEC + 120 + 300;
		// A cursor that moved on by the full lookback (backdate + overlap + skew)
		// still reaches it...
		state.setCursor(now + lookback);
		state.tryClaim(["new"], now + 10);
		expect(state.isClaimed("old")).toBe(true);
		// ...one second further cannot.
		state.setCursor(now + lookback + 1);
		state.tryClaim(["newer"], now + 20);
		expect(state.isClaimed("old")).toBe(false);
		expect(state.isClaimed("new")).toBe(true);
	});

	it("does not prune by the wall clock: a quiet week does not forget claims the saved cursor still reaches", () => {
		const data: IDataObject = {};
		active(data).tryClaim(["e1"], now);
		__resetLiveClaimsForTests();
		const weekLater = now + 7 * 24 * 3600;
		const restarted = active(data, weekLater);
		restarted.tryClaim(["e2"], weekLater);
		expect(restarted.isClaimed("e1")).toBe(true);
	});

	it("gives AgxClient a store that sees claims, and keeps everything else in memory", async () => {
		const data: IDataObject = {};
		const state = active(data);
		const seen = state.seenStore();
		state.tryClaim(["claimed"], now);
		await seen.add("wrap-id");
		expect(await seen.has("claimed")).toBe(true);
		expect(await seen.has("wrap-id")).toBe(true);
		expect([...((await seen.hasMany?.(["claimed", "wrap-id", "other"])) ?? [])].sort()).toEqual([
			"claimed",
			"wrap-id",
		]);
		expect(JSON.stringify(data)).not.toContain("wrap-id");
	});

	it("keeps test-run claims in memory across runs, from now each time", () => {
		const first = TriggerState.forManualRun({}, scope, now);
		first.tryClaim(["e1"], now);
		const second = TriggerState.forManualRun({}, scope, now + 60);
		expect(second.isClaimed("e1")).toBe(true);
		expect(second.since).toBe(now + 60 - 300);
	});
});
