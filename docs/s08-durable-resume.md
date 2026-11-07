# S-08 — Implement durable `input-required` and resume

**PR:** one, stacked on S-06.
**Depends on:** S-06 status updates and S-04 bounded schema validation.
**Files:** core task/client/suspension types and store, gateway file-backed suspension store and client wiring, focused tests, real-relay restart test, CLI documentation, and packages/core/SPEC.md.

**Today:** A handler can report progress but cannot pause for an answer and recover that suspended exchange after restart.

**Change:** add typed `input-required` status and `resume` envelopes. `task.requireInput` accepts a text, choice, or confirmation question, bounded resume schema, expiry, and optional JSON host state. The original requester validates and sends `client.resume(taskId, payload)` with the same task ID and sequence. A separately registered resume handler continues with stored state; the initial handler never reruns after restart. Bind resume to the original peer, reject invalid/expired answers, ignore duplicates and unknown tasks, and persist a `resuming` marker before invoking the handler so an interrupted resume is not executed again. Support repeated questions through the same mechanism.

**Acceptance:** WHEN a responder pauses with `input-required` and the original requester supplies valid input with the same task ID THEN the responder SHALL resume the suspended task once and continue from its stored state, including after client restart with a shared durable store.

**Verify:** core tests for valid resume, repeated questions, duplicate response, wrong peer, late response, invalid response, expiration, unknown task, and restart; real local relay restart with a file-backed store; then full workspace commands.

**Must not:** store secret answers, add UI approval, rerun the initial handler on resume, extend the original requester deadline, change S-01/S-02 operation storage, or add a new dependency.

## Options considered

1. Separate registered resume handler plus injected durable store: recovers without repeating initial side effects and works across process restart. Selected.
2. Rerun initial handler with a resume payload: repeats pre-suspension side effects unless every host adds custom guards. Rejected.
3. In-memory continuation only: cannot satisfy restart recovery. Rejected.

## Trust and storage boundary

Question, schema, expiry, and host state are public to the original peer and persisted locally; secret answers are forbidden. Resume answers are validated but are not written to the suspension store. Unknown resume traffic follows the existing plain-message trust path and receives no automatic reply. Requester timeout and suspension expiry are independent; hosts must choose a request timeout appropriate for the expected answer wait.
