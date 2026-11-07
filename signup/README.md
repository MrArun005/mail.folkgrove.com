# Signup service

A small Node 20 service (no dependencies) that lets the public create a mailbox `username@DOMAIN` on the hosted instance. It calls Stalwart's admin JMAP API, so the admin credentials stay on the server and never reach the browser.

```sh
cd signup
DOMAIN=openmail.test ADMIN_FILE=../deploy/.dev-admin.json INVITE_CODES=welcome:5 node server.mjs
npm test        # unit tests, plus an integration test against the local dev Stalwart (skipped if it's not running)
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DOMAIN` | required | Mail domain for new accounts. It must already exist in Stalwart. |
| `ADMIN_FILE` | | Path to JSON `{"user": "...", "pass": "..."}`. Preferred: mount it as a secret. |
| `ADMIN_USER`, `ADMIN_PASS` | | Use these instead of `ADMIN_FILE`. |
| `STALWART_URL` | `http://localhost:8080` | Base URL of Stalwart's HTTP listener. Use a private network address. |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Address the service listens on. |
| `INVITE_REQUIRED` | `true` | Set to `false` to allow sign-up without an invite. |
| `INVITE_CODES` | | Comma-separated list. Each entry is `code` (one use) or `code:uses`, for example `alpha:10,beta`. Use counts are kept **in memory**, so a restart refills them. |
| `INVITE_FILE` | | The same format, one per line. Remaining uses are written back to this file after every sign-up, so they survive restarts. Use this in production. It takes precedence over `INVITE_CODES`. |
| `TURNSTILE_SECRET` | | When set, every sign-up must include a valid Cloudflare Turnstile `captchaToken`. |
| `QUOTA_BYTES` | `1073741824` (1 GiB) | Disk quota for each new account. `0` means no quota. |
| `SIGNUPS_PER_HOUR` | `3` | Sign-up attempts allowed per client IP (IPv6: per /64) per hour. |
| `CHECKS_PER_MINUTE` | `30` | Username-availability checks allowed per client IP per minute. |
| `CLIENT_IP_HEADER` | | Header that carries the real client IP when the service runs behind a proxy, for example `cf-connecting-ip` or `x-real-ip`. Set this **only** if the proxy overwrites that header, because otherwise clients can spoof it. If unset, the socket address is used. |
| `ADMINS` | | Usernames on `DOMAIN` (comma-separated, e.g. `ann,raj`) who may use the admin console at `/admin`. Empty: the console is off and `/api/admin/*` answers 404. See [Admin console](#admin-console-apiadmin). |
| `RESERVED_NAMES` | | Extra reserved usernames, comma-separated. They are added to the built-in list in `lib.mjs`. |
| `HOLD_HOOK_SECRET` | | Turns on [holding outgoing spam](#outgoing-spam-held-for-review). Stalwart's hook must send it as `Authorization: Bearer …`. `install.sh` creates it (`.hold.env`). |
| `HOLD_DIR` | | Where held messages are kept (one `.json` + `.eml` pair each). Without it they live in memory until restart. `/data/held` in `docker-compose.yml`. |
| `HOLD_SCORE` | `5` | Hold a message whose content scores this much or more (Stalwart's spam scores; see below). |
| `HOLD_SUSPEND_AFTER` | `3` | Pause a sender's sending once this many of their messages are waiting for review. |
| `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_TLS_NAME`, `SYSTEM_SMTP_INSECURE` | `stalwart`, `465` | Where released mail is submitted (and system mail is sent). |
| `RETIRED_FILE` | | File (one name per line) where the names of deleted accounts and their aliases are kept, so they are never given out again. Stalwart itself frees them on delete. Set it in production (`docker-compose.yml` does); without it the list lasts until restart. |

Docker:

```sh
docker build -t openmail-signup signup/
docker run -e DOMAIN=example.com -e ADMIN_FILE=/run/secrets/admin.json -e INVITE_FILE=/data/invites.txt \
  -v ./admin.json:/run/secrets/admin.json:ro -v ./data:/data -p 3000:3000 openmail-signup
```

### Deployment notes

- **Behind the production Caddy** (`deploy/production/Caddyfile`), set `CLIENT_IP_HEADER=x-real-ip`. Caddy overwrites that header with the real client address; without it every visitor shares Caddy's IP and one rate-limit bucket.
- **Serve it from the same origin as the web client** (for example, proxy `/api/` to this service). The service sends no CORS headers. It accepts only `Content-Type: application/json`, so a browser on another site can't submit the form without a CORS preflight, which fails.
- Rate limits and env-configured invite counts live in one process's memory. Run **one instance**, or move the limits to the proxy or Cloudflare. See the `ponytail:` note in `lib.mjs`.
- Logs record why Stalwart refused or failed a request. They never include passwords or the admin credentials.

## API

All responses are JSON with `Cache-Control: no-store`. An error always looks like this:

```json
{ "ok": false, "error": { "code": "username_taken", "message": "That username is already taken. Please pick another one.", "field": "username" } }
```

`message` is plain language and safe to show the user as is. `field` is present when one form field is at fault (`username`, `password`, `inviteCode`, `captchaToken`). Use it to place the message next to that field. Use `code` in your own logic, because the wording of `message` may change.

### `POST /api/signup`

Request (`Content-Type: application/json`, body at most 4 KB):

```json
{ "username": "jane.doe", "password": "correct horse battery staple", "inviteCode": "alpha", "captchaToken": "<turnstile token>" }
```

- `username` is trimmed and lowercased before it is checked. The address becomes `jane.doe@DOMAIN`.
- `inviteCode` is required unless `INVITE_REQUIRED=false`.
- `captchaToken` is required only when the server has `TURNSTILE_SECRET` set. It is the value the Turnstile widget puts in `cf-turnstile-response`. Each token works once, so reset the widget after any error.

Success: `201 {"ok": true, "email": "jane.doe@openmail.test"}`. The user can sign in right away with that address and password.

The checks run in this order, and the first failure is returned:

| Status | `code` | When |
|---|---|---|
| 415 | `json_required` | The body isn't `application/json`. |
| 413 | `body_too_large` | The body is over 4 KB. |
| 400 | `bad_json` | The body isn't a JSON object. |
| 400 | `username_required`, `username_too_short`, `username_too_long`, `username_invalid_chars`, `username_bad_dots`, `username_bad_hyphen`, `username_reserved` | Username rules: 3–32 characters; only `a-z`, `0-9`, `.` and `-`; no dot or hyphen at the start or end; no `..`; not a reserved name. Reserved names are matched with dots and hyphens ignored, so `no.reply` counts as `noreply`. |
| 400 | `password_required`, `password_too_short`, `password_too_long`, `password_contains_username` | Password rules: 12–128 characters, and it must not contain the username (case-insensitive). |
| 429 | `rate_limited` | Too many sign-up attempts from this IP. A `Retry-After` header (seconds) is set. Only requests that pass the checks above count. |
| 400 | `captcha_failed` | Turnstile is on and the token is missing or invalid. |
| 403 | `invite_required` | No invite code was given. |
| 403 | `invite_invalid` | The code is unknown or used up. |
| 409 | `username_taken` | The address already exists. Stalwart returns `primaryKeyViolation` on `email`; this was verified for account names, not for alias collisions. The invite use is refunded. |
| 400 | `password_weak` | Stalwart's own strength check rejected the password (`minPasswordStrength`, a zxcvbn-style score). The invite use is refunded. |
| 503 | `unavailable` | Stalwart is unreachable or refused for another reason. The details are logged on the server only. The invite use is refunded. |
| 500 | `internal` | Unexpected bug. |

### `GET /api/username-available?u=<username>`

Use this for live feedback while the user types. Debounce it (around 400 ms), because it is rate-limited to `CHECKS_PER_MINUTE` per IP.

- `200 {"ok": true, "available": true, "email": "jane.doe@openmail.test"}`
- `200 {"ok": true, "available": false, "code": "username_taken" | "username_reserved" | any username_* code, "message": "..."}`
- `429` and `503` errors use the same shape as above.

This endpoint checks account names only. An alias that collides is caught at sign-up time (`409 username_taken`).

### `DELETE /api/account`

Deletes the caller's own account and all its mail, contacts and calendars. Needs the caller's sign-in token (`Authorization: Bearer …`; passwords are refused as on `/api/aliases`) and a JSON body `{ "password": "…", "code": "123456", "confirm": "jane.doe@DOMAIN" }`: the current password (`code` only with two-factor sign-in on; checked through Stalwart's sign-in API, so an app password doesn't count) and the full address typed as confirmation. Before the account is destroyed, its username and every alias go into `RETIRED_FILE`, so sign-up and masked-address generation never hand them out again. Errors: `401 unauthorized`, `400 confirm_mismatch` / `password_required` / `code_required`, `403 wrong_password` (5 per account per hour, then `429`), `503 unavailable` (nothing removed).
### Admin console (`/api/admin/*`)

The web app's `/admin` screen calls these. Each request must carry the admin's own sign-in token (`Authorization: Bearer …`). The service checks it with Stalwart (same check as `/api/aliases`), then checks that the account's name is in `ADMINS`: `401 unauthorized` without a valid token, `403 not_admin` for anyone else. Failed sign-ins count against the same per-network limit as aliases. It is a fixed list of operations, not a passthrough to Stalwart's admin API. Every change is logged with the admin's name.

| Request | What it does (Stalwart object) |
|---|---|
| `GET overview` | Counts: user accounts, messages waiting in the queue, blocked IPs, accounts on new-account limits, messages held as spam (`null` when holding is off) |
| `GET users?q=` | Up to 200 user accounts by name; `q` matches whole words (Stalwart's text search). Each: email, created, storage used and limit, live alias count, enabled, server admin, on new-account limits (`x:Account`) |
| `POST users` `{name, quotaBytes?, description?}` | Creates `name@DOMAIN` with a generated password, returned once. `quotaBytes` 0 = no limit; omitted = `QUOTA_BYTES` |
| `PATCH users/:id` `{enabled?, sending?, quotaBytes?, resetPassword?}` | `sending: false` pauses sending only (permissions `emailSend` and `jmapEmailSubmissionCreate` taken away: SMTP sign-in and web-app sending are refused, reading mail works); `true` lets them send again. Disable/enable sign-in (removes the `authenticate` permission: sign-in, sending and existing sessions stop; mail still arrives), set the storage limit (`null` = none), or replace the main password with a generated one (returned once; signs them out everywhere; app passwords stay) |
| `DELETE users/:id` | Deletes the account and its mail. Its username and aliases are retired (`RETIRED_FILE`), never given out again |
| `GET blocked`, `DELETE blocked/:id` | IPs Stalwart blocked (reason, when, until) and unblock (`x:BlockedIp`) |
| `GET new-accounts`, `POST new-accounts {address}`, `DELETE new-accounts/:id` | The stricter new-account sending tier: `x:MemoryLookupKey` entries in namespace `new-accounts`, key = full address |
| `GET held`, `POST held/:id/release`, `DELETE held/:id` | Outgoing mail [held as likely spam](#outgoing-spam-held-for-review): who sent it (sign-in and envelope sender), recipients, subject, score and the spam rules that matched. Release sends it as written; delete drops it (the sender isn't told). `404` when holding is off |
| `GET queue?q=` | Outgoing queue (`x:QueuedMessage`), up to 200, by sender or recipient (substring): per recipient status, attempts, next try, last error |
| `POST queue/:id/retry`, `DELETE queue/:id` | Retry now (next attempt due immediately) or cancel delivery |

Administrator accounts (a Stalwart role other than User, or a name in `ADMINS`) and the caller's own account can't be changed or deleted here; names in `ADMINS` are also reserved at sign-up. Delivered or bounced mail leaves the queue; Stalwart's delivery history (`x:Trace`) needs its Enterprise edition, so it isn't shown.

### Outgoing spam held for review

Stalwart calls `POST /internal/outbound-hook` (an MTA hook, `x:MtaHook`, at the DATA stage) for every message a signed-in user sends, by mail app (SMTP) or web app (JMAP). The path isn't under `/api/`, so Caddy never forwards it; the hook also sends `HOLD_HOOK_SECRET`.

1. The service asks Stalwart to score the message (`x:Action` `ClassifySpam`) and adds up only the tags about the message itself. Tags about the connection (`AUTH_*`, `DMARC_*`, `SPF_*`, `HELO_*`, `RCVD_*`, `SOURCE_*`, `FROM_INVALID`…) are dropped: ClassifySpam scores a message as if it came from outside, which says nothing about mail a signed-in user submits. Messages containing the GTUBE test string are always held.
2. At `HOLD_SCORE` or more, the hook answers `reject` with `550 5.7.1 This message looks like spam, so it is held for review…`. The sender sees that as an error in the web app or a bounce in their mail app. The message is kept in `HOLD_DIR`; sending it again (same Message-ID) doesn't hold it twice.
3. An admin releases it from the console: the service submits it as written (SMTP, port 465) as the admin login, which `install.sh` allows to send from any address (`x:MtaStageAuth.mustMatchSender`), and which the hook lets through. Or deletes it.
4. When `HOLD_SUSPEND_AFTER` of one sender's messages are waiting, their sending is paused (as `PATCH users/:id {sending: false}`). Never for admins.

Why this design (tested on Stalwart 1.0.3): its spam filter runs after MTA hooks and its verdict header never reaches a hook; a DATA-stage system Sieve script didn't run; queue routing expressions can't pick out one message. Limits: if the spam check itself fails, the message goes out (logged); messages over 50 MB aren't scanned; released mail counts against the admin login's sending limits, not the sender's.

Dev: `node deploy/dev-setup.mjs` points the hook at `http://host.docker.internal:3000` with the secret `dev-hold-secret` and does not delay mail when nothing answers. To try it:

```sh
DOMAIN=openmail.test ADMIN_FILE=../deploy/.dev-admin.json SIGNUP=off ADMINS=alice HOLD_HOOK_SECRET=dev-hold-secret \
  SYSTEM_SMTP_HOST=localhost SYSTEM_SMTP_PORT=1465 SYSTEM_SMTP_INSECURE=true node server.mjs
```

The test `test/hold.test.mjs` sets up its own hook (for its throwaway sender only) and removes it afterwards.

### `GET /healthz`

`200 {"ok": true}`

## What each new account gets

`x:Account/set` creates `{"@type": "User", name, domainId, credentials: {"0": {"@type": "Password", secret}}, quotas: {"maxDiskQuota": QUOTA_BYTES}, description: "Self sign-up <time> (invite <code>)"}`. Stalwart gives it the default user role, `roles: {"@type": "User"}`. The description lets admins trace an abusive account back to the invite batch it came from.

## Sending limits for new accounts: set these in Stalwart, not here

Stalwart v1.0.3 has **no per-account sending-rate setting**. Account `quotas` covers storage and object counts only. `maxSubmissions` limits how many JMAP EmailSubmission objects an account can store; it is not a rate. Sending is limited with **server-wide throttles** instead:

- **Inbound/submission throttle per authenticated user** (`x:MtaInboundThrottle`, key `authenticatedAs`). It counts **recipients** (each `RCPT TO`) per account, for webmail (JMAP) and mail apps (SMTP) alike, and answers `452 4.4.5` when the limit is exceeded (verified 2026-11-07). It applies to every account, not only new ones. A suggested starting point for the public instance:

  ```json
  ["x:MtaInboundThrottle/set", {"create": {"t": {
    "description": "Per-user submission limit", "key": {"authenticatedAs": true},
    "rate": {"count": 100, "period": 86400000}
  }}}, "0"]
  ```

  Or use the WebUI. This service does **not** create the throttle, because that is an operator decision. Before relying on it, test that it also covers mail sent through JMAP `EmailSubmission` and not only SMTP submission; that wasn't verified here.
- **Outbound throttle** (`x:MtaOutboundThrottle`, key `sender` or `senderDomain`). It delays queued deliveries instead of rejecting them. The `match` expression can't select accounts by role, group or age, so it isn't a "new accounts only" control either.
- **Already on the dev server:** `Sender IP throttle` (5 per second per remote IP) and `Sender address to recipient throttle` (25 per hour per sender domain and recipient).

A "new accounts send less" tier would need either a separate role or group checked by an expression (not documented in v1), or an external outbound filter. That remains open in PLAN.md Phase 4.

Docs: [quotas](https://stalw.art/docs/auth/authorization/quotas/), [MtaInboundThrottle](https://stalw.art/docs/ref/object/mta-inbound-throttle/), [inbound rate limits](https://stalw.art/docs/mta/inbound/rate-limit/), [MtaOutboundThrottle](https://stalw.art/docs/ref/object/mta-outbound-throttle/), [outbound rate limits](https://stalw.art/docs/mta/outbound/rate-limit/).
