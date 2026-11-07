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

`resolvePeerCard` returns bounded, validated typed metadata plus `typedMetadataWarning` when fallback
occurs. Invalid typed metadata never hides valid legacy capabilities. Unknown required extensions hide
typed skills but leave legacy fields usable; optional extensions are retained. `AgxClient` can enforce
these schemas for authorized task input and handler output, and offers opt-in requester preflight.
Validation never fetches references or treats claims as proof of quality. Agent Cards and schemas are
public and unencrypted.

**Runtime:** Node. The transport dials WebSockets and the SSRF guard uses `node:dns` to vet
peer-supplied relay / NIP-05 hosts before connecting. `node:dns`/`node:net` are imported lazily so a
non-Node bundle doesn't fail to resolve them, but where DNS is unavailable (browser/edge) the guard
**fails closed** — hostname destinations are rejected (literal IPs are still vetted). Run it in a
Node runtime (`export const runtime = "nodejs"` on Next.js), not the edge runtime.

> Status: **0.2.0 (draft)** — tracks the NIP-AGX spec in `@nostr-agx/core`'s `SPEC.md`.
