# @nostr-agx/core

Transport-agnostic **NIP-AGX** protocol core. It makes an agent-exchange *correct and interoperable
by default* so an adopting runtime only decides *what to do with a task*.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

`@nostr-agx/core` owns: A2A task/message/receipt shapes, the **task lifecycle** state machine,
**correlation** (receipt↔sent, reply↔thread), **receipts**, **replay protection**, **capability
matching**, and **content-type dispatch** — all over an injected `AgxTransport`. The Nostr transport
binding is [`@nostr-agx/nostr`](https://www.npmjs.com/package/@nostr-agx/nostr).

```ts
import { AgxClient } from "@nostr-agx/core";
import { localSigner, NostrTransport } from "@nostr-agx/nostr";

const agx = new AgxClient({
  transport: await NostrTransport.create({
    signer: localSigner(secretKey),
    relays,
    ws: WebSocket,
  }),
});

// The runtime only writes handlers; the library owns dispatch → lifecycle → result → receipt.
agx.handle("invoice.review", async (task) => {
  await task.report?.("reviewing");
  return paperclip.run(task.payload);
}, {
  description: "Review an invoice against approval policy",
  inputSchema: {
    type: "object",
    required: ["amount"],
    properties: { amount: { type: "number", minimum: 0 } },
  },
  outputSchema: {
    type: "object",
    required: ["approved"],
    properties: { approved: { type: "boolean" } },
  },
});

await agx.start();

const result = await agx.request(peer, "invoice.review", { amount: 25 }, {
  validate: true, // Optional peer-card input preflight.
  onTaskStatus(update) {
    console.log(update.seq, update.message); // Ordered `working` updates; request stays pending.
  },
});
```

Contracts are optional. Authorized invalid input returns `invalid_input` without running the handler;
invalid handler output returns `invalid_output`. Detailed validation paths stay local. Legacy handlers
and peers without typed schemas keep working, and validation never fetches a referenced schema.

> Status: **0.2.0 (draft)** — API is stabilizing alongside the NIP-AGX spec (`SPEC.md`).
