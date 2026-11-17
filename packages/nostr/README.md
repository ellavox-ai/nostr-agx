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

## Private relays (SOCKS5, opt-in)

`NostrTransport` can dial relays through a SOCKS5 proxy with the `relayProxy` field. It accepts a
URL, a `{ url, stop() }` handle, or a lazy resolver:

```ts
const transport = await NostrTransport.create({
  signer,
  relays: ["wss://relay.private.ts.net"],
  ws: WebSocket,
  relayProxy: "socks5://127.0.0.1:1080",
});
```

A bare URL is borrowed — the transport leaves it running and can be restarted. A handle is owned —
`transport.stop()` closes it, and that transport cannot be restarted.

Proxy routing needs an explicit WebSocket implementation (`ws` in Node), because the global WHATWG
WebSocket has no socket/agent options. Hostnames are resolved by the proxy (`socks5h` semantics).

For a tailnet, install [`@nostr-agx/tailscale`](../tailscale/README.md): it starts a
local tsnet node, supplies composable auth-key providers (direct, env, OAuth, custom), and returns a
`relayProxy` value that hands the node's lifecycle to the transport.

> Status: **0.2.0 (draft)** — tracks the NIP-AGX spec in `@nostr-agx/core`'s `SPEC.md`.
