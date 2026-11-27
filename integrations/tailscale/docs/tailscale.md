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
WebSocket—operator relays and peer-advertised NIP-65 relays—is handed to the
local tsnet proxy. That does not mean every connection travels over the tailnet.
The proxy dials each destination with tsnet's `Dial`, and where the connection
leaves this machine depends on the address:

| Destination | Where the connection goes |
|---|---|
| A node on your tailnet (its tailnet address or MagicDNS name) | Over the tailnet. |
| An address inside a subnet route that another node on your tailnet advertises | Over the tailnet to that node, but only when this node accepts subnet routes. In tsnet v1.104.7 that is on by default on Windows and off on Linux and macOS, and the launcher has no option to change it. |
| Anything else: a public relay, a peer-advertised relay, `127.0.0.1`, an address on your local network | Out of this machine's own network connection, not through the tailnet. The destination sees this machine's IP address, and a hostname that is not a tailnet name is looked up with this machine's DNS resolver. |

So public relays are **reachable** (if this machine can reach them), but they
are **not hidden**: the tailnet does not protect this machine's IP address from
them. In the last row, tsnet's own source comment describes the path as
connecting "without going over Tailscale". Whether a VPN, or a Tailscale client
that is already running on this machine, also carries these connections was not
checked and can depend on the platform.

- tsnet can send non-tailnet addresses through an exit node when one is
  selected on the node. The launcher never selects one, and neither the SDK nor
  the CLI has an option for it, so the last row above does not change.
- Peer-advertised relays are dialed the same way. `@nostr-agx/nostr` only
  accepts a peer's relay if it is a `wss://` URL that resolves to a public
  address, so a peer-advertised relay is never the address of a node on your
  tailnet.
- The proxy does not limit where it dials. A relay URL you configure that points
  at `127.0.0.1` or a local-network address is dialed from this machine like any
  other. `agx` only asks the proxy to dial relay WebSockets: the relays you
  configured, and peer relays that pass the public-address check. The launcher
  itself accepts any destination from a client that has its per-run SOCKS5
  credentials.

Use this integration for relays that live on your tailnet. Do not count on it to
hide this machine's IP address from public relays or from a peer's advertised
relays.

This describes tsnet v1.104.7, the version pinned in `launcher/go.mod`
(`net/tsdial` `dialOneUser` and `SystemDial`, `tsnet` `UseNetstackForIP`, and
`ipn` `NewPrefs` with `DefaultRouteAll` for the subnet-route default). It is read
from that source and was not run against a tailnet. Check it again when you
upgrade tsnet.

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

## Tailscale log upload

By default the bundled tsnet node uploads Tailscale's client logs to Tailscale's
logging service, `log.tailscale.com`, and the launcher does not turn that off.
Tailscale describes these logs as information about the client's own operation
and its attempts to contact other nodes; its
[logging overview](https://tailscale.com/docs/features/logging) and privacy
policy say what is collected and how it is used.

To opt out, `TS_NO_LOGS_NO_SUPPORT=true` has to be in the environment of the
launcher process. Tailscale's documentation says this also opts the device out
of any support that would need those logs.

The opt-out has side effects. These come from reading tsnet v1.104.7 and
Tailscale's pages on [logging](https://tailscale.com/docs/features/logging) and
[network flow logs](https://tailscale.com/docs/features/logging/network-flow-logs);
none of it was run against a tailnet.

- The node tells the control server that it opted out: the host information it
  sends carries a `NoLogsNoSupport` field that is set from the variable.
- The node does not report network flow logs (the admin console's record of
  which nodes connected to which). Tailscale's page says nodes report flow
  information "when network flow logs are enabled (and not using
  `--no-logs-no-support`)".
- A tailnet that has network flow logs turned on can stop the node. When the
  opt-out is set and this node's capabilities in the control server's network map
  include `data-plane-audit-logs` (the same source uses that capability to switch
  network flow logging on for a node), tsnet sets the node to not running and
  reports that the "tailnet requires logging to be enabled"
  (`ipn/ipnlocal/local.go`, `setControlClientStatusLocked`). So do not use the
  opt-out on a tailnet that needs flow logs; ask whoever runs the tailnet first.

Today that variable does not reach the launcher on its own: the SDK starts it
with only `HOME` and the auth key, so setting `TS_NO_LOGS_NO_SUPPORT` in your
shell has no effect. There is no `agx` or SDK option for it. What works today is
a small wrapper script that you start in place of the bundled launcher by
setting `AGX_TAILSCALE_BINARY` (or the SDK's `binary` option) to its path:

```sh
#!/bin/sh
export TS_NO_LOGS_NO_SUPPORT=true
exec /path/to/bin/<platform>/agx-tailscale "$@"
```

Make it executable. `<platform>` is the folder for your system under the
package's `bin/`, such as `darwin-arm64` or `linux-x64`. This was checked on
macOS by watching the bundled launcher's network connections: without the
variable it tried to reach `log.tailscale.com`, and with it it did not. The
wrapper is a shell script, so it has not been tried on Windows.

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
