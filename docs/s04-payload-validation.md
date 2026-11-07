# S-04 — Validate task payloads against typed skills

**PR:** one, stacked on S-03.
**Depends on:** S-03.
**Files:** packages/core/src/json-schema.ts, packages/core/src/client.ts, packages/core/src/transport.ts, packages/core/src/index.ts, packages/nostr/src/typed-card.ts, packages/nostr/src/nostr-transport.ts, focused tests, package documentation, and packages/core/SPEC.md.

**Today:** Agent Cards can describe input and output schemas, but `AgxClient` never checks task data against them.

**Change:** let a handler registration supply an optional typed skill contract. Validate authorized request input before the handler and handler output before a completed result. Add opt-in requester preflight through `request(..., { validate: true })`, using the resolved peer's exact typed skill. Advertise registered typed skills through the existing discovery hook. Reuse one bounded schema implementation for card parsing and payload validation. Send only `invalid_input` or `invalid_output` across the trust boundary; keep validation details in local errors and logs.

**Acceptance:** WHEN an authorized payload violates the selected skill's input schema THEN the receiver SHALL return `invalid_input` without invoking the handler, and WHEN requester preflight is enabled THEN the requester SHALL reject invalid input before publishing.

**Verify:** `pnpm --filter @nostr-agx/core test:unit`, `pnpm --filter @nostr-agx/nostr test:unit`, then `pnpm build && pnpm type-check && pnpm test && pnpm check:packages`. Tests must prove invalid input never invokes the handler, denied peers receive no validation response, valid legacy handlers remain unchanged, and invalid output returns `invalid_output` instead of a completed result.

**Must not:** require schemas for existing capabilities; add a dependency; fetch schemas or follow references; evaluate schema text as code; expose validation responses to denied requesters; add structured error fields, task states, remote result validation, generated forms, or S-01/S-02 changes.

## Options considered

1. Core contracts plus opt-in requester preflight: reusable by CLI, gateway, and other runtimes with no extra network work by default. Selected.
2. CLI-only validation: smaller patch, but library and gateway users would bypass the checks. Rejected.
3. Automatic peer resolution for every request: centralizes preflight but adds network latency and stale-card failures to existing callers. Rejected.

## Deliberate limits

Only the S-03 JSON Schema subset is enforced. Input and output checks apply when the corresponding schema exists. Missing cards, missing typed skills, and legacy-only contracts skip requester preflight. Receiver-side output validation catches a bad handler result; it does not trust or validate a remote peer's result on the requester side.
