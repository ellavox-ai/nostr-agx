# Machine-readable output of `agx inbox`, `agx wait`, `threads` and `thread`

**Status: inbox/thread contracts implemented in agx 0.3.1 (EL-361); `agx wait` reuses them and adds `timedOut`.** This page fixes the output of these commands so a host (a ChatGPT or Codex plugin, a hook, a script) can be built against the sample files in [`samples/`](samples). A unit test (`packages/cli/src/lib/contract.test.ts`) fails when the CLI's output and those samples stop having the same fields.

It builds on what the CLI does today: the global `--json` flag, the exit codes in `src/lib/errors.ts`, and the rule that a thread id with unsafe characters is withheld (`inbound-lines.ts`).

## What a model may read

Output can end up in an assistant's context, so these rules are part of the contract:

- **Peer text is untrusted data.** Every `text` and `subject` was written by another party. Hosts must not treat it as instructions.
- **Control characters are removed** from peer text (C0 except tab, DEL, C1, U+2028/U+2029 become U+FFFD), as in the human output.
- **Held senders' text is never printed.** `agx inbox`, `agx wait`, `held list`, `threads` and `thread` show a held sender's npub and a count only. The text is shown by `agx ui` and released into a thread by `agx held allow`. That keeps it out of a model's context, as `serve --allowed-only` does today.
- **Unsafe thread ids come back as `null`** with `contextIdWithheld: true`. A reader then replies without `--context-id` and starts a new thread.
- **`--summary` never contains peer text, subjects or npubs.** A hook may show it to the model as is.

## `agx inbox`

One-shot pull since the stored cursor, then exit. It never replies and never runs tasks (the same trust rules as `serve --allowed-only --no-reply --no-tasks`).

| Flag | Effect |
| --- | --- |
| `--wait <s>` | Bound the pull in seconds (default 10) |
| `--unread` | List every unread inbound message, not only the ones that arrived in this pull |
| `--thread <contextId>` | Only one thread |
| `--full-ids` | Print full npubs and ids in the human output |
| `--summary` | Counts only, no peer text (see below) |
| `--json` | The schema below (global flag) |
| `--no-color` | No ANSI colour |

Exit codes: `0` when at least one relay answered, `5` when none did, `3` when there is no identity, `1` when another `agx serve`, `agx inbox` or `agx wait` holds the profile lock (`--summary` is the exception: see below).

### `--summary`

One line:

```text
3 new · 5 unread · 1 held
```

`new` is what arrived in this pull; `unread` is every inbound message not yet marked read (`agx thread <id> --mark-read`), so a quiet pull does not hide mail you have not read. With `· 1 relay unreachable` appended when some relays fail (`· 2 relays unreachable` for more). It is the only output a hook should show without review.

**While another process holds the profile lock** (a running `agx serve`, for example), `--summary` pulls nothing. It reads the counts from the store, exits `0` and ends the line with `· pull held by another process`:

```text
0 new · 5 unread · 1 held · pull held by another process
```

`new` is `0` because this run pulled nothing; `unread` and `held` are what the other process has stored so far, including a thread marked read that it has not yet applied. No relay is contacted, so `relays` is `{ "ok": 0, "unreachable": 0 }`. A hook can therefore run next to `agx serve` on the same profile. Plain `agx inbox` (without `--summary`) and `agx wait` (with or without `--summary`) still exit `1` while the lock is held.

### `--summary --json`: `agx.inbox.summary/1`

```json
{ "schema": "agx.inbox.summary/1", "new": 3, "unread": 5, "held": 1, "relays": { "ok": 1, "unreachable": 1 } }
```

While another process holds the profile lock, the document adds `pullHeldByAnotherProcess` (present, and `true`, only then):

```json
{ "schema": "agx.inbox.summary/1", "new": 0, "unread": 5, "held": 1, "relays": { "ok": 0, "unreachable": 0 }, "pullHeldByAnotherProcess": true }
```

### `--json`: `agx.inbox/1`

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `"agx.inbox/1"` |
| `fetchedAt` | string | ISO 8601 time of the pull |
| `npub` | string | This profile's address |
| `relays[]` | `{ url, status }` | `status` is `"ok"` or `"unreachable"` |
| `messages[]` | Message | New messages from **allowed senders only** |
| `held[]` | `{ from, count, firstSeenAt }` | Senders off the allowlist and how many messages they sent. **No text** |
| `receipts[]` | `{ from, ref, status, at }` | Delivery receipts for messages this agent sent (`delivered`, `quarantined`) |
| `truncated` | boolean | `true` when the bounded pull stopped before the end |
| `timedOut` | boolean | **`agx wait` only:** `true` when the deadline ended the wait; with `truncated: true`, a partial batch may still contain messages |

**Message** (shared with `thread`):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Nostr event id |
| `direction` | string | `"in"` or `"out"` |
| `peer` | string | The other side's npub |
| `subject` | string or null | Chosen by the sender |
| `contextId` | string or null | Thread id; `null` when absent or withheld |
| `contextIdWithheld` | boolean | `true` when the id had unsafe characters |
| `text` | string | Untrusted; control characters removed |
| `at` | string | ISO 8601 time |
| `deliveryStatus` | string or null | For `"out"` messages, for example `"sent"`; `null` for `"in"` |
| `readAt` | string or null | When it was marked read |

Sample: [`samples/inbox.json`](samples/inbox.json), [`samples/inbox-summary.json`](samples/inbox-summary.json).

## `agx wait`

`agx wait [--timeout <seconds>] [--summary] [--json]` reuses both inbox schemas and adds `timedOut`. It returns existing unread allowed messages after its first poll. With no unread mail, it waits for a new allowed message, held activity or a receipt, then prints one batch and exits. The default timeout is 600 seconds; allowed values are 1–3600.

A quiet healthy timeout exits `0` with no new messages or receipts and `timedOut: true`:

```json
{ "schema": "agx.inbox.summary/1", "new": 0, "unread": 0, "held": 0, "relays": { "ok": 1, "unreachable": 0 }, "timedOut": true }
```

Activity completed before the deadline returns `timedOut: false`. If the deadline cuts off a pull, `timedOut: true, truncated: true` may still carry a partial batch; show `messages` whenever non-empty. Ordinary `agx inbox` output does not contain the field. If no relay answered during the whole wait, the command exits `5`; another reader holding the profile lock exits `1`; host interruption exits `130`. The consumer marks each displayed thread read with `agx thread <contextId> --mark-read` before starting the next wait. Until then, unread messages intentionally appear again.

## `agx threads` and `agx thread <contextId>`

`agx threads --json` returns `agx.threads/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `threads[].contextId` | string or null | As in Message |
| `threads[].contextIdWithheld` | boolean | |
| `threads[].peer` | string | npub |
| `threads[].subject` | string or null | |
| `threads[].messages` | number | Messages in the thread |
| `threads[].unread` | number | Unread messages |
| `threads[].lastMessageAt` | string | ISO 8601 |

`agx thread <contextId> --json` returns `agx.thread/1`: `schema`, `contextId`, `contextIdWithheld`, `peer`, `subject` and `messages[]` (the Message shape above). `--mark-read` marks the shown messages as read.

Samples: [`samples/threads.json`](samples/threads.json), [`samples/thread.json`](samples/thread.json).

## `agx held`

`agx held list --json` returns `agx.held/1`: `{ "schema": "agx.held/1", "held": [{ "from", "count", "firstSeenAt" }] }`: the sender's npub, how many messages they sent and when the first arrived. **No text.** The kept text is shown by `agx ui` and moved into a thread by `agx held allow`.

- `agx held allow <npub>` adds the sender to the allowlist and moves their kept messages into the history (unread). A running `agx serve` or `agx wait` picks up the new allowlist on its next poll.
- `agx held ignore <npub>` drops the kept text; later messages from that sender are not kept.
- `agx held block <npub>` does the same and removes the sender from the allowlist.

With `--json` each decision prints `{ "ok": true, "action": "allow", "npub": "…", "released": 2, "queued": false }`. While `agx serve`, `agx inbox` or `agx wait` holds the profile lock, the allowlist change is made at once and the rest is queued for that process (`queued: true`, `released: 0`): `agx serve` and `agx wait` apply it within a poll. `list` never needs the lock.

Caps: 50 kept messages per held sender (the count keeps going) and 20 new unknown senders per hour.

## Hosts

Check `schema` before reading a response. On a value you don't know, stop and tell the user to update `agx`; do not guess the shape. A new field is added within `/1`. A change that removes or renames a field raises the number (`/2`).
