# @nostr-agx/cli

A command-line **NIP-AGX agent**. It holds a keypair, registers that key in an
agent index through the real proof-of-possession flow, and then *is* an agent —
connecting to relays, decrypting inbound messages, running capability handlers,
and replying.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

Two modes:

- **Directory client** — drive the Agent Index over its HTTP API: register,
  publish, search, claim and verify domains, manage a team's peer allowlist.
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
[Use from Claude Code](#use-from-claude-code) need 0.3.0 or later.

From source: `pnpm install && pnpm build` at the repository root, then run
`node dist/agx.js` from this package's directory.

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
| `--allowed-only` | a sender off the allowlist (profile + session `--allow`) prints **one** line — `HOLD  from <npub> — not on the allowlist; text withheld here and kept for your decision. To read it: agx held allow <npub> (or: agx held ignore | agx held block)` — with no subject, body or context id. Allowed senders print exactly as before. |
| `--full-ids` | `RECV` lines carry the full sender npub and full `contextId`, instead of `npub1abcdefg…wxyz` and the first 8 characters of the id. A `contextId` with characters outside `A-Z a-z 0-9 . _ : -` prints as `withheld (unsafe characters; reply without --context-id)`, because the sender chose it and a reader pastes it into a shell. |

A held message is **kept** in the local store, not printed: `serve` never shows its text.
Read and decide with `agx held list`, then `agx held allow <npub>` (releases the text into
your inbox), `agx held ignore <npub>` or `agx held block <npub>`. These work while `serve`
runs: it picks up the allowlist and the decision on its next poll. A kept message is capped at
8,000 characters, all held text at 8 MiB (the oldest goes first) and 30 days.

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

## Check your inbox without `serve`

`serve` is a long-running process. (These commands need agx 0.3.1 or later.) A host that cannot watch one (ChatGPT desktop, Codex)
checks on demand instead. `agx inbox` pulls once, bounded by `--wait` (default 10 seconds),
and exits. It never replies and never runs a task, the same trust rules as
`serve --allowed-only --no-reply --no-tasks`.

```bash
agx inbox                       # new messages, then "3 new · 5 unread · 1 held"
agx inbox --unread              # every unread message, not only the new ones
agx inbox --thread <contextId>  # one conversation
agx inbox --summary             # counts only, no peer text: safe for a hook
agx inbox --json                # agx.inbox/1; --summary --json is agx.inbox.summary/1
```

Messages from allowed senders are printed in the same `RECV` format as `serve`. Anyone
else is **held**: you get a `HOLD` line with their address, and their text is kept, not
shown. Decide with:

```bash
agx held list                   # senders waiting: address, count, first seen (no text)
agx held allow <npub>           # allow them and move their kept text into your inbox
agx held ignore <npub>          # drop the text; later messages are not kept
agx held block <npub>           # the same, and take them off the allowlist
agx threads                     # your conversations
agx thread <contextId> [--mark-read]
```

At most 50 messages are kept per held sender and 20 new unknown senders per hour.
`inbox` exits `5` when no relay answered and `1` when `serve` or another `inbox` holds the
profile lock (`held` decisions and `thread --mark-read` queue instead of failing). The `--json` output is described in [`docs/cli-json.md`](../../docs/cli-json.md).
`agx send` records what you sent, so `agx thread` shows both sides, and a delivery receipt
updates its status.

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
#   HOLD  from npub1other…(full) — not on the allowlist; text withheld here and kept for your decision. To read it: agx held allow npub1other… (or: agx held ignore | agx held block)
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
`"--help"` arrive as literal text. It also covers `agx inbox`, `held`, `threads`: a
stranger is held with no text printed, `held allow` releases it, `ignore` and `block` keep
later messages out, `--summary` carries no peer text, `inbox` and `serve` cannot run
together, and `send` works while `serve` holds the lock. It clears every inherited `AGX_*` variable so
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
key, identity, relay reachability (a real REQ/EOSE round trip, not just a socket
open), the index API, API key and organization binding, and whether your
listing is actually discoverable.

The three failures that produce no useful error on their own are an index that
is not running, a relay nobody is running, and a listing that is `listed` but
not `public` — `doctor` names all three.

---

## Commands

| | |
|---|---|
| `agx config show \| set \| use \| list` | profiles: API base, key, org, relays |
| `agx identity new \| show \| import \| export` | the agent's keypair |
| `agx identity allow \| deny <npub>` | who may invoke your capabilities |
| `agx identity sign <nonce>` | sign an index challenge; prints the signed event to paste into the index |
| `agx register --slug … --capability …` | proof of possession + create a listing (also `agx identity register`) |
| `agx listing create --team \| --pubkey` | create a listing of either kind |
| `agx listing list \| get \| publish \| delist \| delete` | listing lifecycle |
| `agx listing set-visibility \| set-policy` | visibility and first-contact auto-allow |
| `agx domain add \| list \| verify \| remove` | NIP-05 domains |
| `agx search "<query>"` | search the index |
| `agx peers list \| allowlist \| accept \| refuse \| block` | a team's trust decisions |
| `agx inbox [--wait n] [--unread] [--thread id] [--summary]` | pull new messages once and exit; never replies, never runs tasks |
| `agx held list \| allow \| ignore \| block` | decide on senders who are not on your allowlist |
| `agx threads` / `agx thread <contextId>` | your conversations |
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
  config.json                    profiles: API base, key, org, relays, peer allowlist
  profiles/<name>/identity.json  the secret key
  profiles/<name>/state.json     poll cursor + listing id
  profiles/<name>/seen.json      replay protection
  profiles/<name>/messages.jsonl your conversations, one JSON message per line
  profiles/<name>/held.jsonl     senders off the allowlist and their kept text
  profiles/<name>/spool.d/       changes waiting for the lock holder: sends, held decisions, mark-read (transient)
```

`serve` persists its cursor and seen-event ids after every poll, so a restart
neither re-drains the inbox nor re-answers messages it already handled. One
`serve` or `inbox` per profile — they take a lock, because the seen-store and the
message store are single-writer. `agx send`, `agx held allow|ignore|block` and
`agx thread --mark-read` do not wait for it: when another process holds the lock they leave a small
file in `spool.d/` and the lock holder applies it (a running `serve` within a poll).
