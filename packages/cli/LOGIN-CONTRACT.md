# agx login contract

This document is the contract between the `agx` CLI (0.4.0 and later) and a directory server that supports `agx login`, `agx logout`, `agx whoami` and `agx org`. It says what the server must implement and what the CLI promises the harnesses (scripts, AI agents) that drive it.

Login is an OAuth 2.0 device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)). "The directory server" is whichever server `agx` is pointed at; Elladex (`https://app.ellaworks.ai`) is the default. "Base" is that server's origin, with no trailing slash.

This is not the NIP-AGX protocol. That is [`packages/core/SPEC.md`](../core/SPEC.md), and nothing here changes it. Code comments and tests in this package cite this file as "LOGIN-CONTRACT.md §1.x", so the section numbers below are stable.

## 1. Server–CLI contract

### 1.1 Shared conventions

**Device endpoints** are plain HTTP and JSON.

- Paths: `POST {base}/api/auth/device/code` and `POST {base}/api/auth/device/token`.
- The server accepts request bodies as `application/json` or `application/x-www-form-urlencoded`. agx sends JSON, with `Accept: application/json` and `User-Agent: agx/<version> (node <version>; <platform>)`.
- Responses are always `application/json`, with `Cache-Control: no-store` and `Pragma: no-cache`.
- Error body (RFC 6749 §5.2): `{ "error": "<code>", "error_description"?: "<text>", "interval"?: <int seconds> }`.
- agx never follows a redirect on these endpoints. A 3xx answer ends the login with exit 6.
- agx gives each request 15 seconds.

**API procedures** are called as RPC at `{base}/api/rpc`.

- The request is `POST {base}/api/rpc/<router path, "/"-separated>` with body `{"json": <input>}`. For example `account.principal.get` is `POST {base}/api/rpc/account/principal/get`.
- Auth header: `X-API-Key: <key>`. The server may also accept `Authorization: Bearer <key>`; agx only sends `X-API-Key`.
- An error response has HTTP status = `status` and body `{"json":{"defined":false,"code":"<CODE>","status":<n>,"message":"<text>","data":<object, optional>}}`.
- agx reads `data.code` first (§1.7), then `code` and `status`. It reads message text only for the few fallbacks it keeps for servers that predate `data.code` (§1.9).
- agx never follows a redirect with a key. A 3xx answer is exit 6.
- agx gives each call 30 seconds.

**Base URL.** agx only sends a key to an `https:` origin, or to `http:` on `localhost`, `127.0.0.1` or `::1`.

**Timestamps** in API outputs are ISO-8601 strings.

**Scopes.** This is the whole vocabulary, in canonical order:

`listings:read`, `listings:write`, `domains:read`, `domains:write`

- `:write` does not imply `:read`.
- On the wire a scope string is space-delimited, in canonical order.

**User code** format: `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$`. Clients display it verbatim and do not validate it strictly.

**Key shape.** agx stores an `access_token` only if it is 1 to 512 printable ASCII characters with no spaces, so it can always be sent as a header value. Elladex keys are `ela_` followed by 64 letters.

### 1.2 `POST /api/auth/device/code`

Request fields. All are optional for the server; agx always sends the first three.

| Field | Type | Rules |
|---|---|---|
| `client_id` | string | A client id the server has registered. agx sends `"agx"`. An unknown value is 400 `invalid_client`. Clients that send no `client_id` keep the legacy behaviour (§1.9). |
| `scope` | string | A space-delimited subset of the scopes the client may ask for; anything else is 400 `invalid_scope`. Defaults to the client's default scopes. Not allowed without a `client_id` (400 `invalid_scope`). agx sends `listings:read listings:write domains:read domains:write`. |
| `host_label` | string | Shown on the approval page as reported by the device, not verified. The server sanitizes it: Unicode NFKC, control and format characters removed, whitespace collapsed and trimmed, at most 64 characters, empty becomes null. agx sends the machine's host name. |
| `org_hint` | string | Slug of an existing organization to preselect. Must be a well-formed slug of 3 to 32 characters, else 400 `invalid_request`. The server does not look it up here, so the endpoint tells an anonymous caller nothing about which organizations exist. agx sends it for `--org <slug>`. |
| `new_org` | boolean, or `"true"` / `"false"` | Ask the approver to create a new organization. With `org_hint` it is 400 `invalid_request`. agx sends `true` for `--new-org`. |
| `new_org_name` | string | Prefill. Requires `new_org`. A name that breaks the server's naming rules is 400 `invalid_request`, with the rule in `error_description`. agx sends it for `--org-name`. |
| `new_org_slug` | string | Prefill. Requires `new_org`. Checked for pattern, length and reserved words; availability is not checked here. agx sends it for `--org-slug`. |
| `client_name` | string | Legacy clients only. Ignored when `client_id` is present. |

`200` response:

```json
{
  "device_code": "3f9c…(64 hex)",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://app.ellaworks.ai/auth/device",
  "verification_uri_complete": "https://app.ellaworks.ai/auth/device?code=WDJB-MJHT",
  "expires_in": 1800,
  "interval": 5,
  "scope": "listings:read listings:write domains:read domains:write"
}
```

- `scope` is present only when the request carried a `client_id`. It is the scope the key will have.
- `expires_in` is the code's lifetime in seconds. Elladex uses 1800 for agx.
- `verification_uri` and `verification_uri_complete` are on the origin the request was sent to.

Errors:

- 400 with `invalid_request`, `invalid_client` or `invalid_scope`;
- 429 `{"error":"rate_limited","error_description":"…"}` with `Retry-After: 60`;
- 500 `server_error`.

What agx does with the answer:

- It requires `device_code`, `user_code`, `verification_uri` and a positive `expires_in`. If `verification_uri_complete` is absent it builds `{verification_uri}?code={user_code}`. If `interval` is absent it uses 5.
- **No `scope` in the answer: agx stops before showing a code (exit 6).** A server that does not echo the scope would issue an unscoped key that never expires.
- **A `verification_uri` or `verification_uri_complete` on another origin than base: agx stops before showing a code (exit 6).** A login code is only ever entered on the server being logged in to.
- 429 is exit 6, and the message quotes `Retry-After` (seconds or an HTTP date). A 5xx or an unreachable server is exit 5. Any other non-200 answer, or a body that is not a JSON object, is exit 6; agx prints `error` and `error_description` with control characters removed and cut to 200 characters.

### 1.3 `POST /api/auth/device/token`

Request fields:

- `device_code`: required.
- `grant_type`: required when the code was issued to a `client_id`, and must be `urn:ietf:params:oauth:grant-type:device_code`.
- `client_id`: required when the code was issued to one, and must be the same one.

agx always sends all three.

The server evaluates a request in this order. The first match wins.

| # | Condition | Response |
|---|---|---|
| 1 | The caller's IP is over the server's request limit | 400 `slow_down`, with no `interval` |
| 2 | `device_code` missing | 400 `invalid_request` |
| 3 | No such code | 400 `invalid_grant`, "Invalid device code" |
| 4 | `client_id` sent but not registered | 400 `invalid_client` |
| 5 | The code was issued to a `client_id` and: `grant_type` is missing | 400 `invalid_request` |
|   | … `grant_type` is wrong | 400 `unsupported_grant_type` |
|   | … `client_id` is missing or different | 400 `invalid_grant` |
| 6 | The code's lifetime has passed and it is pending or approved | The code becomes expired; 400 `expired_token` |
| 7 | The code is expired | 400 `expired_token` |
| 8 | The code was denied | 400 `access_denied` |
| 9 | The code was already exchanged for a key | 400 `invalid_grant`, "Device code already used" |
| 10 | Pending, and polled sooner than `interval − 1` s after the previous poll | 400 `{"error":"slow_down","interval":<new>}`. For a registered client the interval grows by 5 s (at most 60) and the new value is returned. |
| 11 | Pending | 400 `authorization_pending` |
| 12 | Approved, but with no organization (by an approval page that predates this contract) | The code becomes expired; 400 `expired_token`, "Approved by an older page; sign in again" |
| 13 | Approved, and a concurrent request has just exchanged it | 400 `invalid_grant` |
| 14 | Approved, but the approver has since lost the organization or the role needed | The code becomes denied; 400 `access_denied`, "The approving account can no longer grant this" |
| 15 | Approved, but the key could not be issued for any other reason | The code stays approved; 500 `{"error":"server_error","error_description":"Could not issue a key, try again"}`. Never raw error text. |
| 16 | Approved | 200, below |

`200` is the only time the key is ever returned. A second request for the same code gets `invalid_grant` (row 9).

```json
{
  "access_token": "ela_AbCd…(64 letters)",
  "token_type": "Bearer",
  "expires_in": 7776000,
  "expires_at": "2026-12-29T18:04:11.000Z",
  "scope": "listings:read listings:write domains:read domains:write",
  "api_key_id": "k_9fJ…",
  "user": { "id": "u_1", "email": "alice@acme.com", "name": "Alice" },
  "organization": { "id": "o_1", "slug": "acme-robotics", "name": "Acme Robotics" }
}
```

- `expires_in` is the key's remaining lifetime in whole seconds; `expires_at` is the same moment as an ISO string. Both are `null` for a key that never expires.
- For a code issued without a `client_id`, `expires_in` and `expires_at` are `null` and there is no `scope`.

**Timing.** `interval` starts at 5 s. A code is single-use and stays valid until its `expires_in` has passed. The server keeps an expired code's record for 24 hours.

What agx does:

- **Spacing.** It waits at least `interval` between polls, counted from the last poll by any agx process on the profile. After `slow_down` it uses the response's `interval`, or its current interval + 5 s when that field is absent, and never lowers it again for that code (RFC 8628 §3.5).
- **429, or a body that is not a JSON object,** is treated like `slow_down` (+5 s), and agx also waits out `Retry-After` when present.
- **5xx or no answer:** it backs off (interval × 2ⁿ, at most 30 s) and gives up with exit 5 after five failures in a row. The code is kept and the same command resumes it. A `--no-wait` run gives up on the first failure.
- **3xx:** exit 6. Never followed.
- **200:** it requires a well-formed `access_token` (§1.1), `token_type`, `api_key_id`, `user.id` and `organization` with `id`, `slug` and `name`. If any is missing or malformed the key is not stored and the run is exit 6, naming the fields and never a value. It records `expires_at`, or else now + `expires_in`, or else no expiry.
- `authorization_pending`: keep polling. `expired_token`, `access_denied`: exit 4.
- `invalid_grant`: exit 4, unless another agx process on the same profile has just stored the login from this code, in which case that login is reported (exit 0).
- Any other `error`: exit 6.
- Once its own clock passes the code's expiry, agx stops with exit 4 without asking the server again.

### 1.4 What the person sees between `/code` and `/token`

This section is informative. It is not wire format.

The person opens `verification_uri_complete`, signs in or signs up (the code survives that round trip), and checks that the code on the page matches the one agx printed. The approval page shows:

- which client is asking ("agx (command-line tool)"), as registered with the server, not as claimed by the request;
- the host label, marked as reported by the device, with the requesting IP address and the time;
- the scopes the key will have;
- the key's lifetime (90 days on Elladex).

They then pick an organization in which they are an owner or admin, or create one from the prefill, and approve or deny.

- The page may link the current Terms. Following the link is optional: there is nothing to tick, nothing is recorded, and approving does not depend on it.
- Denying is what agx sees as `access_denied`. Letting the code run out is `expired_token`.
- The person may pick another organization than `org_hint`. The token response is the truth: agx reports the `organization` it returned, and names the requested one when the two differ (§1.8).

### 1.5 `account.principal.get` (whoami)

- RPC: `POST {base}/api/rpc/account/principal/get`, input `{}`. REST: `GET {base}/api/account/principal`.
- Any valid credential may call it, scoped keys included.

Output for a key issued by `agx login`:

```json
{
  "authMethod": "api_key",
  "user": { "id": "u_1", "emailMasked": "a•••@acme.com" },
  "organization": { "id": "o_1", "slug": "acme-robotics", "name": "Acme Robotics", "role": "owner" },
  "apiKey": {
    "id": "k_9fJ…", "name": "agx-alices-mbp-3fa1", "start": "ela_Ab",
    "scoped": true,
    "scopes": ["listings:read", "listings:write", "domains:read", "domains:write"],
    "clientId": "agx", "hostLabel": "alices-mbp",
    "expiresAt": "2026-12-29T18:04:11.000Z"
  }
}
```

- A key that was not issued to a registered client with scopes (for example one minted in Settings): `scoped: false`, `scopes: []`, and `clientId`, `hostLabel` and `expiresAt` may be `null`.
- A key whose owner is no longer a member of the key's organization: still `200`, with `organization: null` and `user` and `apiKey` as above, so the key's id stays known. This is the only case in which an API-key caller gets `organization: null`.
- A browser-session caller: `authMethod: "session"`, `organization: null`, `apiKey: null`.
- `emailMasked` is the first character, three bullets (`•••`, always three) and `@domain`.
- The output never contains the full email address, key material, or the key's raw stored metadata.
- Errors: 401 with one of the key codes in §1.7. A key whose owner has left the key's organization is not an error here (above); `API_KEY_OWNER_NOT_MEMBER` (§1.7) is for the other procedures.

How agx uses it:

- **`agx whoami`** prints this output. With `--json` the document is `{loggedIn, verified, profile, apiBaseUrl, source, user: {id, email}, organization: {id, slug, name, role}, apiKey: {id, name, scoped, scopes, clientId, hostLabel, expiresAt}}`, where `user.email` is the masked address. It never prints the key.
  - With no credential at all it is exit 4, and under `--json` it prints `{"loggedIn": false, "profile": "<name>"}` first.
  - `organization: null` for an API key: agx says that the key's owner is no longer a member of its organization, and exits 4. Under `--json` it prints the document first, with `verified: true` and `organization: null`; it never substitutes the organization it remembers from the login.
  - A 404 with no `data.code` means a server without this procedure: agx prints its own local record with `verified: false` and exits 0.
- **`agx login`** calls it to confirm a stored login before answering "already logged in" (§1.8). If the server refuses the key (any exit-4 error), answers 404, or answers `organization: null`, agx requests a new code instead.
- **`agx config set apiKey`** calls it once, best effort, after storing the key, and records `apiKey.id` with it, so a later `agx logout` need not ask. The call has a 10-second limit. If the server cannot be reached, does not answer in time, answers 404, refuses the key or names no id, the key stays stored without an id and the command still exits 0. A refusal and `organization: null` each get a notice on stderr.
- **`agx logout`** calls it to learn `apiKey.id` for a key stored without one: by `agx config set apiKey` when that lookup failed, or by an earlier agx (§1.6).

### 1.6 `organizations.list` and `prm.apiKeys.delete` (self-revoke)

**`organizations.list`**

- RPC: `POST {base}/api/rpc/organizations/list` with `{"json":{}}`. REST: `GET {base}/api/organizations`.
- Input `{}`. Output is a bare array; `logo` is optional:
  `[{ "id": "o_1", "name": "Acme Robotics", "slug": "acme-robotics", "logo": "https://…", "role": "owner" }]`
- A scoped key sees only its own organization. An unscoped key or a browser session sees every organization its user belongs to.
- `agx org list --json` prints `{"organizations":[…]}`: the same rows, each with `current: true|false` for the organization the profile acts on.

**`prm.apiKeys.delete`**

- RPC: `POST {base}/api/rpc/prm/apiKeys/delete` with `{"json":{"apiKeyId":"k_9fJ…"}}`. REST: `DELETE {base}/api/api-keys/{apiKeyId}`.
- An API-key caller may delete only its own id. Any other id is 403 `API_KEY_SELF_REVOKE_ONLY`.
- A browser-session caller may delete keys it owns. A key it does not own is 404.
- Output: `{ "success": true }`.
- After success, the next call with that key gets 401 `API_KEY_INVALID`.

**What `agx logout` does with it.** It revokes the profile's key on the server, then forgets it locally. The call goes to the origin the key was issued for, never to whatever the profile currently points at. When the profile has no recorded id for the key (a key stored with `agx config set apiKey` whose lookup failed, §1.5), agx asks `account.principal.get` for it first; that still works after the key's owner has left the key's organization.

`agx logout --json` prints `{"loggedOut":[{"profile","revoked","reason"}]}`, with one row per profile (`--all` covers every profile). `reason` is one of:

| `reason` | Meaning | Key forgotten locally |
|---|---|---|
| `revoked` | The server deleted the key | yes |
| `already-invalid` | The server refused the key itself (below), or the stored value could never be sent as a key | yes |
| `revoke-failed` | Anything else went wrong | **no**: the run fails with exit 5 (unreachable), 6 (for example a 404 from a server without self-revoke) or 4 (any other 401, or another exit-4 code in §1.7) |
| `not-revoked-local` | The same, under `--local` | yes, with a notice that the key is still valid |
| `legacy-key-cleared` | A key left over from agx 0.3: forgotten, never revoked | yes |
| `not-logged-in` | Nothing was stored | — |

The server "refused the key itself" only when:

- the error's `data.code` is `API_KEY_INVALID` or `API_KEY_EXPIRED`; or
- the error has no `data.code`, is a 401, and its `message` is exactly `Invalid API key`.

Any other answer proves nothing about the key, which may still work, so agx keeps it. That includes a 404, a 401 with any other message or any other `data.code`, and `API_KEY_DISABLED` (a disabled key still exists).

**What `agx login` does with it.** When a login replaces an earlier login key on the same profile, agx revokes the earlier key after it has printed the new result. This is best effort with a 10-second limit: if it fails for a reason other than the key being refused as above, agx prints a notice on stderr and the old key is left to expire. A replaced key that did not come from `agx login` (a Settings key, which may still be in use elsewhere) is never revoked; agx prints a notice instead.

### 1.7 Error codes in `data.code`

An API error (§1.1) may carry a stable `data.code`. agx branches on it before anything else.

| `data.code` | `code` / HTTP | Extra `data` fields | When | agx exit |
|---|---|---|---|---|
| `HUMAN_CONFIRMATION_REQUIRED` | `FORBIDDEN` / 403 | `url` (relative: `/elladex/listings/{listingId}?org={orgSlug}`), `listingId`, `requested: {"visibility":"public","status":"listed"}` | A scoped key tries to make a listing public and listed. An organization admin has to do that in the browser. | **7** |
| `TERMS_ACCEPTANCE_REQUIRED` | `PRECONDITION_FAILED` / 412 | `termsVersion`, `url` (absolute Terms URL), `loginRequired: boolean` | Reserved: never sent today, since the approval page (§1.4) records no Terms acceptance. It stays in the contract so that agx already handles it should a server need it later. agx sends the person to `url` in the browser, never to `agx login`. | **7** |
| `INSUFFICIENT_SCOPE` | `FORBIDDEN` / 403 | `required: string \| null` (null: not available to any scoped key), `granted: string[]` | A scoped key calls a procedure its scopes do not cover | 4 |
| `API_KEY_INVALID` | `UNAUTHORIZED` / 401 | — | Unknown, deleted or revoked key. The `message` is exactly `Invalid API key`. | 4 |
| `API_KEY_EXPIRED` | `UNAUTHORIZED` / 401 | — | The key has expired. A server may answer `API_KEY_INVALID` on later calls, once it has dropped the expired key. | 4 |
| `API_KEY_DISABLED` | `UNAUTHORIZED` / 401 | — | The key was disabled and can be re-enabled | 4 |
| `API_KEY_RATE_LIMITED` | `TOO_MANY_REQUESTS` / 429 | `retryAfterMs` | The key's rate limit | 6 |
| `API_KEY_USAGE_EXCEEDED` | `TOO_MANY_REQUESTS` / 429 | — | A key with a lifetime request quota has used it up | 6 |
| `API_KEY_OWNER_NOT_MEMBER` | `FORBIDDEN` / 403 | — | The key's owner is no longer a member of the key's organization. Not from `account.principal.get`, which answers with `organization: null` instead (§1.5). | 4 |
| `API_KEY_SELF_REVOKE_ONLY` | `FORBIDDEN` / 403 | — | `prm.apiKeys.delete` with another key's id (§1.6) | 6 |
| `LISTING_SLUG_TAKEN` | `CONFLICT` / 409 | — | Creating a listing whose slug is taken | 6 |
| `LISTING_ADDRESS_LIVE` | `CONFLICT` / 409 | `listingId`, only when the live listing is in the caller's own organization | Creating a listing for an agent address that already has a live one | 6 |

Wire example, `HUMAN_CONFIRMATION_REQUIRED` over RPC:

```http
HTTP/1.1 403 Forbidden
content-type: application/json

{"json":{"defined":false,"code":"FORBIDDEN","status":403,
 "message":"Making this listing public needs an organization admin to confirm it in the browser: https://app.ellaworks.ai/elladex/listings/l_7?org=acme-robotics",
 "data":{"code":"HUMAN_CONFIRMATION_REQUIRED","url":"/elladex/listings/l_7?org=acme-robotics","listingId":"l_7","requested":{"visibility":"public","status":"listed"}}}}
```

REST returns the same object without the `{"json":…}` envelope. The absolute URL in `message` is there for clients that predate `data.code`.

**URLs.** agx never hands a person a URL the server chose freely:

- a relative `data.url` is resolved against agx's own base, not the server's idea of its origin;
- an absolute URL on the base origin is kept, with any user name and password removed;
- for `TERMS_ACCEPTANCE_REQUIRED` only, an `https:` URL on the same site as the base is also kept (the base host's parent domain and its subdomains, so `www.ellaworks.ai` for `app.ellaworks.ai`);
- anything else, including a missing URL and a scheme other than http or https, is replaced by `{base}/elladex`.

**Unknown codes.** A `data.code` agx does not know falls back to the status: 401 is exit 4; 403, 404, 409, 412, 422 and 429 are exit 6; anything else is exit 1. agx then prints the server's `message`, so a new code needs a message that stands on its own.

**Message rule.** No error message may contain the phrases "organization scope" or "does not have access to this organization", unless it means what an older server meant by them. agx matches both when an error has no known `data.code`, and agx 0.3 matches them always; either would print the wrong remedy.

### 1.8 CLI-facing contract (for harnesses)

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Unexpected error |
| 2 | Usage: a bad flag or argument |
| 3 | Local configuration: not logged in, no organization, a credential bound to another server, a malformed file |
| 4 | Authentication: the key was refused, has expired or is bound to another organization; a login was denied or its code expired |
| 5 | The server could not be reached, or kept failing with 5xx |
| 6 | The server refused the request on its merits |
| 7 | **A person has to act in a browser first.** Not a failure. |
| 130 | Interrupted. A waiting `agx login` stops this way on SIGINT, SIGTERM or SIGHUP and keeps its code. |

**`actionRequired`.** With `--json`, exit 7 prints exactly one JSON object, on one line, on **stdout**:

```json
{"actionRequired":{"reason":"LOGIN_APPROVAL_REQUIRED","url":"https://app.ellaworks.ai/auth/device?code=WDJB-MJHT","userCode":"WDJB-MJHT","expiresIn":1742,"expiresAt":"2026-09-30T18:34:11.000Z","verificationUri":"https://app.ellaworks.ai/auth/device"}}
```
```json
{"actionRequired":{"reason":"HUMAN_CONFIRMATION_REQUIRED","url":"https://app.ellaworks.ai/elladex/listings/l_7?org=acme-robotics","userCode":null,"expiresIn":null,"listingId":"l_7"}}
```
```json
{"actionRequired":{"reason":"TERMS_ACCEPTANCE_REQUIRED","url":"https://www.ellaworks.ai/en/legal/terms","userCode":null,"expiresIn":null}}
```

| Field | Type | Notes |
|---|---|---|
| `reason` | string | A closed list: the three values above. `TERMS_ACCEPTANCE_REQUIRED` is reserved (§1.7). A new reason is a contract change. |
| `url` | string | Always absolute, and always on the server agx is talking to (§1.7 "URLs"). For a login it is `verification_uri_complete`. |
| `userCode` | string \| null | The code the person checks on the page. Null when there is none. |
| `expiresIn` | number \| null | Seconds left, counted when the object is printed. Null when the action does not expire. |
| `expiresAt` | string | Login only. ISO time at which the code expires. |
| `verificationUri` | string | Login only. The page where the code can be typed by hand. |
| `listingId` | string | `HUMAN_CONFIRMATION_REQUIRED` only, when the server sent one. |

Without `--json`, exit 7 prints a message, the URL and the code on stderr and nothing on stdout.

A harness shows the URL, and `userCode` when there is one, to a person. It never opens or fills in the page on their behalf.

**`agx login` modes**

*Already logged in.* When the profile holds a login for the same server that has not expired, the run has no `--force`, and it does not ask for another organization (`--new-org`, or an `--org` other than the stored one), agx confirms the key with `account.principal.get` and exits 0 with `alreadyLoggedIn: true`. No code is requested. A key the server refuses, or answers with `organization: null` (§1.5), is not confirmed: the run requests a new code, and revokes the old key once the new login is stored (§1.6).

*Which code a run uses.* A code that is waiting for approval is saved, with its device code, in `pending-login.json` in the profile's directory (mode `0600`). A run resumes that code when it is for the same server and the same request (`--org`, `--new-org`, `--org-name`, `--org-slug`) and has not expired. Otherwise it discards the file and requests a new code, with the one exception under `--no-wait` below.

*Blocking (`agx login`, the default).* agx prints the URL and code on stderr, opens a browser only when a person is plainly at the terminal, and polls until the login finishes. It never opens a browser under `--json`, `--no-browser`, `--no-wait`, when `CI` or `AGX_NO_BROWSER` is set, over SSH, on Linux without a display, or when stderr is not a terminal. With `--json` it instead writes the `actionRequired` object as one line on **stderr** straight away; only the final result goes to stdout.

*Non-blocking (`agx login --no-wait`).* For harnesses, which cannot click a link and should not sit in a call for minutes.

| State when the run starts | What the run does | Exit |
|---|---|---|
| No saved code for this server and request | Requests a code, saves it, does not poll | 7 |
| A saved code that is still live | Waits out the rest of the interval, polls **once** | 0 approved; 7 still pending; 4 denied, expired or no longer accepted |
| A saved code that expired within the last 24 hours | Reports that code as expired and removes it. The next run requests a new one. | 4 |
| A saved code that expired more than 24 hours ago | Discards it and requests a new code, as a first run would | 7 |
| A saved code for another server or another request | Discards it and requests a new code | 7 |

- So a `--no-wait` run never swaps in a new code for one a person may still be looking at. Only a code abandoned for over a day is replaced silently. The 24 hours match how long the server keeps an expired code (§1.3).
- If another agx process is already polling the same code, a `--no-wait` run waits for it for at most the interval plus 20 seconds. It then reports that process's result, or exits 7 with a notice on stderr naming the process.
- Every remedy a `--no-wait` run prints says `agx login --no-wait`, so a harness is never pointed at the blocking form.
- A 5xx or an unreachable server is exit 5 and the code is kept.

Only one agx process polls a code at a time (a lock file beside `pending-login.json`). `agx org create <name>` is `agx login --new-org --org-name <name>` and follows all of the above.

**Success.** `agx login --json` prints one JSON document on stdout (indented over several lines) and exits 0:

```json
{
  "loggedIn": true,
  "alreadyLoggedIn": false,
  "profile": "default",
  "apiBaseUrl": "https://app.ellaworks.ai",
  "user": { "id": "u_1", "email": "a•••@acme.com" },
  "organization": { "id": "o_1", "slug": "acme-robotics", "name": "Acme Robotics" },
  "requestedOrg": null,
  "scopes": ["listings:read", "listings:write", "domains:read", "domains:write"],
  "expiresAt": "2026-12-29T18:04:11.000Z",
  "apiKeyId": "k_9fJ…"
}
```

- `user.email` is always masked (§1.5).
- `requestedOrg` is the slug the run asked for (`--org`, or `--org-slug` with `--new-org`) when the login was approved for a different organization, and `null` otherwise. `organization` is the one the key belongs to.
- `expiresAt` is `null` for a key that never expires.

**The key.** It is written to `credentials.json` (mode `0600`) and nowhere else. Nothing a harness can read contains the key or the device code: not stdout, not stderr, not an error message, under `--json` or not.

### 1.9 Compatibility promises

**Clients that send no `client_id` keep the legacy behaviour.** For them `/code` returns the same six fields as before (no `scope`), JSON bodies are accepted, the `/token` success still carries `user: {id, email, name}` with `expires_in: null`, `slow_down` never raises the interval, and the key is unscoped with no expiry.

**Unscoped keys keep working.** A key minted in Settings, or one an agx 0.3 profile already holds, is not limited by scopes, and on Elladex the browser confirmation for public listings (`HUMAN_CONFIRMATION_REQUIRED`) applies to scoped keys only. What does change for every key:

- a rate-limited, expired or disabled key gets 429 or 401 with a `data.code` (§1.7);
- a listing slug collision is 409 `LISTING_SLUG_TAKEN`.

**agx 0.4 against a server that does not implement this contract.**

- `/code` answers without `scope`, so agx stops before showing a code (exit 6, §1.2). An older server can therefore never issue an unscoped, never-expiring key into `agx login`.
- `account.principal.get` answers 404: `agx whoami` prints its local record with `verified: false` (§1.5).
- `prm.apiKeys.delete` answers 404: `agx logout` keeps the key and exits 6; `agx logout --local` forgets it (§1.6).
- An error with no `data.code` is mapped by status (§1.7 "Unknown codes"). A few message matches remain for such errors: a 401 whose message is exactly `Invalid API key` counts as the server refusing the key (§1.6); a 403 containing "does not have access to this organization" is exit 4 instead of 6; a 401 containing "organization scope" is exit 4 with its own remedy. Any other match only chooses the hint agx prints.

**agx 0.4 on a machine that ran agx 0.3.**

- Server choice for `agx login`: `--api-base-url`, then `AGX_API_URL`, then the profile's `apiBaseUrl`, then `https://app.ellaworks.ai`. A stored `apiBaseUrl` of `http://localhost:3000` is skipped, because agx 0.3 wrote that value into every profile without anyone choosing it.
- A successful login removes the profile's 0.3 key from `config.json` and says so on stderr. It does not revoke that key.
- `AGX_API_KEY`, when set, still takes precedence over a login for every other command. `agx login` and `agx logout` print a reminder.

### 1.10 Contract fixture

[`src/test/fixtures/contract-v1.json`](src/test/fixtures/contract-v1.json) holds the JSON bodies of §1.2, §1.3, §1.5, §1.6 and §1.7 as data: each request, each success body and each error with its status.

- **The shapes are the contract:** which keys are present or absent, and the type of each value. The values are this document's examples, placeholders included (`"3f9c…(64 hex)"`).
- One case is described here and not in the fixture: `account.principal.get` for a key whose owner is no longer a member of the key's organization is `principal.output` with `organization: null` (§1.5). agx's tests build it from that entry.
- agx's own tests run against a mock directory server that serves these bodies and applies the §1.3 rules in order.
- A server implementation can check itself the same way: assert that each of its responses has the shape of the matching fixture entry.
- A change to the fixture needs a matching change to this document, and the other way round. The fixture's `version` is `1`.
