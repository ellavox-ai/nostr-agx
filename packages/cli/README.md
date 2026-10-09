# @nostr-agx/cli

A command-line **NIP-AGX agent**. It holds a keypair, registers that key in an
agent index through the real proof-of-possession flow, and then *is* an agent —
connecting to relays, decrypting inbound messages, running capability handlers,
and replying.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

Two modes:

- **Directory client** — log in with `agx login`, then drive the Agent Index
  over its HTTP API: register, publish, search, claim and verify domains,
  manage a team's peer allowlist.
- **External agent** — `agx serve`, built on [`@nostr-agx/core`](https://www.npmjs.com/package/@nostr-agx/core) and
  [`@nostr-agx/nostr`](https://www.npmjs.com/package/@nostr-agx/nostr). This is an agent nobody hosts for you.

```bash
agx identity new                       # → npub1…
agx relay                              # a local NIP-01 relay, no Docker
agx serve --allow npub1peer…           # be an agent
```

---

## Install

```bash
npm install -g @nostr-agx/cli
```

`agx --version` prints the installed version; the `serve` flags in
[Use from Claude Code](#use-from-claude-code) need 0.3.0 or later, and
[`agx login`](#log-in) needs 0.4.0 or later.

From source: `pnpm install && pnpm build` at the repository root, then run
`node dist/agx.js` from this package's directory.

---

## Log in

The directory commands (`register`, `listing`, `domain`, `search`) need a
credential for an organization. `agx login` gets one through the browser, so
nobody copies a key anywhere:

```bash
agx login                      # https://app.ellaworks.ai by default
#   Open https://app.ellaworks.ai/auth/device?code=WDJB-MJHT and check the code WDJB-MJHT (expires in 30 min).
#   ✓ Logged in as a•••@acme.com · org acme-robotics · listings:read, listings:write, domains:read, domains:write · expires 2026-12-29
agx whoami                     # who the server says this credential is
agx org list                   # the organization(s) it can see
agx logout                     # revoke the key on the server, then forget it
```

In the browser you sign in (or sign up), check that the code matches, pick the
organization — or create one — and approve. The CLI's poll
then receives the key exactly once and stores it in `credentials.json` in the
agx home directory, `0600` (see [Data on disk](#data-on-disk)). It is never
printed: not by `login`, `whoami`, `config show`, or under `--json`.

What the key can do is deliberately narrow:

- **one organization**, the one you approved (you must be its owner or admin);
- **Elladex listings and domains only** (`listings:read`, `listings:write`,
  `domains:read`, `domains:write`). `agx peers` needs a key minted in Settings;
- it **expires after 90 days**; `agx doctor` warns in the last week;
- **making a listing public needs an org admin's click** in the browser: the
  CLI exits 7 with the link (see [Exit codes](#exit-codes)).

| option | effect |
|---|---|
| `--org <slug>` | preselect an organization on the approval page (the person can still pick another; the result says which) |
| `--new-org [--org-name <name>] [--org-slug <slug>]` | create a new organization on the approval page, prefilled. `agx org create <name> [--slug <slug>]` is the same thing |
| `--api-base-url <url>` | another server, e.g. `http://localhost:3000` for a local stack. https, or plain http on localhost only |
| `--no-browser` | print the link without opening a browser (also automatic under `--json`, in CI, over SSH, or without a display) |
| `--no-wait` | for harnesses: print the link and exit 7; re-run the same command to finish (below) |
| `--force` | log in again even though this profile is logged in (the old key is revoked) |

A second organization is a second profile: `agx --profile other login --org other`.

### From a harness: `--json --no-wait`

A harness (an AI agent, a script) cannot click the approval link, and should not
sit in a minutes-long blocking call. It runs:

```bash
agx login --json --no-wait
# exit 7, and on stdout:
# {"actionRequired":{"reason":"LOGIN_APPROVAL_REQUIRED","url":"https://app.ellaworks.ai/auth/device?code=WDJB-MJHT","userCode":"WDJB-MJHT","expiresIn":1800,"expiresAt":"2026-09-30T18:30:00.000Z","verificationUri":"https://app.ellaworks.ai/auth/device"}}
```

It shows the person that URL and code and, once they say they approved, runs the
**same command again**. The re-run resumes the same code (saved in
`pending-login.json`), polls it once, and exits `0` (logged in; the result on
stdout), `7` (still waiting) or `4` (denied or expired). A `--no-wait` run never
replaces a code on its own: after a `4`, running the command once more starts a
fresh code (exit 7 with a new link). The exception is a code that expired more
than 24 hours ago, left over from an abandoned session: the next run starts a
fresh code straight away (exit 7), as a first run would. Without
`--no-wait`, `agx login --json` writes the same `actionRequired` line to
**stderr** and waits; only the final result goes to stdout. Either way, stdout
never contains the key or the device code.

The full contract — what a directory server must implement for `agx login`, and
what the CLI promises a harness (exit codes, the `actionRequired` object, the
login modes) — is in
[LOGIN-CONTRACT.md](https://github.com/ellavox-ai/nostr-agx/blob/main/packages/cli/LOGIN-CONTRACT.md).

### Which credential is used

For every API command, in this order:

1. `AGX_API_KEY`, if set (sent to whatever server `AGX_API_URL` or the profile names);
2. the profile's entry in `credentials.json` (from `agx login`, or from
   `agx config set apiKey`);
3. a key still in `config.json` from agx 0.3 (moved to `credentials.json` on the
   next config write, with a notice).

A stored credential is bound to the server that issued it: if the profile (or
`AGX_API_URL`) points anywhere else, the command stops with exit 3 and sends
nothing. A login key is also bound to its organization: asking it to act on
another one is exit 4. An expired login is exit 4, fixed by `agx login`.

### CI and Settings keys

Where there is no browser, mint a key in Settings → API keys and pipe it in, so
it never appears in argv, shell history or `ps`:

```bash
agx config set apiBaseUrl https://staging.example.com   # only for a server other than the default; FIRST
printf %s "$AGX_KEY" | agx config set apiKey --stdin
```

It is stored as a `manual` credential, bound to the server the profile points
at **when you store it**, so set `apiBaseUrl` before the key. If you chose that
server (`AGX_API_URL`, or an `apiBaseUrl` other than the default), storing the
key also asks it, once, which key it is, and records the key's id so `agx
logout` can revoke it later (best effort: offline or refused, the key is stored
all the same, and a refusal is reported on stderr). On the default server agx
asks nothing at that point, and `agx logout` looks the id up instead. A script
written for agx 0.3 that sets the key first therefore sends it nowhere: the key
is bound to `https://app.ellaworks.ai`, and once `apiBaseUrl` points elsewhere
every API command stops with exit 3; pipe the key in again after setting
`apiBaseUrl` (agx never rebinds a key by itself). Passing
the key as an argument still works but prints a deprecation warning. `agx
logout` revokes a `manual` key too; a key from agx 0.3 is only forgotten, and
has to be revoked in Settings.

`agx logout` forgets a key without revoking it only when the server refuses it
as invalid or expired (`API_KEY_INVALID` or `API_KEY_EXPIRED`, or an older
server's 401 with exactly the message "Invalid API key"). If the server cannot
be reached (exit 5) or cannot revoke it (for example a 404 from a server without
self-revoke, exit 6, or any other 401, exit 4), the key is **kept** and the
error says so; revoke it in Settings, then `agx logout --local` forgets it on
this machine.

If the account that owns a key leaves the key's organization, the key can no
longer act on it. `agx whoami` says so and exits 4 (under `--json`,
`organization` is `null`), `agx login` asks for a new code instead of answering
"already logged in", and `agx logout` still finds the key's id and revokes it.

---

## Two agents talking, with no server at all

The fastest way to see the whole protocol work. No database, no web app, nothing
but two keypairs and a relay.

```bash
# terminal 1
agx relay

# terminal 2
agx identity new --profile a
agx identity new --profile b
B=$(agx identity show --profile b --json | jq -r .npub)
A=$(agx identity show --profile a --json | jq -r .npub)

agx identity allow "$B" --profile a          # authorization is DEFAULT-DENY
agx serve --profile a                        # leave running

# terminal 3
agx request "$A" invoice.review --payload '{"amount":4200}' --profile b
agx send    "$A" "Please review invoice 1234." --profile b --subject "Invoice 1234"
agx serve   --profile b --once --no-reply     # collect the reply
```

Try it **without** the `agx identity allow` line first. The request times out and
the agent prints why:

```
DENY  task invoice.review from npub1w2unus8…xdns
      not on this profile's allowlist — no reply was sent.
      allow this peer:  agx identity allow npub1w2unus8…
```

That is the specified behaviour, not a rough edge. A registered handler is
reachable by any pubkey on an open relay, so NIP-AGX makes authorization
**default-deny**, and a denied request gets **no reply at all** — an error result
would confirm this identity and its capability set to an unauthenticated peer.
The request still falls through to the plain-message path, so nothing is lost
silently. `--allow-all` opts out explicitly.

---

## Plugging in a real runtime

`--handler` points `serve` at a module that default-exports capability
implementations. That is the whole integration surface — the library owns
identity, encryption, relay routing, the task lifecycle, correlation and
receipts; the runtime never sees a Nostr event.

```js
// paperclip-runtime.mjs
export default {
  "invoice.review": async (payload) => paperclip.run("invoice.review", payload),
};
```

```bash
agx serve --handler ./paperclip-runtime.mjs
#   capabilities  invoice.review, invoice.approve, agx.ping
```

Capabilities default to the module's keys, so the Agent Card advertises exactly
what the runtime can service. A worked example is in
[`examples/paperclip-runtime.mjs`](examples/paperclip-runtime.mjs).

**The error boundary is worth knowing before you demo it.** A thrown error
reaches the peer as a bare `handler failed`, with the real message logged only
locally — an internal error must not leak hostnames, table names or credentials
across a trust boundary. To send a message that is part of the contract
(`invoice not found`, `amount exceeds limit`), throw `AgxPublicError` from
`@nostr-agx/core`; that message is forwarded verbatim.

## What `serve` prints for a message

Every inbound plain message prints a `RECV` line and its body, whoever sent it —
the allowlist gates **replies and tasks**, not what you see. Two opt-in flags
change that for a reader that acts on the output:

| flag | effect |
|---|---|
| `--allowed-only` | a sender off the allowlist (profile + session `--allow`) prints **one** line — `HOLD  from <npub> — not on the allowlist; text withheld and not kept. To read future messages: agx identity allow <npub> (then ask them to resend)` — with no subject, body or context id. Allowed senders print exactly as before. |
| `--full-ids` | `RECV` lines carry the full sender npub and full `contextId`, instead of `npub1abcdefg…wxyz` and the first 8 characters of the id. A `contextId` with characters outside `A-Z a-z 0-9 . _ : -` prints as `withheld (unsafe characters; reply without --context-id)`, because the sender chose it and a reader pastes it into a shell. |

A held message is **not kept**: it is recorded as seen like any other, so
allowing its sender afterwards (and restarting `serve`, which reads the allowlist
once) shows their *next* message, never this one — `--reset-cursor` does not
bring it back either. Ask the sender to resend once they are allowed.

`--allowed-only` changes **printing only**. A held message is still counted and
recorded as seen, `--reply-any` still auto-replies to it, and `--allow-all` still
opens tasks to everyone (a stranger's `TASK` line prints, but its payload and the
handler's result do not) — pair it with `--no-reply` and without `--allow-all`
when the point is that strangers reach nothing. `DENY` lines for refused tasks
are unchanged.

### Replies and tasks are separate switches

`serve` answers two kinds of traffic on its own, and each has its own flag:

| flag | stops |
|---|---|
| `--no-reply` | the canned echo to a **plain message** (`agx send`). |
| `--no-tasks` | every answer to a **typed task request** (`agx request`): no handler is registered — not the built-in `invoice.review` stand-in, not `agx.ping` — so an allowlisted peer's request gets no receipt and no result, and times out on their side. |

`--no-reply` alone does **not** stop task answers: while it runs, an allowlisted
peer's `agx request … invoice.review` still gets a signed canned result. Under
`--no-tasks` the request is not consumed as a task at all; it prints like any
other message — `RECV` with the request envelope as its body (or `HOLD` under
`--allowed-only`), followed by `(typed task request — --no-tasks: not answered)` —
and it never gets the plain-message echo either, even without `--no-reply`. Any
other task-labelled message (a late or stray result, or an envelope that does not
parse as a request) is followed by `(typed task message — --no-tasks: not
handled)` instead. The
banner shows `tasks  off (--no-tasks)` in place of `capabilities`.

`--no-tasks` is a usage error (exit 2) with `--capability`, `--handler`,
`--allow-all` or `--advertise`. The first three only configure capabilities that
`--no-tasks` does not serve. `--advertise` would publish an Agent Card listing no
capabilities, which announces an agent that answers no typed request; to be
discoverable, advertise from a `serve` that actually serves something.

Whatever the flags, a message body cannot pose as a header line: every line of
it is indented (a break is any of `\n`, `\r`, `\v`, `\f`, U+0085, U+2028,
U+2029), and control characters, ANSI escapes included, print as U+FFFD (`�`).
The peer-supplied ids on header lines (`contextId`, a task's `taskId`, a
receipt's `refEventId`) get the same treatment, and a task payload prints as
one-line JSON.

## Use from Claude Code

A Claude Code session can be an AGX peer: it watches `serve` with the Monitor
tool, where every stdout line becomes a notification in the model's context, and
answers with `agx send`. Only let allowlisted peers put text there:

```bash
agx identity allow npub1peer…        # before starting serve; it reads the allowlist once
agx serve --no-reply --no-tasks --allowed-only --full-ids --no-color
#   RECV  from npub1peer…(full)  subject "Invoice 1234"  ctx 2bc8c14c9873c9fea764882abcee9fbd
#          Hi, can you review invoice 1234?
#          (--no-reply: observing only)
#   HOLD  from npub1other…(full) — not on the allowlist; text withheld and not kept. To read future messages: agx identity allow npub1other… (then ask them to resend)
#          (--no-reply: observing only)

agx send --context-id 2bc8c14c9873c9fea764882abcee9fbd -- npub1peer…(full) "Reviewed — approved."
```

Put every option first and the npub and text after `--`. Without it, a message
that starts with `-` (`- migration done`, `--help`) is read as an option: the
send fails, or prints help, instead of sending the text.

`--no-reply` keeps the canned auto-reply out of the conversation, `--no-tasks`
means nothing is sent automatically at all (without it, an allowlisted peer's
`agx request` is still answered by the built-in handlers), `--full-ids` gives the
exact npub and `contextId` to reply on the same thread, and `--no-color`
guarantees plain text. Colour is already off whenever stdout is not
a terminal (and under `NO_COLOR`); `FORCE_COLOR=1` turns it back on.

`pnpm --filter @nostr-agx/cli test:e2e` checks this whole contract against the built
CLI (`pnpm build` first) with no network: it starts `agx relay` on a free
localhost port, creates alice, bob and mallory under a temporary `AGX_HOME`, and
asserts the full-id `RECV` header, mallory's text-free `HOLD`, that a forged
header in a body stays indented, that a shell-unsafe `contextId` is withheld,
that `agx request` to `agx.ping` and `invoice.review` times out under
`--no-tasks` and is answered without it (and that the watch was alive and
printed both requests the whole time), that nothing — not even a receipt —
reaches bob, the reply round trip on the same `contextId`, that default mode
still prints short ids, and that `agx send … -- <npub> "- migration done"` and
`"--help"` arrive as literal text. It clears every inherited `AGX_*` variable so
it can never reach a real relay or API. It is not part of `test:unit`.

| `agx serve [--handler <file>]` | run as an agent; `--handler` binds a real runtime; `--no-reply` / `--no-tasks` stop automatic answers; `--allowed-only` / `--full-ids` shape what inbound messages print |

## Agent Cards

A card (kind `11337`) is how an agent advertises what it can do. It is
**unencrypted** and signed — anyone who can reach the relay can read it, which is
the point: a peer uses it to decide whether an agent can service a capability
before sending anything.

```bash
agx card <npub>            # read any agent's card
agx card <npub> --verify   # check its claimed NIP-05 against the domain itself
agx card <npub> --raw      # plus the raw signed event
```

### A card cannot certify itself

The obvious feature request is a `verified: true` field on the card. It would be
worse than useless. A card is signed by the agent's **own** key, so the signature
attests that *this key published the claim* — not that the claim is true. Anyone
can publish a card asserting any org, any domain, any badge.

What *is* checkable is the claimed NIP-05, because the authority is somebody
else: fetch `https://<domain>/.well-known/nostr.json?name=<name>` and see whether
the domain publishes **this** pubkey. `--verify` does exactly that, and the point
is that anyone can re-run it and get the same answer — no issuer to trust.

```
Domain verification (NIP-05)
  IMPOSTOR  fiatjaf.com publishes 3bf0c63fcb934634… for "_" — a DIFFERENT key
```

That is a real card, signed and valid, claiming a handle its domain does not
back. The signature checks out; the identity does not. Both facts are worth
showing side by side.

An index's "verified" badge is this same mechanism, not a new one: an agent whose
handle is on a domain that serves its key verifies against that domain.
The index stores the outcome (`verifiedPubkeyAt`) and withholds an unverified
handle from public projections — but the index is a *directory you query*, which
can assert things a self-signed card never can.

> Verification needs a **public HTTPS** host. The resolver blocks localhost and
> private addresses with no environment bypass, deliberately — that guard is the
> control. Locally `--verify` reports `UNVERIFIED`; for a real pass, expose the
> host with `cloudflared tunnel --url http://localhost:3000` and claim that
> hostname as the domain.

**An external agent signs its own** — `agx serve --advertise` publishes it.

**A hosted agent's card is published by the platform hosting it**, from its listing, so it
can never advertise something the listing says must stay private.

## When something goes quiet

```bash
agx doctor
```

Checks, in order, with the exact fix for each: file permissions on your secret
key and credentials, identity, relay reachability (a real REQ/EOSE round trip,
not just a socket open), the index API, where the credential comes from (and
whether it may be sent to this server at all, or is about to expire), API key
and organization binding, and whether your listing is actually discoverable.

The three failures that produce no useful error on their own are an index that
is not running, a relay nobody is running, and a listing that is `listed` but
not `public` — `doctor` names all three.

---

## Commands

| | |
|---|---|
| `agx login [--org <slug> \| --new-org] [--no-wait]` | log in through the browser: a scoped, expiring key for one organization |
| `agx whoami` / `agx logout [--all]` | who the credential acts as; revoke it and forget it |
| `agx org list` / `agx org create <name>` | organizations the credential sees; create one in the browser |
| `agx config show \| set \| use \| list` | profiles: API base, org, relays (`set apiKey --stdin` for a Settings key) |
| `agx identity new \| show \| import \| export` | the agent's keypair |
| `agx identity allow \| deny <npub>` | who may invoke your capabilities |
| `agx identity sign <nonce>` | sign an index challenge; prints the signed event to paste into the index |
| `agx register --slug … --capability …` | proof of possession + create a listing (also `agx identity register`); safe to re-run |
| `agx listing create --team \| --pubkey` | create a listing of either kind |
| `agx listing list \| get \| publish [--wait] \| delist \| delete` | listing lifecycle; `--wait` waits for an org admin to confirm a public listing |
| `agx listing set-visibility \| set-policy` | visibility and first-contact auto-allow |
| `agx domain add [--handle] \| list \| verify [--wait] \| remove` | NIP-05 domains; `add` prints the nostr.json the domain must serve |
| `agx search "<query>"` | search the index |
| `agx peers list \| allowlist \| accept \| refuse \| block` | a team's trust decisions |
| `agx serve [--handler <file>]` | run as an agent; `--handler` binds a real runtime; `--no-reply` / `--no-tasks` stop automatic answers; `--allowed-only` / `--full-ids` shape what inbound messages print |
| `agx send <npub> "<msg>"` / `agx request <npub> <capability>` | talk to another agent |
| `agx relay` | a local NIP-01 relay |
| `agx doctor` | preflight |

`agx register` also advertises the profile's relays on the listing, so a peer
that finds the agent can reach it. `agx listing create --pubkey` does the same
only when the key is this profile's own; for any other proven key, pass the
relays it listens on with `--relay wss://…` (repeatable). Only public `wss://` relays are listable;
anything else in the profile (such as the default local dev relay) is skipped
with a warning. Set them with `agx config set relays wss://relay.example.com`.

### Registering from the browser instead

`agx register` does the whole proof-of-possession round trip over HTTP with an API
key. If you would rather drive it from an index's web submit page, the browser
has no private key and must never be given one — so the flow splits:

```bash
# The submit page shows you a nonce; sign it here and paste the output back.
agx identity sign <nonce>
```

The index consumes the challenge **before** it verifies the signature, so a
rejected proof burns the nonce. Every retry needs a fresh challenge.

`--profile <name>` is global; a second identity or a second organization is just
a second profile. Every setting also reads from `AGX_API_URL`, `AGX_API_KEY`,
`AGX_ORG`, `AGX_RELAY`, `AGX_PROFILE`, and `AGX_HOME` relocates `~/.agx`.
`AGX_NO_BROWSER=1` stops `agx login` from opening a browser.

### Publishing an agent, end to end

```bash
agx login                                            # once
agx identity new                                     # the agent's key (stays local)
agx register --slug invoice-desk --capability invoice.review --visibility private
agx domain add acme.com --handle invoice-desk        # prints the nostr.json to serve
#   … the company deploys /.well-known/nostr.json on acme.com …
agx domain verify <domainId> --wait                  # every 15 s, up to --timeout 10m
agx listing publish --visibility public --wait       # an org admin confirms in the browser
```

`register` is safe to re-run: when this organization already owns a listing for
the key, it reports that listing instead of failing. Going public with a login
key needs a person: the server answers with a link to the listing's page, where
an org admin presses Publish. `--wait` prints that link once (on stderr under
`--json`) and checks every 15 s until the listing is public (`--timeout`,
default 30m); without `--wait` the command exits 7 with the link.

## Exit codes

| code | meaning |
|---|---|
| 0 | done |
| 1 | unexpected error |
| 2 | usage: a bad flag or argument |
| 3 | local config: not logged in, no organization, a credential bound to another server, a malformed file |
| 4 | authentication: the key was refused, has expired, or is bound to another organization; a login was denied or expired |
| 5 | the server (or a relay) could not be reached |
| 6 | the server refused the request on its merits |
| 7 | **a person has to act in a browser first**; not a failure |
| 130 | interrupted (Ctrl-C; a waiting `agx login` also stops this way on SIGTERM or SIGHUP, keeping its code) |

With `--json`, exit 7 prints exactly one object on stdout:

```json
{"actionRequired":{"reason":"LOGIN_APPROVAL_REQUIRED","url":"https://app.ellaworks.ai/auth/device?code=WDJB-MJHT","userCode":"WDJB-MJHT","expiresIn":1742,"expiresAt":"2026-09-30T18:34:11.000Z","verificationUri":"https://app.ellaworks.ai/auth/device"}}
{"actionRequired":{"reason":"HUMAN_CONFIRMATION_REQUIRED","url":"https://app.ellaworks.ai/elladex/listings/l_7?org=acme-robotics","userCode":null,"expiresIn":null,"listingId":"l_7"}}
{"actionRequired":{"reason":"TERMS_ACCEPTANCE_REQUIRED","url":"https://www.ellaworks.ai/en/legal/terms","userCode":null,"expiresIn":null}}
```

`reason` is a closed list; `TERMS_ACCEPTANCE_REQUIRED` is reserved, and no
server sends it today. `url` is always absolute and always on the server agx
is talking to (the Terms page may be elsewhere on the same site); a link that
points anywhere else is replaced by that server's `/elladex` page. Hand the URL,
and `userCode` when there is one, to a person; never open or fill the page in
on their behalf.

---

## Things the CLI will not pretend about

- **An external listing publishes no Agent Card.** The index never holds your
  key, so `agx listing publish` reports `cardPublished: false` and points you at
  `agx serve --advertise`, which signs your own card.
- **Only `public` + `listed` is discoverable.** Private and unlisted publish
  nothing and appear in no directory search. `publish` warns when it lists
  something nobody else can find.
- **De-listing is *requested*, not done.** It publishes a NIP-09 kind-5 deletion;
  relays are not obliged to honour it, so the CLI never claims the card was
  removed.
- **An unverified handle is withheld.** Public projections null it out on
  purpose, so a blank handle column is the rule working.
- **NIP-05 cannot verify against localhost.** The resolver requires a public
  HTTPS host and has no environment bypass, deliberately — the guard *is* the
  control. Use a tunnel (`cloudflared tunnel --url http://localhost:3000`).

---

## Data on disk

`~/.agx` is `0700`, every file `0600`, and writes are atomic.

```
~/.agx/
  config.json                         profiles: API base, org, relays, peer allowlist (no keys)
  credentials.json                    API keys, one per profile, each bound to its server
  profiles/<name>/identity.json       the secret key
  profiles/<name>/state.json          poll cursor + listing id
  profiles/<name>/seen.json           replay protection
  profiles/<name>/pending-login.json  an `agx login` waiting for approval (holds the device code)
  profiles/<name>/pending-login.lock  held while one process polls that code
```

`credentials.json` and `pending-login.json` are secrets: never paste, upload or
print them. `agx whoami` answers every question they would.

`pending-login.lock` carries a heartbeat that its holder refreshes on every
poll. A lock whose heartbeat has run out (a minute or more, depending on the
poll interval), whose process is gone, or that names the current process
without being held by it, is abandoned: the next `agx login` takes it over,
`agx doctor` reports it, and `agx doctor --fix-perms` removes it.

`serve` persists its cursor and seen-event ids after every poll, so a restart
neither re-drains the inbox nor re-answers messages it already handled. One
`serve` per profile — it takes a lock, because the seen-store is single-writer.
