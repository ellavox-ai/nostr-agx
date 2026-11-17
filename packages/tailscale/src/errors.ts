/**
 * Failures from the opt-in Tailscale integration. Codes let a host branch on
 * the kind of problem without parsing a message, while `remediation` gives the
 * developer the next command or config change.
 */
export type TailscaleErrorCode =
	/** Missing/invalid config, or a provider returned an unusable key. */
	| "configuration"
	/** The OAuth service or Tailscale API rejected the credentials or scopes. */
	| "auth"
	/** A token/key request could not reach the service. */
	| "network"
	/** The bundled platform binary is missing or unusable. */
	| "module";

export class TailscaleError extends Error {
	readonly code: TailscaleErrorCode;
	/** What the caller can do about it. Never contains a credential. */
	readonly remediation?: string;

	constructor(
		code: TailscaleErrorCode,
		message: string,
		remediation?: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TailscaleError";
		this.code = code;
		this.remediation = remediation;
	}
}
