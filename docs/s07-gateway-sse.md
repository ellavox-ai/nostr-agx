# S-07 — Expose task events through gateway SSE

**PR:** one, stacked on S-02 and S-06.
**Depends on:** S-02 durable background handles and S-06 core working updates.
**Files:** gateway requester/operations/routing, a bounded task-event replay module, gateway tests, and CLI documentation.

**Today:** Background HTTP tasks expose running/completed/failed lookup, but no live event stream.

**Change:** pass remote `onTaskStatus` updates through `Requester` and background task registration. Add `GET /v1/tasks/:id/events` using the same API credential. Return `text/event-stream` with ordered numeric SSE IDs, `working` updates, comments as heartbeat, `Last-Event-ID` replay, and one terminal `completed` or `failed` event containing the stored task view. Bound replay to 128 events per task and 1,000 in-memory task streams for the same 24-hour retention period. Check the durable operation for terminal state instead of rerunning work.

**Acceptance:** WHEN a client reconnects after missing intermediate events THEN the terminal SSE event or stored task lookup SHALL provide the complete final result without rerunning the task.

**Verify:** event-buffer unit tests and real gateway/relay tests for live working events, heartbeat, `Last-Event-ID`, disconnect without cancellation, stored terminal replay, unknown/wrong-credential IDs, then the full workspace commands.

**Must not:** require Nostr relay WebSocket changes, treat SSE disconnect as cancellation, persist intermediate events, change S-01/S-02 storage format, expose another credential's events, or claim lossless intermediate replay after restart.

## Options considered

1. Background handle plus separate SSE endpoint: preserves existing JSON routes and reconnect semantics. Selected.
2. Upgrade POST /v1/tasks itself to SSE: complicates idempotency and existing HTTP clients. Rejected.
3. Persist every intermediate event: unnecessary storage growth for ephemeral progress. Rejected; final outcome remains durable.

## Operational contract

Send `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`; proxies must not buffer SSE. A heartbeat is a comment and has no event ID. Intermediate replay is bounded and in-memory; the durable terminal view is authoritative after process restart.
