# OpenMail plan

**Goal:** an open-source email platform that works like Gmail or Zoho Mail, or better. Anyone can self-host it or use a public hosted instance.

**Core decision:** Stalwart is the mail engine. We build what users touch: the web client, a one-command installer, signup, and the hosted instance.

```
Browser (local-first web app / PWA)
   │  JMAP over HTTPS
   ▼
Stalwart ── SMTP ──► internet        IMAP for Thunderbird/phones, CalDAV/CardDAV
   │
Storage (RocksDB; later Postgres + S3)
Signup service ──► Stalwart management API   (hosted instance only)
```

## Phase 0: Foundation ✅
- [x] Repo, AGPL-3.0 license
- [x] Local Stalwart via docker-compose + one-command bootstrap (`deploy/dev-setup.mjs`)
- [x] Web client scaffold: login, folders, message list, safe reader, read state, local cache
- [ ] CI (GitHub Actions): type-check, build, integration tests against Stalwart in a service container
- [ ] CONTRIBUTING.md, SECURITY.md, issue templates

## Phase 1: Real mail on a real domain
- [ ] VPS with outbound port 25 open; domain; reverse DNS (PTR)
- [ ] MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, autoconfig records
- [ ] TLS via ACME (Let's Encrypt)
- [ ] 10/10 on mail-tester.com; mail lands in the Gmail and Outlook **inbox**

## Phase 2: Tier 1 parity (needed at launch)
- [x] Folders, unread counts, message list, read/unread
- [x] Safe HTML rendering, remote images blocked by default
- [x] Conversation threading (thread view)
- [x] Archive, delete, spam / not spam, mark unread; Gmail-style keyboard shortcuts
- [x] Star + Starred view
- [ ] Labels, multi-select, command palette
- [x] Compose: reply, reply all, forward with quoting and correct threading headers (plain text)
- [x] Compose: rich text (bold, italic, links, lists, quote), safe paste, attachments (button, drag-drop, paste), "forgot attachment?" check
- [x] Drafts: autosave every few seconds, resume from Drafts, discard
- [ ] Signatures, multiple identities; keep inline images when forwarding
- [x] Undo send (delayed submission)
- [x] Full-text search across all mail
- [ ] Search operators (`from:`, `to:`, `has:attachment`, `before:`/`after:`)
- [ ] Live updates via JMAP push (replace 30-second polling); needs token auth first
- [ ] Auth: OAuth/token sign-in, 2FA, passkeys (replace Basic auth)
- [ ] Filters/rules (Sieve), vacation responder, spam / not-spam buttons that train the filter
- [x] Recipient autocomplete from people you email
- [ ] Address book (JMAP contacts)
- [x] Inline (`cid:`) images and attachment download
- [ ] Attachment preview (images, PDF)
- [ ] Phone-friendly layout and installable app (PWA)
- [ ] Import from Gmail or Zoho (IMAP)

- [x] Design pass: tokens, self-hosted fonts, dark mode, phone layout, keyboard focus, reduced motion
- [x] Stay signed in across reloads (sessionStorage; replaced by token auth)

## Phase 2.5: Tier 2
- [ ] Snooze, schedule send (Stalwart supports FUTURERELEASE), follow-up reminders
- [ ] Inbox tabs: Primary / Updates / Promotions
- [ ] Calendar; show and RSVP to invites inside emails
- [ ] Templates, multiple accounts, full offline mode (IndexedDB + `Email/changes` sync)
- [ ] Custom domains for hosted users

## Where we aim to be better than Gmail and Zoho
- [ ] Instant UI: local-first cache, optimistic updates (started)
- [x] Tracker blocking by default (remote images)
- [ ] "This email tried to track you" indicator; strip tracking parameters from links
- [ ] Unlimited masked aliases, each can be turned off on its own
- [ ] One-click unsubscribe plus a subscriptions manager
- [ ] Optional end-to-end encryption (OpenPGP.js)
- [ ] Optional AI (summaries, smart reply): bring your own provider or a local model, off by default

## Phase 3: One-command self-hosting
- [ ] `install.sh`: asks for a domain, writes compose files, starts the stack, prints DNS records, checks until they resolve
- [ ] Production compose: HTTPS, the web client served by Stalwart or a reverse proxy on the same origin
- [ ] Backups (encrypted, restore tested) and upgrade guide
- [ ] Docs site

## Phase 4: Public hosted instance
- [ ] Signup service: captcha, verification, invite codes at first
- [ ] Abuse controls: new-account sending limits, outbound spam scanning, abuse@ mailbox, blocklist monitoring, fast suspension
- [ ] Quotas; paid tier to fund storage
- [ ] Terms of service, privacy policy, GDPR export/delete, law-enforcement request process
- [ ] Monitoring and alerting

## Phase 5: Later
- [ ] Shared team inboxes, notes and tasks, native mobile apps

## Known gaps we accept
- Spam filtering won't equal Gmail's on day one: rspamd plus per-user learning plus blocklists.
- No free 15 GB: quotas or a paid tier on the hosted instance.
- No Docs/Drive/Meet; we integrate with other tools instead of rebuilding them.

## Biggest risks
1. **Deliverability.** Prove it in Phase 1 before investing further.
2. **Abuse on the public instance.** Launch invite-only.
3. **Scope creep.** Finish Phase 2 before anything else.
