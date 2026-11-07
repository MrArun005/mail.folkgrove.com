# OpenMail plan

**Goal:** an open-source email platform that works like Gmail or Zoho Mail, or better. Anyone can self-host it or use a public hosted instance.

**Core decision:** Stalwart is the mail engine. We build what users touch: the web client, a one-command installer, a small account service, and the hosted instance.

**Feature status lives in [PARITY.md](PARITY.md) only.** This file holds the architecture, the decisions behind it, the phases with their gates, and the risks. Last reviewed: 2026-11-07 (after an EGM design review: [docs/reviews/egm-2026-11-07.md](docs/reviews/egm-2026-11-07.md)).

```
Browser (web app / PWA) ── JMAP over HTTPS ──► Stalwart ── SMTP ──► internet
        │                                         │        IMAP, CalDAV/CardDAV for other apps
        └── /api/aliases, /api/signup, /api/account ──► Account service (signup/) ── admin API ──► Stalwart
                                                                │
                                       Self-host: RocksDB (default) · Hosted: PostgreSQL + S3 from day one
```

## Decisions

| Decision | Why | Revisit when |
|---|---|---|
| **Account service** (`signup/`) is the only backend we run. It holds the admin credentials and does what users can't do themselves: masked addresses (everyone) and public sign-up (hosted only, `SIGNUP=on`). It talks to Stalwart on the internal network and accepts users' sign-in tokens, never passwords. | Adding an address to an account needs admin rights. One small service is easier to secure than many. | Stalwart offers a scoped admin role we can use instead of full admin. |
| **Masked addresses are ordinary account aliases**, capped at 200 per account and 30 new per hour. | Stalwart's own masked-email feature is Enterprise-only. Aliases are open source and work in every mail app. | Users need more than 200. |
| **No address recycling, ever.** Deleting a masked address retires it (kept, switched off); usernames can't be reused. Stalwart frees a destroyed account's names at once, so deleting an account first writes its username and aliases to a retired-names file (`RETIRED_FILE`) that sign-up checks. | A recycled address receives the old owner's password resets. Stalwart refuses any account or alias that clashes with an existing one, but not with a deleted one. | Never. |
| **Hosted instance runs on PostgreSQL + S3 from its first user.** Self-hosters keep RocksDB (simpler). There is no supported RocksDB → PostgreSQL migration. | Moving stores later means migrating every mailbox ([scale.md](docs/research/scale.md) §1). | — |
| **Per-user settings live in the Sieve script** (filters, vacation, signatures, saved searches, Screener allow list), saved with `ifInState` and re-applied on conflict. | Synced to every device with no extra storage. Ceiling: ~1,500 Screener senders before the script size limit. | The ceiling is reached: move the allow list to the address book. |
| **Sessions**: per tab by default (access token in memory, refresh token in sessionStorage). **“Keep me signed in”** moves the refresh token into an HttpOnly, Secure, SameSite=Strict cookie held by the account service (`/api/session`, CSRF header required, rotated on every refresh, one refresh per token at a time). Page scripts never see it. | XSS can't steal a long-lived credential; reopening the browser goes straight to your mail. | — |
| **Sending limits** apply to webmail (JMAP) and mail apps (SMTP) alike, as one per-account counter of outside **recipients** per day (verified on the dev server, 2026-11-07). 500 recipients per message for signed-in senders, 100 on port 25. | One limit, one place; can't be dodged by switching apps. | Before public sign-up: add new-account tiers (scale.md §10.2). |

## Phases and gates

**Gate 1 (before any public sign-up):** Phase 1 passes and Phase 4's abuse items are done. Feature work may continue in parallel; **public users wait for this gate.**

### Phase 0: Foundation ✅
Repo, AGPL-3.0, local Stalwart + one-command bootstrap, web client, CI against a real Stalwart, contributor docs.

### Phase 1: Real mail on a real domain (not started: needs a server)
- [ ] Server: Oracle Cloud Always Free (ARM). Domain: `folkgrove.com` itself (Google Workspace was cancelled, so its MX can move to us; mail host `mx.folkgrove.com`). Reverse DNS (PTR) via Oracle support.
- [ ] Outgoing relay, because Oracle blocks port 25: Brevo free tier (300 mails/day) to start; switch to direct sending (port 25 + warm-up) or a paid relay as volume grows.
- [ ] MX, SPF, DKIM, DMARC (p=none → quarantine → reject), MTA-STS, TLS-RPT, autoconfig (`install.sh` prints them; `check-dns.sh` verifies)
- [ ] 10/10 on mail-tester.com; inbox placement at Gmail, Outlook and Yahoo recorded **in this repo** (screenshots + Postmaster Tools)
- [ ] Register Google Postmaster Tools, Microsoft SNDS/JMRP, Yahoo CFL (feedback loops)

### Phases 2 / 2.5: Parity with Zoho, then Gmail
Tracked row by row in [PARITY.md](PARITY.md).

### Phase 3: One-command self-hosting ✅
`install.sh`, production compose (Caddy + Stalwart + account service), backups (age-encrypted, restore tested), [self-hosting guide](docs/self-hosting.md).

### Phase 4: Public hosted instance (blocked by Gate 1)
- [x] Sign-up: invite codes, per-IP limits, reserved names, quotas, optional Turnstile
- [ ] Hosted stack on PostgreSQL + S3 (reuse `deploy/scale/`), with PostgreSQL backups (pg_dump + WAL archiving)
- [x] Email verification at sign-up: a 6-digit code to an existing address (hashed, 15 min, 5 tries, rate-limited per network and per address), sent from a system account through our own server
- [ ] Abuse controls (each with numbers in [scale.md](docs/research/scale.md) §10): new-account sending tiers, outbound spam held for review, forwarding limits (one confirmed forwarding address per account), abuse@ mailbox, complaint/bounce-rate suspension (e.g. > 0.3% complaints over 7 days with ≥ 200 sends)
- [ ] Monitoring: Prometheus + Alertmanager. Alerts: queue age > 30 min, delivery failures > 5% per provider for 15 min, back-pressure rising 5 min
- [x] GDPR export (Settings → Export your data) and delete (Settings → Delete your account, `DELETE /api/account`)
- [ ] Terms, privacy policy, acceptable use, law-enforcement process, inactive accounts: drafts in [docs/legal/](docs/legal/), **need a lawyer's review**; inactive-account reminders/blocking not automated yet
- Expected volume: invite-only, under 100k messages a day at launch. Scale stages 2–3 in scale.md are reference, not commitments.

### Phase 5: Later
Shared team inboxes, notes and tasks, native mobile apps.

## Known gaps we accept
- Spam filtering won't equal Gmail's on day one: Stalwart's filter plus per-user learning plus blocklists.
- No free 15 GB: quotas or a paid tier on the hosted instance.
- No Docs/Drive/Meet; we integrate with other tools instead of rebuilding them.

## Biggest risks
1. **Deliverability.** Unproven until Phase 1 runs on a real server. That is the next milestone that needs the owner (a server).
2. **Abuse on the public instance.** Gate 1 above; invite-only at first.
3. **Scope creep.** New PARITY rows only for what users ask for or what Gmail/Zoho users expect.
