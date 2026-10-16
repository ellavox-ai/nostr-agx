import { chmodSync, existsSync } from "node:fs";
import { GIFT_WRAP_KIND } from "@nostr-agx/nostr";
import kleur from "kleur";
import WebSocket from "ws";
import { createApiClient, toCliError } from "../lib/api.js";
import {
	effectiveProfile,
	type ResolvedApiCredentials,
	resolveApiCredentials,
	resolveProfileName,
} from "../lib/config.js";
import { inspectLock, loadPendingLogin } from "../lib/device-flow.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { loadIdentityFile } from "../lib/identity.js";
import { heading, json, say } from "../lib/output.js";
import {
	agxHome,
	configPath,
	credentialsPath,
	identityPath,
	isTooPermissive,
	pendingLoginLockPath,
	pendingLoginPath,
	removePrivateFile,
} from "../lib/paths.js";
import { runtime } from "../lib/runtime.js";
import { loadState } from "../lib/state.js";

/** A login closer to expiry than this is worth a warning. */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Preflight. The things that silently break this workflow — an index that is
 * not running, a relay nobody is running, a listing nobody can find — produce
 * no error that names the cause. Each check therefore carries the exact command
 * that fixes it.
 */

export interface DoctorOptions {
	profile?: string;
	fixPerms?: boolean;
}

type Verdict = "pass" | "warn" | "fail";

/** "Start it" advice is only useful when the target really is on this machine;
 * against a real deployment it would just be noise. */
function isLocalTarget(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "::1";
	} catch {
		return false;
	}
}

interface Check {
	name: string;
	verdict: Verdict;
	detail: string;
	remediation?: string;
}

function render(check: Check): void {
	const badge =
		check.verdict === "pass"
			? kleur.green("PASS")
			: check.verdict === "warn"
				? kleur.yellow("WARN")
				: kleur.red("FAIL");
	say(`${badge}  ${check.name}`);
	if (check.detail) {
		say(kleur.dim(`      ${check.detail}`));
	}
	if (check.remediation) {
		for (const line of check.remediation.split("\n")) {
			say(kleur.dim(`      → ${line}`));
		}
	}
}

async function probeHttp(
	url: string,
	timeoutMs = 4000,
): Promise<number | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		return res.status;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** An author that matches nothing, so the probe's REQ returns EOSE immediately
 * rather than scanning. It exists to satisfy a relay's `requireAuthorOrTag`
 * filter validation, not to look anything up. */
const PROBE_AUTHOR =
	"0000000000000000000000000000000000000000000000000000000000000000";

interface RelayProbe {
	verdict: Verdict;
	/** The relay's own words: why it CLOSED the probe (a refusal), or the last
	 * NOTICE it sent when no EOSE ever came (a hint, not a verdict). */
	reason?: string;
	/** What `reason` is — they read very differently:
	 * - `closed`: the relay refused our subscription;
	 * - `auth`: it refused pending NIP-42 AUTH, which this probe never answers;
	 * - `dropped`: it hung up before answering;
	 * - `notice`: its last NOTICE, explaining a timeout. */
	reasonKind?: "closed" | "auth" | "dropped" | "notice";
}

/** A relay frame's human-readable text, or a stand-in when it sent none. */
function frameText(value: unknown): string {
	return typeof value === "string" && value.length > 0
		? value
		: "(no reason given)";
}

/** A relay is healthy when it answers a REQ with EOSE, not merely when the socket
 * opens — an HTTP server on the port would pass a connect-only check. */
function probeRelay(url: string, timeoutMs = 4000): Promise<RelayProbe> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (result: RelayProbe) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				try {
					socket.close();
				} catch {
					// already closing
				}
				resolve(result);
			}
		};
		// A NOTICE is connection-scoped, not about our REQ: a banner or a
		// rate-limit notice can arrive before a perfectly good EOSE. So it never
		// settles the probe; it is held and only spent if the timer runs out, to
		// explain the silence.
		let lastNotice: string | undefined;
		const timer = setTimeout(
			() =>
				done(
					lastNotice === undefined
						? { verdict: "warn" }
						: {
								verdict: "warn",
								reason: lastNotice,
								reasonKind: "notice",
							},
				),
			timeoutMs,
		);
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			clearTimeout(timer);
			resolve({ verdict: "fail" });
			return;
		}
		socket.on("open", () => {
			// Shaped to survive a relay running strict filter validation: exactly
			// one author, and a kind on the exchange's allow-list. A bare
			// `{ limit: 0 }` is the maximally open filter, which such a relay
			// answers with CLOSED rather than EOSE — so this probe would report
			// every hardened relay as degraded. The all-zero author matches
			// nothing, so EOSE still comes back immediately and cheaply.
			//
			// `limit: 1`, not 0: the same shape as a relay deploy smoke test.
			// A zero limit is not a filter every
			// relay answers with EOSE, and a probe that sends something the deploy
			// gate never does can report a healthy relay as degraded.
			socket.send(
				JSON.stringify([
					"REQ",
					"agx-doctor",
					{
						kinds: [GIFT_WRAP_KIND],
						authors: [PROBE_AUTHOR],
						limit: 1,
					},
				]),
			);
		});
		socket.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (!Array.isArray(msg)) {
					return;
				}
				if (msg[0] === "EOSE" && msg[1] === "agx-doctor") {
					done({ verdict: "pass" });
				} else if (msg[0] === "CLOSED" && msg[1] === "agx-doctor") {
					// A refusal of OUR subscription is an answer, not silence: report
					// it with the relay's own reason instead of waiting out the timer
					// and blaming the relay for not speaking NIP-01.
					//
					// `auth-required:` is the one refusal that does NOT mean the relay
					// is unusable: this probe is deliberately unauthenticated, while
					// every real call answers the NIP-42 challenge (relay-pool.ts
					// auto-answers AUTH with a signer and lists `auth-required:` among
					// its refusal prefixes). Failing it would report a relay `agx card`
					// reads and writes through as broken.
					const reason = frameText(msg[2]);
					const needsAuth = reason
						.trim()
						.toLowerCase()
						.startsWith("auth-required:");
					done({
						verdict: needsAuth ? "warn" : "fail",
						reason,
						reasonKind: needsAuth ? "auth" : "closed",
					});
				} else if (msg[0] === "NOTICE") {
					lastNotice = frameText(msg[1]);
				}
			} catch {
				// ignore non-JSON frames
			}
		});
		socket.on("error", () => {
			done({ verdict: "fail" });
		});
		// Hung up before answering: an answer of sorts, not silence, for the same
		// reason as CLOSED above — without this the timer runs out and the relay
		// is reported as "may not be a NIP-01 relay". `done` is idempotent, so the
		// close our own `socket.close()` triggers is a no-op, and a failed connect
		// fires `error` first ("unreachable", with the `agx relay` remediation).
		// Worded the way a relay smoke test reports it ("socket closed before EOSE").
		socket.on("close", (code: number) => {
			done({
				verdict: "fail",
				reason: `code ${code}`,
				reasonKind: "dropped",
			});
		});
	});
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const checks: Check[] = [];

	// 1. Permissions on the files holding a secret key and a bearer credential.
	const permTargets = [
		configPath(),
		credentialsPath(),
		identityPath(profileName),
		pendingLoginPath(profileName),
	].filter(existsSync);
	const loose = permTargets.filter(isTooPermissive);
	if (options.fixPerms) {
		for (const path of loose) {
			chmodSync(path, 0o600);
		}
	}
	checks.push(
		loose.length === 0 || options.fixPerms
			? {
					name: "file permissions",
					verdict: "pass",
					detail: `${agxHome()} — secrets are owner-only${options.fixPerms && loose.length > 0 ? " (repaired)" : ""}`,
				}
			: {
					name: "file permissions",
					verdict: "fail",
					detail: `readable by other users: ${loose.join(", ")}`,
					remediation: `chmod 600 ${loose.join(" ")}\n(or: agx doctor --fix-perms)`,
				},
	);

	// 2. Identity.
	let npub: string | null = null;
	try {
		npub = loadIdentityFile(profileName, { allowInsecurePerms: true }).npub;
		checks.push({
			name: "identity",
			verdict: "pass",
			detail: `${npub} (profile "${profileName}")`,
		});
	} catch {
		checks.push({
			name: "identity",
			verdict: "fail",
			detail: `profile "${profileName}" has no identity`,
			remediation: "agx identity new",
		});
	}

	// 3. Relays.
	for (const relay of profile.relays) {
		const { verdict, reason, reasonKind } = await probeRelay(relay);
		checks.push({
			name: `relay ${relay}`,
			verdict,
			detail:
				verdict === "pass"
					? "connected and answered a REQ with EOSE"
					: reasonKind === "closed"
						? `connected, but refused the probe: ${reason}`
						: reasonKind === "auth"
							? `connected; reads need NIP-42 auth, which this probe does not answer (real clients do): ${reason}`
							: reasonKind === "dropped"
								? `connected, but the relay closed the connection before answering (${reason})`
								: reasonKind === "notice"
									? `connected but sent no EOSE; its last notice: ${reason}`
									: verdict === "warn"
										? "connected but sent no EOSE — it may not be a NIP-01 relay"
										: "unreachable",
			remediation:
				verdict === "fail" && reasonKind === undefined
					? "agx relay\n(run it in another terminal and leave it running)"
					: undefined,
		});
	}

	// 4. The index API. Probing `/api/docs` rather than `/api/rpc`: the RPC mount
	// matches on "/rpc/" WITH a trailing slash, so a bare path never matches and
	// would look like an outage.
	const apiStatus = await probeHttp(`${profile.apiBaseUrl}/api/docs`);
	checks.push(
		apiStatus === null
			? {
					name: "index",
					verdict: "fail",
					detail: `no response from ${profile.apiBaseUrl}`,
					remediation: isLocalTarget(profile.apiBaseUrl)
						? `Start the agent index at ${profile.apiBaseUrl}, then re-run:\n    agx doctor`
						: "Check the API is running and that apiBaseUrl is correct:\n    agx config show",
				}
			: {
					name: "index",
					verdict: "pass",
					detail: `${profile.apiBaseUrl} responded (${apiStatus})`,
				},
	);

	// 5. API credentials: where the key comes from, that it may be sent to this
	// server at all, that it is not about to expire, and that the server takes it.
	let creds: ResolvedApiCredentials | null = null;
	try {
		creds = resolveApiCredentials(profileName);
	} catch (error) {
		if (!(error instanceof AgxCliError)) {
			throw error;
		}
		checks.push({
			name: "api credentials",
			verdict: "fail",
			detail: error.message,
			remediation: error.remediation ?? "agx login",
		});
	}
	if (creds) {
		const sourceLabel =
			creds.source === "env"
				? "AGX_API_KEY"
				: creds.source === "legacy-config"
					? "config.json (0.3 key)"
					: `credentials.json (${creds.source})`;
		checks.push({
			name: "credential source",
			verdict: creds.source === "legacy-config" ? "warn" : "pass",
			detail: `${sourceLabel}${creds.entry?.organization ? `, org "${creds.entry.organization.slug}"` : ""}`,
			remediation:
				creds.source === "legacy-config"
					? "This key predates agx login and has no expiry or scope. Replace it:\n    agx login"
					: undefined,
		});
		const expiresAt = creds.entry?.expiresAt
			? Date.parse(creds.entry.expiresAt)
			: Number.NaN;
		if (
			Number.isFinite(expiresAt) &&
			expiresAt - runtime().now() < EXPIRY_WARNING_MS
		) {
			checks.push({
				name: "login expiry",
				verdict: "warn",
				detail: `the login expires on ${creds.entry?.expiresAt}`,
				remediation: "agx login --force",
			});
		}
	}
	const pending = loadPendingLogin(profileName);
	if (pending && Date.parse(pending.expiresAt) <= runtime().now()) {
		checks.push({
			name: "pending login",
			verdict: "warn",
			detail: `an unfinished login code expired at ${pending.expiresAt}`,
			remediation: "agx login",
		});
	}
	// A poll lock nobody holds any more (a crash, a reused pid). agx login
	// takes such a lock over by itself; this names it, and --fix-perms clears it.
	const loginLock = pendingLoginLockPath(profileName);
	const lock = inspectLock(loginLock);
	if (lock?.stale) {
		const who = lock.pid !== null ? `agx process ${lock.pid}` : "an agx process";
		const holder = lock.at ? `${who}, last heartbeat ${lock.at}` : who;
		if (options.fixPerms) {
			removePrivateFile(loginLock);
			checks.push({
				name: "login lock",
				verdict: "pass",
				detail: `removed ${loginLock}, abandoned by ${holder}`,
			});
		} else {
			checks.push({
				name: "login lock",
				verdict: "warn",
				detail: `${loginLock} was abandoned by ${holder}`,
				remediation: "agx doctor --fix-perms   (removes it; agx login also takes it over)",
			});
		}
	}
	if (creds && apiStatus !== null) {
		try {
			const client = createApiClient(creds);
			const result = await client.agentIndex.searchListings({
				orgSlug: creds.orgSlug,
				limit: 1,
			});
			checks.push({
				name: "api credentials",
				verdict: "pass",
				detail: `key accepted for org "${creds.orgSlug}" (${result.total} listing(s) visible)`,
			});
		} catch (error) {
			// Through toCliError, never the raw message: a transport error can
			// quote the key (undici does, for a header it refuses).
			const mapped = toCliError(error, "searchListings", creds.baseUrl);
			checks.push({
				name: "api credentials",
				verdict: "fail",
				detail: mapped.message,
				remediation: /does not have access to this organization/i.test(
					mapped.message,
				)
					? `A key is bound to a single organization. Log in to "${creds.orgSlug}":\n    agx login --org ${creds.orgSlug}`
					: (mapped.remediation ?? "agx login"),
			});
		}
	}

	// 6. Listing health — the two states that make discovery silently return nothing.
	const state = loadState(profileName);
	if (state.listingId && creds && apiStatus !== null) {
		try {
			const client = createApiClient(creds);
			const { listing } = await client.agentIndex.getListing({
				orgSlug: creds.orgSlug,
				listingId: state.listingId,
			});
			if (npub && listing.npub !== npub) {
				checks.push({
					name: "listing",
					verdict: "fail",
					detail: `listing ${listing.id} is bound to ${listing.npub}, but this profile's identity is ${npub}`,
					remediation:
						"A listing's address is immutable. Register a new one, or switch profiles:\n    agx config use <profile>",
				});
			} else if (listing.status !== "listed") {
				checks.push({
					name: "listing",
					verdict: "warn",
					detail: `listing ${listing.id} is "${listing.status}" — not discoverable yet`,
					remediation: "agx listing publish",
				});
			} else if (listing.visibility !== "public") {
				checks.push({
					name: "listing",
					verdict: "warn",
					detail: `listing ${listing.id} is listed but "${listing.visibility}" — directory search returns public entries only`,
					remediation: "agx listing set-visibility public",
				});
			} else if (listing.capabilities.length === 0) {
				checks.push({
					name: "listing",
					verdict: "warn",
					detail: "no capabilities declared; publishing will be refused",
					remediation:
						"agx listing set-policy --capability invoice.review",
				});
			} else {
				checks.push({
					name: "listing",
					verdict: "pass",
					detail: `${listing.id} — listed, public, ${listing.capabilities.join(", ")}`,
				});
			}
		} catch {
			checks.push({
				name: "listing",
				verdict: "warn",
				detail: `stored listing ${state.listingId} could not be read`,
				remediation: "agx listing list",
			});
		}
	}

	// 7. NIP-05, only when it is configured and can never work.
	if (profile.nip05) {
		const domain = profile.nip05.split("@")[1] ?? "";
		if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(domain)) {
			checks.push({
				name: "nip-05",
				verdict: "warn",
				detail: `"${profile.nip05}" can never verify — the resolver blocks localhost and private addresses (SSRF guard, no bypass)`,
				remediation:
					"cloudflared tunnel --url http://localhost:3000\nagx config set nip05 bot@<tunnel-host>\nagx domain add <tunnel-host> && agx domain verify <domainId>",
			});
		}
	}

	heading("agx doctor");
	for (const check of checks) {
		render(check);
	}
	json({ checks });

	const failed = checks.filter((c) => c.verdict === "fail");
	say("");
	if (failed.length === 0) {
		say(kleur.green(`${checks.length} check(s) passed.`));
		return;
	}
	throw new AgxCliError(
		`${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`,
		{ exitCode: EXIT.config },
	);
}
