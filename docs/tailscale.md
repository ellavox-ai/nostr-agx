# Tailscale transport (opt-in)

AGX keeps Nostr as its transport. Tailscale is only a **network path**: the SDK
starts a bundled tsnet node, exposes a loopback SOCKS5 proxy, and `NostrTransport`
sends relay WebSockets through it. No `tailscale` command has to be installed,
and no `tailscale serve` rule, tailnet URL adoption, Funnel or public listener is
involved.

Everything here is opt-in. A profile that never enables Tailscale behaves
exactly as before.

```
this machine                                    tailnet
┌────────────────────────────────────────┐       ┌──────────────────────┐
│ AGX → NostrTransport                  │       │ private Nostr relay  │
│        │ relayProxy: socks5h://…      │       │ wss://relay.*.ts.net │
│        ▼                              │       └──────────────────────┘
│ bundled tsnet node (SDK) ─────────────┼──────────────►
└────────────────────────────────────────┘
```

The CLI and the SDK use the same package:

- **CLI:** `agx tailscale …` stores the opt-in and credentials, then `agx serve`,
  `agx relay` and `agx gateway` start the SDK proxy automatically.
- **SDK:** [`@nostr-agx/tailscale`](../packages/tailscale/README.md) starts the
  node programmatically for an application that creates its own transport.
  `@nostr-agx/nostr` has no Tailscale dependency.

```ts
import { NostrTransport } from "@nostr-agx/nostr";
import { tailscaleRelayProxy } from "@nostr-agx/tailscale";
import WebSocket from "ws";

const transport = await NostrTransport.create({
  signer,
  relays: ["wss://relay.private.ts.net"],
  ws: WebSocket,
  relayProxy: tailscaleRelayProxy({
    authKey: process.env.TS_AUTHKEY, // or environmentAuthKey() / oauthAuthKey(...)
    hostname: "my-agent",
  }),
});
```

`authKey` accepts a direct string, `environmentAuthKey()`, `oauthAuthKey()`,
`customAuthKey()`, or `firstAuthKey(...)` chaining several sources. The OAuth
provider mints a short-lived, tagged, one-off key from a provisioning secret;
the secret is never handed to the agent. `startTailscaleRelayProxy()` returns a
`{ url, stop() }` handle when your code owns the node's lifecycle. See the
[package README](../packages/tailscale/README.md) for the full API.

## Prerequisites

1. A Tailscale auth key, or an OAuth client that can obtain one.
2. A relay reachable on the tailnet, and ACLs that allow the tagged agent node
   to reach it (see below).
3. Node 20+ on this machine; the launcher binary is bundled with the package.

No local `tailscale` daemon, HTTPS certificate setup, or port forwarding is
required for the CLI path. Tailnet MagicDNS names in relay URLs are resolved at
the proxy (`socks5h:` normalization), so `wss://relay.<tailnet>.ts.net` works as
a configured relay URL.

## Quick start (auth key)

Keep the key out of shell history and `ps` by piping it on stdin:

```bash
printf %s "$TS_AUTHKEY" | agx tailscale enable --auth-key-stdin
agx serve
```

`enable` stores the opt-in and the key for the active profile, then briefly
starts and stops the proxy to verify the credentials. Any long-running command
with Tailscale enabled starts its own proxy and stops it on shutdown.

## Quick start (OAuth)

Point AGX at an authentication service and store the client secret privately:

```bash
printf %s "$CLIENT_SECRET" | agx tailscale enable \
  --oauth-url https://api.tailscale.com/api/v2/oauth/token \
  --oauth-client-id "$CLIENT_ID" \
  --oauth-client-secret-stdin \
  --oauth-scope auth_keys
```

Two response shapes are supported:

- **A custom service** may answer `{ "authKey": "tskey-…" }` directly.
- **Tailscale's OAuth endpoint** answers `{ "access_token": … }`. The SDK
  exchanges that token for an ephemeral, preauthorized key through the Tailscale
  API (`--oauth-api-base-url`, `--oauth-tailnet`, `--tag`). The key is tagged
  `tag:agx-agent` by default; override it with `--tag` or `AGX_TAILSCALE_TAGS`.

The key is minted only when a proxy is created. A client secret is never passed
to the node or printed.

Environment overrides: `AGX_TAILSCALE_AUTH_KEY`, `TS_AUTHKEY`,
`AGX_TAILSCALE_OAUTH_CLIENT_ID`, `AGX_TAILSCALE_OAUTH_CLIENT_SECRET`,
`AGX_TAILSCALE_OAUTH_URL`, `AGX_TAILSCALE_OAUTH_SCOPE`, `AGX_TAILSCALE_TAILNET`,
`AGX_TAILSCALE_OAUTH_API_BASE_URL`, `AGX_TAILSCALE_TAGS`,
`AGX_TAILSCALE_HOSTNAME`, `AGX_TAILSCALE_STATE_DIR`, and `AGX_TAILSCALE=1|0`.

## Running the services with Tailscale

Once a profile is opted in, these commands use Tailscale automatically:

```bash
agx relay --tailscale     # start a local relay and its own SOCKS5 proxy
agx gateway --tailscale   # route the gateway's relay WebSockets through the proxy
agx serve --tailscale     # route this agent's relay WebSockets through the proxy
```

- `--tailscale` opts in for one run even when the profile has not.
- `--without-tailscale` ignores the profile's opt-in for one run.
- `AGX_TAILSCALE=0` does the same for every command in the process.

`agx relay` and `agx gateway` keep serving locally if Tailscale fails; they
print a warning instead of taking the local service down.

## Tailnet ACLs for agent nodes

The minted key gives the node the `tag:agx-agent` identity; your tailnet policy still has to allow
that identity to reach the relay. If the relay is published as a **Tailscale Service**, the Service
must be a grant destination. `autoApprovers.services` only lets tagged hosts advertise and approve
the Service — it does not grant clients access to it.

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
`wss://cluster-relay.<tailnet>.ts.net`). `svc:…` is a policy selector, not a hostname. If the
Service itself has a service tag, you can grant `dst` to that tag instead of the individual Service
name. A broad `src: ["*"], dst: ["*"]` grant also works, but gives every tailnet node access.

`tsnet` ignores an auth key when its state directory already contains an
enrolled node, so an old identity (and old tags) can persist. AGX therefore uses
a fresh ephemeral node per run by default. Pass `--state-dir <path>` (or set
`AGX_TAILSCALE_STATE_DIR`) only when you intentionally want to reuse state.

## Commands

| Command | What it does |
| --- | --- |
| `agx tailscale enable` | Store the opt-in and auth route, then verify the proxy (use `--no-up` to only store it). |
| `agx tailscale up` | Verify the stored (or one-off) key can start the proxy; prints its SOCKS5 URL. |
| `agx tailscale status` | Show opt-in, auth readiness and proxy settings; never prints a key. |
| `agx tailscale disable` | Stop starting a proxy for this profile (`--forget` deletes stored secrets). |

Useful options:

- `--hostname <name>`: node name (default `agx-<profile>`).
- `--state-dir <path>`: persistent tsnet state dir (default: fresh per run).
- `--auth-key-stdin` / `--oauth-client-secret-stdin`: keep credentials out of
  argv and shell history.
- `agx tailscale disable --forget`: delete this profile's stored secrets.

## Where the secrets live

`~/.agx/profiles/<name>/tailscale.json` (mode `0600`) holds:

```json
{
  "version": 1,
  "authKey": "tskey-…",
  "oauthClientSecret": "…",
  "updatedAt": "2026-11-16T00:00:00.000Z"
}
```

Nothing Tailscale-related is written to `config.json`. Only `authKey` and
`oauthClientSecret` go to that private file; both are registered for output
redaction before any command that could print an error. The SDK hands the key to
the launcher through its environment, never argv.

## Troubleshooting

- **No auth key is configured** — pipe one with `--auth-key-stdin`, configure
  OAuth, or use `AGX_TAILSCALE_AUTH_KEY` / `TS_AUTHKEY`.
- **OAuth `invalid_client`** — check the client id, secret and `auth_keys` scope;
  nothing is sent to the node until a key has been minted.
- **Proxy fails to join** — check the key has not expired, the device is not
  rejected in the admin console, and the tag exists in tailnet policy.
- **A peer cannot connect** — the relay URL must be reachable on the tailnet and
  allowed by its ACLs. A wrong tag on the node is usually caused by a reused
  state dir (see above).
- **No bundled launcher for this platform** — rebuild with
  `pnpm --filter @nostr-agx/tailscale build:launcher`, or set
  `AGX_TAILSCALE_BINARY` to a local build.
