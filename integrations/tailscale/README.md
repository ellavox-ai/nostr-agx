# @nostr-agx/tailscale

Opt-in Tailscale routing for `@nostr-agx/nostr`. It starts a local tsnet node with a launcher
that is **bundled in this package** (Go source in `launcher/`, prebuilt binaries in `bin/`), then
gives `NostrTransport` the authenticated loopback SOCKS5 proxy it needs to dial a relay that is
already reachable on your tailnet. No separate launcher package or optional platform dependencies
are required.

AGX stays on Nostr — Tailscale only supplies the network path. `@nostr-agx/nostr` has no Tailscale
dependency; its `relayProxy` hook and the optional `socks-proxy-agent` peer are opt-in. Nothing
changes for hosts that do not use them.

This is the **SDK integration** for applications that build their own transport.

It requires a version of `@nostr-agx/nostr` that exposes the `relayProxy`
transport option. Until that option is published, install a local build or a
prerelease of `@nostr-agx/nostr` when developing this package.

## Install

```sh
npm install @nostr-agx/nostr @nostr-agx/tailscale socks-proxy-agent
```

`@nostr-agx/tailscale` is an optional integration for `@nostr-agx/nostr`: installing the
transport alone does not pull in the bundled binaries. Install both packages, plus
`socks-proxy-agent`, when you want this path.

The native launcher for the host platform ships inside the package under `bin/<platform>/`. Set
`AGX_TAILSCALE_BINARY` to use your own build instead; `startBundledTailscale()` and
`bundledBinaryPath()` are exported for direct use. The binaries are cross-compiled from
`launcher/` with `pnpm build:launcher` (requires Go 1.27+).

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
`NostrTransport.create()` runs, and `transport.stop()` (called by `AgxClient.stop()` after the client
has started) closes the subscriptions first, then stops the Tailscale child process. The transport
cannot be restarted afterwards: create a new one, or start Tailscale once and pass its `.url`.

Omitting `relayProxy` entirely leaves the transport exactly as before.

## Examples: two agents over a private relay

Two runnable examples start one node and run a reviewer and a requester through its `relayProxy`.
The two transports borrow the same proxy URL; the example owns the node and stops it once at the
end. See the [example README](examples/README.md) for the full argument lists and notes.

With an auth key piped on stdin (or taken from `TS_AUTHKEY`). The key is not accepted as an
argument, because arguments show in process listings:

```sh
pnpm install && pnpm build   # at the repository root
printf %s "$TS_AUTHKEY" | \
  pnpm --filter @nostr-agx/tailscale example:two-agents-auth-key -- \
    --auth-key-stdin \
    --relay wss://relay.my-tailnet.ts.net
```

With a key minted through an OAuth client, keeping the secret on stdin:

```sh
printf %s "$CLIENT_SECRET" | \
  pnpm --filter @nostr-agx/tailscale example:two-agents-oauth -- \
    --client-id "$CLIENT_ID" \
    --client-secret-stdin \
    --relay wss://relay.my-tailnet.ts.net
```

## Keys are composable

`authKey` accepts a direct string, a provider, or a lazy callback. Providers ship for the common
sources, and `firstAuthKey` chains them in order:

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

An absent source falls through to the next one. A source that returns a malformed key fails loudly
instead of falling through.

`oauthAuthKey` performs the OAuth client-credentials exchange and then mints a **one-off, tagged,
pre-authorized** key through the Tailscale API. Keys default to a one-hour lifetime and ephemeral
devices; the node keeps its own key after enrollment, so the client secret never needs to reach the
agent's environment and the minted key is useful only for the first join. Tailscale requires at
least one tag on keys created this way: `oauthAuthKey()` defaults to `tag:agx-agent`, and any tags
you pass override it. The tag must already exist in tailnet policy and be allowed by the client.
`DEFAULT_TAILSCALE_OAUTH_TAGS` is exported if you want to extend the default.

The node still needs a tailnet ACL grant from `tag:agx-agent` to the relay. If the relay is a
Tailscale Service, add `svc:…` (or the Service's tag) to the grant's `dst`; `autoApprovers.services`
only approves Service hosts and does not grant access. See
[Tailnet ACLs for agent nodes](docs/tailscale.md#tailnet-acls-for-agent-nodes).

> Use the OAuth client to mint keys, not as the auth key itself. The client secret is a provisioning
> authority; an auth key is a single enrollment.

When `authKey` is omitted, `TS_AUTHKEY` and then `AGX_TAILSCALE_AUTH_KEY` are read from the
environment. The key is handed to the child through `TS_AUTHKEY` in its environment, never argv, and
is never logged.

## Other entry points

- `startTailscaleRelayProxy(config)` starts the bundled node immediately and returns a bare
  `{ url, stop() }` handle. Use it when you need the proxy lifecycle in your own code.
- `startBundledTailscale(options)` is the underlying launcher, and `bundledBinaryPath()` reports the
  binary selected for the current platform.
- `TailscaleError` carries a `code` (`configuration | auth | network | module`) and a `remediation`
  string, so a host can branch on the failure without parsing messages.
- `start` in the config replaces the launcher, which is useful in tests or with a custom binary.

### Using a proxy that is already running

If you start Tailscale once for the whole process, pass the proxy URL to the transport directly. The
transport will borrow it, not own it:

```ts
import { startBundledTailscale } from "@nostr-agx/tailscale";

const tailscale = await startBundledTailscale({ authKey, hostname: "my-agent" });

const transport = await NostrTransport.create({
  signer,
  relays: ["wss://relay.private.ts.net"],
  ws: WebSocket,
  relayProxy: tailscale.url, // socks5://127.0.0.1:PORT
});

// ... later
await transport.stop(); // leaves the Tailscale node running
await tailscale.stop();
```

A borrowed URL can be reused after `transport.stop()`; an owned handle cannot.

## Constraints

**Routing scope.** The proxy is all-or-nothing for a transport: every relay
WebSocket it owns (operator relays and peer-advertised NIP-65 relays) is dialed
through tsnet. Public relays are outside the tailnet, so unless you configure
the tsnet node's exit node, they will not be reachable over that path. Use this
integration for a tailnet-only transport, or split public and tailnet relays
across separate transports/profiles.

Proxy routing needs an explicit WebSocket implementation (`ws` in Node), because the global WHATWG
WebSocket has no socket/agent options. Operator-configured relay hostnames are resolved by the proxy
(`socks5h` semantics), so tailnet MagicDNS names work even when the host cannot resolve them.
Peer-advertised NIP-65 relays are vetted with local DNS first and dialed with those addresses
pinned, preventing a second proxy-side resolution from rebinding the name to a private address.
The launcher generates random SOCKS5 username/password credentials per run and prints them only to
the parent process in the proxy URL; do not log that URL.

**No global WebSocket mutation.** The transport injects a WebSocket implementation per relay dial, so
host code that dials `nostr-tools` directly is unaffected. Use separate transports (and separate
Tailscale state directories) for separate tailnet nodes.
