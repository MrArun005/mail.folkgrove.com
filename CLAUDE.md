# OpenMail repo map (for AI agents)

Read this first, then jump to the file. Status and roadmap live in `PLAN.md`; Gmail/Zoho feature parity in `PARITY.md`;
design rules in `web/DESIGN.md`; account-service API and settings in `signup/README.md`; self-hosting in `docs/self-hosting.md`.

## How it fits together
The browser loads the React app (`web/`, built to static files) from **Caddy** (`deploy/production/Caddyfile`). The app has
no backend of its own: it talks **JMAP** (RFC 8620/8621) straight to **Stalwart v1.0.3** (`/jmap`, OAuth at `/auth` +
`/api/auth`, DAV, `/.well-known/*`) on the same origin. Anything that needs admin rights or server-side state goes to the
**account service** (`signup/`, plain Node, no framework, port 3000): Caddy's `@signup` matcher sends `/api/signup`,
`/api/aliases*`, `/api/session/*`, `/api/admin/*`, `/api/domains*`, `/api/files*`, `/f/*`, `/api/sending*`, `/api/blocked`,
`/api/principal`, `/api/retention`, `/api/sso*`, `/api/bimi/*`, `/.well-known/openpgpkey/*` there; everything else goes to
Stalwart. The account service checks the caller's own token against Stalwart, then acts with admin credentials (`ADMIN_FILE`)
via Stalwart's admin JMAP (`x:*` objects). Stalwart calls back into it on the internal network: an **MTA hook** at the DATA
stage (`x:MtaHook` → `POST /internal/outbound-hook`, `signup/hold.mjs`) and event posts (`EVENTS_URL` → `/api/events`,
`signup/abuse.mjs`), neither of which Caddy exposes. In dev, `web/vite.config.ts` proxies the same paths (Stalwart :8080,
account service :3000). `apps/` are thin native shells that open a server's own web app.

## Directory map
```
web/            React 19 + Vite + TS web client. src/ (flat), src/i18n/, e2e/ (Playwright), public/ (sw.js, manifest, icons, legal)
  index.html, confidential.html   the two Vite entry pages (app; confidential-message viewer)
signup/         account service (Node ESM .mjs, no deps beyond stdlib); test/ (node --test)
deploy/         dev-setup.mjs + docker-compose.yml (local Stalwart); production/ (install.sh, Caddyfile, compose, backup.sh,
                check-dns.sh, hosted/ = Postgres+S3 mode, monitoring/ = Prometheus/Grafana); scale/ (multi-node reference)
apps/           shell/index.html (first-run "which server?"), desktop/ (Electron), mobile/ (Capacitor: android/, ios/)
docs/           self-hosting.md, deploy-folkgrove.md, legal/ (policies + build.mjs), research/ (gmail-gap, zoho, scale), reviews/
.github/workflows/ci.yml   CI: web + signup tests, installer end-to-end, Android debug build
```

## File index: web/src
**Core / plumbing**
- `main.tsx` — entry: loads language before first paint, registers `sw.js` in production.
- `App.tsx` — sign-in vs app, SSO return (`?sso=`), `/admin` → `Admin`, session-expiry handling.
- `jmap.ts` — the JMAP client (`class Jmap`, `JmapError`, all types: `Mailbox`, `EmailSummary`, `EmailFull`, `Identity`, `Draft`, `Contact`, `Note`, `Task`…). Every server call lives here; concurrency limiter, offline reads, sharing (`as()`).
- `oauth.ts` — OAuth 2.1 + PKCE sign-in from our own form, `signIn`, `stepUp`, SSO (`adoptSso`), multi-account `signedInAccounts`.
- `route.ts` — hash routing `#/in/<folder>`, `#/search/<q>`, `/t/<thread>` (`parseRoute`, `writeRoute`).
- `store.ts` — sessionStorage list cache (local-first). `offline.ts` — IndexedDB mail + outbox on trusted devices.
- `launch.ts` — mailto/share/compose shortcuts, install prompt, badge, native-shell bridge.
- `notify.ts` — desktop notifications + Web Push. `Dialog.tsx` — `confirmIt`/`promptIt`/`chooseIt`/`notify` + `DialogHost`.
- `Button.tsx`, `Menu.tsx` (dropdown + `TimeChoices`), `icons.tsx` (`Icon`), `Swipe.tsx` (`useSwipe`), `EmojiPicker.tsx`.
- `styles.css` — all CSS (themes, phone layout, RTL). `when.ts` — snooze/schedule quick times.

**Mail list & reader**
- `Mail.tsx` — the main screen: owns lists, selection, folders, virtual folders, account switcher; wires everything else.
- `Rail.tsx` — left rail / phone drawer (`Rail`, `ShortcutsHelp`); stateless. `Rows.tsx` — conversation rows (`ConversationRows`, `InboxZero`).
- `Reader.tsx` — conversation view (`Reader`, `MessageFrame`, link checks `claimedHost`/`sameSite`).
- `safeHtml.ts` — hostile-HTML rendering: sandboxed iframe srcdoc + CSP + tracker stripping (`buildSrcdoc`, `cleanLink`).
- `messageActions.ts` — per-message/sender actions (unsubscribe, block, print, original, receipts, react, save search).
- `search.ts` — Gmail-style query → JMAP filter (`parseSearch`). `SearchChips.tsx` — one-click filters.
- `smarts.ts` — on-device cards/dates/sender trust (`findCards`, `findWhen`, `trust`); `SmartCards.tsx` renders them + BIMI logo.
- `FeedView.tsx` — newsletters as one scrolling page. `Subscriptions.tsx` — every newsletter, unsubscribe/clear.
- `reactions.ts` — RFC 9078 emoji reactions. `privacy.ts` + `PrivacyReport.tsx` — tracker tally (local only).
- `Palette.tsx` — ⌘K command palette. `Ask.tsx` + `ai.ts` — on-device translate/summarise/rewrite/replies/"Ask your inbox".
- `Sending.tsx` — "sending suspended" notice (from `signup/abuse.mjs`).

**Compose**
- `Compose.tsx` — editor, recipients, attachments, large-file links, send/schedule. `ComposeDock.tsx` — multiple drafts, pop-out windows.
- `ComposeExtras.tsx` — format bar, image sizes, "Help me schedule". `RecipientInput.tsx` — ARIA combobox recipients.
- `SmartCompose.tsx` — on-device inline suggestions. `mailutil.ts` — address parsing, `cleanHtml`, `draftFor` (reply/forward), signatures, `unsubscribePlan`, `buildMdn`.
- `Confidential.tsx` + `seal.ts` — confidential mode (AES-GCM in browser, key in URL `#`); `confidentialView.ts` — the static `/confidential.html` viewer.

**Security / encryption**
- `pgp.ts` — openpgp.js wrapper, lazy-loaded (`import('./pgp')`): PGP/MIME read/write, keys, WKD lookup.
- `keys.ts` — own + peer keys in IndexedDB, passphrase wrapping, Autocrypt, `senderAuthenticated` (topmost Authentication-Results/Received).
- `Encryption.tsx` — Settings → Security key UI, reader decrypt/verify (`useSecureMail`, `SecureBanner`), compose `useRecipientKeys`.
- `Security.tsx` — password, 2FA, app passwords (step-up token kept in memory). `totp.ts` — RFC 6238 via WebCrypto.

**Calendar / contacts / notes / tasks**
- `calendar.ts` — pure date math/layout (`layoutDay`, `freeSlots`…). `CalendarView.tsx` — week/month views, `EventEditor`.
- `ics.ts` — parse invitations, build iTIP REPLY. `Contacts.tsx` — list, panel, groups. `Notes.tsx`, `Tasks.tsx`.

**Settings, sharing, data**
- `Settings.tsx` — settings page, theme + per-device display prefs (`applyTheme`, `displayPref`).
- `Filters.tsx` + `rules.ts` — rules ⇄ Sieve script (`toSieve`, `parseRules`), vacation, tabs/categories; `FoldersSection`.
- `Addresses.tsx` — masked aliases. `Domains.tsx` — custom domains. `SharedFiles.tsx` — large-file links. `Retention.tsx` — own + admin retention.
- `Sharing.tsx` — shared folders, delegation, team mailboxes, team comments. `Install.tsx` — Settings → App.
- `Import.tsx` + `importer.ts` — mbox/eml import on raw bytes. `Export.tsx` + `exporter.ts` — mbox export, `DeleteAccountSection`.
- `Signup.tsx` — public sign-up form (shown only if the service answers).

**Admin** — `Admin.tsx` — `/admin` console (users, teams, blocked IPs, limits, queue, held mail, audit, retention) → `signup/admin.mjs`.

**i18n** — `i18n/index.ts` (`t()`, plurals, `LANGUAGES`, `pickLanguage`), `i18n/en.ts` (source of all keys) + 10 catalogs: `ar de es fr hi ja kn pt-BR ta zh-CN`. `i18n/i18n.test.ts` checks keys/vars.

## File index: signup/
- `server.mjs` — `configFromEnv` (every env var) + `createApp`: builds each `*Routes` module and dispatches by path; also `/api/signup`, `/api/username-available`, `/healthz`, scheduled jobs.
- `lib.mjs` — pure: `checkUsername`, `checkPassword`, `RateLimiter`, `ipKey`, `Invites`. `mailer.mjs` — SMTP `sendMail`/`sendRaw` (system mail).
- **Accounts:** `account.mjs` — DELETE `/api/account` (erasure), retired names. `aliases.mjs` — masked aliases. `tiers.mjs` — new-account sending limits, hourly promotion.
- **Sessions / SSO:** `session.mjs` — HttpOnly refresh-token cookie, `/api/session/*`. `sso.mjs` — OIDC (`verifyIdToken`, `/api/sso*`).
- **Admin:** `admin.mjs` — `/api/admin/*`, explicit op list, `AUDITED` map. `audit.mjs` — JSONL audit log (`auditLog`).
- **Abuse:** `abuse.mjs` — sending suspension + self-unblock, `/api/events`, `/api/blocked`, `/api/sending`, inactive-account step. `hold.mjs` — MTA hook, spam-scored outgoing mail held for admin review. `arf.mjs` — spam-complaint (ARF) reports read from abuse@.
- **Domains:** `domains.mjs` — custom domains, TXT verify, DNS record checks, cleanup. `wkd.mjs` — Web Key Directory. `bimi.mjs` — brand logo fetch + SVG sanitise.
- **Files / sharing / retention:** `files.mjs` — large-file links (FileNode storage, `/f/*`). `sharing.mjs` — `/api/principal` exact-address lookup. `retention.mjs` — retention rules, legal hold, sweep.
- `test/*.test.mjs` — one per module + `integration.test.mjs` (needs dev Stalwart). `Dockerfile` for production.

## Where to change X
| Task | Touch |
|---|---|
| Add/change a UI string | `web/src/i18n/en.ts` (key), use `t('key', {vars})`; add translations to the 10 other catalogs (missing keys fall back to English; `// review:` marks strings for a native speaker). Run web tests. |
| Add an `/api/...` route | new or existing `signup/<area>.mjs` `*Routes` → dispatch line in `signup/server.mjs` `createApp` → **`@signup` path list in `deploy/production/Caddyfile`** (else it goes to Stalwart) → `web/vite.config.ts` proxy → test in `signup/test/` → document in `signup/README.md`. |
| Add an admin action | handler in `signup/admin.mjs` routes + `AUDITED` entry; UI in `web/src/Admin.tsx`. |
| Change Stalwart config | both `deploy/dev-setup.mjs` (dev/CI) **and** `deploy/production/install.sh` (production); they use the same `x:*` JMAP calls. |
| Add an account-service env var | `configFromEnv` in `signup/server.mjs` + `signup` environment in `deploy/production/docker-compose.yml` + `install.sh` (`.env` var list, flags) if users set it + `signup/README.md`. |
| New JMAP call | method on `Jmap` in `web/src/jmap.ts`; integration test in `web/src/jmap.test.ts`. |
| Filter / Sieve behaviour | `web/src/rules.ts` (pure, tested in `rules.test.ts`); UI in `Filters.tsx`. |
| New settings section | component in its own file, mounted in `web/src/Settings.tsx`. |
| Styles / layout | `web/src/styles.css` (follow `web/DESIGN.md`). |
| PWA / offline | `web/public/sw.js`, `web/public/manifest.webmanifest`, `web/src/offline.ts`, `web/src/launch.ts`. |

## Commands
```
node deploy/dev-setup.mjs            # Stalwart on :8080 (docker), domain openmail.test, user alice / alice-dev-pass; --reset wipes
cd web && npm install && npm run dev # http://localhost:5173 ; Stalwart admin UI http://localhost:8080/admin (creds: deploy/.dev-admin.json)
cd signup && DOMAIN=openmail.test ADMIN_FILE=../deploy/.dev-admin.json INVITE_CODES=welcome:5 node server.mjs   # :3000
#   admin console / held mail: add SIGNUP=off ADMINS=alice HOLD_HOOK_SECRET=dev-hold-secret (see signup/README.md)
cd web && npx tsc --noEmit -p . && npm test && npm run build   # vitest; integration tests skip if dev Stalwart is down
cd web && npm run e2e                # Playwright against the dev server
cd signup && npm test                # node --test --test-concurrency=1 (serial: shares the dev Stalwart on :8080)
```
CI (`.github/workflows/ci.yml`) runs dev-setup, web type-check/test/build/e2e, signup tests; `installer` job runs
`install.sh --local-test` and curls webmail + `/api` via Caddy; `android` job builds the debug APK.

## Gotchas (verified in code/history)
- **Stalwart limits:** `maxObjectsInGet` is 500, so page `/get` calls by 500 (`jmap.ts` ~L955, `abuse.mjs` `getAccounts`); `maxConcurrentRequests` is 4 per account, so `Jmap` throttles in-flight requests (`maxConcurrent`, keeps one free).
- **JMAP `header:X`** without `:all` returns only the *last* instance. For "topmost" (ours, added on delivery) ask `:all` and take `[0]`: see `FULL` in `jmap.ts` (`header:Authentication-Results:asText:all`, `header:Received:asRaw:all`). Received is read `:asRaw`.
- **Dev auth bans:** tests fail sign-ins on purpose; `dev-setup.mjs` raises `authBanRate`/`abuseBanRate`/`loiterBanRate` so the host isn't banned. If your IP still got banned (older dev server), re-run `node deploy/dev-setup.mjs`, delete the `x:BlockedIp` entry (Stalwart admin UI or `x:BlockedIp/set` destroy with `.dev-admin.json`), or `--reset`. Production uses 1-hour/1-day bans (`install.sh` `x:Security/set`).
- **Bans behind Caddy** don't stop `/jmap`/`/api/auth` answers; the app asks `/api/blocked` after a failed sign-in (`signup/README.md`).
- **RTL:** Arabic is shipped. Use CSS logical properties (`margin-inline-*`, `padding-inline-*`, `inset-inline-*`), never left/right; direction icons use `.icon-dir` (mirrored under `[dir="rtl"]`).
- **Layout:** pages use the full screen width with modest padding; no narrow centred max-width columns.
- **`/admin` vs `/admin/`:** exact `/admin` is our console (served by Caddy as the app); `/admin/` is Stalwart's own admin.
- **New `/api` path not reaching signup?** It's missing from the Caddyfile `@signup` matcher or the Vite proxy.
- **`ponytail:` comments** mark deliberate simplifications and name their ceiling/upgrade path. Don't "fix" them without need.
- **Commits:** never add `Co-Authored-By` or other AI attribution trailers.
- Stalwart 1.0.3 open-source gaps (no last-login, no passkeys, Enterprise-only tracing) are documented in `signup/README.md` and `PLAN.md`; check there before building around a missing feature.
