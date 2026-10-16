# Changelog

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
