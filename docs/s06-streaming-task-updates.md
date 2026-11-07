# S-06 — Implement `working` status updates

**PR:** one, stacked on S-04.
**Depends on:** S-04; S-05 structured errors is independent.
**Files:** packages/core/src/task.ts, packages/core/src/client.ts, core client tests and documentation, packages/core/SPEC.md, and the real-relay integration test.

**Today:** A requester waits for a terminal result with no authenticated progress updates from the handler.

**Change:** add `{ t: "status", taskId, status: "working", seq, message? }`. Give each client-created task a `report(message?)` function. Assign increasing sequence numbers starting at 1. Add per-request `onTaskStatus`; bind updates to the pending task and original peer, ignore duplicate or older sequence numbers, and leave the request pending. Do not extend its deadline. Add `working` to registered typed skill features. Unknown, late, and post-terminal status traffic follows the existing plain-message trust path and receives no automatic reply.

**Acceptance:** WHEN an authorized handler reports `working` THEN the requester SHALL receive the ordered public update and SHALL keep the original request pending until a terminal result or its original deadline.

**Verify:** focused core tests for delivery, ordering, duplicates, wrong sender, unknown task, post-terminal traffic, publish failure, and unchanged timeout; a real local relay test with two independent agents; then `pnpm build && pnpm type-check && pnpm test && pnpm check:packages`.

**Must not:** add token-by-token model streaming, raw reasoning, implicit deadline extension, gateway SSE, durable resume, new dependencies, or S-01/S-02 operation-storage changes.

## Options considered

1. Additive status envelope: preserves the terminal-only result contract and lets older peers fall through safely. Selected.
2. Nonterminal result envelopes: weakens the existing completed/failed result invariant. Rejected.
3. Plain text messages: cannot provide task correlation, ordering, or terminal-state rules. Rejected.

## Public boundary

A status message is handler-supplied public text and must not contain secrets, credentials, raw reasoning, stack traces, or internal host details. Reporting is best-effort: transport failures are logged and do not fail the task. Sequence numbers provide ordering and deduplication, not delivery guarantees.
