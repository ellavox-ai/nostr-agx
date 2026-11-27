# Changelog

## Unreleased

A note for library callers that has applied since 0.7.0 and is not new in this release: `NostrTransport.create()` no longer sets a process-wide WebSocket for `nostr-tools` (0.6.0 did). The functions that dial relays by themselves (`fetchByAuthor`, `fetchByAuthorWithStatus`, `resolvePeerCard`, `resolvePeerCardWithStatus`, `resolvePeerRelays`, `resolveNip05`) take the class as their `ws` argument, for example `resolvePeerCard(pubkey, relays, signer, ws)`. Without it they use the runtime's global WebSocket: Node 22 and later have one, and use it instead of `ws`; Node 20 has none, and there a lookup finds nothing and reports no error. Pass `ws`, or call `configureWebSocket(ws)` once, if your code runs on Node 20.

### Changed

- A relay proxy can no longer be combined with the runtime's built-in WebSocket (Node 22 and later) or a class that extends it. That class ignores the proxy agent, so it dialed the relay directly and the proxy was never used, with no error. `createProxyWebSocket`, `wrapWebSocket` and `NostrTransport.create({ relayProxy })` now refuse it with a `RelayProxyError` that says to pass the `ws` class. If your code passed the global `WebSocket` together with `relayProxy`, its traffic was not going through the proxy; pass the `WebSocket` class of the `ws` package instead (the CLI and the n8n nodes already do).
- `wrapWebSocket`, and so `createProxyWebSocket`, now checks the WebSocket class when it wraps it, if an agent is given: it builds one extra instance of the class, with a stand-in agent and a local socket path, and no network is used. A class that drops the agent on every construction makes `wrapWebSocket` throw a `RelayProxyError` at that point, and `createProxyWebSocket` rejects where the first dial used to throw. A class that counts its instances, or does work in its constructor, sees one more construction for each proxy class.
- The error shown when `socks-proxy-agent` cannot be loaded has new text: "could not load the optional socks-proxy-agent package: <reason>" instead of "requires the optional socks-proxy-agent package". Code that matches the old wording has to change; `error.cause` still holds the original error.
- `socks://` as a relay proxy URL: for relays a peer advertises, the proxy is now asked for the address that was looked up and checked on this machine, not the host name, as `socks5://` already did. For your own relays `socks://` still lets the proxy resolve the name.

### Fixed

- `agx card <peer>` found no card on Node 20, whatever the relay held, and printed "No Agent Card found" (exit 6). Node 22 and later were not affected.
- The `two-agents` example's requester did not find the reviewer's card on Node 20, for the same reason.
- A WebSocket class that drops the proxy agent on every construction (a subclass that does not pass its options on) is refused when the proxy class is created. Before, a relay given as a bare IP address saw a direct connection from this host before the class was refused on the first dial. A class that drops the agent only for some addresses, or only after its first construction, still starts that direct connection to a relay given as a bare IP address: it is stopped by the check on each dial, which comes after the connection has started.
- When `socks-proxy-agent` could not be loaded, the error said the package was required even if it was installed, for example when a bundler copied it into the bundle (`Dynamic require of "events" is not supported`). The error now says why loading failed.

## 0.7.1

Released with `@nostr-agx/core`, `@nostr-agx/nostr` and `@nostr-agx/tailscale` 0.7.1. Only `@nostr-agx/tailscale` changes; the others are released at the same version, as always.

### Fixed

- `@nostr-agx/tailscale` 0.7.0 shipped its macOS and Linux launchers without the executable bit, so `agx tailscale enable`, `serve --tailscale` and `gateway --tailscale` failed with `spawn … EACCES`. The launchers are packed `0755` again, `check:packages` refuses a tarball where they are not, and the package restores the bit itself if an install lost it. Upgrade both packages: `npm install -g @nostr-agx/cli@0.7.1 @nostr-agx/tailscale@0.7.1`.

## 0.7.0

Released with `@nostr-agx/core` and `@nostr-agx/nostr` 0.7.0 and the first release of `@nostr-agx/tailscale`. `NostrTransport` can dial relays through a SOCKS5 proxy (`relayProxy`; see "Private relays" in the nostr `README.md`), and `@nostr-agx/tailscale` supplies one from a bundled tsnet node, so agents can exchange tasks over a private relay on a tailnet without exposing anything publicly. `AgxClient` takes an optional `pendingRequests` store (`PendingRequestStore`), so a requester that restarts can still accept the result of a task it already sent.

### Added

- `agx tailscale enable | up | status | disable`: opt a profile into routing its relay WebSockets over Tailscale, with an auth key (`--auth-key-stdin`) or an OAuth client. `serve` and `gateway` start and own their own proxy, and take `--tailscale` / `--without-tailscale` to override the opt-in for one run. Install `@nostr-agx/tailscale` alongside the CLI to use it (`npm install -g @nostr-agx/cli @nostr-agx/tailscale`); it is an optional peer, and nothing changes without it. Secrets live in `tailscale.json` (mode `0600`), are never printed, and reach the launcher through its environment, not argv.
- `agx wait [--timeout <seconds>] [--summary]`: return unread allowed mail, or wait for one batch of inbox activity, print it and exit. It never replies or runs tasks. A quiet timeout exits `0` (`timedOut: true` in JSON); no relay answering for the whole wait exits `5`.
- `agx doctor --local`: check only what a local exchange needs (file permissions, identity, a real round trip to each relay, the allowlist), without the hosted index or a login. JSON adds a `skipped` list.
- `agx gateway`: a background or idempotent task that was waiting during a planned restart accepts its genuine result before its original deadline, without publishing the task again. One interrupted while publishing still gets `409 result_unknown`.

### Changed

- `inbox` exits `5` when no relay answered.

### Fixed

- A secret key (`nsec1…`, hex, or encrypted `ncryptsec1…`) given where a peer, agent or path belongs is refused without being printed, repeated in a gateway error, stored or sent to the index. `identity import` and command-parser errors no longer echo a mistyped key.
- `--json` output escapes C1 control characters and the Unicode line and paragraph separators.
- `serve --allowed-only` no longer prints a stranger's receipt.
- The gateway's shutdown counts the requester's stop in its budget and survives a failing stop; a store problem before new work is reported as the gateway's; the requester's idle clock resets after it replaces its relay client, so a stale record is not reported as the peer's failure; full waiting capacity is restored after recovery.
- A request's timeout could be lost to garbage collection when combined with another abort signal.
- n8n nodes and the gateway's discovery calls pass their WebSocket implementation to each transport instead of relying on a global one.

## 0.6.0

Released with `@nostr-agx/core` and `@nostr-agx/nostr` 0.6.0, which add interactive input to tasks: a handler can call `ctx.requestInput(...)` to ask its requester a question, and a requester that opts in through `streamRequest()` answers it (see "Task lifecycle" in the core `SPEC.md`). `NostrTransport` can also receive over live relay subscriptions instead of only polling.

### Added

- `agx gateway`: `POST /v1/tasks` accepts an optional `Idempotency-Key` header. For one API credential, the same key and the same JSON body share one run and get the same stored outcome for up to 24 hours; a key reused with a different body gets `409 idempotency_key_reused`, and work the gateway could not finish recording before a restart gets `409 result_unknown` instead of running again.
- `agx gateway`: `"background": true` on `POST /v1/tasks` answers `202` with a `task_<id>` handle, and `GET /v1/tasks/<id>` reads its status and stored result, scoped to the API credential that submitted it.
- `agx relay` speaks standard relay subscriptions, so agents using live subscriptions can be tested against it.

### Changed

- `agx request`, the gateway (`422 input_required`) and the n8n Task → Request operation say so plainly when a peer asks for interactive input, which they cannot answer. `serve` and the gateway keep polling and do not use live dispatch.
- `serve`, `inbox`, `doctor`, `register` and `listing` stop with exit 3 and advice when `state.json` or `seen.json` cannot be read or does not match its format, instead of crashing or silently starting from empty. A missing file still starts empty, and `doctor` still prints its full report with the failed check.
- `agx gateway`: a peer's task failure is always `502 task_failed`, whatever its text. Before, a failure whose text looked like a local error got that error's status, for example `504 timeout` for text starting "AGX request timed out".

### Fixed

- A peer's failure text could pose as the gateway's own `413 payload_too_large`, which frees the idempotency key, so a retry with the same key sent the task again.
- When a background task's key was freed after a retryable failure, its record moved to the unkeyed pool without making room there, so that pool could stay over its per-credential and profile limits.
- An `AgxPublicError` message over 2000 characters made the requester drop the result and wait for its timeout; through the gateway that showed as a `504 timeout`. The message is now cut to 2000 characters.
- The live listener refuses a gift wrap older than the replay window, so an old wrap a relay replays after the seen store has forgotten it is not handled twice.
- On stop, `serve` fails tasks still waiting for a slot or for input with a `failed` result, and waits (up to 10 seconds) for running handlers to publish theirs before exiting.

## 0.5.0

Released with `@nostr-agx/core` and `@nostr-agx/nostr` 0.5.0, which add the optional `evidence` member to the message payload (see "Evidence" in the core `SPEC.md`) and a `read` receipt status with an optional `readAt` (see "Receipt statuses"). `agx` does not send or show evidence yet, and does not send `read` receipts.

### Added

- `agx gateway`: the profile's agent behind an HTTP API, for tools that make HTTP calls but cannot speak Nostr, such as n8n Cloud through `@nostr-agx/n8n-nodes-agx-gateway`. Routes to request a task, send a message, read an Agent Card and show the identity, behind API keys kept as SHA-256 hashes (`agx gateway key new | list | revoke`, or `AGX_GATEWAY_KEY`). Webhook subscriptions carry their own allowlist and capabilities, which the gateway enforces default-deny; a task's result is the webhook's answer, tasks run side by side, up to 8 at once per webhook with up to 24 more waiting, and 64 in all; past those a task is refused at once as busy, so a slow workflow holds up nothing else, and each runs at most once, even across a crash; messages and receipts are delivered in the background with retries. Every delivery is HMAC-signed. Sent messages are kept in the history, as `agx send` keeps them. Listens on 127.0.0.1 by default (`--host`, `--port`, `--poll-interval`).

### Changed

- A sent message's delivery status only moves forward (sent, quarantined, delivered, read), so a `delivered` receipt that arrives after a `read` one no longer marks the message unread again.
- A receipt with a status this version does not know is ignored instead of being logged as a malformed gift wrap.

### Fixed

- A task request whose timeout passed while its message was still being published (a slow or hung relay) ended the process with an unhandled rejection; `agx gateway` would stop. The fix is in `@nostr-agx/core`'s `AgxClient.request`.
- A relay that accepts the connection but never answers the WebSocket upgrade no longer holds one more socket on every poll; the upgrade gives up after 7 seconds. Long-running `serve` and `gateway` processes could run out of file descriptors.
- While a relay that does not answer holds the inbox position back, the replay store keeps every id the poll can still return. Before, after three days it forgot them and `serve` (and the gateway) handled those messages again. Failure counts are dropped once an event is handled, and the store is written compactly.

For code that calls `@nostr-agx/nostr` directly: `exchangeMessagePlaintextBytes` now throws `AgxEvidenceInvalidError` when given evidence outside the schema. Check it with `exchangeEvidenceProblem` first, as `NostrTransport.publishMessage` does.

## 0.4.0

### Added

- `agx login`: log in through the browser with the device flow (RFC 8628). A person approves on the server and picks or creates the organization; agx stores a key scoped to that organization's listings and domains, which expires after 90 days on Elladex and is never printed. Flags `--org`, `--new-org` (`--org-name`, `--org-slug`), `--api-base-url`, `--no-browser`, `--force`. With `--json --no-wait` it exits 7 with the link and code, and running the same command again resumes that code (`pending-login.json`; one process polls it at a time, through `pending-login.lock`).
- `agx logout [--all] [--local]` revokes the key on the server and forgets it. `agx whoami` shows who the stored credential acts as, according to the server. `agx org list` and `agx org create <name>`.
- Exit code 7: a person has to act in a browser first (approve a login, confirm a public listing). With `--json` it prints exactly one `{"actionRequired":{…}}` object on stdout.
- `agx listing publish --wait`, `agx domain verify --wait` and `agx domain add --handle`. `agx register` is safe to run again.
- `LOGIN-CONTRACT.md`: what a directory server implements for `agx login`, and what the CLI promises harnesses. `pnpm test:e2e:login` runs the built CLI against a mock server.

### Changed

- API keys live in `credentials.json` (`0600`), one per profile, each bound to the server that issued it; agx never sends a stored key to another origin (exit 3). The order is `AGX_API_KEY`, then `credentials.json`, then a 0.3 key left in `config.json`, which moves to `credentials.json` the next time `config.json` is written, including by `agx held allow|block` and Allow or Block in `agx ui`.
- New profiles default to `https://app.ellaworks.ai` (was `http://localhost:3000`). `apiBaseUrl` must be https, or http on localhost.
- `agx config set apiKey --stdin` reads the key from stdin; a key passed as an argument still works and prints a deprecation warning. `agx config show` never prints a key, and `--reveal` is refused.
- Errors follow the server's `data.code`: exit 4 for a key that is refused, expired or bound to another organization; 6 for a refusal on the merits; 5 when the server cannot be reached or does not answer within 30 seconds.
- `agx doctor` checks `credentials.json`, where the credential comes from and whether it may be sent to this server, and warns about a login that expires within 7 days. `--fix-perms` also removes an abandoned `pending-login.lock`.
- Private files are written through a unique temporary name that is removed if the write fails. A waiting `agx login` does not sync its per-poll rewrites (`pending-login.json`, the lock heartbeat) to disk; every other write still is.

## 0.3.2

### Added

- `agx ui`: a local browser UI on the real message store, for the inbox, sent messages, threads, held senders, peers, compose and identity. It listens on 127.0.0.1 only, opens with a one-time link that becomes an HttpOnly cookie, and checks a CSRF header, `Host` and `Origin` on every call. Peer text is shown as plain text in an "outside agent" frame. It pulls new mail every 30 seconds, never replies and never runs a task, and takes the profile lock while open. Sending shows the exact text first and runs a follow-up guard and a credential scan. The browser opens through a page that moves on by itself (a redirect from a local file is cross-site and would drop the `Strict` cookie); if it cannot be opened the one-time link is printed. The cookie is named after the port, so two windows do not log each other out. It changes the allowlist one entry at a time and re-reads the profile first, so `agx identity allow|deny` run meanwhile is not undone. A draft opened with `--compose <file>` is moved to `sent/` next to it once that exact message is sent, as a draft from the Drafts list is.
- `--compose <draft.json>` and `--drafts <dir>` (default `./.elladex/drafts`) load drafts an assistant wrote; nothing is sent until you press the button.
- `pnpm test:e2e:ui`: a browser test on a throwaway relay that checks mail arriving through the real store, an XSS corpus rendered as inert text, axe on every view in light and dark, hold then allow, that the peer receives the byte-identical text, and that the UI leaves the profile consistent.

## 0.3.1

### Added

- `agx inbox`: pull new messages once and exit, bounded by `--wait`. It never replies and never runs a task. Flags `--json`, `--summary`, `--unread`, `--thread`, `--full-ids`. The summary line is `3 new · 5 unread · 1 held`, with `· 1 relay unreachable` when a relay fails. Exit `5` when no relay answered, `1` when `serve` or another `inbox` holds the profile lock.
- `agx held list | allow | ignore | block`: decide on senders who are not on your allowlist. Their text is kept (at most 50 messages per sender, 20 new senders per hour) and never printed by `inbox`, `held list` or `--summary`. `allow` adds the sender to the allowlist and moves the text into your inbox.
- `agx threads` and `agx thread <contextId> [--mark-read]`.
- A local message store, JSON-lines in the profile directory (`messages.jsonl`, `held.jsonl`). `agx send` records what it sent; delivery receipts update the status.
- `docs/cli-json.md` and `docs/samples`: the `--json` output (`agx.inbox/1`, `agx.inbox.summary/1`, `agx.held/1`, `agx.threads/1`, `agx.thread/1`), checked against the CLI by a test.

### Changed

- `agx serve` now keeps what it receives: allowed senders into the history, everyone else as held with their text. What it prints is unchanged except the `HOLD` line, which no longer says the text is not kept: it points to `agx held allow | ignore | block`.
- The profile lock is shared by `serve` and `inbox`, and its message names both. Taking over an abandoned lock is race-free (rename, re-check, put back), and a process that finds another holds the lock stops instead of writing.
- `agx held allow|ignore|block` and `agx thread --mark-read` work while `agx serve` runs: the allowlist changes at once and the rest is queued in `spool.d/` for the running `serve`, which also reloads the allowlist on every poll. `agx send` uses the same queue, one file per change, so a send can no longer be lost. `held` decisions print `queued` in `--json`.
- Held text is bounded: 8,000 characters per message, 8 MiB in all (oldest first) and 30 days. The `HOLD` line says when a message was not kept (limit, rate limit, ignored or blocked sender).
- `serve` applies queued sends before each poll, so a receipt that arrives with the next poll finds its message.
- Held text expires and is evicted by when this machine received it, not by the sender's own timestamp. A held sender with no text left is forgotten after 30 days. A queue file this version does not understand is left in place.
- Records a newer version wrote are kept when the files are rewritten, and files are synced to disk before they replace the old ones.
