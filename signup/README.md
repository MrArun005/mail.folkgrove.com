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
| `FILES_DB` | | JSON file with the large-file links (`/api/files`). Set it in production (`docker-compose.yml` does); without it links last until restart. The files themselves live in each user's own storage in Stalwart. |
| `MAX_FILE_BYTES` | `2147483648` (2 GiB) | Biggest file one link can hold. |
| `FILES_QUOTA_BYTES` | `5368709120` (5 GiB) | All of one user's live links together. Their Stalwart storage quota applies as well. |
| `FILES_PER_HOUR`, `DOWNLOADS_PER_HOUR` | `20`, `200` | Uploads per user, and downloads per client IP (IPv6: per /64), per hour. |
| `CUSTOM_DOMAINS` | on | `off` hides Settings → Your domain (`/api/domains` answers 404). |
| `MAX_DOMAINS`, `MAX_DOMAIN_ADDRESSES` | `3`, `10` | Domains per account; addresses per domain (the owner's own name included). |
| `RESERVED_DOMAINS` | | Extra domains (and their subdomains) users may not add, comma-separated. `DOMAIN` and the mail host are always refused. |
| `DNS_SERVERS` | system resolver | Resolvers for the record checks, comma-separated, e.g. `1.1.1.1,8.8.8.8`. |
| `RETIRED_FILE` | | File (one name per line) where the names of deleted accounts and their aliases are kept, so they are never given out again. Stalwart itself frees them on delete. Set it in production (`docker-compose.yml` does); without it the list lasts until restart. |
| `EVENTS_URL` | | How Stalwart reaches this service's `/api/events`, e.g. `http://signup:3000/api/events`. When set, the service registers a Stalwart webhook for itself at start; abuse blocking and sign-in tracking need it. See [Abuse blocking and inactive accounts](#abuse-blocking-and-inactive-accounts). |
| `STATE_FILE` | | JSON file for sending suspensions and last sign-in per account (`/data/state.json` in `docker-compose.yml`). Without it they last until restart. |
| `ABUSE_LIMIT_HITS` | `10` | Messages a sending limit may refuse for one account in an hour; one more suspends its sending. |
| `ABUSE_BOUNCES` | `20` | Hard bounces of one account's mail in an hour; one more suspends its sending. |
| `INACTIVE_MONTHS` | `12` with sign-up on, else off | Months without sign-in before an account is due for blocking (reminders 60, 30 and 7 days before). `0` = off. Needs `EVENTS_URL`, and `SYSTEM_SMTP_USER` to send reminders. |

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
### Large-file links: `/api/files` and `/f/:id`

Compose offers this for a file that would take the message over 25 MB (most mail servers refuse bigger messages). The file goes into the sender's **own** Stalwart file storage (JMAP FileNode, top-level folder "Shared files", created when first needed), so it counts toward their storage quota and is deleted with their account. The message carries a link `https://HOST/f/<id>#n=<name>&s=<bytes>`; the part after `#` never reaches a server and lets OpenMail's reader show the link as a file chip.

| Request | What it does |
|---|---|
| `POST /api/files?name=<file name>&expires=7\|30\|0` | Body: the raw file, `Content-Length` required (`411` without). `expires` in days, `0` = never (default 30). Streams straight to Stalwart (`/jmap/upload/<account>/` with admin rights, then `FileNode/set`). `201 {ok, file: {id, url: "/f/<id>", name, size, created, expires, downloads}}` (`expires`: ms, or `null`). Errors: `400 bad_expiry`, `413 too_large` (`MAX_FILE_BYTES`), `413 quota` (`FILES_QUOTA_BYTES`), `413 over_quota` (their Stalwart storage is full), `429 rate_limited` (`FILES_PER_HOUR`), `503 unavailable`. |
| `GET /api/files` | The caller's live links, newest first. Links whose file the owner deleted from their storage (e.g. over WebDAV) are dropped here. |
| `DELETE /api/files/:id` | Revoke: the link answers 404 from now on and the file is deleted from their storage. Only the owner can (`404` for anyone else). |
| `GET /f/:id` (also `HEAD`) | **Public**, no sign-in. The file as `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, `CSP: default-src 'none'; sandbox`, `Cache-Control: private, no-store`: never rendered as a page. Counts a download. `404` (plain text) when unknown, expired, revoked or gone; `429` past `DOWNLOADS_PER_HOUR` per network. |

`/api/files` uses the same token check and per-network failed-sign-in limit as `/api/aliases`. Link ids are 18 random bytes (144 bits, base64url). Expired links stop working at once; an hourly sweep then deletes their files. Deleting an account (`DELETE /api/account` or the admin console) drops its links.

Limits worth knowing: every request must arrive within 15 s; only a signed-in `POST /api/files` gets longer, a minute plus its size at 256 KB/s (2 GiB: about 2.3 hours), and a stalled upload ends after a minute without data. Uploads still streaming count toward `FILES_QUOTA_BYTES`, so parallel uploads can't overshoot it; if anything fails after the file is stored, the file is deleted again. Only links to this server's own address show as file chips in the reader (a link to another host is a plain link, with the usual lookalike-link warning). There is no resumable upload: a dropped connection means starting again. Stalwart 1.0.3's own limits (`x:Jmap` `maxUploadSize` 50 MB and `uploadQuota` 50 MB per hour per user, `x:FileStorage` `maxSize` 25 MiB for WebDAV) apply to users, not to the admin uploads this service makes; verified on the dev server 2026-11-08.
### Your own domain (`/api/domains`)

Settings → Your domain calls these with the user's sign-in token (as `/api/aliases`). The code is in `domains.mjs`.

| Request | What it does |
|---|---|
| `GET /api/domains` | `{domains, maxDomains}`: each claimed domain with `status` (`active`, `missing`: TXT gone, `paused`: gone over 7 days), `pausesAt`, its records with live DNS status (`ok`: true / false / null = DNS didn't answer) and its addresses. Looking at it re-checks the TXT record (and switches a paused domain back on). |
| `POST /api/domains {domain}` | Add, or "Check again". Until the TXT record `openmail-verify=<token>` is at the domain: `status: "pending"` and the records to add; nothing is stored. Once it's there: the domain is created in Stalwart (its DKIM keys follow a few seconds later: `dkimPending`) and `<username>@domain` is added to the account. |
| `POST /api/domains/:domain/addresses {name}` | One more address on it (up to `MAX_DOMAIN_ADDRESSES`). |
| `DELETE /api/domains/:domain/addresses/:name` | Removes and retires it (never given out again). The owner's own name can't be removed alone. |
| `DELETE /api/domains/:domain` | Retires every address on it, deletes its DKIM keys and the domain. |

Records shown: the TXT check, `MX 10 <mail host>.` (our main domain's MX), `v=spf1 include:DOMAIN -all`, Stalwart's DKIM keys for the domain, and `v=DMARC1; p=quarantine`. Errors: `400 bad_domain` / `reserved` / `bad_name`, `404 not_found` (not yours), `409 taken` (another account, or a domain Stalwart already has), `too_many`, `exists`, `retired`, `main`, `429 rate_limited` (60 checks an hour, 3 new domains a day, 30 new addresses an hour per account).

What's stored: the domain's description in Stalwart is `openmail-custom-domain {"owner": <account id>, "token", "added", "checked", "missing", "paused"}`. Every 6 hours the service re-checks each TXT record; gone for 7 days, the domain's addresses are switched off (no receiving, no sending: Stalwart drops the sending identity) and the owner gets an email (when system mail is set up). Deleting the account retires its domain addresses and keeps the domain claimed by that (deleted) account, so nobody else can take it over. Verified against Stalwart 1.0.3: `x:Domain/set` create (DKIM keys appear in `dnsZoneFile` and as `x:DkimSignature` a few seconds later; no rotation with manual DNS), alias `{name, domainId}` on the new domain (gets an identity; mail to it delivered over SMTP; signed `d=<domain>`), a disabled alias refuses mail (550) and has no identity, and a domain can only be destroyed after its aliases and DKIM keys are gone.

### Admin console (`/api/admin/*`)

The web app's `/admin` screen calls these. Each request must carry the admin's own sign-in token (`Authorization: Bearer …`). The service checks it with Stalwart (same check as `/api/aliases`), then checks that the account's name is in `ADMINS`: `401 unauthorized` without a valid token, `403 not_admin` for anyone else. Failed sign-ins count against the same per-network limit as aliases. It is a fixed list of operations, not a passthrough to Stalwart's admin API. Every change is logged with the admin's name.

| Request | What it does (Stalwart object) |
|---|---|
| `GET overview` | Counts: user accounts, messages waiting in the queue, blocked IPs, accounts on new-account limits |
| `GET users?q=` | Up to 200 user accounts by name; `q` matches whole words (Stalwart's text search). Each: email, created, storage used and limit, live alias count, enabled, server admin, on new-account limits (`x:Account`) |
| `POST users` `{name, quotaBytes?, description?}` | Creates `name@DOMAIN` with a generated password, returned once. `quotaBytes` 0 = no limit; omitted = `QUOTA_BYTES` |
| `PATCH users/:id` `{enabled?, quotaBytes?, resetPassword?}` | Disable/enable sign-in (removes the `authenticate` permission: sign-in, sending and existing sessions stop; mail still arrives), set the storage limit (`null` = none), or replace the main password with a generated one (returned once; signs them out everywhere; app passwords stay) |
| `DELETE users/:id` | Deletes the account and its mail. Its username and aliases are retired (`RETIRED_FILE`), never given out again |
| `GET blocked`, `DELETE blocked/:id` | IPs Stalwart blocked (reason, when, until) and unblock (`x:BlockedIp`) |
| `GET new-accounts`, `POST new-accounts {address}`, `DELETE new-accounts/:id` | The stricter new-account sending tier: `x:MemoryLookupKey` entries in namespace `new-accounts`, key = full address |
| `GET queue?q=` | Outgoing queue (`x:QueuedMessage`), up to 200, by sender or recipient (substring): per recipient status, attempts, next try, last error |
| `POST queue/:id/retry`, `DELETE queue/:id` | Retry now (next attempt due immediately) or cancel delivery |
| `GET domains` | Users' own domains: owner (null once that account was deleted), status, address count, added, last checked |
| `PATCH users/:id` `{sending}` | `false` suspends sending (reason "An administrator suspended sending."; the person can't lift it), `true` allows it again. Each user in `GET users` has `sending` |
| `GET suspended` | Accounts with sending suspended: email, reason, since, by (admin name, or null = automatic), suspensions in the last 7 days |
| `GET inactive` | Accounts the daily job reminded or found due (`due: true`), with last sign-in (null = none since tracking began, `since`) and whether sign-in is on. Nothing is blocked or deleted automatically: disable or delete them with the requests above |

Administrator accounts (a Stalwart role other than User, or a name in `ADMINS`) and the caller's own account can't be changed or deleted here; names in `ADMINS` are also reserved at sign-up. Delivered or bounced mail leaves the queue; Stalwart's delivery history (`x:Trace`) needs its Enterprise edition, so it isn't shown.

### `GET /api/sending`, `POST /api/sending/unblock`

The web app's banner. Sign-in token required, as for `/api/aliases`. `GET` answers `{"ok": true, "suspended": false}` or `{"ok": true, "suspended": true, "reason": "…", "since": "<time>", "unblock": "ok" | "wait" | "admin", "retryAfter": <seconds, with wait>}`. `POST …/unblock` switches sending back on when `unblock` is `ok`, and is logged. Rules: the first automatic suspension can be lifted by the account itself; at most one self-unblock per 24 hours (`429 wait`); a second suspension within 7 days, or one an admin made, needs an admin (`403 needs_admin`). 10 requests per account per hour.

### `GET /api/blocked`

No sign-in. `{"ok": true, "blocked": true, "until": "<time>", "reason": "authFailure"}` when the caller's own IP is in Stalwart's blocked list (`x:BlockedIp`, exact address), else `{"ok": true, "blocked": false}`. The sign-in form asks after a failed sign-in, because Stalwart answers a banned address exactly like a wrong password. 30 per network per minute.

### `POST /api/events` (Stalwart only)

Stalwart's webhook posts events here, signed with a key the service makes at each start (`X-Signature`: base64 HMAC-SHA256 of the body); anything unsigned is refused. Not routed by the production Caddy: only Stalwart reaches it, on the internal network.

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

## Abuse blocking and inactive accounts

`abuse.mjs`. What Stalwart 1.0.3 offers, checked on the dev server (2026-11-08):

- **No last-login time.** `x:Account` has `createdAt` but nothing for sign-ins. `x:Log` (query the server log) fails unless a log-file tracer is set up (`serverUnavailable` on the dev server); `x:Trace` and `x:Metric` are Enterprise. The queue (`x:QueuedMessage`) only holds mail still waiting, so hard bounces are already gone.
- **A webhook** (`x:WebHook`): `{url, enable, eventsPolicy: "include", events: {"auth.success": true, …}, signatureKey: {"@type": "Value", secret}, lossy: false}`. It posts `{"events": [{id, createdAt, type, data}]}` in batches (at most one request a second), header `X-Signature` = base64 HMAC-SHA256 of the body. Event ids (`spanId`, `queueId`) are 64-bit integers, so they are read as strings. Events used:
  - `auth.success` `{accountName, spanId, listenerId, remoteIp}`: every real sign-in (web, IMAP, SMTP, DAV; cached tokens don't repeat it). This is the last-sign-in signal, kept per account (to the hour) in `STATE_FILE`.
  - `smtp.rate-limit-exceeded` `{from, spanId}`: an `x:MtaInboundThrottle` refused a message (`452 4.4.5`). Fired once per refused message (a second event per refusal carries the throttle's name, no `from`). Over JMAP, `spanId` is `0`.
  - `queue.authenticated-message-queued` `{from, to, queueId}` and `delivery.dsn-perm-fail` `{queueId, from, to, details}`: mail a signed-in account sent, and its hard bounces.
  Refusals count only for the account signed in to that SMTP session (or JMAP), and bounces only for mail an account queued itself, so mail forged with someone's address on port 25 can't get them suspended.
- **Suspending sending, not reading**: `permissions: {"@type": "Merge", disabledPermissions: {emailSend, jmapEmailSubmissionCreate, calendarSchedulingSend}}`. `emailSend` alone stops SMTP submission (`550 5.7.1`) but **not** JMAP `EmailSubmission/set` (that needs `jmapEmailSubmissionCreate`, answered `forbidden`). Reading, flagging and IMAP keep working. Other custom permissions (e.g. a disabled sign-in) are kept.
- **Not used**: `disabledPermissions.emailReceive` did not refuse mail at `RCPT TO`, so "refuse new mail to a blocked inactive account" isn't automated.
- **Banned IPs**: with `clientIpSource: xForwardedFor` (production behind Caddy), a banned client address still got a normal answer from `/api/auth` and `/jmap` when the proxy's connection wasn't banned; Stalwart's bans act on direct connections (IMAP, SMTP). A failed sign-in from a banned address gets `{"type": "failure"}`, the same as a wrong password, so the web app asks `/api/blocked` after any failure and then says the block is temporary. (A ban of the connecting address itself wasn't tried: on the dev server that would lock out everyone.)

Thresholds are per hour, fixed windows, in memory (`ABUSE_LIMIT_HITS`, `ABUSE_BOUNCES`). Suspension history (last 20 per account) and last sign-ins are in `STATE_FILE` and are dropped by the daily job once the account is deleted. The daily job also sends the inactive-account reminders (system mailer) and lists due accounts in the admin console; it never blocks or deletes. Sign-ins only count from the day tracking began (`since` in the file), so nobody is due before 12 months after that. Every suspension and unblock is logged with its reason.
