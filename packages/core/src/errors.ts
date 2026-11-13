/**
 * A task-handler error whose message is SAFE to send across the trust boundary to
 * the requesting peer. By default a thrown handler error is reported to the peer
 * as a generic "handler failed" (and the real message logged locally), so an
 * internal error — a driver/ORM/HTTP failure carrying hostnames, table names, or
 * connection strings — never leaks to another org. Throw `AgxPublicError` when you
 * intend the message to be part of the protocol contract (e.g. "invoice not
 * found", "amount exceeds limit").
 *
 *   agx.handle("invoice.review", (t) => {
 *     if (!found) throw new AgxPublicError("invoice not found");
 *     ...
 *   });
 */
export class AgxPublicError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgxPublicError";
	}
}

/**
 * How a request's result promise rejects when the peer reports the task
 * failed. The message is the peer's own text (or "task failed"), so it is
 * untrusted: classify by this type, never by matching the message, which a
 * peer could word like one of this client's local errors.
 */
export class AgxTaskFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgxTaskFailedError";
	}
}

/**
 * How `request` / `streamRequest` with `validate: true` reject when the
 * payload fails the input schema on the peer's Agent Card. Local only: it is
 * thrown before anything is sent. A peer that refuses the input itself
 * answers `invalid_input`, which still arrives as {@link AgxTaskFailedError}.
 */
export class AgxInvalidInputError extends Error {
	constructor(public readonly problem: string) {
		super(`AGX request: invalid_input: ${problem}`);
		this.name = "AgxInvalidInputError";
	}
}

/**
 * Thrown by a task handler to leave a task unanswered: no result goes back, not
 * even a failure, and the task is recorded as handled so this client does not
 * run it again. For a host that runs the same identity in more than one place
 * and finds, once the handler has started, that the task is another
 * instance's to answer. The requester hears nothing from THIS client, so
 * decline only a task something else will answer.
 */
export class AgxTaskDeclined extends Error {
	constructor(reason = "task declined") {
		super(reason);
		this.name = "AgxTaskDeclined";
	}
}

/**
 * A message body over {@link MAX_BODY} characters, thrown by
 * `buildExchangePayload` rather than silently shortening it.
 *
 * This is a BACKSTOP, not the intended failure path. Every caller that can
 * produce a user-facing result checks the length first and reports it cleanly —
 * `AgxClient.fitsWire`, `NostrTransport.publishMessage`, `egress.ts`. Reaching
 * this throw means one of them was bypassed, which is exactly when a loud
 * failure beats a body delivered with its tail missing.
 */
export class AgxBodyTooLongError extends Error {
	constructor(public readonly chars: number) {
		super(
			`AGX message body is too long (${chars} characters). Callers must check the limit and report it; reaching this means the body would otherwise have been truncated silently.`,
		);
		this.name = "AgxBodyTooLongError";
	}
}

/**
 * `evidence` that does not fit the wire schema (too many records or fields, a
 * value too long, a time that is not ISO 8601), thrown by
 * `buildExchangePayload`. A receiver would drop such evidence whole, so it is
 * refused at the sender instead of shipping a claim nobody can read.
 *
 * Like {@link AgxBodyTooLongError}, a BACKSTOP: `NostrTransport.publishMessage`
 * checks with `exchangeEvidenceProblem` first and returns `ok: false`.
 */
export class AgxEvidenceInvalidError extends Error {
	constructor(public readonly problem: string) {
		super(`AGX message evidence is invalid: ${problem}`);
		this.name = "AgxEvidenceInvalidError";
	}
}
