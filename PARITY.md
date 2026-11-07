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
| Translate | ✅ (Zia) | ✅ | On this device (browser's built-in model): the message never leaves your computer |
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
| Send-as / aliases | ✅ | ✅ | From menu for every address you own; replies come from the address the mail was sent to |
| Templates | ✅ | ✅ | Synced to every device; insert, save, delete from compose |
| Large file links (WorkDrive) | ✅ | ✅ | Files over 25 MB go to your own storage (counts toward your quota) as a link that expires in 7 or 30 days, or never; always downloaded, never opened in the browser; downloads counted and links revocable in Settings → Shared files; recipients on OpenMail see it like an attachment |
| Spell check | ✅ | ✅ | Browser's own, in the user's languages |
| AI writing (Zia) | ✅ | ✅ | More formal / more casual / shorter, on this device; one ⌘Z undoes it |

## 3. Organising and automation

| Feature | Zoho | Us | Better because |
|---|---|---|---|
| Filters / rules | ✅ | ✅ | Sieve (open standard): run on the server, visible to any client; "filter messages like this" |
| Block sender | ✅ | ✅ | Exact-address match; goes to Junk, never silently lost |
| One-click unsubscribe | 🟡 | ✅ | RFC 8058 one-click, mailto fallback |
| Subscriptions manager | ⬜ | ✅ | Every newsletter in one list: unsubscribe or delete everything from a sender |
| Vacation / out-of-office | ✅ | ✅ | Date range, once per sender |
| Forwarding | ✅ | ✅ | Per-filter forwarding (keeps a copy) |
| Folder management (rename, nest, delete) | ✅ | ✅ | Folders inside folders, in the rail, menus and filters |

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
| End-to-end encryption | 🟡 (S/MIME) | ✅ | OpenPGP (PGP/MIME, signed + encrypted; works with Proton, Thunderbird, GnuPG). Keys found by WKD, Autocrypt (only from authenticated senders) or import; a changed key is held back until you choose; signatures checked in the reader. Our users' keys published by WKD + Autocrypt. Private key stays in the browser. Subject not hidden yet |
| Encryption at rest | ✅ | ✅ | Per user, to *their own* key (Stalwart PGP/MIME): the server can't read stored mail. Decrypted in the browser; search can't see bodies; S/MIME keys accepted but read in another app |
| Masked / disposable aliases | ⬜ | ✅ | One per site, labelled, switch off any time (sender gets “no such mailbox”) |
| Self-hosting / data ownership | ⬜ | ✅ | AGPL, one-command install (Phase 3) |
| Open standards (IMAP, JMAP, CalDAV, CardDAV, Sieve) | 🟡 | ✅ | No lock-in; any client works |

## 5. Beyond mail

| Feature | Zoho | Us | Plan |
|---|---|---|---|
| Calendar + invites in mail | ✅ | ✅ | Week and month views, create/edit/delete, all-day; invitations: Yes/Maybe/No sent to the organizer (iTIP), added once by UID |
| Contacts / address book | ✅ | ✅ | JMAP Contacts: list, search, add/edit/delete, "Add sender to contacts", feeds autocomplete |
| Tasks, notes, bookmarks | ✅ | ✅ | Tasks (due dates, “Add to Tasks” from any email) and Notes (search, pin), synced everywhere |
| Streams (team comments on mail) | ✅ | ✅ | Internal comments under a conversation in a team or delegated mailbox, with author and time; synced (hidden Comments folder in that mailbox), never sent. Zoho's Streams don't work on shared mailboxes |
| Shared / group mailboxes, delegation | ✅ | ✅ | Share a folder (Settings → Folders → Share: read only, read and write, full); it shows under “Shared with me” and can be hidden. Team mailboxes (support@) from the admin console: members open them from the account menu and reply as the team. Delegation (Settings → Delegation): full access, and sending “on behalf of” (From: owner, Sender: delegate). Limits: no true send-as for delegates (Stalwart 1.0.3 refuses another account's envelope), their Sent copy and Undo stay in the delegate's own mailbox, and folders made after delegating need it saved again |
| Multiple accounts in one app | ✅ | ✅ | Gmail-style switcher; signing out of one keeps the others |
| Import from Gmail / Zoho / IMAP | ✅ | ✅ | Gmail Takeout / any .mbox or .eml, in the browser, byte-exact; labels → folders, stars and unread kept |

## 6. Platform and admin

| Feature | Zoho | Us | Plan |
|---|---|---|---|
| Web app | ✅ | ✅ | Local-first: instant UI, light and dark, phone layout |
| Installable app / offline | 🟡 | 🟡 | Installable (PWA: install button, unread badge, Compose shortcut, “Share to OpenMail”, mailto handler), shell works offline; mail offline in Phase 2.5 |
| Desktop app | ✅ | 🟡 | `apps/desktop` (Electron): any server, opens mailto: links, Dock badge; unsigned, no installers yet |
| Native mobile apps | ✅ | 🟡 | `apps/mobile` (Capacitor) shells for any server, generated but not yet built; native push needs FCM/APNs + a push gateway (apps/README.md) |
| Custom domains | ✅ | 🟡 | Settings → Your domain: TXT ownership check, the MX/SPF/DKIM/DMARC records with live status, your address plus up to 10 more, send from them. One owner per domain (no shared org domains yet); re-checked every 6 hours, paused after 7 days without the TXT record |
| Admin console (users, groups, aliases, policies) | ✅ | 🟡 | Ours at `/admin` (`ADMINS`): users, blocked IPs, new-account limits, outgoing queue, users' domains, suspended and inactive accounts, team mailboxes (groups and members). Policies, audit log: Stalwart's admin UI (`/admin/`) |
| SSO (OpenID Connect) | ✅ | 🟡 | `install.sh --oidc-issuer`: Google Workspace, Microsoft Entra, Okta, Keycloak; accounts made on first sign-in, own domains only, verified addresses only, optional tenant lock. Webmail only (the OpenMail console is off: admin names are refused via SSO), server-wide (no IMAP/SMTP for SSO users; per-domain is Stalwart Enterprise). SAML ⬜ |
| Retention policies, legal hold | ✅ | 🟡 | Console → Retention: Trash/Junk auto-empty (Stalwart), delete-older-than per server or account with a dry-run count first, users' own Trash/Junk setting, legal hold (blocks every delete). Hold doesn't stop Stalwart's server-wide Trash auto-empty. eDiscovery ⬜ |
| Public sign-up with abuse controls | n/a | ✅ | Invites, rate limits, quotas (signup/); outgoing spam held for admin review, repeat senders paused |
| Automatic sending block on abuse, self-service unblock | ✅ | ✅ | Repeated throttle refusals or a bounce spike suspend sending (reading still works); a banner explains it and lifts it once, a second time within 7 days needs an admin (signup/abuse.mjs) |
| Inactive-account reminders | ✅ | 🟡 | Daily job emails reminders 60/30/7 days before 12 months without sign-in and lists due accounts for an admin; blocking is the admin's click, not automatic |

## Toward Gmail (and past it)

From docs/research/gmail-gap.md. Gmail column: ✅ has it, ⬜ doesn't.

| Feature | Gmail | Us | Notes |
|---|---|---|---|
| Bcc | ✅ | ✅ | Envelope only; recipients' copies carry no Bcc header (tested) |
| Endless list (beyond 50) | ✅ | ✅ | Pages in as you scroll |
| Desktop notifications | ✅ | ✅ | Opt-in; also with every tab closed (standard Web Push from the mail server, no third party); content never in the push |
| Follow-up reminders / nudges | ✅ | ✅ | “Remind me if nobody replies”: unanswered mail comes back marked “No reply yet” |
| Mute conversation | ✅ | ✅ | New replies skip the Inbox (m) |
| Attachment preview | ✅ | ✅ | Images, PDF, text; SVG always downloads (safety) |
| Label chips in the list | ✅ | ✅ | |
| Gmail shortcuts (g i, g s, z, ], m…) | ✅ | ✅ | |
| Branded sign-in incl. 2FA | ✅ | ✅ | Our own page on the server's sign-in API; security changes re-ask in place (no pop-up) |
| Screener (first-time senders wait) | ⬜ | ✅ | Server-side Sieve; spam still goes to Junk (spamtest, can't be forged) |
| Masked addresses | ⬜ | ✅ | See above |
| 150+ recipients from mail apps | ✅ | ✅ | 500 per message for signed-in senders (was 100) |
| Priority Inbox / important | ✅ | ✅ | Unread mail from people you write to comes first; no scanning, no AI: it uses your own Sent mail |
| Search chips + typeahead | ✅ | ✅ | One-click filters (unread, starred, attachments, last 7 days, sent) and “From <person>” as you type |
| AI (summarise, smart reply) | ✅ | ✅ | Summaries, smart replies and writing help, all on this device; nothing goes to an AI company |
| Offline mail | ✅ | ⬜ | Installable today; mail offline later |
| Large files as links | ✅ | ⬜ | |

## Score today

Counting rows a typical Zoho Mail user touches (sections 1–4 plus calendar, contacts and the web app):
**47 of 50 at parity or better (94%), 1 partial.**
Phase 2.5 (calendar, contacts UI, categories, multiple signatures, multi-account, E2E, OAuth/2FA) takes it past 90%;
shared mailboxes and import close the rest of the 95%.

## Order of work

1. **Next batch:** Priority Inbox, search chips, multiple accounts, import from Gmail (IMAP), tracking report.
2. **Phase 2 security:** passkeys. (E2E OpenPGP and encryption at rest: done.)
3. **Phase 2.5:** calendar, address book, inbox categories, subscriptions manager,
   multi-account, saved searches.
4. **Phase 3–4:** shared mailboxes, admin console. Scale: docs/research/scale.md (1 → 3 → N nodes).
5. **Toward Gmail:** smart categorisation, offline-first sync, AI features (opt-in), native apps.
