import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { normalizePubkey } from "@nostr-agx/nostr";
import { z } from "zod";
import { gatewaySubscriptionsPath, writePrivateJson } from "../paths.js";
import { mayHoldSecretKey } from "./http.js";

/**
 * Webhook subscriptions: where `agx gateway` delivers what arrives for this
 * agent, and on whose behalf it answers task requests.
 *
 * A subscription carries the same rules the AGX Trigger node enforces, and the
 * gateway — not the webhook — enforces them, so nothing reaches the webhook,
 * and no delivery receipt goes out, for an agent the subscription does not
 * allow. Authorization stays default-deny: no allowed agent and no `acceptAll`
 * means no task is ever run.
 *
 * Kept in the profile directory with each one's signing secret, so they
 * survive a restart: n8n registers a webhook once, when a workflow is turned
 * on, and expects it to stay registered.
 */

export const SUBSCRIPTION_EVENTS = ["task", "message", "receipt"] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

/** The longest capability name a task request may carry (`taskRequestSchema`). */
const MAX_CAPABILITY_CHARS = 200;
/** The most capabilities other agents accept on an Agent Card. */
const MAX_CARD_CAPABILITIES = 64;
/** How long the gateway holds a task open waiting for the webhook's answer. */
export const MAX_RESULT_TIMEOUT_SEC = 3600;
/** How far before a subscription was made a sender may date an event and
 * still have it delivered: clock skew, or a test message sent just before. */
export const START_GRACE_SEC = 300;

const storedSchema = z.object({
	id: z.string(),
	secret: z.string(),
	/** Unix seconds. Events dated before this, less the grace, are not delivered. */
	createdAt: z.number(),
	label: z.string().nullable(),
	url: z.string(),
	events: z.array(z.enum(SUBSCRIPTION_EVENTS)).min(1),
	capabilities: z.array(z.string()),
	acceptAll: z.boolean(),
	/** Hex public keys. */
	allowedPeers: z.array(z.string()),
	includeUnlisted: z.boolean(),
	/** Task requests sent longer ago than this are ignored, with no reply. 0: off. */
	maxTaskAgeSec: z.number(),
	resultTimeoutSec: z.number(),
	advertise: z.boolean(),
});
const fileSchema = z.object({
	version: z.literal(1),
	subscriptions: z.array(storedSchema).default([]),
});

export type Subscription = z.infer<typeof storedSchema>;
/** A subscription as the API shows it after creation: without its secret. */
export type SubscriptionView = Omit<Subscription, "secret">;

/** An IPv4 address a webhook may not point at: unspecified (0.0.0.0/8),
 * link-local (169.254.0.0/16, where cloud metadata services answer), or
 * multicast and reserved (224.0.0.0 and up). */
function isForbiddenIPv4(address: string): boolean {
	const [a, b] = address.split(".").map(Number);
	return a === 0 || (a === 169 && b === 254) || a >= 224;
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function ipv6Groups(address: string): number[] | null {
	let text = address;
	// A dotted IPv4 tail (`::ffff:1.2.3.4`) is the last two groups.
	const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (dotted) {
		const octets = dotted.slice(2).map(Number);
		if (octets.some((octet) => octet > 255)) {
			return null;
		}
		text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) {
		return null;
	}
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const gap = 8 - head.length - tail.length;
	if (halves.length === 1 ? gap !== 0 : gap < 1) {
		return null;
	}
	const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill("0"), ...tail];
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
		return null;
	}
	return groups.map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address an IPv6 one carries and reaches: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), IPv4-compatible
 * (`::a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`). */
function embeddedIPv4(groups: number[]): string | null {
	const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
	const mapped = zero(0, 5) && groups[5] === 0xffff;
	const translated = zero(0, 4) && groups[4] === 0xffff && groups[5] === 0;
	const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6);
	// `::` and `::1` are not IPv4 addresses, whatever their shape says.
	const compatible = zero(0, 6) && (groups[6] !== 0 || groups[7] > 1);
	if (!mapped && !translated && !nat64 && !compatible) {
		return null;
	}
	return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

/**
 * Addresses a webhook may not point at: link-local, where cloud metadata
 * services answer (169.254.169.254, fd00:ec2::254), unspecified, and multicast,
 * however an IPv6 address wraps them. Loopback and private networks stay
 * allowed, since n8n often runs on the same machine or network as the gateway.
 * Anything that is not an address at all is refused.
 */
export function isForbiddenAddress(address: string): boolean {
	const plain = address.replace(/%.*$/, "").toLowerCase();
	if (isIP(plain) === 4) {
		return isForbiddenIPv4(plain);
	}
	const groups = ipv6Groups(plain);
	if (!groups) {
		return true;
	}
	const v4 = embeddedIPv4(groups);
	if (v4) {
		return isForbiddenIPv4(v4);
	}
	return (
		groups.every((group) => group === 0) ||
		(groups[0] & 0xffc0) === 0xfe80 ||
		groups[0] >> 8 === 0xff ||
		(groups[0] === 0xfd00 && groups[1] === 0xec2 && groups.slice(2, 7).every((group) => group === 0) && groups[7] === 0x254)
	);
}

/**
 * Refuse a webhook URL whose host is, or resolves to, a forbidden address: an
 * API key would otherwise read a metadata service through a task the gateway
 * sends itself. Checked when the subscription is made; a host whose DNS
 * changes later is not caught, and one that does not resolve yet is allowed.
 */
export async function assertWebhookHost(rawUrl: string): Promise<void> {
	const { hostname } = new URL(rawUrl);
	const host = hostname.replace(/^\[|\]$/g, "");
	let addresses: string[];
	if (isIP(host)) {
		addresses = [host];
	} else {
		try {
			addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
		} catch {
			return;
		}
	}
	if (addresses.some(isForbiddenAddress)) {
		throw new SubscriptionError(
			`Invalid subscription: ${hostname} is a link-local, multicast or unspecified address, which a webhook may not use`,
		);
	}
}

/** A rejected subscription request, with a message fit to show the user. */
export class SubscriptionError extends Error {}

const inputSchema = z.object({
	url: z.string().max(2048),
	label: z.string().max(200).nullish(),
	events: z.array(z.enum(SUBSCRIPTION_EVENTS)).min(1).max(3),
	capabilities: z.array(z.string().max(1000)).max(1000).default([]),
	acceptAll: z.boolean().default(false),
	allowedPeers: z.array(z.string().max(200)).max(10_000).default([]),
	includeUnlisted: z.boolean().default(false),
	maxTaskAgeSec: z.number().int().min(0).max(7 * 24 * 3600).default(600),
	resultTimeoutSec: z.number().int().min(1).max(MAX_RESULT_TIMEOUT_SEC).default(120),
	advertise: z.boolean().default(false),
});

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/** Check and normalize a subscription request. Throws `SubscriptionError`. */
export function parseSubscriptionInput(
	body: unknown,
): Omit<Subscription, "id" | "secret" | "createdAt"> {
	const parsed = inputSchema.safeParse(body);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new SubscriptionError(
			`Invalid subscription: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "malformed"}`,
		);
	}
	const input = parsed.data;
	// Kept in the subscriptions file, shown back and logged: a key has no place in either.
	if (mayHoldSecretKey(input.url)) {
		throw new SubscriptionError(
			"Invalid subscription: url holds a secret key (nsec1…), which is not shown here",
		);
	}
	if (mayHoldSecretKey(input.label ?? "")) {
		throw new SubscriptionError(
			"Invalid subscription: label holds a secret key (nsec1…), which is not shown here",
		);
	}
	let url: URL;
	try {
		url = new URL(input.url);
	} catch {
		throw new SubscriptionError(`Invalid subscription: url is not a URL: ${input.url}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new SubscriptionError("Invalid subscription: url must be http(s)");
	}
	const events = [...new Set(input.events)];
	const serveTasks = events.includes("task");
	const capabilities = serveTasks
		? [...new Set(input.capabilities.map((c) => c.trim()).filter(Boolean))]
		: [];
	if (serveTasks && capabilities.length === 0) {
		throw new SubscriptionError("Name the capabilities this webhook serves, such as invoice.review");
	}
	// A capability goes onto the Agent Card, which anyone can read.
	if (capabilities.some(mayHoldSecretKey)) {
		throw new SubscriptionError(
			"A capability must be a name such as invoice.review, not a secret key (nsec1…), which is not shown here",
		);
	}
	// The client runs a handler for exactly the capability it was registered
	// under, so `invoice.*` would be advertised and never served.
	const wildcards = capabilities.filter((c) => c.includes("*"));
	if (wildcards.length > 0) {
		throw new SubscriptionError(`List each capability by name: ${wildcards.join(", ")} cannot be served`);
	}
	const tooLong = capabilities.filter((c) => c.length > MAX_CAPABILITY_CHARS);
	if (tooLong.length > 0) {
		throw new SubscriptionError(`Capability names can be at most ${MAX_CAPABILITY_CHARS} characters`);
	}
	if (input.advertise && capabilities.length > MAX_CARD_CAPABILITIES) {
		throw new SubscriptionError(
			`An Agent Card can list at most ${MAX_CARD_CAPABILITIES} capabilities, and this webhook serves ${capabilities.length}`,
		);
	}
	const allowedPeers: string[] = [];
	const invalid: string[] = [];
	for (const entry of input.allowedPeers) {
		const hex = normalizePubkey(entry.trim());
		if (hex) {
			allowedPeers.push(hex);
		} else if (entry.trim()) {
			invalid.push(mayHoldSecretKey(entry) ? "(a secret key, not shown)" : entry.trim());
		}
	}
	if (invalid.length > 0) {
		throw new SubscriptionError(
			`These are not npub1… keys or 64-character hex public keys: ${invalid.join(", ")}`,
		);
	}
	const reachable =
		input.acceptAll ||
		allowedPeers.length > 0 ||
		(!serveTasks && input.includeUnlisted);
	if (!reachable) {
		throw new SubscriptionError(
			"No agent is allowed to reach this webhook: AGX denies everyone by default. Allow some agents, or accept all of them.",
		);
	}
	return {
		label: input.label ?? null,
		url: url.toString(),
		events,
		capabilities,
		acceptAll: input.acceptAll,
		allowedPeers: [...new Set(allowedPeers)],
		includeUnlisted: input.includeUnlisted,
		maxTaskAgeSec: input.maxTaskAgeSec,
		resultTimeoutSec: input.resultTimeoutSec,
		advertise: input.advertise,
	};
}

export function viewOf(subscription: Subscription): SubscriptionView {
	const { secret: _secret, ...view } = subscription;
	return view;
}

/** A subscription that would take an event, and whether it allows the sender. */
export interface Recipient {
	subscription: Subscription;
	allowed: boolean;
}

export class SubscriptionStore {
	private subscriptions: Subscription[];

	constructor(private readonly profile: string) {
		const path = gatewaySubscriptionsPath(profile);
		if (!existsSync(path)) {
			this.subscriptions = [];
			return;
		}
		const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.success) {
			throw new Error(`${path} is not a gateway subscription file this version can read`);
		}
		this.subscriptions = parsed.data.subscriptions;
	}

	/** On disk first, then in memory: a write that fails (a full disk) leaves
	 * the gateway as it was, not serving a subscription that will not survive a
	 * restart. */
	private replace(subscriptions: Subscription[]): void {
		writePrivateJson(gatewaySubscriptionsPath(this.profile), { version: 1, subscriptions });
		this.subscriptions = subscriptions;
	}

	list(): Subscription[] {
		return [...this.subscriptions];
	}

	get(id: string): Subscription | undefined {
		return this.subscriptions.find((s) => s.id === id);
	}

	create(input: Omit<Subscription, "id" | "secret" | "createdAt">): Subscription {
		const subscription: Subscription = {
			...input,
			id: `sub_${randomBytes(8).toString("hex")}`,
			secret: randomBytes(32).toString("base64url"),
			createdAt: nowSec(),
		};
		this.replace([...this.subscriptions, subscription]);
		return subscription;
	}

	delete(id: string): boolean {
		const kept = this.subscriptions.filter((s) => s.id !== id);
		if (kept.length === this.subscriptions.length) {
			return false;
		}
		this.replace(kept);
		return true;
	}

	/** Every capability some subscription serves. */
	capabilities(): string[] {
		return [...new Set(this.subscriptions.flatMap((s) => s.capabilities))];
	}

	/** The capabilities the Agent Card lists: those of subscriptions that advertise. */
	advertised(): string[] {
		return [
			...new Set(this.subscriptions.filter((s) => s.advertise).flatMap((s) => s.capabilities)),
		].sort();
	}

	/**
	 * The subscriptions that would run a task request for `capability` from
	 * `from`, newest first: the newest is tried first, and an older one only when
	 * its webhook cannot be reached (a test webhook n8n has dropped, say). With
	 * `sentAt`, those for which the request is too old, or older than the
	 * subscription, are left out.
	 */
	forTask(capability: string, from: string, sentAt?: number, now = nowSec()): Subscription[] {
		return this.subscriptions
			.filter(
				(s) =>
					s.events.includes("task") &&
					s.capabilities.includes(capability) &&
					(s.acceptAll || s.allowedPeers.includes(from)) &&
					(sentAt === undefined ||
						(sentAt >= s.createdAt - START_GRACE_SEC &&
							(s.maxTaskAgeSec === 0 || now - sentAt <= s.maxTaskAgeSec))),
			)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	/** The subscriptions a message or receipt from `from`, dated `sentAt`, goes to. */
	forEvent(kind: "message" | "receipt", from: string, sentAt: number): Recipient[] {
		const out: Recipient[] = [];
		for (const subscription of this.subscriptions) {
			if (!subscription.events.includes(kind) || sentAt < subscription.createdAt - START_GRACE_SEC) {
				continue;
			}
			const allowed = subscription.acceptAll || subscription.allowedPeers.includes(from);
			if (allowed || subscription.includeUnlisted) {
				out.push({ subscription, allowed });
			}
		}
		return out;
	}
}
