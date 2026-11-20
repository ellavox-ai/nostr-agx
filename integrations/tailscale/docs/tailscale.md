# Tailscale integration

Tailscale is only a **network path**: this package starts a bundled `tsnet`
node, exposes an authenticated loopback SOCKS5 proxy, and hands that proxy to
`NostrTransport` as its `relayProxy`. No `tailscale` command, `tailscale serve`
rule, tailnet URL adoption, Funnel or public listener is involved. The relay
itself must already be reachable on the tailnet.

```
this machine                                    tailnet
┌────────────────────────────────────────┐       ┌──────────────────────┐
│ AGX → NostrTransport                  │       │ private Nostr relay  │
│        │ relayProxy: socks5h://…      │       │ wss://relay.*.ts.net │
│        ▼                              │       └──────────────────────┘
│ bundled tsnet node (SDK) ─────────────┼──────────────►
└────────────────────────────────────────┘
```

## Install

```sh
npm install @nostr-agx/nostr @nostr-agx/tailscale socks-proxy-agent
```

`@nostr-agx/tailscale` is an optional integration for `@nostr-agx/nostr`.
Installing the transport alone does not pull in the bundled binaries. Install
both packages, plus `socks-proxy-agent`, when you want this path.

## Use

```ts
import { AgxClient } from "@nostr-agx/core";
import { NostrTransport } from "@nostr-agx/nostr";
import { tailscaleRelayProxy } from "@nostr-agx/tailscale";
import WebSocket from "ws";

const agx = new AgxClient({
  transport: await NostrTransport.create({
    signer,
    relays: ["wss://relay.private.ts.net"],
    ws: WebSocket,
    relayProxy: tailscaleRelayProxy({
      authKey: process.env.TS_AUTHKEY, // direct argument
      hostname: "my-agent",
    }),
  }),
});
```

`tailscaleRelayProxy()` returns a lazy `RelayProxyInput`. The node starts when
`NostrTransport.create()` runs, and `transport.stop()` closes the subscriptions
first, then stops the Tailscale child process. The transport cannot be
restarted afterwards: create a new one, or start Tailscale once and pass its
`.url`.

## Auth keys are composable

`authKey` accepts a direct string, a provider, or a lazy callback. Providers
ship for the common sources, and `firstAuthKey` chains them in order:

```ts
import {
  customAuthKey,
  environmentAuthKey,
  firstAuthKey,
  oauthAuthKey,
} from "@nostr-agx/tailscale";

tailscaleRelayProxy({
  authKey: firstAuthKey(
    // 1. an explicit argument or secret manager value
    process.env.DEPLOYED_TS_AUTHKEY,
    // 2. the usual environment variables
    environmentAuthKey(),
    // 3. a short-lived, tagged key minted on demand
    oauthAuthKey({
      clientId: process.env.TS_OAUTH_CLIENT_ID!,
      clientSecret: process.env.TS_OAUTH_CLIENT_SECRET!,
      // tags default to ["tag:agx-agent"]
    }),
    // 4. anything else, e.g. your control plane
    customAuthKey(() => controlPlane.tailscaleKey(agentId), "control-plane"),
  ),
});
```

An absent source falls through to the next one. A source that returns a
malformed key fails loudly instead of falling through.

## Routing scope

Tailscale routing is **all-or-nothing** for a transport: every relay
WebSocket—operator relays and peer-advertised NIP-65 relays—is dialed through
the tsnet proxy. Public relays are outside the tailnet, so unless you configure
the tsnet node's exit node, they will not be reachable over that path. Use this
integration for a tailnet-only transport, or split public and tailnet relays
across separate transports/profiles.

## Tailnet ACLs for agent nodes

The minted key gives the node the `tag:agx-agent` identity; your tailnet policy
still has to allow that identity to reach the relay. If the relay is published
as a **Tailscale Service**, the Service must be a grant destination.
`autoApprovers.services` only lets tagged hosts advertise and approve the
Service — it does not grant clients access to it.

```jsonc
{
  "tagOwners": {
    "tag:agx-agent": ["autogroup:admin"],
    "tag:load-balancer": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:agx-agent"],
      "dst": [
        "tag:relay-load-balancer", // direct access to relay hosts
        "svc:cluster-relay"        // access to the Service VIP / MagicDNS name
      ],
      "ip": ["*"]
    }
  ],
  "autoApprovers": {
    "services": {
      "svc:cluster-relay-stage": ["tag:relay-load-balancer"]
    }
  }
}
```

Use the Service's normal MagicDNS name in the relay URL (for example
`wss://cluster-relay.<tailnet>.ts.net`). `svc:…` is a policy selector, not a
hostname. If the Service itself has a service tag, you can grant `dst` to that
tag instead of the individual Service name.

## Bundled launcher

The native launcher for the host platform ships inside the package under
`bin/<platform>/`. Set `AGX_TAILSCALE_BINARY` to use your own build instead.
The binaries are cross-compiled from `launcher/` with:

```sh
pnpm build:launcher
```

`make -C launcher build-all` cross-compiles to `launcher/dist/<platform>/`,
then `scripts/stage-binaries.mjs` copies those files into `bin/`. Those
binaries are generated and are not checked in; stage them locally when testing.

## Troubleshooting

- **No auth key is configured** — set `TS_AUTHKEY` or
  `AGX_TAILSCALE_AUTH_KEY`, or configure one of the auth-key providers above.
- **OAuth `invalid_client`** — check the client id, secret and `auth_keys`
  scope; nothing is sent to the node until a key has been minted.
- **Proxy fails to join** — check the key has not expired, the device is not
  rejected in the admin console, and the tag exists in tailnet policy.
- **A peer cannot connect** — the relay URL must be reachable on the tailnet
  and allowed by its ACLs. A wrong tag on the node is usually caused by a reused
  state dir.
- **No bundled launcher for this platform** — rebuild with
  `pnpm build:launcher`, or set `AGX_TAILSCALE_BINARY` to a local build.
