# Two agents over a Tailscale relay

Both examples here run a reviewer and a requester over a private Nostr relay. Each starts **one**
Tailscale node with the launcher bundled in this package — no separate Tailscale install — and both
transports use the node's loopback SOCKS5 URL as a *borrowed* `relayProxy`. The script stops the node
once after both agents finish. The shared agent flow lives in `run-agents.ts`.

| Example | How the key is obtained |
| --- | --- |
| `two-agents-auth-key.ts` | An `--auth-key` argument (or `TS_AUTHKEY` / `AGX_TAILSCALE_AUTH_KEY`). |
| `two-agents-oauth.ts` | Minted on demand from an OAuth client-credentials exchange. |

The relay must be a `wss://` (or `ws://`) name reachable from the tailnet. With MagicDNS and HTTPS
certificates enabled, use the relay's `.ts.net` name — the proxy resolves it, so the host does not
need tailnet DNS.

## Auth-key example

From the repository root, after `pnpm install && pnpm build`:

```sh
pnpm --filter @nostr-agx/tailscale example:two-agents-auth-key -- \
  --auth-key tskey-auth-... \
  --relay wss://relay.my-tailnet.ts.net
```

| Argument | Environment fallback | Meaning |
| --- | --- | --- |
| `--auth-key <key>` | `TS_AUTHKEY`, `AGX_TAILSCALE_AUTH_KEY` | Tailscale auth key. Required. Never printed. |
| `--relay <url>` | `AGX_RELAY` | Private Nostr relay URL. Required. |
| `--hostname <name>` | — | Tailnet node name (default `agx-two-agents`). |
| `--state-dir <path>` | — | Tailscale state dir (default: fresh temporary dir per run). |
| `--help` | — | Show usage without starting anything. |

An auth key on the command line can be captured in shell history; use the environment fallback on
shared machines. The key is passed to the launcher through its environment, not argv, and is never
logged.

## OAuth example

Create an OAuth client in the Tailscale admin console with the `auth_keys` scope, give it permission
to use a tag that exists in your tailnet policy (`tag:agx-agent` by default), then pipe the secret on
stdin:

```sh
printf %s "$CLIENT_SECRET" | \
  pnpm --filter @nostr-agx/tailscale example:two-agents-oauth -- \
    --client-id "$CLIENT_ID" \
    --client-secret-stdin \
    --relay wss://relay.my-tailnet.ts.net
```

| Argument | Environment fallback | Meaning |
| --- | --- | --- |
| `--client-id <id>` | `AGX_TAILSCALE_OAUTH_CLIENT_ID` | OAuth client id. Required. |
| `--client-secret-stdin` | — | Read the secret from stdin (recommended). |
| `--client-secret <s>` | `AGX_TAILSCALE_OAUTH_CLIENT_SECRET` | Inline secret; prefer stdin to avoid shell history. |
| `--tag <tag>` | `AGX_TAILSCALE_TAGS` (comma-separated) | ACL tag for the minted key; repeatable. Defaults to `tag:agx-agent`. |
| `--token-url <url>` | `AGX_TAILSCALE_OAUTH_URL` | Token endpoint (default `<api-base-url>/oauth/token`). |
| `--token-auth <method>` | `AGX_TAILSCALE_OAUTH_TOKEN_AUTH` | `basic` (default) or `post`. |
| `--scope <scope>` | `AGX_TAILSCALE_OAUTH_SCOPE` | OAuth scope, e.g. `auth_keys`. |
| `--tailnet <name>` | `AGX_TAILSCALE_TAILNET` | Tailnet for the key, or `-` (default). |
| `--api-base-url <url>` | `AGX_TAILSCALE_OAUTH_API_BASE_URL` | API base used to mint a key. |
| `--relay <url>` | `AGX_RELAY` | Private Nostr relay URL. Required. |
| `--hostname <name>` | — | Tailnet node name (default `agx-two-agents-oauth`). |
| `--state-dir <path>` | — | Tailscale state dir (default: fresh temporary dir per run). |
| `--help` | — | Show usage without starting anything. |

Both examples use a fresh temporary Tailscale state directory by default. `tsnet` ignores an auth
key when its state directory already contains an enrolled node, which would leave the node with an
older identity (and older ACL tags). Pass `--state-dir` if you intentionally want to reuse state.

`oauthAuthKey()` exchanges the client credentials and mints a **single-use, short-lived, tagged**
key. The client secret stays in this process and is never handed to the node or printed. A custom
authentication service may return `{ "authKey": "tskey-…" }` directly; Tailscale's endpoint returns
an access token that is exchanged through its API.

## Local dummy OAuth endpoint (real Tailscale API token)

`dummy-oauth-server.ts` is a loopback-only HTTP server for exercising the OAuth path without giving
the AGX process an OAuth secret from Tailscale. It validates an OAuth client-credentials request and
then uses a **real Tailscale API access token** (read from the environment, never passed to the
client) to mint a one-off auth key through the real API. The access token needs the `auth_keys`
scope and permission to use the tags in `DUMMY_OAUTH_TAGS`. The tags are defined by the server; the
client cannot choose them.

```sh
# Terminal 1: the server creates a dummy client and prints its id/secret once.
TAILSCALE_API_ACCESS_TOKEN=tskey-api-... \
  pnpm --filter @nostr-agx/tailscale dummy-oauth:server
```

Environment for the server:

| Variable | Meaning |
| --- | --- |
| `TAILSCALE_API_ACCESS_TOKEN` | Required. Real API token with `auth_keys` scope; stays in this process. |
| `TAILSCALE_API_BASE_URL` | API base (default `https://api.tailscale.com/api/v2`). |
| `DUMMY_OAUTH_CLIENT_ID`, `DUMMY_OAUTH_CLIENT_SECRET` | Client credentials. Generated and printed once if unset. |
| `DUMMY_OAUTH_PORT` | Listen port (default `8787`, loopback only). |
| `DUMMY_OAUTH_TAGS` | Comma-separated ACL tags the server puts on the minted key (default `tag:agx-agent`). Client-supplied tags are ignored. |
| `DUMMY_OAUTH_TAILNET` | Tailnet for the key, or `-` (default). |
| `DUMMY_OAUTH_EXPIRY_SECONDS` | Key lifetime (default `3600`). |

Check the flow with the small client (it authenticates, mints a key, and prints only its length):

```sh
export DUMMY_OAUTH_CLIENT_ID=... DUMMY_OAUTH_CLIENT_SECRET=...  # printed by the server
pnpm --filter @nostr-agx/tailscale dummy-oauth:client
```

Or run the full two-agent example against the dummy endpoint. The server answers
`{ "authKey": "tskey-…" }` directly, so `--tag` and `--api-base-url` are not needed — tags are set
server-side:

```sh
printf %s "$DUMMY_OAUTH_CLIENT_SECRET" | \
  pnpm --filter @nostr-agx/tailscale example:two-agents-oauth -- \
    --client-id "$DUMMY_OAUTH_CLIENT_ID" \
    --client-secret-stdin \
    --token-url http://127.0.0.1:8787/oauth/token \
    --relay wss://relay.my-tailnet.ts.net
```

The server accepts both `client_secret_basic` and `client_secret_post`, rejects invalid credentials
with `401 invalid_client`, and maps upstream API failures to `502 upstream_error` so the SDK reports
them as network errors. Secrets, tokens, and keys are never logged. This is a demo proxy — no
persistence, no refresh tokens, no consent — and is not intended for production.

If the relay is published as a Tailscale Service, the `tag:agx-agent` node also needs a grant whose
`dst` includes `svc:…` (or the Service's own tag). `autoApprovers.services` alone only approves the
Service hosts; it does not allow the agent to connect. See
[Tailnet ACLs for agent nodes](../../../docs/tailscale.md#tailnet-acls-for-agent-nodes).

## What both examples do

1. Obtain a key — directly, or via `oauthAuthKey({ clientId, clientSecret, tags })` — and call
   `startTailscaleRelayProxy()`, which joins the tailnet and returns `{ url, stop() }`.
2. Create two `NostrTransport` instances with `relayProxy: tailscale.url` and an explicit
   `ws: WebSocket` implementation (required for SOCKS5 routing).
3. The reviewer allows only the requester's generated key, registers `invoice.review`, and both
   agents start polling.
4. The requester sends a task and prints the result; a `finally` block stops both agents and then
   the Tailscale node.

`@nostr-agx/nostr` has no Tailscale dependency. For a single agent, `tailscaleRelayProxy({ authKey })`
returns a lazy `relayProxy` that the transport owns instead; see the
[package README](../README.md).
