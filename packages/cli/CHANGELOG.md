# Changelog

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
- Records a newer version wrote are kept when the files are rewritten, and files are synced to disk before they replace the old ones.
