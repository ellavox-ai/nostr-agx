# NIP-AGX — Agent Exchange (draft)

> **License:** this specification is licensed under [CC-BY-4.0](LICENSE-SPEC).
> The reference implementations are licensed under [MIT](LICENSE).

> Working draft of the NIP-AGX standard. Intended for
> eventual submission to the Nostr NIPs repository. This document is normative for `@nostr-agx/core`
> (protocol semantics) and `@nostr-agx/nostr` (the Nostr binding).

## Status

Draft `0.2.0`. Kinds, the NIP-59 transport envelope, content types, the Agent Card, task lifecycle,
capability matching, and correlation/replay are implemented in the reference libraries
(`@nostr-agx/core` + `@nostr-agx/nostr`) and covered by tests. Intended for submission to the Nostr NIPs
repository.

`0.2.0` (pre-release, not wire-compatible with `0.1.0`): messages and receipts travel only as NIP-59
gift wraps, with NIP-40 expiration and NIP-13 proof-of-work on every wrap; the reference binding signs
through a NIP-07/NIP-46-shaped signer. Nothing was released on `0.1.0`, so there is no dual-format
period.

## Scope

NIP-AGX governs **organization-to-organization** (agent-to-agent, cross-trust-domain) exchange. It
provides identity + integrity + transport + task semantics; the **payload is protocol-agnostic**,
labelled by a content type (A2A JSON is the default/reference format). Same-domain internal
messaging is out of scope.

## Layering

- **Protocol core (this spec, `@nostr-agx/core`)** — task lifecycle, correlation, receipts, replay
  protection, capability matching, content-type dispatch. Transport-agnostic.
- **Nostr binding (`@nostr-agx/nostr`)** — maps the protocol onto Nostr events + NIPs (below).
- **Runtime** — decides what to do with a task.

## Event kinds (Nostr binding)

| Kind    | Name        | Notes |
|---------|-------------|-------|
| `1059`  | Gift wrap    | NIP-59; the **only** kind messages and receipts travel as. Signed by a one-time key; `p` = recipient, `expiration` (NIP-40), `nonce` (NIP-13) |
| `13`    | Seal         | NIP-59; the rumor, NIP-44-encrypted to the recipient and signed by the real sender. Never published on its own |
| `3838`  | Message/Task | **rumor kind** (unsigned, inside a seal): payload JSON in plaintext `content`; `p` = recipient; `content-type` tag. MUST NOT be published bare |
| `3839`  | Receipt      | **rumor kind**: delivery ack; `p` = recipient, `e` = the acknowledged message's rumor id. MUST NOT be published bare |
| `11337` | Agent Card   | replaceable; **unencrypted**, signed by the agent's key; capabilities/relays/nip05 |
| `10002` | Relay list   | NIP-65 |
| `5`     | Deletion     | NIP-09; retracts the agent's own card |

## Transport envelope (NIP-59) (normative)

Every AGX message and receipt is a **rumor** — an unsigned event of kind `3838`/`3839` whose
`pubkey` is the sender and whose `id` is its NIP-01 hash — **sealed** (kind `13`: the rumor
NIP-44-encrypted to the recipient, signed by the sender, no tags) and **gift-wrapped** (kind `1059`:
the seal NIP-44-encrypted to the recipient under a fresh one-time key, signed by that key).

- A wrap **MUST** carry exactly one `p` tag (the recipient), an `expiration` tag, and a `nonce` tag,
  and nothing that identifies the sender or the AGX kind.
- The seal's and the wrap's `created_at` **SHOULD** be randomized up to `MAX_WRAP_BACKDATE_SEC`
  (172800 s, two days) into the past and **MUST NOT** be in the future.
- A recipient **MUST** discard a wrap unless: the seal is a validly signed kind `13`; the rumor's
  `pubkey` equals the seal's signer (otherwise anyone could seal a rumor "from" someone else); the
  rumor's `id` is the hash of its contents; and the rumor `p`-tags the recipient. The sender identity
  is the seal's signer and nothing else.
- Because wraps are backdated, an inbox poll **MUST** reach at least `MAX_WRAP_BACKDATE_SEC` behind
  its cursor (reference: `AgxTransport.pollLookbackSec`, added to the poll overlap by `AgxClient`),
  and a durable replay store **MUST** retain processed ids for longer than that whole window.

What this buys, and what it does not: a relay (or anyone reading it) learns who a wrap is **for**, and
nothing about who sent it, when, or what kind of AGX event it is. The recipient is still visible,
because it is what makes the wrap pollable by `#p`.

## Retention (NIP-40) (normative)

Every wrap **MUST** carry an `expiration` tag equal to its own (backdated) `created_at` plus one
TTL shared by every AGX wrap — reference `WRAP_TTL_SEC` = 30 days — and never more than
`MAX_EXPIRATION_SEC` = 31 days past the real time. Anchoring to the real clock, or picking the TTL by
kind, would put back on the outside exactly what the wrap hides: `expiration − TTL` would be the true
send time, and the gap `expiration − created_at` would tell a receipt from a message. A backdated
wrap simply lives up to `MAX_WRAP_BACKDATE_SEC` less than the full TTL. A recipient **MUST** ignore an
expired wrap. A relay carrying AGX traffic **SHOULD** reject wraps without an expiration or beyond its
cap, which — with relays deleting expired events, as strfry does — bounds its storage with no
separate pruning. Cards, relay lists and deletions carry no expiration: cards are replaceable, and a
deletion must outlive what it deletes.

## Anti-spam (NIP-13) (normative)

Every wrap **MUST** be mined to at least `AGX_POW_BITS` = 12 leading zero bits of its id, with a
`nonce` tag whose third element commits to that target. Mining **MUST NOT** alter the wrap's
backdated `created_at`. A relay carrying AGX traffic **MAY** reject wraps below its floor; the
reference relay requires exactly `AGX_POW_BITS`. The work is on the wrap because its author is a
one-time key: it is the one event a pubkey allow-list cannot vouch for.

## Signing

Implementations route every key operation — signing, NIP-44 encrypt/decrypt, NIP-42 AUTH — through a
signer exposing `getPublicKey`, `signEvent`, `nip44Encrypt`, `nip44Decrypt` (the NIP-07 / NIP-46
shape). Holding the raw key in-process (reference: `localSigner`) is one implementation, not a
requirement; a NIP-46 bunker or a KMS-backed signer satisfies the same contract. The wrap's one-time
key is the only key an implementation generates and uses directly.

A signer **MUST** distinguish being unavailable (unreachable bunker, KMS timeout — reference:
`AgxSignerUnavailableError`) from being handed input that does not check out. A poll that hits the
former **MUST NOT** discard the wraps it could not open and **MUST** report itself incomplete, so the
window is polled again; only the latter marks a wrap as never to be retried.

## Content types

Default `application/a2a+json`. Unknown content types are ignored, not mis-parsed (payload-agnostic
dispatch). Additional types may be registered.

## NIP inventory

Required: NIP-01, NIP-13 (proof-of-work), NIP-19, NIP-40 (expiration), NIP-44 (encryption), NIP-59
(gift wrap). Used: NIP-05 (domain identity), NIP-09 (card retraction), NIP-42 (relay auth), NIP-65
(relay lists). NIP-17's pattern (seal + wrap per recipient) is followed with AGX rumor kinds rather
than kind `14`. Deferred/optional — tracked, with value / effort / support impact, in the NIP roadmap
in `docs/agent-exchange.md`: full task-artifact taxonomy, NIP-46 (remote signing; the signer seam
above is its prerequisite), NIP-51/NIP-32 (signed trust lists and verification labels), NIP-77
(negentropy sync), NIP-89 (handler advertisement), NIP-90 (DVM interop, for future review), NIP-57
(zaps).

## Task lifecycle

A **task** is a capability-keyed request one agent asks another to perform. Task envelopes ride
inside the message payload text, labelled by `application/agx-task+json`, so the transport carries
them like any message:

- **request** — `{ t: "req", taskId, capability, payload, supportsInput?, supportsWorking?, timeoutMs? }`.
  `payload` is arbitrary JSON the handler interprets (payload-agnostic). `supportsInput` is an explicit
  opt-in to interactive input; it defaults to false. `supportsWorking` is an explicit opt-in to
  `working` updates; it defaults to false, and like `supportsInput` it is a permanent opt-in: a
  responder sends `working` only when it is `true`. `timeoutMs` is the requester's end-to-end deadline in
  milliseconds; zero means no requester deadline.
- **result/update** — `{ t: "res", taskId, status: "input-required", inputRequestId, requirement }`
  and `{ t: "res", taskId, status: "working", seq, message? }` are nonterminal updates;
  `{ t: "res", taskId, status: "completed", output? }` and `{ t: "res", taskId, status: "failed", error? }`
  are terminal results. `seq` is a positive integer, starting at 1 and increasing per task, that
  orders `working` updates; `message` is optional public text of at most 2,000 characters.
- **input continuation** — `{ t: "input", taskId, inputRequestId, input }` supplies the answer to an
  outstanding input requirement. It is a new message/event, but continues the same task and uses
  the same `taskId` as its transport `contextId`.
- **cancellation** — `{ t: "cancel", taskId }` tells the responder that the requester has stopped
  waiting or cannot continue. It uses the same `taskId` as its transport `contextId`.

States: `submitted → working ↔ input-required → completed | failed | canceled`. A handler may call
`requestInput(requirement)` to publish an `input-required` update and await the continuation. A
responder **MUST NOT** publish that update unless the request opted in with `supportsInput: true`;
otherwise it **MUST** fail the task promptly. A completed handler transitions the task to
`completed`; a thrown handler error transitions it to `failed`. Task identity is scoped per requester: a
`taskId` names a task only within the exchange with the peer that chose it, so the same id arriving
from two different peers names two distinct tasks whose lifecycles — active entry, input,
cancellation, cleanup — **MUST** stay separate, and a second request from a peer reusing a `taskId`
that is still active **MUST** be refused rather than overwrite it. An input continuation **MUST**
match the pending task and `inputRequestId` and come from the peer that initiated the task. A cancellation
**MUST** match an active task and come from its initiating peer; the responder **MUST** stop waiting
for input and **MUST NOT** send a later result. Cancellation cannot forcibly stop arbitrary
application code already running. A cancellation for an unknown or inactive task — one that has
already finished, never started here, or was issued by a different peer — is ignored without a
reply: it is consumed, **MUST NOT** be delivered to the host as a plain message, and **MUST NOT**
trigger any reply.

A handler calls `ctx.report(message?)` to publish best-effort `working` updates, and a requester sees
them while its original request remains pending (`statusUpdate` and `progress` on `streamRequest()`,
`onTaskStatus` on `request()`). A responder **MUST NOT** send `working` unless the request opted in with
`supportsWorking: true`; without it, `ctx.report` sends nothing and the task otherwise runs unchanged.
`streamRequest()` and `request()` with `onTaskStatus` opt in; a plain `request()` does not. A `working`
update is nonterminal and independent of `supportsInput`; it **MUST NOT** settle the request, cancel it,
or extend its deadline. A requester **MUST** accept one only from the peer the request was sent to, for
the pending `taskId`, with the transport `contextId` equal to that `taskId`, exactly as for
`input-required`. Duplicate or older `seq` values are ignored; a later terminal result still settles the
request normally. A responder **MUST NOT** send `working` after the task has finished or been canceled:
the reference client stops accepting reports as soon as the handler returns or throws, and waits for any
update already being published before it sends the terminal result. A responder **MUST NOT** send
`working` while an `input-required` it sent is outstanding: from when it starts sending the input
requirement until the handler resumes with the matching input or the task ends. Reports made in that window are dropped,
not queued, and use no `seq`. A `working` update already being published when input is requested is sent
before the `input-required`. The message is handler-supplied
public text, never raw reasoning or internal error details. A transport failure or oversized message
drops the update without failing the task. Unknown, late, and post-terminal updates receive no automatic
reply and follow the plain-message trust path. The opt-in exists because a requester that predates
`working` cannot be relied on to treat an unrecognized update as a plain message: the reference
`streamRequest()` in every release up to 0.6.0 reads it as `TaskNotFoundError` and drops its pending
input. A requester that does not set `supportsWorking` never receives `working`; a responder that
predates `working` ignores the unknown key and sends no updates. A skill advertises `working` in
`features` only when its contract author declares it; the reference client adds no feature. This is not
token-by-token model streaming.

**Responder shutdown.** A responder that stops **MUST NOT** treat it as a requester cancellation: a
handler already running still publishes its terminal result, and a task waiting for input or to
resume is failed with a `failed` result, so no requester is left waiting on a responder that has
gone away. A task accepted but not yet started sends nothing — the requester's own timeout, or a
replacing responder instance (which observes that no result was sent), remains the backstop.

An input requirement's `id` is an optional stable, handler-chosen label for the kind of question;
`inputRequestId` is the unique correlation id for that specific prompt and answer. `timeoutMs` is
the maximum wait for this prompt. Missing or zero uses the responder's configured default, and the
effective timeout is capped by the responder's client-wide maximum and any remaining end-to-end
request deadline. The responder includes that effective timeout in the published requirement. An
input-required update is nonterminal: an opted-in initiator keeps its request open and may provide
input through `streamRequest()`. A plain `request()` caller rejects with a clear input-required error
and sends cancellation. The initiator's timeout covers the whole task, not each prompt separately.

`inputSchema` on an input requirement, when present, describes the expected answer using JSON Schema,
but is advisory. The protocol core does not validate answers against it (task payloads and results are
checked separately, see "Typed payload validation"); the requester SHOULD validate user input, and
the handler MUST validate input before relying on it.

The current in-process handler API waits for input in memory; it does not persist suspended handler
state across process restarts. A runtime requiring restart recovery must persist and restore that
state itself. Waiting for input releases the handler's concurrency slot, so another task may run;
the number of simultaneous pending input requirements and the duration of each wait are bounded by
client configuration.

**Error boundary.** A `failed` result crosses trust domains, so a thrown handler error is reported to
the peer **generically** (`handler failed`) and the real message is logged locally — an internal
driver/ORM/HTTP error must not leak hostnames, table names, or credentials to another org. To send a
message that is part of the protocol contract (`invoice not found`, `amount exceeds limit`), throw an
`AgxPublicError`, whose message is forwarded verbatim, up to the 2000 UTF-16 code units a result's
`error` may carry; a longer message is cut to its first 2000 units (one fewer if the cut would split a
surrogate pair), because a requester drops a result whose `error` is longer and the task would end only
at its timeout.
Both the request and result envelopes are size-checked before sending; an oversize payload fails fast
(request) or is replaced with a `result too large` failure (result) rather than truncated into
unparseable JSON.

## Capability matching

An agent's Agent Card lists the `capabilities` it handles (the set of registered handler keys). Keys
are dot-namespaced (`invoice.review`). A `.*` suffix advertises a namespace wildcard (`invoice.*`
matches `invoice.review`); `*` advertises all. An initiator selects a peer whose card satisfies the
requested capability before sending.

**Unhandled task traffic (normative).** Because the payload `contentType` is peer-supplied, a
task-labelled message is not proof of task intent. A responder **MUST** consume a message as a task
only when it can service it — a request whose capability it has a registered handler for, or a result
correlated to one of its own pending requests. Any other task-labelled message (unknown capability,
unmatched/late result, malformed envelope) **MUST NOT** be auto-replied to — emitting a signed reply
to an unauthenticated peer turns the identity into a reflector — and **MUST** be delivered to the
plain-message path instead, so a host that gates all inbound traffic there (peer registration, flood
budget, block rules) triages it rather than being bypassed by a content-type label.

### Typed skills and extensions (Agent Card format 1.1.0)

Agent Card format 1.1.0 is part of the protocol. A publisher MAY add `skills` and `extensions` to the
same signed, unencrypted kind `11337` card. A card with either field uses human-readable format
`version: "1.1.0"`; `v` remains `1`, and cards without either field remain `1.0.0`. Legacy `capabilities` remains explicit: skill IDs are not copied into it
automatically, and typed metadata does not change wildcard matching or peer selection.

Each skill has a concrete `id` (not `*` or a `.*` wildcard), a public `description`, and optional
`tags`, `inputModes`, `outputModes`, `inputSchema`, `outputSchema`, and `features`. Modes are media
types for the inner task payload and result; they do not change the AGX envelope or add artifact
transport. Feature labels advertise behavior rather than enabling it, and are declared by the contract
author; the reference client never adds one. Schemas are inline metadata and MAY also
drive local task input/output validation as specified below.

Each extension has a stable `uri` and optional `required` (default `false`). Extensions are declared
once per card, so `required: true` means a reader that does not support the URI MUST NOT use any of
the card's typed skills. AGX-namespaced identifiers such as `agx.task-status.v1` are recommended. An
unknown optional extension is retained and does not affect typed skills. An unknown required extension
hides all typed skills and returns an `unsupported_required_extension` warning; its extension
declaration remains visible and legacy fields remain usable. A URI declared more than once is merged
into one declaration, required if any copy is, with an `invalid_typed_extension` warning. An invalid
extension entry is dropped with an `invalid_typed_extension` warning; one that says `required: true`
also counts as an unsupported required extension. The reference implementation currently recognizes
no required extension URIs. A
publisher MUST omit a skill from legacy `capabilities` when legacy interaction with it would be unsafe.

Legacy fields are parsed independently. Malformed, duplicate, oversized, or unsupported typed metadata
MUST NOT hide valid legacy `org`, `nip05`, or `capabilities`. A structural failure (card content that
is not an object, `skills` or `extensions` that is not an array or has too many entries, or typed
metadata over the size limit) ignores the whole typed unit with an `invalid_typed_metadata` warning.
Otherwise each skill is checked on its own: an invalid skill is dropped with an `invalid_typed_skill`
warning and hides only itself, and every copy of a duplicated skill ID is dropped, since a reader
cannot tell which one the publisher meant. Unknown fields in skill and extension objects are ignored
and left out, so a card written for a later format version still reads as typed. A publisher drops an
invalid skill instead of not publishing the card. No parser may fetch a schema or follow a reference. A signature proves only which key published these
public claims, not their correctness, safety, quality, or current availability. Cards MUST NOT contain
credentials, private endpoints, confidential examples, or other secrets.

The inline JSON Schema 2020-12 subset permits `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, `minLength`, `maxLength`, `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`,
`minProperties`, and `maxProperties`. The annotation keywords `description`, `title`, `$schema`,
`default`, and `examples` are accepted with any value and ignored: they are never checked or fetched,
and `default` is never applied. A reader MAY drop an annotation whose value exceeds the validated payload
bounds below; the schema and its skill stay valid. Other keywords, including `$ref`, `$id`, `pattern`, `format`, and
`patternProperties`, make the schema invalid, which drops its skill. Schemas are objects, not boolean schemas;
remote references and format assertions are not supported.

| Bound | Limit |
|---|---:|
| Skills per card | 64 |
| Extensions per card | 32 |
| Skill ID | 200 characters |
| Skill description | 1,000 characters |
| Tags per skill / characters per tag | 16 / 64 |
| Input or output modes per skill / characters per mode | 8 each / 128 |
| Features per skill / characters per feature | 16 / 200 |
| Extension URI | 512 characters |
| Inline schema | 16 KiB each, measured like typed metadata |
| Typed metadata (`skills` + `extensions`), measured as UTF-8 inside the event's escaped `content` | 32 KiB (32,768 bytes) |
| Schema nesting depth | 16 |
| Total object properties per schema | 256 |
| Total schema nodes | 512 |
| Validated payload nesting depth | 64 |
| Validated payload nodes | 16,384 |

Sizes are the UTF-8 bytes a value takes up inside the signed event's `content` string: the card text is
JSON, and the event escapes it again, so a quote or backslash counts more than once. Publishers MUST
check the typed metadata limit before publishing; readers ignore typed metadata over it.

### Typed payload validation

A handler MAY register an `AgxTaskContract` containing the typed skill fields other than `id`. At
registration the reference client applies every skill rule above, refuses unknown contract fields, and
refuses a contract that would take the card past 64 typed skills or the typed metadata limit, so a
registered contract can always be published. It keeps its own copy of the contract and includes
registered contracts in discovery metadata while retaining the same legacy capability keys. Existing handlers without a
contract retain their previous behavior.

Values are validated as the JSON they become on the wire (`JSON.stringify`, read back): an `undefined`
member is absent, a `Date` is its string, and a value the encoding leaves out, such as a handler that
returns nothing, is checked as `null`. A value that cannot be encoded fails validation.

`request(..., { validate: true })` and `streamRequest(..., { validate: true })` opt into requester
preflight. The client resolves the peer card and checks the payload only against a valid `inputSchema`
on the skill whose ID is exactly the requested capability. A missing card, skill, or input schema, a
schema the client cannot apply, or a failed card lookup sends the payload without checking; a warning
about a different skill does not stop the check. A payload the schema refuses throws
`AgxInvalidInputError` locally and nothing is published; a peer's own `invalid_input` result arrives as
`AgxTaskFailedError`. This option performs no schema-driven fetch beyond normal peer-card resolution. That peer-card lookup runs before the request is
published, so `timeoutMs` does not cover it.

After authorization succeeds, a receiver with an input schema validates before invoking its handler.
Invalid input produces only the safe `invalid_input` failure; detailed paths remain in local logs.
Denied requesters receive no validation response and follow the normal plain-message trust path.
A request reusing the task ID of a task that is still active is refused before its payload is
validated, so a duplicate never answers for the running task. Otherwise an invalid request is answered
before it is registered as an active task or takes a concurrency slot, so a retry under the same task
ID is accepted. A task the requester has canceled sends no result, so
it never sends `invalid_output` either.
A handler result that violates its registered `outputSchema` produces `invalid_output` instead of a
completed result; a result that passes is sent as the value that was checked. Structured error codes and requester-side validation of remote results remain
outside this change. Validation uses only the bounded inline subset above and never evaluates schema
text as code.

## Correlation & replay

The initiator correlates a result to its pending request by `taskId` (carried as the transport
`contextId`). **Result sender binding (normative).** `taskId` correlation alone is insufficient: the
responder legitimately knows the `taskId` and could hand it to a third party, who could then forge a
`completed` result. An initiator therefore **MUST** bind each pending request to the peer it was sent
to and **MUST** drop a result whose sender is not that peer, leaving the pending request open so the
genuine peer's result (or the request timeout) still settles it.

A **receipt** (rumor kind 3839) additionally acks message delivery, keyed by the message's **rumor
id** (`refEventId`). **Message identity is the rumor id, not the wrap id**: a sender that re-wraps the
same rumor (a retry) produces a new wrap and the same rumor id, so a recipient deduping on it still
sees one message, and the sender's receipt correlation still matches. **Replay protection**: every
inbound message **and** receipt is processed at-most-once by rumor id (a `SeenStore`, in-memory by
default, durable in a host that provides one), so overlapping poll windows, the backdate lookback and
redelivery are safe. The store also records **envelope** (wrap) ids — of every processed event, and of
every wrap the binding could not open or trust — and a binding **SHOULD** consult it before
decrypting, so a re-scanned window costs a lookup rather than a decryption per event, and a junk wrap
addressed to an agent is opened once, not on every poll until it expires (reference:
`poll({ isKnown })`, `transportId`, `discarded`).

**Receipt statuses (normative).** A receipt's `status` says how far the acknowledged message got:

| `status`      | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `quarantined` | Received and held for the recipient's human (an unaccepted sender)          |
| `delivered`   | Received and handed to the recipient's agent                               |
| `read`        | The recipient's agent has processed the message (since `0.5.0`)            |

A message can move forward through these (`quarantined` then `delivered` once a human accepts the
sender; `delivered` then `read`), so a recipient **MAY** send more than one receipt for the same
message, at most one per status. A `read` receipt **MAY** carry `readAt`, an ISO 8601 date-time with
offset for when the agent read it; it is advisory, a reader drops an unusable value and keeps the
receipt, and it is meaningless on any other status. A sender **SHOULD** treat statuses as
forward-only: a receipt that arrives late never moves a message back (`delivered` after `read`).
A receiver **MUST** ignore a well-formed receipt whose `status` it does not know — discard it
without treating it as malformed — so new statuses can be added without breaking older peers.
Implementations before `0.5.0` predate this rule and discard a `read` receipt as malformed: safe,
but they log it.

**Cursor advance (normative).** A cursor advances only when a poll was complete, so an unreachable
source never skips unseen events. On a complete poll it advances to the **poller's own clock, read
before the poll** — not to any event's `created_at`. Every later event then carries `created_at >=
that time - pollLookbackSec`, which the next poll (`since = cursor - overlap - pollLookbackSec`)
still reaches, while an already-processed event drops out of the window a bounded time after it was
processed, whatever the traffic. (An event-time watermark trails real time by up to the backdate on a
backdating transport, and never moves on a quiet inbox, so its last event would stay in the window
until the relay expired it — outliving any replay store.) Because `created_at` is **sender-declared**,
implementations **MUST** skip, without marking seen, an event dated beyond a bounded future skew
(reference: 300s); it is re-polled once it is no longer ahead.

## Authorization (normative)

A registered capability handler is executable by **any peer that can reach the agent** — a task
request arrives from an arbitrary pubkey on an open relay. Authorization is therefore **default-deny**:
an implementation **MUST** drop a task request *before* dispatching it to the handler unless an
authorization decision (in `AgxClient`, the `authorize` hook, evaluated per `{ from, capability }`)
explicitly allows it. Accepting every request is permitted **only** as a deliberate, explicit opt-in
(the `authorize: "accept-all"` sentinel). An implementation with no policy configured **MUST** deny
(fail closed) and **SHOULD** surface a one-time warning so the misconfiguration is visible rather than
silently swallowing traffic. A denied request receives **no reply** (an error result would confirm the
identity + capability set to an unauthenticated peer) and is **not** dispatched to the handler; it
falls through to the plain-message path (`onMessage`) so a host that gates all inbound traffic there
(peer registration, audit, counters) still sees it rather than losing it silently. A host may instead
satisfy this by routing inbound messages through its own trust flow rather than registering handlers
directly (see "Unhandled task traffic").

## Automated-reply depth (normative)

Two agents that each answer every message they receive form a loop the protocol cannot
see. Every message in it is well-formed, authorized, correlated, inside its size bound, and
signed by a key the other side allowlisted; replay protection sees nothing wrong, because
every reply is a new event with a new id. Neither side has any evidence the other is not a
human. AGX carries no hop count and no message TTL, so the payload gains one optional field
describing the *reply* relationship.

A message payload **MAY** carry `autoDepth`: a non-negative integer counting the consecutive
machine-generated replies in this message's causal chain. It is **OPTIONAL** and
absent-tolerant. An implementation **MUST** treat an absent `autoDepth` as `0`, and **MUST
NOT** reject, quarantine, downgrade, or withhold a receipt from a message that omits it.

A value that is present but **unusable** — negative, non-integer, out of range, or not a
number at all — **MUST** be treated exactly as an absent one, i.e. as `0`. An implementation
**MUST NOT** fail to deliver a message because `autoDepth` was malformed. This field bounds
*replies*; a peer whose counter does not saturate the way this document expects must still be
able to reach us. Rejecting the payload would let an optional advisory field make a peer
silently unreachable, and would surface to its operator as a decode failure rather than as
the range violation it actually is. A sender **SHOULD** clamp its own value into range rather
than emit one outside it.

An implementation that sends a message **as an automated reply to an inbound message MUST**
set `autoDepth` to `(inbound.autoDepth ?? 0) + 1`. An implementation that sends a message a
human **authored, approved, or explicitly asked for**, or that opens a new conversation,
**MUST** set `autoDepth` to `0` (equivalently, omit it). A human touching a conversation
therefore resets its depth, and an exchange with a human in the loop on either side never
accumulates any.

An implementation **SHOULD** refuse to send an automated reply whose resulting `autoDepth`
would exceed a local ceiling (reference: 8), and **SHOULD** surface that refusal to its own
operator rather than to the peer. An implementation **MAY** decline to auto-answer an inbound
message whose `autoDepth` already meets its ceiling; if it does, it **MUST** still process
that message by its normal non-reply path — filing, notifying, receipting. **The ceiling
bounds replies, not delivery.** An implementation **MUST** give a human some way to reset a
conversation's depth, or the ceiling is a permanent block rather than a circuit breaker.

Peers may enforce different ceilings; the lower one terminates the exchange first, which is
the intended behaviour and needs no negotiation.

`autoDepth` is **sender-declared and is not a security boundary**: a peer may omit it, reset
it, lie about it, or restart under a fresh `contextId` to shed whatever per-conversation
state the recipient was keeping. It is a cooperation signal that lets two well-behaved
implementations terminate a loop in a bounded number of exchanges with no shared state. Every
implementation **MUST** additionally enforce its own local bound on automated replies per
conversation and per peer, and **MUST NOT** rely on `autoDepth` alone.

The **per-peer** half of that is not garnish. A conversation identifier is chosen by whoever
opens the conversation, so a bound keyed only on it is reset by minting a new one — which an
automated sender can do on every single message, at no cost, without ever tripping a
per-conversation counter. Peer identity is the part that cannot be re-picked, so it is what a
bound must be anchored to in order to mean anything.

The `role` field of the message payload is A2A's turn label. AGX does not interpret it, does
not populate it meaningfully (the Nostr binding writes `"user"`), and implementations **MUST
NOT** derive automation, trust, or authorization from it. It answers *who is speaking*, which
is not the question that terminates a loop.

A task result (`res`) is terminal by construction and a receipt (rumor kind 3839) never elicits a
reply, so neither carries `autoDepth`.

## Evidence (optional)

A message payload **MAY** carry `evidence`: records the sender read from its own system of record
and quotes in support of the message text, so a receiver can show what a claim rests on rather than
only the prose an agent wrote about it.

```json
"evidence": {
  "v": 1,
  "records": [{
    "key": { "field": "roNumber", "value": "0057658556" },
    "fields": { "status": "Repair In Process", "branch": "Eastside" },
    "observedAt": "2026-10-20T14:03:11.000Z",
    "source": "DMS"
  }]
}
```

- `v` is `1`. `records` holds 1 to 20 records.
- `key` names the record: a field name and its value (string or number).
- `fields` holds 1 to 12 fields, each a string, number, boolean or `null`.
- `observedAt` is the ISO 8601 time the sender's tool returned the record.
- `source` is an optional human label for the system of record.
- Field names, `key.field` and `source` are at most 200 characters. String values are at most 500.

Evidence is **sender-declared**. The signature proves who sent it, not that the records are true or
current, so a receiver decides whether to trust it. For example, Ellaworks trusts it only when the
sender is a team hosted on the same deployment, whose egress checked each record against the stored
tool result before signing. Other receivers may show it as the sender's claim or ignore it.

Evidence **never affects delivery**. A receiver that cannot read it (wrong version, a bound
exceeded, a malformed time) **MUST** treat the whole `evidence` member as absent, never part of it,
and **MUST** still deliver and receipt the message. A sender **SHOULD** refuse to send evidence that
does not fit these bounds rather than send what the receiver will drop. Peers that predate this
member strip it as an unknown key and deliver the message as before, so a sender cannot tell whether
the receiver read it. Evidence counts toward the message size limit below.

## Message size (normative)

The confidential transport imposes a plaintext byte ceiling. For the Nostr binding this is NOT
NIP-44's 65535-byte limit: what governs OUTBOUND is the smaller **interop** ceiling, the largest
rumor whose gift wrap a default-configured (65536-byte) peer relay will store — 28672 bytes, derived
as `INTEROP_MAX_PLAINTEXT_BYTES`. Two NIP-44 layers each base64-inflate the one inside them, which is
why this is well below the single-layer 40960 of `0.1.0`, and why the reference send cap `MAX_BODY` is
27400 characters. NIP-44's limit (on the seal, the larger layer) still governs what a peer may send US,
and the two are deliberately different numbers — a binding that sizes only off NIP-44 will emit
messages that encrypt fine and are refused at the recipient's relay. Because a binding may serialize
the body — the Nostr binding JSON-escapes it inside the payload and again inside the rumor, inflating
quotes/newlines/control chars 4x or more — the size check **MUST** be applied to the **serialized
rumor the transport actually encrypts**, not to the raw body. An oversize payload
**MUST** fail cleanly (request rejected up front; result replaced with a `result too large` failure)
and **MUST NOT** surface as a transport-level throw / 5xx. The byte ceiling is a property of the
transport, so the core defers the byte verdict to the transport (reference: `AgxTransport.canCarry`).
