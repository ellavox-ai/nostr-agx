/**
 * Local bounds on automated replies (SPEC "Automated-reply depth").
 *
 * A message sent as an automated reply declares `autoDepth = inbound + 1`, so a
 * peer that honours its own ceiling stops. But `autoDepth` is sender-declared:
 * a peer can omit it, reset it, or open a fresh `contextId` for every message.
 * So every implementation MUST also bound automated replies itself, per
 * conversation and per peer — and per peer is the half that holds, because a
 * peer cannot pick a new identity the way it can pick a new conversation id.
 *
 * Kept in process memory, like `agx serve`'s per-conversation count, rather than
 * in workflow static data: n8n saves static data as one blob per workflow, so a
 * node that writes it during an execution overwrites the AGX Trigger's replay
 * state in the same workflow with the stale copy the execution started from.
 */

export interface AutoReplyLimits {
	/** Refuse an automated reply deeper than this (reference: 8). */
	maxDepth: number;
	/** Automated replies per peer and conversation, for the process lifetime. */
	perConversation: number;
	/** Automated replies per peer in any rolling hour. */
	perPeerPerHour: number;
}

export const DEFAULT_AUTO_REPLY_LIMITS: AutoReplyLimits = {
	maxDepth: 8,
	perConversation: 20,
	perPeerPerHour: 60,
};

const HOUR_MS = 60 * 60 * 1000;
/** Memory guards. Evicting an entry only forgets old replies. */
const MAX_TRACKED_CONVERSATIONS = 10_000;
const MAX_TRACKED_PEERS = 10_000;

/** The guard's answer to one send: a reason to refuse it, or a reservation to
 * hand back if the send does not go out after all. */
export type Admission = { refused: string } | { refused: null; release(): void };

const NOTHING_TO_RELEASE: Admission = { refused: null, release: () => undefined };

export class AutoReplyGuard {
	/** `${from}>${to}` -> send times (ms) within the last hour. */
	private readonly byPeer = new Map<string, number[]>();
	/** `${from}>${to}:${contextId}` -> automated replies sent. Insertion order
	 * is the eviction order. */
	private readonly byConversation = new Map<string, number>();

	/**
	 * Admit one send. A depth of 0 is not an automated reply and is never
	 * bounded: a human in the loop resets the depth. An admitted reply is counted
	 * at once, so two sends racing each other cannot both slip under a limit;
	 * `release()` takes the count back for a send that then did not go out.
	 * Keyed on the sending identity too, since one n8n can hold several agents'
	 * credentials.
	 */
	admit(
		send: { from: string; to: string; contextId: string; depth: number },
		limits: AutoReplyLimits,
		now = Date.now(),
	): Admission {
		const { depth } = send;
		if (depth <= 0) {
			return NOTHING_TO_RELEASE;
		}
		if (depth > limits.maxDepth) {
			return { refused: `its automated-reply depth (${depth}) is over this node's ceiling of ${limits.maxDepth}. Two agents answering each other automatically end here; a message a person writes or approves (depth 0) starts the conversation over.` };
		}
		const peer = `${send.from}>${send.to}`;
		const conversation = `${peer}:${send.contextId}`;
		const inConversation = this.byConversation.get(conversation) ?? 0;
		if (inConversation >= limits.perConversation) {
			return {
				refused: `${inConversation} automated replies were already sent to this agent in this conversation (limit ${limits.perConversation}).`,
			};
		}
		const recent = (this.byPeer.get(peer) ?? []).filter(
			(at) => at > now - HOUR_MS,
		);
		if (recent.length >= limits.perPeerPerHour) {
			return {
				refused: `${recent.length} automated replies were already sent to this agent in the last hour (limit ${limits.perPeerPerHour}).`,
			};
		}

		recent.push(now);
		this.byPeer.delete(peer);
		this.byPeer.set(peer, recent);
		this.byConversation.delete(conversation);
		this.byConversation.set(conversation, inConversation + 1);
		this.evict(now);
		let released = false;
		return {
			refused: null,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				const times = this.byPeer.get(peer);
				const at = times?.lastIndexOf(now) ?? -1;
				if (times && at >= 0) {
					times.splice(at, 1);
				}
				const count = this.byConversation.get(conversation);
				if (count !== undefined) {
					if (count <= 1) {
						this.byConversation.delete(conversation);
					} else {
						this.byConversation.set(conversation, count - 1);
					}
				}
			},
		};
	}

	private evict(now: number): void {
		while (this.byConversation.size > MAX_TRACKED_CONVERSATIONS) {
			const oldest = this.byConversation.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.byConversation.delete(oldest);
		}
		if (this.byPeer.size > MAX_TRACKED_PEERS) {
			for (const [peer, times] of this.byPeer) {
				if (times.every((at) => at <= now - HOUR_MS)) {
					this.byPeer.delete(peer);
				}
			}
		}
	}
}

/** One guard per n8n process, shared by every AGX node in it. */
export const autoReplyGuard = new AutoReplyGuard();
