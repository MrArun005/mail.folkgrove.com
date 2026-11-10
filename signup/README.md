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
| `HELPDESK` | | Usernames on `DOMAIN` (comma-separated) with a limited console: see [Admin console](#admin-console-apiadmin). Reserved at sign-up like `ADMINS`; a name on both lists is an admin. |
| `RESERVED_NAMES` | | Extra reserved usernames, comma-separated. They are added to the built-in list in `lib.mjs`. |
| `RETENTION_FILE` | | JSON file for retention rules (`retention.mjs`). Without it rules last until restart. |
| `AUDIT_FILE` | | File the admin console's [audit log](#audit-log) is appended to, one JSON object per line (`/data/audit.jsonl` in `docker-compose.yml`). Without it the log lasts until restart. |
| `AUDIT_MAX_ENTRIES` | `10000` | Lines in `AUDIT_FILE` before it is rotated to `AUDIT_FILE.1` (one old file is kept, so the last 10,000 to 20,000 changes). |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_SECRET` (or `OIDC_SECRET_FILE`), `OIDC_NAME`, `OIDC_CLAIM` (default `email`, must be verified), `OIDC_TENANT` (Google `hd` / Entra `tid` that must match), `PUBLIC_URL` | | Single sign-on (`sso.mjs`). All but the name are needed together; `PUBLIC_URL` is the webmail address (callback `PUBLIC_URL/api/sso/callback`). Stalwart's OIDC directory must point at the same provider (`install.sh --oidc-*`). |
| `FILES_DB` | | JSON file with the large-file links (`/api/files`). Set it in production (`docker-compose.yml` does); without it links last until restart. The files themselves live in each user's own storage in Stalwart. |
| `MAX_FILE_BYTES` | `2147483648` (2 GiB) | Biggest file one link can hold. |
| `FILES_QUOTA_BYTES` | `5368709120` (5 GiB) | All of one user's live links together. Their Stalwart storage quota applies as well. |
| `FILES_PER_HOUR`, `DOWNLOADS_PER_HOUR` | `20`, `200` | Uploads per user, and downloads per client IP (IPv6: per /64), per hour. |
| `BIMI_LOGOS` | off | `on` shows senders' brand logos (BIMI). Off by default: without checking the VMC trademark certificate a lookalike domain could show a real brand's logo, and a fresh lookup tells the sender's DNS the mail was opened. |
| `CUSTOM_DOMAINS` | on | `off` hides Settings → Your domain (`/api/domains` answers 404). |
| `MAX_DOMAINS`, `MAX_DOMAIN_ADDRESSES` | `3`, `10` | Domains per account (waiting for verification included); addresses per domain (the owner's own name, members' addresses and invitations not answered yet included). |
| `DOMAIN_INVITE_DAYS`, `MAX_DOMAIN_INVITES` | `14`, `5` | An address offered to another account waits this many days for an answer, then the invitation expires; how many unanswered invitations one account can have at a time, from all domains together. |
| `PENDING_DOMAINS_FILE` | | JSON file with the domains users added that wait for their TXT record (`/data/pending-domains.json` in `docker-compose.yml`). Without it they are forgotten on restart. |
| `RESERVED_DOMAINS` | | Extra domains (and their subdomains) users may not add, comma-separated. `DOMAIN` and the mail host are always refused. |
| `DNS_SERVERS` | system resolver | Resolvers for the record checks, comma-separated, e.g. `1.1.1.1,8.8.8.8`. |
| `HOLD_HOOK_SECRET` | | Turns on [holding outgoing spam](#outgoing-spam-held-for-review). Stalwart's hook must send it as `Authorization: Bearer …`. `install.sh` creates it (`.hold.env`). |
| `HOLD_DIR` | | Where held messages are kept (one `.json` + `.eml` pair each). Without it they live in memory until restart. `/data/held` in `docker-compose.yml`. |
| `HOLD_SCORE` | `5` | Hold a message whose content scores this much or more (Stalwart's spam scores; see below). |
| `HOLD_SUSPEND_AFTER` | `3` | Pause a sender's sending once this many of their messages are waiting for review. |
| `SYSTEM_SMTP_HOST`, `SYSTEM_SMTP_PORT`, `SYSTEM_SMTP_TLS_NAME`, `SYSTEM_SMTP_INSECURE` | `stalwart`, `465` | Where released mail is submitted (and system mail is sent). |
| `RETIRED_FILE` | | File (one name per line) where the names of deleted accounts and their aliases are kept, so they are never given out again. Stalwart itself frees them on delete. Set it in production (`docker-compose.yml` does); without it the list lasts until restart. |
| `EVENTS_URL` | | How Stalwart reaches this service's `/api/events`, e.g. `http://signup:3000/api/events`. When set, the service registers a Stalwart webhook for itself at start; abuse blocking and sign-in tracking need it. See [Abuse blocking and inactive accounts](#abuse-blocking-and-inactive-accounts). |
| `STATE_FILE` | | JSON file for sending suspensions and last sign-in per account (`/data/state.json` in `docker-compose.yml`). Without it they last until restart. |
| `ABUSE_LIMIT_HITS` | `10` | Messages a sending limit may refuse for one account in an hour; one more suspends its sending. |
| `ABUSE_BOUNCES` | `20` | Hard bounces of one account's mail in an hour; one more suspends its sending. |
| `INACTIVE_MONTHS` | `12` with sign-up on, else off | Months without sign-in before an account is due for blocking (reminders 60, 30 and 7 days before). `0` = off. Needs `EVENTS_URL`, and `SYSTEM_SMTP_USER` to send reminders. |
| `ARF_MAILBOX` | `abuse` | The team mailbox (a Stalwart group, which `install.sh` creates) read every 5 minutes for [spam complaints](#spam-complaints-arf-reports); the service also keeps the `ADMINS` in it. `off` = not read. Runs with `EVENTS_URL`. |
| `ARF_LIMIT`, `ARF_WINDOW_HOURS` | `5`, `24` | Genuine complaints about one account within the window that suspend its sending (only an admin can lift it). |
| `ARF_REPORTERS` | | Comma-separated feedback-loop senders to trust: domains (the report must still pass DKIM/DMARC for them) and IP addresses (enough by themselves). Empty: no report counts automatically (they stay in abuse@ for an admin). Set it once you've joined the loops, e.g. `yahoo.com,microsoft.com`. |

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
| `POST /api/files?name=<file name>&expires=1\|7\|30\|0` | Body: the raw file, `Content-Length` required (`411` without). `expires` in days, `0` = never (default 30; `1` is what confidential messages use). Streams straight to Stalwart (`/jmap/upload/<account>/` with admin rights, then `FileNode/set`). `201 {ok, file: {id, url: "/f/<id>", name, size, created, expires, downloads}}` (`expires`: ms, or `null`). Errors: `400 bad_expiry`, `413 too_large` (`MAX_FILE_BYTES`), `413 quota` (`FILES_QUOTA_BYTES`), `413 over_quota` (their Stalwart storage is full), `429 rate_limited` (`FILES_PER_HOUR`), `503 unavailable`. |
| `GET /api/files` | The caller's live links, newest first. Links whose file the owner deleted from their storage (e.g. over WebDAV) are dropped here. |
| `DELETE /api/files/:id` | Revoke: the link answers 404 from now on and the file is deleted from their storage. Only the owner can (`404` for anyone else). |
| `GET /f/:id` (also `HEAD`) | **Public**, no sign-in. The file as `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, `CSP: default-src 'none'; sandbox`, `Cache-Control: private, no-store`: never rendered as a page. Counts a download. `404` (plain text) when unknown, expired, revoked or gone; `429` past `DOWNLOADS_PER_HOUR` per network. |

`/api/files` uses the same token check and per-network failed-sign-in limit as `/api/aliases`. Link ids are 18 random bytes (144 bits, base64url). Expired links stop working at once; an hourly sweep then deletes their files. Deleting an account (`DELETE /api/account` or the admin console) drops its links.

Limits worth knowing: every request must arrive within 15 s; only a signed-in `POST /api/files` gets longer, a minute plus its size at 256 KB/s (2 GiB: about 2.3 hours), and a stalled upload ends after a minute without data. Uploads still streaming count toward `FILES_QUOTA_BYTES`, so parallel uploads can't overshoot it; if anything fails after the file is stored, the file is deleted again. Only links to this server's own address show as file chips in the reader (a link to another host is a plain link, with the usual lookalike-link warning). There is no resumable upload: a dropped connection means starting again. Stalwart 1.0.3's own limits (`x:Jmap` `maxUploadSize` 50 MB and `uploadQuota` 50 MB per hour per user, `x:FileStorage` `maxSize` 25 MiB for WebDAV) apply to users, not to the admin uploads this service makes; verified on the dev server 2026-11-08.
### Confidential messages (stored as file links)

Compose's "Send confidentially" (web/src/seal.ts, Confidential.tsx) encrypts the message in the browser (AES-256-GCM; key = 32 random bytes, or PBKDF2-SHA256 600,000 rounds over a passcode with that key as salt) and uploads only the ciphertext with `POST /api/files?expires=1|7|30`. Recipients get `https://HOST/confidential.html#id=<link id>&k=<key>[&p=1]`; browsers never send the part after `#`, so neither Caddy nor this service sees the key. The viewer is a static page from the web build: it fetches `/f/<id>`, decrypts, and shows the text with `textContent`. Revoking (`DELETE /api/files/:id`, from Sent or Settings → Shared files) and expiry give `404`, as for any link; `downloads` counts how often it was fetched. Production Caddy serves `/confidential.html` with `Content-Security-Policy` (`default-src 'none'`, scripts, styles, fonts and fetches from itself only, `frame-ancestors 'none'`), `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`. Tested in `test/confidential.test.mjs` (encrypt → store → open → wrong key fails → revoked 404 → expired 404).

What this service can't protect: the link with its key is in the email, so the recipient's mail server and the sender's Sent folder can open it unless a passcode was used; with the link, passcodes can be guessed offline (PBKDF2 slows that down; use a few words). The `Shared files` name is generic, so the stored file doesn't reveal the subject.

### Your own domain (`/api/domains`)

Settings → Your domain calls these with the user's sign-in token (as `/api/aliases`). The code is in `domains.mjs`.

| Request | What it does |
|---|---|
| `GET /api/domains` | `{domains, maxDomains, memberOf}`: each domain the caller owns or is waiting to verify with `status` (`pending`, `active`, `missing`: TXT gone, `paused`: gone over 7 days), `pausesAt`, its records with live DNS status (`ok`: true / false / null = DNS didn't answer) its `addresses` (the owner's own) and `members` (addresses given to other accounts: `{account, name, email, enabled}`). Looking at it re-checks the TXT record (and switches a paused domain back on). Each domain also has `invitations`: addresses offered to other accounts that haven't answered, `{account, name, email, invited, expires}`. `memberOf`: addresses the caller was given on other people's domains and accepted, `{domain, name, email, enabled, owner}`. `invitations` (top level): addresses the caller is offered and hasn't answered, `{domain, name, email, owner, invited, expires}`. |
| `POST /api/domains {domain}` | Add, or "Check again". Until the TXT record `openmail-verify=<token>` is at the domain: `status: "pending"` and the records to add; it is kept in `PENDING_DOMAINS_FILE` (and counts towards `MAX_DOMAINS`). Once it's there: the domain is created in Stalwart (its DKIM keys follow a few seconds later: `dkimPending`) and `<username>@domain` is added to the account. |
| `POST /api/domains/:domain/addresses {name}` | One more address on it for the owner (up to `MAX_DOMAIN_ADDRESSES` on the domain, members' addresses and waiting invitations included). |
| `DELETE /api/domains/:domain/addresses/:name` | Removes and retires it (never given out again). The owner's own name can't be removed alone. |
| `POST /api/domains/:domain/members {account, name}` | Owner only. Offers `name@domain` to another account on this server: `account` is that person's exact address on `DOMAIN` (`sam@DOMAIN`). This makes an invitation and nothing else: no alias, no identity, no mail, until that person accepts. Same cap and hourly limit as the owner's own addresses, plus the invitation limits below. |
| `POST /api/domains/:domain/invitations/:name` | The invited account accepts. Everything is checked again as it is now: the domain is still verified (not paused) and still its inviter's, the address is free and not retired, there is room under the cap, the account has room under `MAX_ALIASES_TOTAL`. Then the address becomes an alias of their account: its mail lands in their mailbox and Stalwart gives them a sending identity for it. The owner can't accept for them. |
| `DELETE /api/domains/:domain/invitations/:name` | The invited account declines, or the owner withdraws. The invitation is removed; nothing existed, so nothing is retired and the address can be offered again. |
| `DELETE /api/domains/:domain/members/:name` | The owner takes a member's address back, or a member gives up their own (the only thing a member can change). Removed from the member's account and retired. |
| `DELETE /api/domains/:domain` | A pending domain is just forgotten. Otherwise: retires every address on it (members' too, taken off their accounts), deletes its DKIM keys and the domain. |

Records shown: the TXT check, `MX 10 <mail host>.` (our main domain's MX), `v=spf1 include:DOMAIN -all`, Stalwart's DKIM keys for the domain, and `v=DMARC1; p=quarantine`. Errors: `400 bad_domain` / `reserved` / `bad_name` / `bad_account` (not a full address on `DOMAIN`) / `self`, `403 protected` (a server administrator's account), `404 not_found` (not yours; also an invitation that was answered, withdrawn or has expired) / `no_such_account`, `409 taken` (another account, or a domain Stalwart already has), `too_many`, `exists`, `retired`, `main`, `invited` (the address is offered to someone who hasn't answered), `too_many_invites` (that account has `MAX_DOMAIN_INVITES` waiting), `paused` (no invitations on a paused domain), on accepting `gone` (the address was taken or retired meanwhile; the invitation is dropped) / `unavailable` (the domain is paused or no longer the inviter's; dropped too) / `too_many` (no room now; the invitation stays), `429 rate_limited` (60 checks an hour, 3 new domains a day, 30 new addresses an hour per account, counting the owner's own, invitations made, and for the invited account each accept; 3 invitations a day from one owner to the same account).

What's stored: the domain's description in Stalwart is `openmail-custom-domain {"owner": <account id>, "token", "added", "checked", "missing", "paused", "members": {<account id>: [names]}, "invites": {<name>: {"to": <account id>, "made": <that account's createdAt>, "by": <owner id>, "at": <time>}}}`. Every 6 hours the service re-checks each TXT record; gone for 7 days, the domain's addresses are switched off (no receiving, no sending: Stalwart drops the sending identity) and the owner gets an email (when system mail is set up). Deleting the account retires its domain addresses and keeps the domain claimed by that (deleted) account, so nobody else can take it over (it is released after 30 days).

Shared domains (members). The member list is in the claim because every path that ends a domain already reads the claim. What exists is the alias on the member's account; the list says where to look.

Invitations. Nobody gets an address they didn't agree to: the owner's "Invite" only writes an invitation into the claim, and the address is made when the invited person accepts (Settings → Your domain shows it with Accept and Decline). They are in the claim, not in a file of their own, for the same reason as the member list: an invitation belongs to one verified domain, and whatever removes, releases or pauses that domain already rewrites or destroys the claim, so there is no second store to keep in step; being in Stalwart, they survive a restart. `made` ties an invitation to the account it was made for (an account id can be reused after a deletion). The rules:

- An invitation waits `DOMAIN_INVITE_DAYS` (14). After that it counts for nothing and is removed the next time the claim is written (at the latest by the 6-hourly re-check).
- While it waits it holds its address (not offered twice, not taken by the owner) and a place under `MAX_DOMAIN_ADDRESSES`, so what was offered can be accepted. A domain therefore never has more invitations waiting than its cap.
- So that invitations can't be used to pester someone: one owner can invite the same account 3 times a day (kept in memory, like the other rate limits, so a restart resets it), and one account can have `MAX_DOMAIN_INVITES` (5) waiting from everyone together (counted without a lock across domains: two owners at the same moment can go one over).
- Declined, withdrawn and expired invitations all simply disappear from the owner's list. The owner is not told which it was.
- The invited person is not emailed. They see the invitation when they open Settings → Your domain; the owner has to tell them to look.

Nothing is left dangling:

- The owner removes the domain, or it is released: every member's address is taken off their account and retired. Its invitations are gone with the claim.
- The domain pauses (TXT gone 7 days): members' addresses are switched off with the owner's, and back on with them. Invitations still waiting are dropped (they are not restored when the domain comes back), and none can be made or accepted while it is paused. While the record is only missing (inside the 7 days) invitations work as usual.
- The owner's account is deleted: members' addresses on its domains are retired and removed at once, since nobody is left to manage them, and the invitations are dropped. The members get no notice.
- A member's account is deleted: its addresses are retired and it leaves the list (account ids can come back). Invitations made to it are removed from every domain.
- A member's account disappears in Stalwart's own admin, behind this service: its listed addresses are retired the next time that domain's list is written. An invitation made to it can't be seen or accepted by a later account with the same id; it is dropped when the owner next opens the domain, or when it expires.

Limits: one owner per domain (no co-owners, no handing a domain over); members must be accounts on `DOMAIN` (not on another custom domain, not a team mailbox); the invited person is told nothing by mail (see above); an accepted address counts toward the member's `MAX_ALIASES_TOTAL`; an address can't be moved from one account to another (removing retires it); the owner can't read a member's mail, and can't see more of the member than the address they typed.

Verified against Stalwart 1.0.3: `x:Domain/set` create (DKIM keys appear in `dnsZoneFile` and as `x:DkimSignature` a few seconds later; no rotation with manual DNS), alias `{name, domainId}` on the new domain (gets an identity; mail to it delivered over SMTP; signed `d=<domain>`), a disabled alias refuses mail (550) and has no identity, and a domain can only be destroyed after its aliases and DKIM keys are gone; an alias on the domain on a second account receives its mail in that account's mailbox, sends from it, and Stalwart refuses the same address on two accounts (`primaryKeyViolation`); a domain's description holds at least 16 KB (a claim with 10 invitations is under 2 KB).

### Admin console (`/api/admin/*`)

The web app's `/admin` screen calls these. Each request must carry the admin's own sign-in token (`Authorization: Bearer …`). The service checks it with Stalwart (same check as `/api/aliases`), then checks that the account's name is in `ADMINS`: `401 unauthorized` without a valid token, `403 not_admin` for anyone else. Failed sign-ins count against the same per-network limit as aliases. It is a fixed list of operations, not a passthrough to Stalwart's admin API. Every change goes into the [audit log](#audit-log) with the admin's name and `role`.

A `HELPDESK` account may make only these requests; anything else is `403 not_allowed` (deny by default: `HELPDESK_ROUTES` in `admin.mjs`): `GET overview` (its `role` is `admin` or `helpdesk`; the web app shows only what the role can use), `GET users`, `PATCH users/:id` with only `enabled`, `resetPassword` or `sending: true`, and only on a plain account (User role, no permissions beyond the sign-in, sending and legal-hold switches this console sets, only in plain team mailboxes; never an admin or helpdesk account, nor the system sender `SYSTEM_SMTP_USER`, which no one can change from the console), `GET suspended`, `GET held`, `POST held/:id/release`, `DELETE held/:id` and `GET audit`. A helpdesk account gets at most 100 changes an hour (`429 rate_limited` after that, not recorded), so it can't flush the bounded audit log.

| Request | What it does (Stalwart object) |
|---|---|
| `GET overview` | Counts: user accounts, messages waiting in the queue, blocked IPs, accounts on new-account limits, messages held as spam (`null` when holding is off) |
| `GET users?q=` | Up to 200 user accounts by name; `q` matches whole words (Stalwart's text search). Each: email, created, storage used and limit, live alias count, enabled, server admin, on new-account limits (`x:Account`) |
| `POST users` `{name, quotaBytes?, description?}` | Creates `name@DOMAIN` with a generated password, returned once. `quotaBytes` 0 = no limit; omitted = `QUOTA_BYTES` |
| `POST users/check` `{rows}`, `POST users/import` `{rows}` | Add accounts from a CSV (the console parses it). `rows`: up to 1,000 `{name, description?, password?, quotaBytes?}`. `check` runs the checks only (not audited); `import` creates the accounts one by one and answers per row `{name, email, password?}` or `{name, error, message}`; a bad row never stops the others. Stricter than `POST users`: reserved, retired and admin/helpdesk names are refused, as is a name twice in the list or a password `checkPassword` refuses. An empty password is generated and returned once. Audit: `user.import` with the counts (`created:N`, `failed:N`), never names or passwords. Admins only |
| `PATCH users/:id` `{enabled?, sending?, quotaBytes?, resetPassword?}` | `sending: false` pauses sending only (permissions `emailSend` and `jmapEmailSubmissionCreate` taken away: SMTP sign-in and web-app sending are refused, reading mail works); `true` lets them send again. Disable/enable sign-in (removes the `authenticate` permission: sign-in, sending and existing sessions stop; mail still arrives, except that disabling an account `GET inactive` lists as due also [refuses its mail](#mail-to-blocked-inactive-accounts); enabling accepts it again), set the storage limit (`null` = none), or replace the main password with a generated one (returned once; signs them out everywhere; app passwords stay) |
| `DELETE users/:id` | Deletes the account and its mail. Its username and aliases are retired (`RETIRED_FILE`), never given out again |
| `GET blocked`, `DELETE blocked/:id` | IPs Stalwart blocked (reason, when, until) and unblock (`x:BlockedIp`) |
| `GET new-accounts`, `POST new-accounts {address}`, `DELETE new-accounts/:id` | The stricter new-account sending tier: `x:MemoryLookupKey` entries in namespace `new-accounts`, key = full address |
| `GET held`, `POST held/:id/release`, `DELETE held/:id` | Outgoing mail [held as likely spam](#outgoing-spam-held-for-review): who sent it (sign-in and envelope sender), recipients, subject, score and the spam rules that matched. Release sends it as written; delete drops it (the sender isn't told). `404` when holding is off |
| `GET queue?q=` | Outgoing queue (`x:QueuedMessage`), up to 200, by sender or recipient (substring): per recipient status, attempts, next try, last error |
| `POST queue/:id/retry`, `DELETE queue/:id` | Retry now (next attempt due immediately) or cancel delivery |
| `GET domains` | Users' own domains: owner (null once that account was deleted), status, address count (members' included), how many other accounts have one (`members`), added, last checked |
| `PATCH users/:id` `{sending}` | `false` suspends sending (reason "An administrator suspended sending."; the person can't lift it), `true` allows it again. Each user in `GET users` has `sending` |
| `GET suspended` | Accounts with sending suspended: email, reason, since, by (admin name, or null = automatic), suspensions in the last 7 days |
| `GET audit?limit=&offset=` | The [audit log](#audit-log), newest first: `{entries, total, offset, limit}` (`limit` 50 by default, at most 200) |
| `GET inactive` | Accounts the daily job reminded or found due (`due: true`), with last sign-in (null = none since tracking began, `since`), whether sign-in is on, and `refusingMail`. Nothing is blocked or deleted automatically: disable (which then refuses their mail) or delete them with the requests above |

Administrator accounts (a Stalwart role other than User, or a name in `ADMINS`) and the caller's own account can't be changed or deleted here; names in `ADMINS` are also reserved at sign-up. Delivered or bounced mail leaves the queue; Stalwart's delivery history (`x:Trace`) needs its Enterprise edition, so it isn't shown.

| `GET retention` | Trash/Junk auto-empty days (Stalwart `x:DataRetention.expungeTrashAfter`), server "older than" rule, accounts with their own rule or a hold |
| `PUT retention` `{trashJunkDays?, maxAgeDays?}` | Set them. `trashJunkDays` 0 = never; `maxAgeDays` ≥ 30, 0/null = keep forever |
| `POST retention/preview` `{maxAgeDays?}` or `{accountId, accountMaxAgeDays}` | Dry run of the saved rules, or of a proposed one: per account how many messages would go. Deletes nothing |
| `POST retention/run` | Run the job now (it also runs daily) |
| `PATCH retention/:id` `{maxAgeDays?, hold?}` | One account: own age limit (0 = keep forever, null = server rule), legal hold on/off (Stalwart permissions `jmapEmailDestroy`, `jmapMailboxDestroy`, `imapExpunge`, `imapDelete`, `pop3Dele` taken away). Held accounts can't be deleted (`409 on_hold`) |

#### Audit log

Every change made through `/api/admin/*` (anything but a `GET`, and not the `retention/preview` dry run) is appended to `AUDIT_FILE` as one JSON line, written in the one place all admin requests pass through (`handle()` in `admin.mjs`; the format is in `audit.mjs`):

```json
{"at":"2026-11-09T10:12:03.511Z","admin":"ann","role":"admin","ip":"203.0.113.7","action":"user.update","target":"sam@example.com","detail":["disable","quota:5000000000"],"outcome":"ok"}
```

- `action`: `user.create|update|delete`, `team.create|members|delete`, `ip.unblock`, `limits.add|lift`, `queue.retry|cancel`, `held.release|delete`, `retention.rules|run|account`.
- `target`: the account, team mailbox or sender address, or the blocked IP (Stalwart's id when the object was already gone).
- `detail`: what was asked for: `enable`, `disable`, `sending_suspend`, `sending_allow`, `password_reset`, `quota:<bytes|none>`, `member_add:<address>`, `member_remove:<address>`, `hold_on`, `hold_off`, `trash_days:<n>`, `max_age_days:<n|server>`.
- `outcome`: `ok`, or the error code the admin was shown (`protected`, `not_found`, `stalwart_refused`, …). Refused and failed changes are recorded too.
- `ip`: the admin's address as the rate limiters see it (IPv6 cut to its /64).

Never recorded: passwords (generated ones included), tokens, request bodies, subjects or message text. Not recorded either: reads, and requests from accounts that aren't administrators (they get `403` before anything runs). Users' own actions (their domains, masked addresses, deleting their account) and automatic ones (suspensions by the abuse jobs) are in the service log, not here.

The file is append-only and bounded: at `AUDIT_MAX_ENTRIES` lines it is renamed to `AUDIT_FILE.1` (replacing the previous one) and a new file starts. It is not tamper-proof: an administrator with a shell on the server can edit it, and one without can push old lines out by making 20,000 changes. Ship the service log elsewhere if you need more (each change is also printed there).

### `GET|PUT /api/retention`

The caller's own rule (sign-in token): `{trashDays}` = empty my Trash and Junk after 1–365 days (null = server default). Answers `{trashDays, serverTrashDays, maxAgeDays, held}`.

### Single sign-on: `GET /api/sso`, `/api/sso/start`, `/api/sso/callback`

Only with `OIDC_ISSUER`. `GET /api/sso` → `{name}` (the login page shows "Sign in with {name}"). `start` redirects to the provider (authorization code + PKCE S256, `state` bound to an HttpOnly SameSite=Lax cookie, `nonce`). `callback` exchanges the code with the client secret, verifies the ID token (JWKS signature RS/PS/ES, `iss`, `aud`/`azp`, `exp`, `iat`, `nonce`), requires a verified address (`email_verified` or Entra `xms_edov`) and the `OIDC_TENANT` if set, refuses `ADMINS`, reserved and retired names, asks Stalwart which account it opens (Stalwart creates it on first sign-in, only in local domains), puts the provider's refresh token in the `/api/session` cookie, and redirects to `/?sso=<address>` (or `/?sso_error=expired|cancelled|refused|no_account|unavailable|rate_limited|busy`; `rate_limited` also when one network has 20 sign-ins started and not finished in the last 10 minutes). `/api/session/refresh` then returns a fresh ID token as the access token; `forget` revokes at the provider's `revocation_endpoint`.
### `GET /api/sending`, `POST /api/sending/unblock`

The web app's banner. Sign-in token required, as for `/api/aliases`. `GET` answers `{"ok": true, "suspended": false}` or `{"ok": true, "suspended": true, "reason": "…", "since": "<time>", "unblock": "ok" | "wait" | "admin", "retryAfter": <seconds, with wait>}`. `POST …/unblock` switches sending back on when `unblock` is `ok`, and is logged. Rules: the first automatic suspension can be lifted by the account itself; at most one self-unblock per 24 hours (`429 wait`); a second suspension within 7 days, or one an admin made, needs an admin (`403 needs_admin`). 10 requests per account per hour.

### `GET /api/blocked`

No sign-in. `{"ok": true, "blocked": true, "until": "<time>", "reason": "authFailure"}` when the caller's own IP is in Stalwart's blocked list (`x:BlockedIp`, exact address), else `{"ok": true, "blocked": false}`. The sign-in form asks after a failed sign-in, because Stalwart answers a banned address exactly like a wrong password. 30 per network per minute.

### `POST /api/events` (Stalwart only)

Stalwart's webhook posts events here, signed with a key the service makes at each start (`X-Signature`: base64 HMAC-SHA256 of the body); anything unsigned is refused. Not routed by the production Caddy: only Stalwart reaches it, on the internal network.

### Outgoing spam held for review

The same hook also checks the From line people see (Stalwart checks only the envelope sender): it must be one of the sender's own addresses or aliases, a team mailbox they belong to, or, with `Sender:` naming them, an owner whose Inbox they may send from (delegation). Anything else is refused with `550 5.7.1 You can't send as …`. Without the hook (`HOLD_HOOK_SECRET` unset) this check is off too.


Stalwart calls `POST /internal/outbound-hook` (an MTA hook, `x:MtaHook`, at the DATA stage) for every message a signed-in user sends, by mail app (SMTP) or web app (JMAP). The path isn't under `/api/`, so Caddy never forwards it; the hook also sends `HOLD_HOOK_SECRET`.

1. The service asks Stalwart to score the message (`x:Action` `ClassifySpam`) and adds up only the tags about the message itself. Tags about the connection (`AUTH_*`, `DMARC_*`, `SPF_*`, `HELO_*`, `RCVD_*`, `SOURCE_*`, `FROM_INVALID`…) are dropped: ClassifySpam scores a message as if it came from outside, which says nothing about mail a signed-in user submits. Messages containing the GTUBE test string are always held.
2. At `HOLD_SCORE` or more, the hook answers `reject` with `550 5.7.1 This message looks like spam, so it is held for review…`. The sender sees that as an error in the web app or a bounce in their mail app. The message is kept in `HOLD_DIR`; sending it again (same Message-ID) doesn't hold it twice.
3. An admin releases it from the console: the service submits it as written (SMTP, port 465) as the admin login, which `install.sh` allows to send from any address (`x:MtaStageAuth.mustMatchSender`), and which the hook lets through. Or deletes it.
4. When `HOLD_SUSPEND_AFTER` of one sender's messages are waiting, their sending is paused (as `PATCH users/:id {sending: false}`). Never for admins.

Why this design (tested on Stalwart 1.0.3): its spam filter runs after MTA hooks and its verdict header never reaches a hook; a DATA-stage system Sieve script didn't run; queue routing expressions can't pick out one message. Fails closed: if the spam check itself fails, the sender gets a temporary error (retry in a few minutes) and nothing goes out unchecked; messages over 50 MB are refused (big files go as links). Limits: released mail counts against the admin login's sending limits, not the sender's.

Dev: `node deploy/dev-setup.mjs` points the hook at `http://host.docker.internal:3000` with the secret `dev-hold-secret` and does not delay mail when nothing answers. To try it:

```sh
DOMAIN=openmail.test ADMIN_FILE=../deploy/.dev-admin.json SIGNUP=off ADMINS=alice HOLD_HOOK_SECRET=dev-hold-secret \
  SYSTEM_SMTP_HOST=localhost SYSTEM_SMTP_PORT=1465 SYSTEM_SMTP_INSECURE=true node server.mjs
```

The test `test/hold.test.mjs` sets up its own hook (for its throwaway sender only) and removes it afterwards.
### `GET /.well-known/openpgpkey/…` (Web Key Directory)

Serves users' OpenPGP public keys (the ones they uploaded in Settings → Security, Stalwart `x:PublicKey`) so other mail apps can encrypt to them: `/.well-known/openpgpkey/hu/<hash>?l=<local>` (direct) and `/.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>` (advanced, on `openpgpkey.<domain>`), plus an empty `policy`. Binary key, `Access-Control-Allow-Origin: *`, 60 lookups a minute per network. Only keys made out to the address asked about; requests without `?l=` get 404.

### `GET /api/bimi/<domain>` (brand logos)

The sender's brand logo for the web client's avatar (BIMI). Looks up `default._bimi.<domain>` (then the last two labels),
requires a DMARC policy of `quarantine` or `reject` at `pct=100`, fetches the `l=` https SVG (32 KB at most, public
addresses only, no redirects), keeps only SVG Tiny PS shapes (no scripts, styles, images or external references) and
serves it as `image/svg+xml` with a sandboxing CSP. 404 when there's no logo. Answers are cached for a day (no logo:
an hour); fresh lookups are limited to 30 a minute per network. The client only asks for mail whose DMARC passed.

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
- **Not used**: `disabledPermissions.emailReceive` did not refuse mail at `RCPT TO`; a RCPT-stage Sieve script does (below).
- **Banned IPs**: with `clientIpSource: xForwardedFor` (production behind Caddy), a banned client address still got a normal answer from `/api/auth` and `/jmap` when the proxy's connection wasn't banned; Stalwart's bans act on direct connections (IMAP, SMTP). A failed sign-in from a banned address gets `{"type": "failure"}`, the same as a wrong password, so the web app asks `/api/blocked` after any failure and then says the block is temporary. (A ban of the connecting address itself wasn't tried: on the dev server that would lock out everyone.)

Thresholds are per hour, fixed windows, in memory (`ABUSE_LIMIT_HITS`, `ABUSE_BOUNCES`). Suspension history (last 20 per account) and last sign-ins are in `STATE_FILE` and are dropped by the daily job once the account is deleted. The daily job also sends the inactive-account reminders (system mailer) and lists due accounts in the admin console; it never blocks or deletes. Sign-ins only count from the day tracking began (`since` in the file), so nobody is due before 12 months after that. Every suspension and unblock is logged with its reason.

### Mail to blocked inactive accounts

When an admin disables an account the daily job lists as due (the console's "Disable" on the inactive list), the service also adds every address of the account (main address, aliases, and each `name+*@domain` as a glob) to the `x:MemoryLookupKey` namespace `inactive-accounts`. `install.sh` (and `dev-setup.mjs`) point Stalwart's RCPT stage at a system Sieve script for those recipients:

- `x:SieveSystemScript` `{name: "openmail-inactive", isActive: true, contents: 'require "reject"; reject "550 5.2.1 This mailbox is inactive and no longer receives mail.";'}`. A reason that starts with a code is sent as is; without one Stalwart answers `503 5.5.3`.
- `x:MtaStageRcpt.script` = `{match: {0: {if: "key_exists('inactive-accounts', rcpt)", then: "'openmail-inactive'"}}, else: "false"}` (`rcpt` is lowercased; `+tag` addresses need the glob key).
- Lookup keys are read into memory: after a change the service runs `x:Action` `ReloadLookupStores` (`ReloadSettings` doesn't pick them up; verified on 1.0.3).

Senders from outside get `550 5.2.1` at `RCPT TO`, as do mail apps on this server. Enabling the account (or deleting it) removes the keys. Known limit: a message sent from the web app (JMAP) to a refused address is dropped without a bounce on 1.0.3.

### Spam complaints (ARF reports)

`arf.mjs`. Feedback loops (Yahoo CFL, Microsoft JMRP, …) send an ARF report (RFC 5965, `multipart/report; report-type=feedback-report`) when someone marks our mail as spam; register `abuse@DOMAIN` with them. `install.sh` makes `abuse@` a team mailbox (Stalwart group, alias `postmaster@`, first mailbox as member); the service adds the `ADMINS` to it, so they read it in the web app. Every 5 minutes it reads new messages there as admin over JMAP (`Email/query` on the group's account id, download the raw message) and flags each one it has looked at with the keyword `$openmail-arf-seen`.

A report counts against an account only when:

1. **the reporter is trusted**: Stalwart's own lines (the topmost `Received`, and the first `Authentication-Results` below it naming the same host) show DMARC pass for the report's `From` domain or an aligned DKIM pass; with `ARF_REPORTERS`, that domain must be listed, or the connecting IP is. Mail one of our users submitted has no such `Received` line but carries our DKIM signature above any it wrote, so it never counts.
2. **the reported message left this server**: it carries our DKIM signature (`d=DOMAIN`) or a `Message-ID` in our domain;
3. **the sender is ours**: `Original-Mail-From`, else the original's `Return-Path`, else its `From`, on `DOMAIN` (aliases count for their account).

Each reported message counts once. `ARF_LIMIT` complaints within `ARF_WINDOW_HOURS` suspend sending with `by: "spam complaints"`, so only an admin can lift it (`PATCH users/:id {sending: true}`, which also clears the count). Complaints are kept in `STATE_FILE`. Known limits: one level of MIME (base64 decoded, quoted-printable not); accounts on users' own domains aren't matched; a listed IP is trusted for any report, so list only the loops' own addresses.
