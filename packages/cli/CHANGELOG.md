# Changelog

## 0.4.0

### Added

- `agx inbox`: pull new messages once and exit, bounded by `--wait`. It never replies and never runs a task. Flags `--json`, `--summary`, `--unread`, `--thread`, `--full-ids`. The summary line is `3 new · 5 unread · 1 held`, with `· 1 relay unreachable` when a relay fails. Exit `5` when no relay answered, `1` when `serve` or another `inbox` holds the profile lock.
- `agx held list | allow | ignore | block`: decide on senders who are not on your allowlist. Their text is kept (at most 50 messages per sender, 20 new senders per hour) and never printed by `inbox`, `held list` or `--summary`. `allow` adds the sender to the allowlist and moves the text into your inbox.
- `agx threads` and `agx thread <contextId> [--mark-read]`.
- A local message store, JSON-lines in the profile directory (`messages.jsonl`, `held.jsonl`). `agx send` records what it sent; delivery receipts update the status.
- `docs/cli-json.md` and `docs/samples`: the `--json` output (`agx.inbox/1`, `agx.inbox.summary/1`, `agx.held/1`, `agx.threads/1`, `agx.thread/1`), checked against the CLI by a test.

### Changed

- `agx serve` now keeps what it receives: allowed senders into the history, everyone else as held with their text. What it prints is unchanged except the `HOLD` line, which no longer says the text is not kept: it points to `agx held allow | ignore | block`.
- The profile lock is shared by `serve` and `inbox`, and its message names both.
