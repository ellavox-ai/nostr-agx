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

With an auth key passed as an argument (or from `TS_AUTHKEY`):

```sh
pnpm install && pnpm build   # at the repository root
pnpm --filter @nostr-agx/tailscale example:two-agents-auth-key -- \
  --auth-key tskey-auth-... \
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

- `startTailscaleRelayProxy(config)` starts the bundled node immediately and returns a
  `{ url, stop(), onExit() }` handle. Use it when you need the proxy lifecycle in your own code.
- `startBundledTailscale(options)` is the underlying launcher, and `bundledBinaryPath()` reports the
  binary selected for the current platform.
- `TailscaleError` carries a `code` (`configuration | auth | network | module`) and a `remediation`
  string, so a host can branch on the failure without parsing messages.
- `start` in the config replaces the launcher, which is useful in tests or with a custom binary.

### State directory, exit notice, environment and logs

- **Exit notice.** The handle from `startTailscaleRelayProxy()` and `startBundledTailscale()` has
  `onExit(listener)`. The listener gets `{ code, signal }` if the launcher ends without `stop()`
  having been called (it crashed, or was killed from outside); after that the proxy URL no longer
  works. It returns a function that removes the listener. A transport that is given the handle keeps
  only `url` and `stop()`, so subscribe before handing it over. A listener that throws does not end
  your process and does not stop the listeners after it: the error is printed as a process warning
  (code `AGX_TAILSCALE_ONEXIT_LISTENER`) and, on the handle from `startBundledTailscale()`, kept in
  `listenerErrors`. Each listener is called once.
- **State directory.** Without `stateDir`, each node gets its own private temporary directory
  (`agx-tailscale-XXXXXX` in your operating system's temporary folder, mode 0700, POSIX).
  It holds the node's private keys, so it is deleted as soon as the launcher stops. Pass `stateDir`
  to keep a node's identity between runs; a directory you pass is never deleted. tsnet ignores a
  new auth key once its state already holds a node, so a key's tags are applied only the first time
  a directory is used.
  - *Removed:* when `stop()` is awaited (or the launcher ends on its own), and, as a last resort,
    when the whole process ends through `process.exit()`, an uncaught exception or an unhandled
    promise rejection (checked by tests with a stand-in launcher). The last-resort removal is
    synchronous and best effort.
  - *Left behind:* when the process is ended by `SIGKILL`, or by a signal it has no handler for
    (`SIGINT`, `SIGTERM` and `SIGHUP` do that by default), because Node does not run the exit hook
    then. The same holds when V8 runs out of memory and when the process calls `process.abort()`
    (not run here; from Node's documentation of the `exit` event). Look in the temporary folder for
    `agx-tailscale-*` and delete what no running process uses.
  - This library installs no signal handlers, because that is the host's choice. A host that wants
    the directory removed on `Ctrl-C` handles the signal and awaits `stop()`.
  - The `agx` command line keeps its Tailscale state in its own per-run folder under `AGX_HOME`
    (`tailscale-runs/node-XXXXXX`) and removes it when the node stops, and also, as a last
    resort, when the process ends through `process.exit()`, an uncaught exception or an unhandled
    rejection. That includes a second `Ctrl-C` while `agx serve` is still stopping. A folder you
    name with `--state-dir` or in the profile is never removed. The `agx` folder is left behind in
    these cases, because Node does not run the exit hook for them: `SIGKILL`; `SIGHUP`
    (`agx serve` handles `SIGINT` and `SIGTERM` only; `SIGHUP` was sent to `agx serve` and to its
    process group, and the folder was left); V8 running out of memory; `process.abort()` (the last
    two from Node's documentation, not run); and a `Ctrl-C` or `SIGTERM` that reaches `agx serve`
    while it is still starting, before it prints "watching for messages", because it installs its
    two signal handlers only once the start is done (tried with a stand-in launcher that was
    slow to report its address; `main` has the same order, so this is not new). With
    the real launcher that window is the time it takes to join the tailnet. Delete `tailscale-runs/node-*`
    folders under `AGX_HOME` that no running `agx` uses.
  - A `Ctrl-C` in a terminal reaches `agx serve` and the launcher it started together. If serve
    sees the launcher end first, it starts to stop and prints the launcher notice; the signal that
    reaches it a moment later is taken as that same `Ctrl-C`, so serve finishes the stop and exits
    with status 5. A second signal ends it at once with status 130. If serve gets the signal first,
    the launcher's end is not reported and serve exits 0.
  - Windows has not been tried.
- **Environment.** The launcher gets `HOME` and the auth key, plus these when they are set and not
  empty: `USERPROFILE`, `SystemRoot`, `TMPDIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (upper and
  lower case) and `TS_NO_LOGS_NO_SUPPORT`. Nothing else from your environment reaches it, including
  `TS_AUTHKEY`, `TS_AUTH_KEY` and `AGX_TAILSCALE_AUTH_KEY`. The key comes only from the `authKey`
  option: `startTailscaleRelayProxy()` reads `TS_AUTHKEY` and `AGX_TAILSCALE_AUTH_KEY` for you when
  `authKey` is omitted, `startBundledTailscale()` does not. Windows has not been tried.
  - *Proxy logins.* A `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` or `https_proxy` value that has an
    `@` in it (`user:password@host`, with or without a scheme, valid address or not) is not passed
    on. One line on stderr names the variable and never its value. `NO_PROXY` and `no_proxy` are
    always passed on, and so is a proxy address without a login. Use a proxy address without a
    login for the launcher. Why: the Tailscale code inside the launcher logs the proxy it uses
    (`net/tshttpproxy/tshttpproxy.go` line 162, with the address from line 155), and, for every
    request through a proxy, the first 20 characters of the `Proxy-Authorization` header, which are
    `Basic ` and the start of the base64 of `user:password` (lines 226-234). That is the first 10
    bytes of `user:password`: a login of up to 10 bytes is in it in full, a longer one shows its
    first 10 bytes. Read in the source of v1.104.7 with `gh api` on 2026-11-27, and
    the format strings are also in the bundled macOS arm64 binary (read with `strings`, never run).
    Go's own error for a proxy address it cannot read, `invalid proxy address %q`
    (`golang.org/x/net/http/httpproxy`, `proxy.go` line 163 at v0.60.0, the version in
    `launcher/go.mod`), prints the raw value, login included; the skip above is what keeps a login
    out of it. Read in the source with `gh api` on 2026-11-27, not run. The proxy variables are the
    only proxy setting this package controls. On Synology Linux the Tailscale code also builds a proxy
    address, with a login, from `/etc/proxy.conf` (`proxy_user`, `proxy_pwd`:
    `net/tshttpproxy/tshttpproxy_synology.go` lines 102-105, wired in by `tshttpproxy_linux.go`
    lines 21-23, v1.104.7; read with `gh api` on 2026-11-27, not run). Such a login
    does not come from your environment, so it is not skipped; only the masking below covers it,
    in the two shapes it is printed in. Windows has its own system proxy code that was not read.
  - *What is done to the launcher's stderr.* This package reads it and writes it to your stderr one
    whole line at a time, as a second layer. Replaced with `***`: what sits between `://` and `@`
    in any URL, the `(auth "...")` text of that CONNECT line, a `Proxy-Authorization` header (to the
    end of its line) and any `Basic` followed by base64 text; a plain word that follows `Basic`
    is hidden too. Also changed: bytes that are not valid UTF-8 come out as the replacement character
    U+FFFD, a last line without a newline is written without one (so it runs into the next thing
    written to stderr), and at most 65,536 characters (64 KiB) of one line are kept: a longer line is
    written as its first 65,536 characters, masked, followed by ` [line cut]`, and the rest of that line is dropped. The
    launcher's stdout is not forwarded: it carries only the SOCKS5 address, which this package reads
    and never prints. The masking cannot cover a login in your own environment, which anything that
    can read your process's environment still sees. The masking knows the shapes the pinned
    Tailscale code prints. Three shapes that code never prints still pass it unchanged: a URL
    written with its slashes escaped for JSON (`http:\/\/user:pass@host`), a bare `user:pass@host`
    with no `://` before it, and a loose `Basic` value of fewer than 8 base64 characters (a login of
    about 4 bytes or less; the same login inside `(auth "...")` is masked). That is acceptable
    because a proxy variable with a login is not passed on at all, and a login the system supplies
    (the Synology file above) is printed only in the two shapes the masking covers.
  - *`TS_NO_LOGS_NO_SUPPORT`.* Tailscale reads it as a yes/no value and stops the whole launcher
    when it cannot read it. So the value is passed on only when it is one of `1`, `t`, `T`, `TRUE`,
    `true`, `True`, `0`, `f`, `F`, `FALSE`, `false`, `False`. Any other value is left out, with one
    line on stderr that names the variable and not its value.
- **Log upload.** tsnet uploads Tailscale client logs to `log.tailscale.com` by default.
  `disableLogUpload: true` sets `TS_NO_LOGS_NO_SUPPORT=true` for the launcher to turn that off, and
  it wins over the value in your environment. It is off unless you ask, and the `agx` command line
  has no flag for it yet. Side effects, as of 2026-11-27:
  - Tailscale's logging page says the switch "disables telemetry and opts the device out of any
    support that would require that telemetry for debugging"
    (<https://tailscale.com/docs/features/logging>, read live 2026-11-27).
  - The network flow logs page says "When network flow logs are enabled (and not using
    `--no-logs-no-support`), nodes report their flow information (for both ends of the connection)
    to the Tailscale logs service", so with the switch the node does not report flows
    (<https://tailscale.com/docs/features/logging/network-flow-logs>, read live 2026-11-27; the
    page says it was last validated on Oct 8, 2026).
  - In the source of the Tailscale release this package pins (v1.104.7), the node also tells the
    control server that it has opted out (`hostinfo/hostinfo.go` line 67), and if the control
    server's network map turns network flow logging on for the node, a node with the switch sets
    itself to not run and reports "tailnet requires logging to be enabled"
    (`ipn/ipnlocal/local.go` lines 2067-2081). The test there is for the capability
    `data-plane-audit-logs`, which the same source uses to switch flow logging on for the node
    (`NetLogIDs`, lines 8251-8259). Neither is stated on the docs pages above. They were read
    from the source, and not run here, so what the launcher does in that second case has not
    been tried.

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
