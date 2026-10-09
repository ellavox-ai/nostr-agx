import { hostname } from "node:os";
import kleur from "kleur";
import { createApiClient, isKeyRejected, toCliError } from "../lib/api.js";
import { openBrowser, shouldOpenBrowser } from "../lib/browser.js";
import {
	assertApiBaseUrl,
	DEFAULT_API_BASE_URL,
	getProfile,
	LEGACY_DEFAULT_API_BASE_URL,
	resolveProfileName,
	updateProfile,
} from "../lib/config.js";
import {
	type CredentialEntry,
	getCredential,
	isExpired,
	originOf,
	setCredential,
} from "../lib/credentials.js";
import {
	AGX_CLIENT_ID,
	AGX_SCOPE_STRING,
	inspectLock,
	type LockInfo,
	type LoginRequest,
	loadPendingLogin,
	type PendingLogin,
	type PollOutcome,
	pollDeviceToken,
	removePendingLogin,
	requestDeviceCode,
	savePendingLogin,
	tryAcquireLock,
} from "../lib/device-flow.js";
import {
	type ActionRequired,
	AgxCliError,
	authError,
	EXIT,
	HumanActionRequiredError,
	usageError,
} from "../lib/errors.js";
import {
	emitStderrJson,
	isJsonMode,
	json,
	maskEmail,
	notice,
	ok,
	say,
} from "../lib/output.js";
import { pendingLoginLockPath } from "../lib/paths.js";
import { runtime } from "../lib/runtime.js";
import { isWellFormedApiKey, rememberSecret } from "../lib/secrets.js";

/**
 * `agx login`: the device authorization flow (LOGIN-CONTRACT.md §1.2–§1.4,
 * §1.8).
 *
 * The CLI asks the server for a code, a human approves it in the browser
 * (signing up, picking or creating the org), and the CLI's poll receives a
 * scoped, expiring key exactly once. The key goes straight to
 * `credentials.json` and is never printed. Nothing a harness reads — stdout,
 * stderr, exit codes — contains it or the device code.
 */

export interface LoginOptions {
	profile?: string;
	json?: boolean;
	apiBaseUrl?: string;
	org?: string;
	newOrg?: boolean;
	orgName?: string;
	orgSlug?: string;
	/** `false` under `--no-browser`. */
	browser?: boolean;
	/** `false` under `--no-wait`. */
	wait?: boolean;
	force?: boolean;
}

/** What `agx login --json` prints on success (LOGIN-CONTRACT.md §1.8). Never
 * the key. */
export interface LoginResult {
	loggedIn: true;
	alreadyLoggedIn: boolean;
	profile: string;
	apiBaseUrl: string;
	user: { id: string; email: string | null } | null;
	organization: { id: string; slug: string; name: string } | null;
	requestedOrg: string | null;
	scopes: string[];
	expiresAt: string | null;
	apiKeyId: string | null;
}

/**
 * `--api-base-url` > `AGX_API_URL` > the profile's (unless it is still the 0.3
 * default `http://localhost:3000`, which every 0.3 profile stored without
 * anyone choosing it) > {@link DEFAULT_API_BASE_URL}.
 */
export function resolveLoginBaseUrl(
	profileName: string,
	flag: string | undefined,
): string {
	if (flag) {
		return assertApiBaseUrl(flag, {
			exitCode: EXIT.usage,
			label: "--api-base-url",
		});
	}
	const env = process.env.AGX_API_URL;
	if (env) {
		return assertApiBaseUrl(env, { label: "AGX_API_URL" });
	}
	const stored = getProfile(profileName).apiBaseUrl;
	if (stored && stored.replace(/\/+$/, "") !== LEGACY_DEFAULT_API_BASE_URL) {
		return assertApiBaseUrl(stored, {
			label: `apiBaseUrl of profile "${profileName}"`,
		});
	}
	return DEFAULT_API_BASE_URL;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function minutesLeft(seconds: number): string {
	if (seconds < 90) {
		return `${Math.max(0, seconds)} s`;
	}
	return `${Math.round(seconds / 60)} min`;
}

/** The `actionRequired` for a pending login, with `expiresIn` counted from now. */
export function loginActionRequired(
	pending: PendingLogin,
	now: number,
): ActionRequired {
	return {
		reason: "LOGIN_APPROVAL_REQUIRED",
		url: pending.verificationUriComplete,
		userCode: pending.userCode,
		expiresIn: Math.max(
			0,
			Math.floor((Date.parse(pending.expiresAt) - now) / 1000),
		),
		expiresAt: pending.expiresAt,
		verificationUri: pending.verificationUri,
	};
}

/**
 * The command a remediation tells a person to re-run: the same mode as this
 * run, so a harness that drives `--no-wait` is never pointed at the blocking
 * form (which would sit polling inside the harness).
 */
function rerunCommand(wait: boolean): string {
	return wait ? "agx login" : "agx login --no-wait";
}

/**
 * How long after a pending code expired a `--no-wait` re-run still reports
 * THAT code as expired (exit 4) instead of starting over. The server keeps a
 * code's row this long after expiry (LOGIN-CONTRACT.md §1.3), so within it the
 * run is plausibly the harness following up on the code it showed a person; a
 * pending file older than that was abandoned in an earlier session, and the
 * run requests a fresh code (exit 7) as a first run would.
 */
export const RECENTLY_EXPIRED_MS = 24 * 60 * 60 * 1000;

function stillPendingError(action: ActionRequired): HumanActionRequiredError {
	return new HumanActionRequiredError(
		`This login needs approval in the browser. Open the link and check the code (expires in ${minutesLeft(action.expiresIn ?? 0)}):`,
		action,
		`Once it is approved, re-run the same command to finish:\n    ${rerunCommand(false)}`,
	);
}

function sameRequest(a: LoginRequest, b: LoginRequest): boolean {
	return (
		a.orgHint === b.orgHint &&
		a.newOrg === b.newOrg &&
		a.newOrgName === b.newOrgName &&
		a.newOrgSlug === b.newOrgSlug
	);
}

function sameOrigin(a: string, b: string): boolean {
	const left = originOf(a);
	return left !== null && left === originOf(b);
}

/** Did another agx process store a login for this code while we waited? */
function finishedElsewhere(
	profileName: string,
	base: string,
	pending: PendingLogin,
): CredentialEntry | null {
	const entry = getCredential(profileName);
	if (
		entry &&
		entry.source === "login" &&
		entry.apiKeyId !== pending.replacesApiKeyId &&
		sameOrigin(entry.apiBaseUrl, base) &&
		Date.parse(entry.createdAt) >= Date.parse(pending.createdAt)
	) {
		return entry;
	}
	return null;
}

function pendingStillThere(profileName: string, pending: PendingLogin): boolean {
	return loadPendingLogin(profileName)?.deviceCode === pending.deviceCode;
}

/** Signals that stop a waiting login cleanly instead of killing it mid-poll. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** How long a `--no-wait` run waits for another process's poll to finish. */
const NO_WAIT_LOCK_PATIENCE_MS = 20_000;
const LOCK_RETRY_MS = 1_000;

/**
 * Poll the code while holding the per-profile lock, so two `agx login` runs
 * never poll the same code. A run that finds the lock taken waits for the
 * holder, then reports what it achieved. `once` is a `--no-wait` run; `rerun`
 * is the command its remediations quote.
 */
async function pollWithLock(
	profileName: string,
	base: string,
	pending: PendingLogin,
	once: boolean,
	rerun: string,
	signal: AbortSignal,
): Promise<
	| PollOutcome
	| { kind: "finished"; entry: CredentialEntry }
	| {
			kind: "locked";
			pending: PendingLogin;
			lockPath: string;
			lock: LockInfo | null;
	  }
> {
	const rt = runtime();
	const lockPath = pendingLoginLockPath(profileName);
	let lock = tryAcquireLock(lockPath);
	const patienceUntil =
		rt.now() + pending.interval * 1000 + NO_WAIT_LOCK_PATIENCE_MS;
	let waited = false;
	while (!lock) {
		waited = true;
		const done = finishedElsewhere(profileName, base, pending);
		if (done) {
			return { kind: "finished", entry: done };
		}
		if (!pendingStillThere(profileName, pending)) {
			throw endedElsewhereError(rerun);
		}
		if (rt.now() >= Date.parse(pending.expiresAt)) {
			throw authError(
				"The login code expired before it was approved.",
				`Run the same command again for a fresh code:\n    ${rerun}`,
			);
		}
		if (once && rt.now() >= patienceUntil) {
			// Another process holds the lock and has not finished: say who.
			return {
				kind: "locked",
				pending,
				lockPath,
				lock: inspectLock(lockPath),
			};
		}
		try {
			await rt.sleep(LOCK_RETRY_MS, signal);
		} catch {
			throw interruptedError();
		}
		lock = tryAcquireLock(lockPath);
	}
	const held = lock;
	try {
		const done = finishedElsewhere(profileName, base, pending);
		if (done) {
			return { kind: "finished", entry: done };
		}
		const fresh = loadPendingLogin(profileName);
		if (!fresh || fresh.deviceCode !== pending.deviceCode) {
			throw endedElsewhereError(rerun);
		}
		if (once && waited) {
			// The other process just spent this code's poll; polling again now
			// would only earn a slow_down.
			return { kind: "pending", pending: fresh };
		}
		return await pollDeviceToken(
			base,
			fresh,
			{
				once,
				rerun,
				persist: (next) => savePendingLogin(profileName, next),
				recover: () => finishedElsewhere(profileName, base, fresh) !== null,
				heartbeat: (nextGapMs) => {
					held.heartbeat(nextGapMs);
				},
			},
			{ signal },
		);
	} finally {
		held.release();
	}
}

function endedElsewhereError(rerun: string): AgxCliError {
	return authError(
		"This login ended in another agx process without a key (denied or expired).",
		`Run the same command again for a fresh code:\n    ${rerun}`,
	);
}

/** Stderr, `--json` or not (the exit-7 JSON carries no remediation): which
 * process holds the lock, and the file, so a person can clear a dead one. */
function noticeLockHolder(lockPath: string, lock: LockInfo | null): void {
	notice(
		`Another agx process${lock?.pid ? ` (pid ${lock.pid})` : ""} is polling this login code and holds ${lockPath}${lock?.at ? ` (last heartbeat ${lock.at})` : ""}. If no other \`agx login\` is running, that lock is abandoned and clears itself within a few minutes (\`agx doctor\` reports it, and \`agx doctor --fix-perms\` removes it once it is stale); a person can also delete the file.`,
	);
}

function interruptedError(): AgxCliError {
	return new AgxCliError("Interrupted.", {
		exitCode: EXIT.interrupted,
		remediation:
			"The login code stays valid until it expires. Resume it with the same command:\n    agx login",
	});
}

function resultFromEntry(
	profileName: string,
	base: string,
	entry: CredentialEntry,
	extra: { alreadyLoggedIn: boolean; requestedOrg: string | null },
): LoginResult {
	return {
		loggedIn: true,
		alreadyLoggedIn: extra.alreadyLoggedIn,
		profile: profileName,
		apiBaseUrl: base,
		user: entry.user
			? { id: entry.user.id, email: maskEmail(entry.user.email) }
			: null,
		organization: entry.organization,
		requestedOrg: extra.requestedOrg,
		scopes: entry.scopes ?? [],
		expiresAt: entry.expiresAt,
		apiKeyId: entry.apiKeyId,
	};
}

/** The org the person asked for, if any (`--org`, or `--new-org --org-slug`). */
function requestedOrgOf(options: LoginOptions): string | null {
	return options.org ?? options.orgSlug ?? null;
}

/** Report a login that another agx process (or an earlier run) completed. */
function reportFinished(
	profileName: string,
	base: string,
	entry: CredentialEntry,
	options: LoginOptions,
): void {
	const requestedOrg = requestedOrgOf(options);
	report(
		resultFromEntry(profileName, base, entry, {
			alreadyLoggedIn: false,
			requestedOrg:
				requestedOrg && entry.organization?.slug !== requestedOrg
					? requestedOrg
					: null,
		}),
	);
}

function report(result: LoginResult): void {
	const who = result.user?.email ?? result.user?.id ?? "this account";
	const org = result.organization?.slug ?? "—";
	const scopes = result.scopes.length > 0 ? result.scopes.join(", ") : "—";
	const expires = result.expiresAt ? result.expiresAt.slice(0, 10) : "never";
	ok(
		`${result.alreadyLoggedIn ? "Already logged in" : "Logged in"} as ${who} · org ${org} · ${scopes} · expires ${expires}`,
	);
	say(kleur.dim(`  ${result.apiBaseUrl} · profile "${result.profile}"`));
	json(result);
}

interface PrincipalLike {
	user?: { id?: string; emailMasked?: string | null } | null;
	organization?: { id: string; slug: string; name: string } | null;
	apiKey?: {
		id?: string;
		scopes?: string[];
		expiresAt?: string | Date | null;
	} | null;
}

/** The server's view of a stored login, or null when the key no longer works. */
async function currentPrincipal(
	base: string,
	apiKey: string,
): Promise<PrincipalLike | null> {
	if (!isWellFormedApiKey(apiKey)) {
		return null; // cannot be a working key: log in for a new one
	}
	try {
		const client = createApiClient({ baseUrl: base, apiKey });
		return (await client.account.principal.get({})) as PrincipalLike;
	} catch (error) {
		const mapped = toCliError(error, "account.principal.get", base);
		if (
			mapped.exitCode === EXIT.auth ||
			(error as { status?: number })?.status === 404
		) {
			return null;
		}
		throw mapped;
	}
}

/** The replaced key's revoke is best effort, so it gets a shorter leash than a
 * normal call: it only ever delays the exit (the result is already printed). */
const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Best effort: revoke the login key this one replaces, against the origin it
 * was issued for. A key that is already gone, or a server that cannot be
 * reached, is left to expire on its own.
 */
async function revokeReplacedKey(old: CredentialEntry): Promise<void> {
	const origin = originOf(old.apiBaseUrl);
	if (!origin || !old.apiKeyId) {
		return;
	}
	try {
		const client = createApiClient(
			{ baseUrl: origin, apiKey: old.apiKey },
			{ timeoutMs: REVOKE_TIMEOUT_MS },
		);
		await client.prm.apiKeys.delete({ apiKeyId: old.apiKeyId });
	} catch (error) {
		if (isKeyRejected(error)) {
			return; // already invalid or expired: nothing left to revoke
		}
		// Anything else, a 404 included (a server without self-revoke), leaves
		// the old key alive: say so.
		notice(
			`Could not revoke the previous login key (${old.apiKeyId}); it expires on its own${old.expiresAt ? ` on ${old.expiresAt.slice(0, 10)}` : ""}, or revoke it in Settings → API keys.`,
		);
	}
}

function validateFlags(options: LoginOptions): void {
	if (options.org && options.newOrg) {
		throw usageError(
			"--org and --new-org cannot be combined.",
			"Log in to an existing organization:  agx login --org <slug>\n  Or create one on the approval page:  agx login --new-org --org-name <name>",
		);
	}
	if ((options.orgName || options.orgSlug) && !options.newOrg) {
		throw usageError(
			"--org-name and --org-slug only apply with --new-org.",
			'agx login --new-org --org-name "Acme Robotics" --org-slug acme-robotics',
		);
	}
}

export async function loginCommand(options: LoginOptions): Promise<void> {
	validateFlags(options);
	const rt = runtime();
	const profileName = resolveProfileName(options.profile);
	const base = resolveLoginBaseUrl(profileName, options.apiBaseUrl);
	const host = new URL(base).host;
	const jsonMode = Boolean(options.json) || isJsonMode();
	const wait = options.wait !== false;

	if (!jsonMode) {
		say(kleur.dim(`Logging in to ${host} (profile "${profileName}")`));
	}
	if (process.env.AGX_API_KEY) {
		notice(
			"AGX_API_KEY is set. It takes precedence over this login for every other agx command until you unset it.",
		);
	}

	// 3. Already logged in here, for this org: confirm with the server and stop.
	const existing = getCredential(profileName);
	const wantsOtherOrg =
		Boolean(options.newOrg) ||
		(options.org !== undefined &&
			existing?.organization?.slug !== options.org);
	if (
		existing &&
		existing.source === "login" &&
		!options.force &&
		!wantsOtherOrg &&
		sameOrigin(existing.apiBaseUrl, base) &&
		!isExpired(existing, rt.now())
	) {
		const principal = await currentPrincipal(base, existing.apiKey);
		if (principal) {
			const result = resultFromEntry(profileName, base, existing, {
				alreadyLoggedIn: true,
				requestedOrg: null,
			});
			if (principal.user?.emailMasked && result.user) {
				result.user.email = principal.user.emailMasked;
			}
			report(result);
			return;
		}
	}

	// 4. Resume the code this request already has, or ask for a new one.
	const request: LoginRequest = {
		orgHint: options.org ?? null,
		newOrg: Boolean(options.newOrg),
		newOrgName: options.orgName ?? null,
		newOrgSlug: options.orgSlug ?? null,
	};
	let pending = loadPendingLogin(profileName);
	let resumed = false;
	const sameCode =
		pending !== null &&
		pending.apiBaseUrl === base &&
		sameRequest(pending.request, request);
	/** How long ago this request's pending code expired: negative while it is
	 * live, NaN when there is none (or its date is unreadable). */
	const expiredForMs =
		pending && sameCode
			? rt.now() - Date.parse(pending.expiresAt)
			: Number.NaN;
	if (pending && expiredForMs < 0) {
		resumed = true;
	} else if (pending && !wait && expiredForMs <= RECENTLY_EXPIRED_MS) {
		// --no-wait re-runs report on THE code the harness already showed a
		// person (LOGIN-CONTRACT.md §1.8): it ran out, so this run says so
		// (exit 4) instead of swapping in a new code nobody has seen. The next
		// run starts over.
		removePendingLogin(profileName);
		const done = finishedElsewhere(profileName, base, pending);
		if (done) {
			reportFinished(profileName, base, done, options);
			return;
		}
		throw authError(
			"The login code expired before it was approved.",
			`Run the same command again for a fresh code:\n    ${rerunCommand(wait)}`,
		);
	} else {
		// Another server or another request, a code that expired more than
		// RECENTLY_EXPIRED_MS ago (abandoned in an earlier session), or, when
		// waiting, any expired code: start over.
		removePendingLogin(profileName);
		pending = {
			...(await requestDeviceCode(base, {
				clientId: AGX_CLIENT_ID,
				scope: AGX_SCOPE_STRING,
				hostLabel: hostname(),
				...request,
			})),
			replacesApiKeyId:
				existing?.source === "login" ? existing.apiKeyId : null,
		};
		savePendingLogin(profileName, pending);
	}

	// 5. Hand the URL and code to the human.
	const action = loginActionRequired(pending, rt.now());
	if (!wait && !resumed) {
		// --no-wait, fresh code: never poll it now; the harness re-runs.
		throw stillPendingError(action);
	}
	if (wait) {
		if (jsonMode) {
			emitStderrJson({ actionRequired: action });
		} else {
			console.error(
				`\nOpen ${kleur.bold(action.url)} and check the code ${kleur.bold(action.userCode ?? "")} (expires in ${minutesLeft(action.expiresIn ?? 0)}).`,
			);
			console.error(
				kleur.dim(
					"Sign in or sign up there, pick or create the organization, then approve.\n",
				),
			);
			if (
				shouldOpenBrowser({
					browser: options.browser,
					json: jsonMode,
					wait,
				})
			) {
				openBrowser(action.url, base);
			}
			console.error(
				kleur.dim("Waiting for approval… (Ctrl-C keeps the code; re-run to resume)"),
			);
		}
	}

	// 6. Poll: once for a resumed --no-wait, until done otherwise. Ctrl-C, a
	// SIGTERM (a harness or container stopping us) and a SIGHUP (the terminal
	// closing) all end the poll the same way: the code is kept, the lock is
	// released in `finally`, and the exit is 130.
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	for (const name of STOP_SIGNALS) {
		process.once(name, onSignal);
	}
	let outcome: Awaited<ReturnType<typeof pollWithLock>>;
	try {
		outcome = await pollWithLock(
			profileName,
			base,
			pending,
			!wait,
			rerunCommand(wait),
			controller.signal,
		);
	} catch (error) {
		if (
			error instanceof AgxCliError &&
			error.exitCode === EXIT.auth &&
			!controller.signal.aborted
		) {
			// Denied, expired or already used: this code is finished.
			removePendingLogin(profileName);
		}
		throw error;
	} finally {
		for (const name of STOP_SIGNALS) {
			process.off(name, onSignal);
		}
	}

	const requestedOrg = requestedOrgOf(options);
	if (outcome.kind === "locked") {
		noticeLockHolder(outcome.lockPath, outcome.lock);
		throw stillPendingError(loginActionRequired(outcome.pending, rt.now()));
	}
	if (outcome.kind === "pending") {
		throw stillPendingError(loginActionRequired(outcome.pending, rt.now()));
	}
	if (outcome.kind === "finished" || outcome.kind === "recovered") {
		const entry =
			outcome.kind === "finished"
				? outcome.entry
				: finishedElsewhere(profileName, base, outcome.pending);
		if (!entry) {
			throw authError(
				"The login finished in another agx process, but its credential is not on disk.",
				rerunCommand(wait),
			);
		}
		removePendingLogin(profileName);
		reportFinished(profileName, base, entry, options);
		return;
	}

	// 7. Store the key, point the profile at this server and org, clean up.
	const { token } = outcome;
	rememberSecret(token.access_token);
	const now = rt.now();
	const entry: CredentialEntry = {
		apiBaseUrl: originOf(base) ?? base,
		apiKey: token.access_token,
		apiKeyId: token.api_key_id,
		source: "login",
		clientId: AGX_CLIENT_ID,
		organization: {
			id: token.organization.id,
			slug: token.organization.slug,
			name: token.organization.name,
		},
		user: { id: token.user.id, email: maskEmail(token.user.email ?? null) },
		scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : null,
		expiresAt:
			token.expires_at ??
			(typeof token.expires_in === "number"
				? iso(now + token.expires_in * 1000)
				: null),
		createdAt: iso(now),
	};
	const previous = getCredential(profileName);
	const legacyKey = getProfile(profileName).apiKey;
	setCredential(profileName, entry);
	updateProfile(profileName, {
		apiBaseUrl: base,
		orgSlug: token.organization.slug,
		apiKey: null,
	});
	removePendingLogin(profileName);

	if (legacyKey) {
		notice(
			`Removed the 0.3 API key from config.json for profile "${profileName}"; this login replaces it. It was not revoked: revoke it in Settings → API keys if nothing else uses it.`,
		);
	}
	const replaced =
		previous && previous.apiKey !== entry.apiKey ? previous : null;
	if (replaced && replaced.source !== "login") {
		// A Settings key may still be in use elsewhere (CI): never revoke it.
		notice(
			`This login replaces the ${replaced.source} API key of profile "${profileName}". That key was not revoked: revoke it in Settings → API keys if nothing else uses it.`,
		);
	}
	const differs =
		requestedOrg !== null && token.organization.slug !== requestedOrg;
	if (differs) {
		notice(
			`You asked for organization "${requestedOrg}", but the login was approved for "${token.organization.slug}". agx now acts on "${token.organization.slug}".`,
		);
	}
	// The result goes out BEFORE the best-effort revoke of the replaced key:
	// the new key is already stored, so a slow or dead server can only delay
	// the exit, never cost a harness the result.
	report(
		resultFromEntry(profileName, base, entry, {
			alreadyLoggedIn: false,
			requestedOrg: differs ? requestedOrg : null,
		}),
	);
	if (replaced && replaced.source === "login") {
		await revokeReplacedKey(replaced);
	}
}
