# Beating Zoho Mail, then Gmail

**Goal:** be at least as good as Zoho Mail on 95% of what its users touch, and clearly better on privacy, speed
and openness. Then close the gap to Gmail.

Status key: ✅ done · 🟡 partial · ⬜ planned. "Better" means a concrete advantage over Zoho, not a tie.
Phase numbers refer to PLAN.md. Last reviewed: 2026-11-07.

## 1. Reading and triage

| Feature | Zoho | Us | Better because |
|---|---|---|---|
| Conversation view | ✅ | ✅ | Paper-trail layout: newest open, older folded |
| Unified folders + labels (tags) | ✅ | ✅ | A conversation can live in several folders (JMAP), no tag/folder split |
| Star / flag | ✅ | ✅ | |
| Snooze | 🟡 (reminders) | ✅ | Real snooze: leaves the inbox, returns unread |
| Archive, delete, spam / not spam | ✅ | ✅ | Auto-advance to the next conversation |
| Multi-select + bulk actions | ✅ | ✅ | Shift-click ranges, keyboard `x` |
| Keyboard shortcuts | ✅ | ✅ | Gmail-compatible keys plus a ⌘K command palette |
| Search | ✅ | ✅ | `from:` `to:` `subject:` `has:attachment` `is:unread` `in:` `before:` `after:` `-negation` |
| Saved searches / search folders | ✅ | ✅ | Pinned in the rail, synced through the account |
| Live updates | ✅ | ✅ | Server push, no polling |
| Show original / headers | ✅ | ✅ | |
| Print | ✅ | ✅ | Prints with trackers removed |
| Read receipts (request) | ✅ | ✅ | Request from compose; when asked, you choose Send or Ignore (standard MDN), never automatic |
| Translate | ✅ (Zia) | ⬜ | Optional, local model where possible |
| Inbox categories (Updates / Promotions) | 🟡 | ✅ | Primary / Updates, sorted on the server as mail arrives; one switch in Settings |

## 2. Writing

| Feature | Zoho | Us | Better because |
|---|---|---|---|
| Rich text compose | ✅ | ✅ | Safe paste: formatting kept, scripts and trackers removed |
| Attachments, drag-drop, paste | ✅ | ✅ | "You mentioned an attachment" check |
| Inline images | ✅ | ✅ | Kept in replies and forwards, shown inside the editor |
| Drafts autosave | ✅ | ✅ | |
| Undo send | ✅ | ✅ | Server-side hold: works even if the tab closes |
| Schedule send | ✅ | ✅ | Scheduled view to edit or cancel |
| Recipient autocomplete | ✅ | ✅ | Ranks people you write to above people who write to you |
| Signatures | ✅ (many) | ✅ | Named signatures synced on the server; separate defaults for new messages and replies; switch or remove per message |
| Send-as / aliases | ✅ | ⬜ | Needs admin API: with masked aliases (below) |
| Templates | ✅ | ✅ | Synced to every device; insert, save, delete from compose |
| Large file links (WorkDrive) | ✅ | ⬜ | Phase 5: integrate, don't rebuild |
| Spell check | ✅ | ✅ | Browser's own, in the user's languages |
| AI writing (Zia) | ✅ | ⬜ | Optional, user's own provider or local model, off by default |

## 3. Organising and automation

| Feature | Zoho | Us | Better because |
|---|---|---|---|
| Filters / rules | ✅ | ✅ | Sieve (open standard): run on the server, visible to any client; "filter messages like this" |
| Block sender | ✅ | ✅ | Exact-address match; goes to Junk, never silently lost |
| One-click unsubscribe | 🟡 | ✅ | RFC 8058 one-click, mailto fallback |
| Subscriptions manager | ⬜ | ✅ | Every newsletter in one list: unsubscribe or delete everything from a sender |
| Vacation / out-of-office | ✅ | ✅ | Date range, once per sender |
| Forwarding | ✅ | ✅ | Per-filter forwarding (keeps a copy) |
| Folder management (rename, nest, delete) | ✅ | 🟡 | Create, rename, delete; nesting later |

## 4. Privacy and security (where we must win clearly)

| Feature | Zoho | Us | Better because |
|---|---|---|---|
| No ads, no content scanning | ✅ (paid) | ✅ | Free tier included; code is public, so it's checkable |
| Remote images blocked | 🟡 | ✅ | Default on |
| Tracking pixels removed | ⬜ | ✅ | Removed even after "Load images", and the sender is named |
| Link tracking parameters stripped | ⬜ | ✅ | utm_*, fbclid, gclid, … |
| Hostile HTML isolation | ✅ | ✅ | Sandboxed frame + strict CSP, tested |
| 2FA / passkeys | ✅ | ✅ | Settings → Security: fresh sign-in → security token in memory only; QR enrolment with the code checked before saving; app passwords limited to IMAP/SMTP/POP/DAV (a leaked one can't change the password or 2FA); password change. Passkeys later |
| OAuth sign-in (no stored password) | ✅ | ✅ | PKCE, rotating refresh token, revoked at sign-out |
| End-to-end encryption | 🟡 (S/MIME) | ⬜ | OpenPGP.js, Phase 2.5 |
| Encryption at rest | ✅ | 🟡 | Stalwart supports per-account encryption at rest; expose in settings |
| Masked / disposable aliases | ⬜ | ⬜ | Phase 4: unlimited, each can be turned off |
| Self-hosting / data ownership | ⬜ | ✅ | AGPL, one-command install (Phase 3) |
| Open standards (IMAP, JMAP, CalDAV, CardDAV, Sieve) | 🟡 | ✅ | No lock-in; any client works |

## 5. Beyond mail

| Feature | Zoho | Us | Plan |
|---|---|---|---|
| Calendar + invites in mail | ✅ | ✅ | Week and month views, create/edit/delete, all-day; invitations: Yes/Maybe/No sent to the organizer (iTIP), added once by UID |
| Contacts / address book | ✅ | ✅ | JMAP Contacts: list, search, add/edit/delete, "Add sender to contacts", feeds autocomplete |
| Tasks, notes, bookmarks | ✅ | ⬜ | Phase 5 (lightweight) |
| Streams (team comments on mail) | ✅ | ⬜ | Phase 5: shared mailboxes first |
| Shared / group mailboxes, delegation | ✅ | ⬜ | Phase 4: Stalwart groups + JMAP sharing |
| Multiple accounts in one app | ✅ | ⬜ | Phase 2.5 |
| Import from Gmail / Zoho / IMAP | ✅ | ⬜ | Phase 3 (documented imapsync first, then built in) |

## 6. Platform and admin

| Feature | Zoho | Us | Plan |
|---|---|---|---|
| Web app | ✅ | ✅ | Local-first: instant UI, light and dark, phone layout |
| Installable app / offline | 🟡 | 🟡 | Installable (PWA), shell works offline; mail offline in Phase 2.5 |
| Native mobile apps | ✅ | ⬜ | PWA first; native in Phase 5 |
| Custom domains | ✅ | 🟡 | Self-hosting: yes. Hosted: Phase 2.5 |
| Admin console (users, groups, aliases, policies) | ✅ | 🟡 | Stalwart's admin UI today; our own in Phase 4 |
| SSO / SAML, eDiscovery, retention | ✅ | ⬜ | Phase 5 (business tier) |
| Public sign-up with abuse controls | n/a | ✅ | Invites, rate limits, quotas (signup/) |

## Score today

Counting rows a typical Zoho Mail user touches (sections 1–4 plus calendar, contacts and the web app):
**42 of 50 at parity or better (84%), 2 partial.** The "next batch" items below take that toward 85%;
Phase 2.5 (calendar, contacts UI, categories, multiple signatures, multi-account, E2E, OAuth/2FA) takes it past 90%;
shared mailboxes and import close the rest of the 95%.

## Order of work

1. **Next batch (small, high value):** branded sign-in page (today it is the mail server's own page); send-as / aliases.
2. **Phase 2 security:** passkeys.
3. **Phase 2.5:** calendar, address book, inbox categories, subscriptions manager,
   multi-account, E2E (OpenPGP), saved searches, encryption-at-rest toggle.
4. **Phase 3–4:** installer, import, masked aliases, shared mailboxes, admin console.
5. **Toward Gmail:** smart categorisation, offline-first sync, AI features (opt-in), native apps.
