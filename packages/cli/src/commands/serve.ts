import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AgxClient,
	type AgxIncomingMessage,
	type AgxIncomingReceipt,
	DEFAULT_CONTENT_TYPE,
	type Task,
} from "@nostr-agx/core";
import kleur from "kleur";
import { effectiveProfile, resolveProfileName } from "../lib/config.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { createCollector } from "../lib/inbox.js";
import { acquireLock } from "../lib/lock.js";
import {
	neutralizeControls,
	oneLineJson,
	renderInboundLines,
} from "../lib/inbound-lines.js";
import { heading, info, kv, say, shortNpub, warn } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";
import {
	capabilitiesToServe,
	noTasksConflicts,
	PING_CAPABILITY,
	servesPing,
	unservedTaskNote,
} from "../lib/serve-tasks.js";
import { FileSeenStore, loadState, updateState } from "../lib/state.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";

/**
 * Run as a real off-platform agent: connect to relays, poll, decrypt, dispatch
 * capability handlers, and reply.
 *
 * Authorization is DEFAULT-DENY, which NIP-AGX makes normative: a registered
 * handler is executable by any pubkey that can reach the agent, so a request is
 * dropped before dispatch unless an explicit decision allows it. A denied request
 * receives NO reply — an error result would confirm this identity and its
 * capability set to an unauthenticated peer — and falls through to the plain
 * message path so nothing is lost silently.
 */

export interface ServeOptions {
	profile?: string;
	allow?: string[];
	allowAll?: boolean;
	advertise?: boolean;
	capability?: string[];
	pollInterval?: string;
	reply?: boolean;
	replyAny?: boolean;
	replyText?: string;
	maxAutoDepth?: string;
	once?: boolean;
	resetCursor?: boolean;
	handler?: string;
	verbose?: boolean;
	/** Print only the npub of a plain message from a sender off the allowlist. */
	allowedOnly?: boolean;
	/** Print the full sender npub and contextId on RECV lines. */
	fullIds?: boolean;
	/** `false` under `--no-tasks`: register no capability handler at all, so no
	 * typed task request is ever answered (no receipt, no result). */
	tasks?: boolean;
}

/** What a `--handler` module default-exports: capability key → implementation. */
export type HandlerModule = Record<
	string,
	(
		payload: Record<string, unknown>,
		task: Task<Record<string, unknown>>,
	) => unknown | Promise<unknown>
>;

/**
 * Load a handler module by path. This is the seam a third-party runtime plugs
 * into — the module is free to call anything (an HTTP service, an LLM, a rules
 * engine); the protocol does not care what a capability is implemented with.
 */
async function loadHandlerModule(
	path: string | undefined,
): Promise<HandlerModule> {
	if (!path) {
		return {};
	}
	const resolved = resolve(process.cwd(), path);
	if (!existsSync(resolved)) {
		throw new AgxCliError(`Handler module not found: ${resolved}`, {
			exitCode: EXIT.usage,
			remediation:
				"Pass a path to a JS module that default-exports { capability: handler }:\n    agx serve --handler ./my-runtime.mjs",
		});
	}
	let mod: { default?: unknown };
	try {
		mod = await import(pathToFileURL(resolved).href);
	} catch (error) {
		throw new AgxCliError(
			`Could not load handler module ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
			{ exitCode: EXIT.usage },
		);
	}
	const exported = mod.default;
	if (!exported || typeof exported !== "object") {
		throw new AgxCliError(
			`${resolved} must default-export an object mapping capability keys to functions.`,
			{
				exitCode: EXIT.usage,
				remediation:
					'export default {\n      "invoice.review": async (payload) => ({ approved: payload.amount < 10000 }),\n    };',
			},
		);
	}
	const handlers: HandlerModule = {};
	for (const [key, value] of Object.entries(
		exported as Record<string, unknown>,
	)) {
		if (typeof value !== "function") {
			throw new AgxCliError(
				`Handler "${key}" in ${resolved} is not a function.`,
				{ exitCode: EXIT.usage },
			);
		}
		handlers[key] = value as HandlerModule[string];
	}
	return handlers;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
	// Checked before the lock and the relays: a contradictory command line should
	// fail fast and touch nothing.
	const conflicts = noTasksConflicts(options);
	if (conflicts.length > 0) {
		throw new AgxCliError(
			`--no-tasks serves no capability, so it cannot be combined with ${conflicts.join(", ")}.`,
			{
				exitCode: EXIT.usage,
				remediation:
					"Drop --no-tasks to serve capabilities, or drop the flags above to only watch:\n    agx serve --no-reply --no-tasks --allowed-only --full-ids",
			},
		);
	}
	const tasksEnabled = options.tasks !== false;
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);
	const logger = makeLogger(options.verbose ?? false);
	const releaseLock = acquireLock(profileName);

	const state = loadState(profileName);
	if (options.resetCursor) {
		state.cursor = 0;
	}

	// Session `--allow` flags are additive to the persisted allowlist; both are
	// normalized to hex, because `authorize`'s `from` is a raw hex pubkey and an
	// npub in the set would simply never match.
	const sessionAllow = (options.allow ?? []).map((entry) => toHexPubkey(entry, "--allow value"));
	const allowed = new Set<string>();
	// `agx identity allow` and `agx held allow|block` edit the profile while this runs.
	function refreshAllowed(): void {
		const current = effectiveProfile(profileName).allow.map((entry) => toHexPubkey(entry, "allowlist entry"));
		allowed.clear();
		for (const entry of [...current, ...sessionAllow]) {
			allowed.add(entry);
		}
	}
	refreshAllowed();

	const transport = await createTransport(profile, identity, logger);
	const seen = new FileSeenStore(profileName);
	// Keeps what arrives, held senders' text included. Output below is unchanged.
	const store = new MessageStore(profileDir(profileName), undefined, { claimSpool: true });
	const collector = createCollector({
		store,
		allowed,
		onError: (error) => warn(`A message could not be stored and will be retried: ${error instanceof Error ? error.message : String(error)}`),
	});
	const stats = { ...state.stats };
	/** Replies sent per `${peer}:${contextId}`, for the process's lifetime. The
	 * local bound the SPEC requires alongside the sender-declared depth. */
	const repliesPerContext = new Map<string, number>();
	/** Ceiling on the automated-reply depth this responder will answer at. Lower
	 * than the SPEC's reference 8 because this is a demo echo responder — four
	 * exchanges is more than enough to show correlation working. */
	const maxAutoDepth = Number.parseInt(options.maxAutoDepth ?? "4", 10) || 4;
	/** Belt to that suspender: bounds a peer that never increments the depth. */
	const MAX_REPLIES_PER_CONTEXT = 20;

	function denyLine(from: string, capability: string): void {
		stats.denied += 1;
		const npub = toDisplayNpub(from);
		say(
			`${kleur.yellow("DENY ")} task ${kleur.bold(capability)} from ${shortNpub(npub)}`,
		);
		say(
			kleur.dim(
				"       not on this profile's allowlist — no reply was sent.",
			),
		);
		say(kleur.dim(`       allow this peer:  agx identity allow ${npub}`));
		say(
			kleur.dim(
				"       allow every peer: agx serve --allow-all   (accepts tasks from anyone)",
			),
		);
	}

	const client = new AgxClient({
		transport,
		seen,
		logger,
		identity: { org: profile.org ?? undefined, nip05: profile.nip05 },
		startCursor: state.cursor,
		// The sentinel, never `() => true` — the SPEC treats open access as a
		// deliberate opt-in, and the literal is what makes that legible.
		authorize: options.allowAll
			? "accept-all"
			: ({ from, capability }) => {
					if (allowed.has(from)) {
						say(
							`${kleur.green("ALLOW")} task ${kleur.bold(capability)} from ${shortNpub(toDisplayNpub(from))}`,
						);
						return true;
					}
					denyLine(from, capability);
					return false;
				},
		onMessage: async (msg: AgxIncomingMessage) => {
			stats.received += 1;
			const stored = collector.onMessage(msg);
			const npub = toDisplayNpub(msg.from);
			const isAllowed = allowed.has(msg.from);
			say("");
			// `--allowed-only` changes what is PRINTED, nothing else: a held message
			// is still counted, still recorded as seen, and still takes the reply
			// path below (so `--reply-any` still answers it).
			for (const line of renderInboundLines({
				fromNpub: npub,
				allowed: isAllowed,
				subject: msg.subject,
				contextId: msg.contextId,
				text: msg.text,
				allowedOnly: options.allowedOnly === true,
				fullIds: options.fullIds === true,
				held: stored,
			})) {
				say(line);
			}

			// A task-labelled message only reaches here when no handler consumed it.
			// `contentType` is peer-supplied, so this is a hint for the reader, not a
			// trust decision.
			const taskNote = unservedTaskNote(options, msg);
			if (taskNote) {
				say(kleur.dim(`       ${taskNote}`));
			}
			if (options.reply === false) {
				say(kleur.dim("       (--no-reply: observing only)"));
				return;
			}
			// `--no-tasks` means nothing is published in answer to a task request —
			// the plain echo reply included.
			if (taskNote) {
				return;
			}
			// Replies are allowlist-gated for the same reason denied task requests
			// get no reply: an agent that answers anyone is a reflector. `--reply-any`
			// is the explicit opt-out.
			if (!isAllowed && !options.replyAny) {
				say(
					kleur.yellow(
						"       not on the allowlist — no reply sent.",
					),
				);
				say(kleur.dim(`       allow: agx identity allow ${npub}`));
				return;
			}

			// Loop bound. Without one, two `agx serve` instances that allowlist each
			// other exchange messages forever — every reply is a fresh event, so the
			// seen store never fires, and both sides are behaving perfectly. This is
			// the reference auto-responder, so it has to demonstrate the rule rather
			// than the failure. NOTE: `--reply-any` bypasses the ALLOWLIST above; it
			// deliberately does not bypass this.
			const depth = msg.autoDepth ?? 0;
			if (depth >= maxAutoDepth) {
				say(
					kleur.yellow(
						`       automated-reply depth ${depth} reached its ceiling (${maxAutoDepth}) — no reply sent.`,
					),
				);
				say(
					kleur.dim(
						"       the message was still received; the ceiling bounds replies, not delivery.",
					),
				);
				return;
			}
			// `autoDepth` is sender-declared, so a peer that never increments it
			// would loop past the ceiling regardless. The SPEC requires a local bound
			// alongside it, and this is that bound.
			const threadKey = `${msg.from}:${msg.contextId}`;
			const sent = (repliesPerContext.get(threadKey) ?? 0) + 1;
			if (sent > MAX_REPLIES_PER_CONTEXT) {
				say(
					kleur.yellow(
						`       ${MAX_REPLIES_PER_CONTEXT} replies already sent on this conversation — no reply sent.`,
					),
				);
				return;
			}
			repliesPerContext.set(threadKey, sent);

			const text =
				options.replyText ??
				`Received: ${JSON.stringify(msg.text.slice(0, 120))} — acknowledged by agx CLI (${identity.npub}) at ${new Date().toISOString()}.`;
			// The inbound `contextId` is reused, never minted. A fresh one makes the
			// published event and the peer's filed thread row disagree, forking the
			// conversation — which reads as a bug in the platform, not in the demo.
			const res = await transport.publishMessage(msg.from, {
				text,
				subject: msg.subject ? `Re: ${msg.subject}` : null,
				contextId: msg.contextId,
				contentType: DEFAULT_CONTENT_TYPE,
				// This IS an automated reply, so it declares itself as one. A peer
				// that honours the ceiling will stop; one that does not is bounded by
				// the per-conversation cap above.
				autoDepth: depth + 1,
			});
			if (res.ok) {
				stats.replied += 1;
				say(
					`${kleur.green("REPLY")} → ${shortNpub(npub)}  ${kleur.dim(
						`event ${res.eventId.slice(0, 8)}  ${res.accepted ?? "?"}/${res.total ?? "?"} relays`,
					)}`,
				);
			} else {
				say(
					kleur.red(
						`REPLY failed: ${(res.errors ?? []).join("; ") || "no relay accepted the event"}`,
					),
				);
			}
		},
		onReceipt: (receipt: AgxIncomingReceipt) => {
			collector.onReceipt(receipt);
			say(
				`${kleur.green("ACK  ")} from ${shortNpub(toDisplayNpub(receipt.from))}  ${kleur.dim(
					`ref ${neutralizeControls(receipt.receipt.refEventId.slice(0, 8))}  ${receipt.receipt.status}`,
				)}`,
			);
		},
	});

	// A handler module turns this from a demo into an actual runtime binding: the
	// file default-exports `{ [capability]: (payload, task) => result }`, which is
	// the whole integration surface a runtime like Paperclip needs. Dispatch, the
	// task lifecycle, correlation, receipts and encryption stay the library's job.
	const handlers = await loadHandlerModule(options.handler);
	const capabilities = capabilitiesToServe(options, Object.keys(handlers));

	for (const capability of capabilities) {
		const custom = handlers[capability];
		client.handle(
			capability,
			async (task: Task<Record<string, unknown>>) => {
				stats.tasks += 1;
				// Under `--allow-all` a stranger's task runs; `--allowed-only` still
				// keeps what it wrote (payload, and a handler result that may echo it)
				// off stdout.
				const withhold =
					options.allowedOnly === true && !allowed.has(task.from);
				say(
					`${kleur.magenta("TASK ")} ${kleur.bold(task.capability)} from ${shortNpub(
						toDisplayNpub(task.from),
					)}  ${kleur.dim(`taskId ${neutralizeControls(task.taskId.slice(0, 8))}`)}`,
				);
				say(
					kleur.dim(
						withhold
							? "       payload withheld (sender not on the allowlist)"
							: `       payload ${oneLineJson(task.payload)}`,
					),
				);
				if (custom) {
					// Errors propagate to the library, which reports a THROWN error to
					// the peer generically as "handler failed" and logs the real one
					// here — an internal error must not leak across a trust boundary.
					// Throw `AgxPublicError` for a message meant for the peer.
					const output = await custom(task.payload, task);
					if (!withhold) {
						say(kleur.dim(`       → ${oneLineJson(output)}`));
					}
					return output;
				}
				// The built-in stand-in: enough to prove dispatch, honest about being
				// canned. `--handler` replaces it with real work.
				const amount = Number(task.payload?.amount ?? 0);
				return {
					ok: true,
					capability: task.capability,
					approved: amount > 0 ? amount < 10_000 : null,
					reviewedBy: identity.npub,
					note: "handled by the agx CLI reference handler",
				};
			},
		);
	}
	if (servesPing(options)) {
		client.handle(PING_CAPABILITY, async () => ({
			ok: true,
			agent: identity.npub,
			at: new Date().toISOString(),
		}));
	}

	heading("agx serve");
	kv("profile", profileName);
	kv("npub", identity.npub);
	kv("relays", profile.relays.join(", "));
	if (tasksEnabled) {
		kv("capabilities", client.capabilities().join(", "));
	} else {
		kv("tasks", "off (--no-tasks) — no typed request is answered");
	}
	kv(
		"authorize",
		!tasksEnabled
			? `allowlist (${allowed.size} peer${allowed.size === 1 ? "" : "s"}) — gates printing and replies only`
			: options.allowAll
				? "accept-all (EVERY peer may invoke a capability)"
				: `allowlist (${allowed.size} peer${allowed.size === 1 ? "" : "s"}) — default-deny`,
	);
	if (options.allowedOnly || options.fullIds) {
		kv(
			"messages",
			[
				options.allowedOnly
					? "allowed-only (text from senders off the allowlist is withheld)"
					: null,
				options.fullIds ? "full ids" : null,
			]
				.filter((mode): mode is string => mode !== null)
				.join(" · "),
		);
	}
	kv("cursor", state.cursor);
	if (options.allowAll) {
		warn(
			"--allow-all is set: any pubkey on these relays can invoke your capabilities.",
		);
	}
	if (tasksEnabled && allowed.size === 0 && !options.allowAll) {
		warn(
			"The allowlist is empty, so every task request will be denied. Add a peer with `agx identity allow <npub>`.",
		);
	}

	// `pollIntervalMs: 0` disables the library's own self-rescheduling loop so the
	// cursor can be persisted after each poll — `start()`'s internal loop offers no
	// per-pump hook, and an unpersisted cursor means a restart re-drains the inbox.
	const advertise = options.advertise === true;
	await client.start({ pollIntervalMs: 0, advertise });
	if (advertise) {
		info(
			"Published an Agent Card (kind 11337) and relay list (kind 10002). These are UNENCRYPTED.",
		);
		state.advertisedAt = new Date().toISOString();
	}
	say(kleur.dim("\nwatching for messages — Ctrl-C to stop\n"));

	const intervalMs = Number(options.pollInterval ?? 3000);
	let running = true;
	let draining = false;

	// Write ONLY the fields `serve` owns, merged onto freshly-read state. A blind
	// whole-object write from the snapshot loaded at startup would clobber
	// anything another command changed meanwhile — `agx register` stores the new
	// listing id, and a long-running serve would silently erase it on its next
	// poll.
	function persist(): void {
		// History before the seen-store: a crash in between re-delivers, and the store dedupes by id.
		store.absorbSpool();
		store.flush();
		seen.flush();
		updateState(profileName, {
			cursor: state.cursor,
			advertisedAt: state.advertisedAt,
			lastPumpAt: new Date().toISOString(),
			stats,
		});
	}

	async function shutdown(): Promise<void> {
		if (draining) {
			process.exit(EXIT.interrupted);
		}
		draining = true;
		running = false;
		say("");
		info("stopping…");
		// Relay operations time out at 8s; cap the drain so Ctrl-C always returns.
		const timer = setTimeout(() => {
			persist();
			releaseLock();
			process.exit(EXIT.interrupted);
		}, 10_000);
		timer.unref();
		await client.stop().catch(() => undefined);
		clearTimeout(timer);
		persist();
		releaseLock();
		say(
			`received ${stats.received} · replied ${stats.replied} · tasks ${stats.tasks} · denied ${stats.denied} · cursor ${state.cursor}`,
		);
		process.exit(EXIT.ok);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	while (running) {
		try {
			// Before the pump, so a receipt for a send made since the last poll finds its message.
			refreshAllowed();
			store.absorbSpool();
			const result = await client.pump();
			// Advance ONLY on a complete poll. An incomplete source may still hold
			// unseen events; advancing past them loses mail permanently.
			if (result.complete) {
				state.cursor = result.cursor;
			}
			persist();
		} catch (error) {
			say(
				kleur.red(
					`poll failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
		if (options.once) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	if (options.once) {
		await client.stop().catch(() => undefined);
		persist();
		releaseLock();
	}
}
