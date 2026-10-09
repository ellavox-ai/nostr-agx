/**
 * Every failure the CLI reports carries a remediation. A tool whose job is to
 * exercise a multi-process system fails for boring environmental reasons far more
 * often than for interesting ones, so "what do I type next" is part of the error,
 * not an afterthought.
 */

export const EXIT = {
	ok: 0,
	generic: 1,
	usage: 2,
	/** No profile, no identity, missing local config. */
	config: 3,
	/** API rejected the credential, or it is bound to another organization. */
	auth: 4,
	/** Index or relay unreachable. */
	network: 5,
	/** The remote refused the request on its merits (403/422). */
	remote: 6,
	/**
	 * A human has to do something in a browser first: approve a login, confirm
	 * a public listing, or (reserved, never sent today) accept new Terms. Not a
	 * failure. With `--json` the CLI prints exactly one `{"actionRequired":{…}}`
	 * object on stdout.
	 */
	humanAction: 7,
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class AgxCliError extends Error {
	readonly exitCode: ExitCode;
	readonly remediation: string | null;

	constructor(
		message: string,
		options?: { exitCode?: ExitCode; remediation?: string | null },
	) {
		super(message);
		this.name = "AgxCliError";
		this.exitCode = options?.exitCode ?? EXIT.generic;
		this.remediation = options?.remediation ?? null;
	}
}

/** The reasons a harness can be handed back to a human. A closed list: a
 * harness branches on it, so a new reason is a contract change. */
export type ActionRequiredReason =
	| "LOGIN_APPROVAL_REQUIRED"
	| "HUMAN_CONFIRMATION_REQUIRED"
	| "TERMS_ACCEPTANCE_REQUIRED";

/** The `actionRequired` object printed with exit 7 (LOGIN-CONTRACT.md §1.8). */
export interface ActionRequired {
	reason: ActionRequiredReason;
	/** Always absolute, and always on the API origin agx is talking to (or, for
	 * the Terms, the same site). */
	url: string;
	userCode: string | null;
	/** Seconds left, or null when the action does not expire. */
	expiresIn: number | null;
	expiresAt?: string;
	verificationUri?: string;
	listingId?: string;
}

/**
 * The CLI cannot go further without a person. Always exit 7, so a harness can
 * tell "a human must click something" apart from every real failure.
 */
export class HumanActionRequiredError extends AgxCliError {
	readonly actionRequired: ActionRequired;

	constructor(
		message: string,
		actionRequired: ActionRequired,
		remediation?: string | null,
	) {
		super(message, {
			exitCode: EXIT.humanAction,
			remediation: remediation ?? null,
		});
		this.name = "HumanActionRequiredError";
		this.actionRequired = actionRequired;
	}
}

export function configError(message: string, remediation: string): AgxCliError {
	return new AgxCliError(message, { exitCode: EXIT.config, remediation });
}

export function usageError(message: string, remediation?: string): AgxCliError {
	return new AgxCliError(message, {
		exitCode: EXIT.usage,
		remediation: remediation ?? null,
	});
}

export function authError(message: string, remediation?: string): AgxCliError {
	return new AgxCliError(message, {
		exitCode: EXIT.auth,
		remediation: remediation ?? "agx login",
	});
}

export function networkError(
	message: string,
	remediation: string,
): AgxCliError {
	return new AgxCliError(message, { exitCode: EXIT.network, remediation });
}

export function remoteError(
	message: string,
	remediation?: string | null,
): AgxCliError {
	return new AgxCliError(message, {
		exitCode: EXIT.remote,
		remediation: remediation ?? null,
	});
}
