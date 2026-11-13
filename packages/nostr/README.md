# @nostr-agx/nostr

The **Nostr transport binding** for [`@nostr-agx/core`](https://www.npmjs.com/package/@nostr-agx/core). Implements `AgxTransport` over
Nostr: messages and receipts as NIP-59 gift wraps (kind `1059`, sealing `3838`/`3839` rumors) with
NIP-40 expiration and NIP-13 proof-of-work, NIP-44 encryption, a pluggable `AgxSigner`
(NIP-07/NIP-46 shape) for every key operation, a relay pool (paged poll + publish-with-retries),
NIP-65 routing, NIP-42 auth, and Agent Card (`11337`) + NIP-05 discovery.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

```ts
import { AgxClient } from "@nostr-agx/core";
import { NostrTransport, generateKeypair, localSigner } from "@nostr-agx/nostr";
import WebSocket from "ws"; // Node (see Runtime below)

const agx = new AgxClient({
  transport: await NostrTransport.create({
    signer: localSigner(secretKey),    // or any NIP-07/NIP-46-shaped signer
    relays: ["wss://relay.example"],
    ws: WebSocket,                     // injected WebSocket impl
  }),
});

agx.handle("invoice.review", async (task) => paperclip.run(task.payload));
await agx.start();
```

### Typed Agent Card skills

`buildCard` and `NostrTransport.publishDiscovery` accept optional `skills` and `extensions`. Typed cards
use format version `1.1.0`; existing callers and legacy-only cards remain on `1.0.0`.

```ts
await transport.publishDiscovery({
  org: "Acme Finance",
  capabilities: ["invoice.review"],
  payloadTypes: ["application/json"],
  skills: [{
    id: "invoice.review",
    description: "Review an invoice against approval policy",
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: { amount: { type: "number", minimum: 0 } },
      additionalProperties: false,
    },
  }],
  extensions: [{ uri: "agx.task-status.v1", required: false }],
});
```

`resolvePeerCard` returns bounded, validated typed metadata plus `typedMetadataWarnings` listing what
was left out. Invalid typed metadata never hides valid legacy capabilities. An invalid skill is dropped
on its own (`invalid_typed_skill`) and the card's other skills stay usable; a structural failure or
typed metadata over 32 KiB, measured inside the event's escaped `content`, ignores the whole typed unit
(`invalid_typed_metadata`). Unknown fields on skills and extensions are ignored, and the schema
annotations `description`, `title`, `$schema`, `default` and `examples` are accepted and ignored.
Unknown required extensions hide typed skills but leave legacy fields usable; optional extensions are
retained. `buildCard` and `publishDiscovery` leave an invalid skill off the card instead of refusing
it (`buildCardWithWarnings` returns why; `publishDiscovery` logs it). `AgxClient` can enforce
these schemas for authorized task input and handler output, and offers opt-in requester preflight.
Validation never fetches references or treats claims as proof of quality. Agent Cards and schemas are
public and unencrypted.

`NostrTransport.create()` only constructs the transport. `AgxClient.start()` opens its relay subscriptions, and `AgxClient.stop()` closes both those subscriptions and their relay connections.
Live subscriptions replay a bounded recent window, skip envelopes already in the client's `SeenStore` before decryption, and record expired or invalid wraps there; polling remains the completeness and recovery path.

For a multi-turn human-in-the-loop example where a task handler asks several
sequential questions with `ctx.requestInput()` and the requester answers each
through `stream.provideInput()`, run
`pnpm dlx tsx examples/input-required-agent.ts` from `packages/nostr`.

For the same workflow split across **two real agents** — separate processes
with persistent identities, default-deny authorization, Agent Card discovery
and an autonomous requester, all over a local relay and each backed by any
local OpenAI-compatible LLM server — see
[`examples/two-agents`](examples/two-agents/README.md).

**Runtime:** Node. The transport dials WebSockets and the SSRF guard uses `node:dns` to vet
peer-supplied relay / NIP-05 hosts before connecting. `node:dns`/`node:net` are imported lazily so a
non-Node bundle doesn't fail to resolve them, but where DNS is unavailable (browser/edge) the guard
**fails closed** — hostname destinations are rejected (literal IPs are still vetted). Run it in a
Node runtime (`export const runtime = "nodejs"` on Next.js), not the edge runtime.

> Status: **0.2.0 (draft)** — tracks the NIP-AGX spec in `@nostr-agx/core`'s `SPEC.md`.
