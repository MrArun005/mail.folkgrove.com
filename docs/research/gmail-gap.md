# Gmail gap analysis (and how to beat it)

Target: Gmail consumer + Workspace as of Nov 2026, then past it. Every row below was checked against
`web/src` (Mail, Compose, Reader, Settings, jmap.ts, search.ts, store.ts) on 2026-11-07. Features we already
ship (see PARITY.md: snooze, schedule/undo send, Sieve filters, subscriptions manager, categories, saved searches,
templates, signatures, calendar/RSVP, contacts, tracker stripping, 2FA, push) are not repeated.

Effort: S ≤ 2 days · M ≈ 1–2 weeks · L = a month+. Value: H/M/L for a typical Gmail switcher.

## 0. Surprises (basics missing, found while verifying)

| Gap | Evidence | Fix |
|---|---|---|
| **No Bcc** | `Draft` has `to`/`cc` only; Compose has no Bcc field | Add `bcc` to Draft; set `bcc` on Email/set, and on EmailSubmission `envelope.rcptTo` (RFC 8621 §7) |
| **List stops at 50 conversations** | `client.threads(filter, limit = 50)`, no paging/infinite scroll | `Email/query` `position`/`anchor` + "load more" on scroll; show `total` |
| **No desktop notifications** | Push exists (EventSource) but no `Notification` API use | On `Email/changes` with new Inbox+Primary mail, `new Notification()`; Web Push (RFC 8030 via JMAP `PushSubscription`, RFC 8620 §7.2) when tab closed |
| **Labels not visible in the list** | Rows show sender/subject/preview/star only | Render `mailboxIds` (non-current) as chips; label colours (see #L1) |
| Attachment preview | PLAN Phase 2 item still open; Reader only downloads | Images/PDF in a sandboxed viewer from blob URL (pdf.js or browser PDF viewer) |
| Go-to shortcuts (`g i`, `g s`…), `[`/`]`, `z` undo, `m` mute, `l`/`v` label/move | Keymap in Mail.tsx lacks them | Extend the keymap; chord buffer for `g` |
| Folder nesting, drag-and-drop to folder | PARITY says partial; no `dragstart` in list | `Mailbox.parentId` (RFC 8621 §2); HTML5 DnD rows → `move()` |

## 1. Gmail features we don't have

### Reading and triage

| Feature | What Gmail does | How on JMAP/Stalwart | Eff | Val |
|---|---|---|---|---|
| Mute conversation | Future replies skip the inbox | `$muted` keyword on thread (IANA keyword registry); Sieve can't see thread keywords, so a small server hook or client-side rule on `Email/changes`: new mail in a muted thread → archive. Stalwart's Sieve `vnd.stalwart` eval may allow it server-side | S | M |
| Important markers / Priority Inbox | ML "important" flag, sections: Important & unread, Starred, Everything else | Score from our own data (replied-to senders, contacts, threads you're in) → `$important` keyword set by a Sieve/ingest step; inbox sections = three `Email/query` calls | M | H |
| Nudges | "Received 3 days ago. Reply?" and "Sent 5 days ago. Follow up?" | Client-side: query threads where last message is from other/you, older than N days, no reply; surface at top of Inbox. No server change | S | H |
| Follow-up reminders (explicit) | Remind me if no reply by date (Gmail via Tasks/nudges; Superhuman/Spark native) | Store `{threadId, due}` as keyword `$followup` + date in a JMAP-stored settings blob; reuse snooze machinery to return thread to Inbox if no new message from others | S | H |
| AI conversation summary card | Gemini summary above long threads | Opt-in "Summarise" button; user-provided LLM endpoint (OpenAI-compatible) or local (WebLLM/Ollama). Text only, never stored server-side | M | M |
| AI Inbox / Ask your inbox | Priority digest + natural-language Q&A over mail (paid) | Hybrid: our search (`Email/query` text) retrieves top N, LLM answers with citations to message ids. BYO model, off by default | L | M |
| Package / purchase / travel cards | Order tracking, flight cards, "Purchases" view | Parse schema.org JSON-LD (`ParcelDelivery`, `FlightReservation`, `Order`) from HTML body in the client; virtual "Purchases" / "Trips" views via `Email/query` + keyword `$purchase` set at ingest | M | M |
| Emoji reactions | React to a message; shows under it (Workspace default on 2026) | **RFC 9078** (Content-Disposition: reaction) — open standard; send tiny MIME part, render reactions grouped under the reacted message by `In-Reply-To` | S | M |
| Translate message | Detect language, translate inline | Browser `Translator`/`LanguageDetector` APIs (Chrome built-in AI) first, BYO-LLM fallback | S | M |
| Quick filter chips under search | `From`, `Any time`, `Has attachment`, `Is unread`, `To` chips | UI over existing `search.ts` operators; chips edit the query string | S | M |
| More search operators | `larger:`, `filename:`, `label:`, `is:starred`, `has:drive`, `around`, `{a b}` OR, `older_than:`, `list:` | `Email/query` supports `minSize`, `attachmentName`? (Stalwart: `header` filter, `text`); `older_than` = `before`; OR = `FilterOperator` | S | M |
| Search suggestions / typeahead | Contacts + recent queries + subject matches while typing | Contacts + `Email/query` with limit 5 debounced | S | M |
| Reading pane options / density | Right/below/none; compact/comfortable/default | CSS + setting | S | L |
| Multiple inboxes / sections | Up to 5 query-defined sections beside inbox | Reuse saved searches as stacked sections | S | L |
| Promotions/Social/Forums tabs | 5 tabs, ML-sorted | Extend existing `$updates` Sieve: `List-Id`, `Precedence: bulk`, known social domains → `$social`, `$promotions` | S | M |
| Sender verification / BIMI logos | Blue check, brand logos, "be careful" banners | Read `Authentication-Results` (DKIM/DMARC) header; BIMI via `BIMI-Location`/DNS TXT fetched server-side; warn on DMARC fail + lookalike domains | M | H |
| Gmail Offline | Read, search, compose offline | IndexedDB cache (encrypted with session key, see store.ts note), `Email/changes` + `Thread/changes` delta sync, outbox queue in SW | L | H |
| Dynamic email (AMP) | Interactive forms in mail | **Skip**: tiny sender adoption, security cost. Note only | — | L |

### Writing

| Feature | What Gmail does | How on JMAP/Stalwart | Eff | Val |
|---|---|---|---|---|
| Bcc | Blind copy | See §0 | S | H |
| Send-as / aliases (identity picker) | Choose From address per message | `Identity/get` already typed in jmap.ts; add From dropdown → `EmailSubmission.identityId`; aliases via Stalwart admin API | S | H |
| Smart Compose (inline autocomplete) | Ghost-text sentence completion | Local small model or BYO endpoint; debounce, Tab to accept; off by default | M | M |
| Smart Reply / suggested replies | 3 one-tap replies | Same LLM path, prompt with last message | S | M |
| Help me write / Proofread / refine | Draft from prompt; formalize, shorten, elaborate, proofread | Compose sidebar calling BYO model; Proofread could use LanguageTool (self-hostable, open source) without any LLM | M | M |
| Confidential mode | Expiry, no forward/print, SMS passcode | Real version: send a link to a self-hosted encrypted page (age/OpenPGP), expiring blob; honest about screenshot limits | M | M |
| Large attachments via link | Auto Drive link >25 MB | Upload to blob store (RFC 9404 `Blob/upload`) + expiring download link served by our gateway; or Nextcloud/WebDAV share | M | H |
| Insert emoji, tables, text colour, font size, image resize | Rich toolbar | Editor extensions; consider migrating contentEditable to Tiptap/ProseMirror only if needed | M | L |
| Undo after archive/delete everywhere + "Unsend" visible | Toasts with Undo | Toast undo exists for some actions; extend to all bulk actions | S | M |
| Pop-out / multiple compose windows | Several drafts side by side, pop-out | Compose state array; `window.open` for pop-out | M | L |
| Recipient chips: groups / lists | Expand contact groups | JMAP Contacts `kind: group` (RFC 9610) → expand in RecipientInput | S | M |
| Calendar "Help me schedule" / propose times | Insert free slots from calendar into mail | Read CalendarEvent free/busy from our calendar.ts, insert slot list; replies create events | M | M |
| Add to calendar from email | Detects dates/events | Parse dates in body (chrono-node) → prefilled event | S | M |

### Organising, automation, Workspace

| Feature | What Gmail does | How on JMAP/Stalwart | Eff | Val |
|---|---|---|---|---|
| L1 Label colours & nesting | Coloured, nested labels | `Mailbox.parentId`; colour in a JMAP-stored prefs object (or Stalwart `color` ext if present) | S | M |
| Filter import/export | XML export | Export/import raw Sieve script (`SieveScript/get`, RFC 9661) — trivially better: portable standard | S | L |
| Delegation | Give someone access to read/send as you | JMAP Sharing (RFC 9670) `shareWith` on mailboxes + Stalwart ACLs; client account switcher | L | M |
| Collaborative inbox / Groups | Shared mailbox, assign, mark complete | Stalwart groups + shared mailboxes; assignment = keyword `$assigned:<user>` | L | M |
| Multiple accounts | Switch accounts | Multiple OAuth sessions in memory; JMAP `accounts` already multi-account in session object | M | H |
| Mail merge / multi-send | Personalised bulk send to a list (Workspace) | CSV/contacts → one EmailSubmission each, with rate limit | M | L |
| Chat / Meet adjacency | Chat, Meet, Spaces in sidebar | **Skip**; link out to Jitsi/Matrix if anything | — | L |
| Tasks from email | "Add to Tasks" | CalDAV VTODO (Stalwart supports) → JMAP Tasks draft; small Tasks pane | M | M |
| Admin: DLP, Vault/retention, eDiscovery, CSE | Workspace compliance | Stalwart has retention/ACLs; our admin UI later. Out of scope for consumer | L | L |
| Data export (Takeout) | Download all mail | mbox/EML zip via `Blob/get` streaming; already doable via IMAP, but one button matters | S | M |
| Import from Gmail | Built-in mailfetch / migration | imapsync-backed wizard (Phase 3) + Gmail OAuth | M | H |
| Native mobile apps | Android/iOS | PWA first; Web Push makes PWA viable | L | M |

## 2. Top-15 build order (value ÷ effort)

| # | Item | Eff | Val | Why now |
|---|---|---|---|---|
| 1 | Bcc | S | H | Basic; its absence is a deal-breaker |
| 2 | Pagination / infinite scroll beyond 50 | S | H | Users cannot reach older mail except by search |
| 3 | Desktop notifications (+ Web Push for closed tab) | S→M | H | Push already wired; PWA without it feels dead |
| 4 | Send-as / identity picker | S | H | Identity/get already in jmap.ts |
| 5 | Nudges (reply / follow-up) | S | H | Pure client query, very visible Gmail feature |
| 6 | Follow-up reminders ("remind me if no reply") | S | H | Reuses snooze path; Gmail doesn't do this explicitly |
| 7 | Label chips in list + label colours + nested folders | S | M | Labels feel invisible today |
| 8 | Attachment preview (images, PDF) | S | M | Long-open Phase 2 item |
| 9 | Mute conversation | S | M | Expected by Gmail users; keyword + list rule |
| 10 | Search chips + more operators + typeahead | S | M | Cheap, makes search feel Gmail-grade |
| 11 | Missing shortcuts (`g i`, `[` `]`, `z`, `m`, `l`, `v`) + drag-to-folder | S | M | Power users switch for keys |
| 12 | Sender verification banners (DMARC fail, lookalike) | M | H | Security + a visible trust win |
| 13 | Large attachments as expiring links | M | H | Every Gmail user hits 25 MB |
| 14 | Priority Inbox / important (local scoring) | M | H | Gmail's core triage idea, private version |
| 15 | Opt-in AI pack: summarise, smart reply, proofread (BYO / local model) | M | M | Closes the Gemini headline gap without data mining |

Next after 15: offline mode (L/H), multiple accounts (M/H), Gmail import wizard (M/H), purchases/travel cards,
emoji reactions (RFC 9078), translate, delegation/shared inboxes.

## 3. Better than Gmail (top 10)

| # | Idea | Who does it well | How on our stack | Eff |
|---|---|---|---|---|
| 1 | Masked aliases per sender, one-click disable, "who leaked my address" | Fastmail+1Password, Proton, SimpleLogin | Stalwart alias API; generate `random@domain` from compose / sign-up forms; Sieve tags mail by alias; view by alias | M |
| 2 | Screener: first-time senders wait in a queue until you approve | HEY | Sieve: sender not in contacts/allowlist → `Screener` mailbox; one-click Yes/No writes Sieve list (`extlists` RFC 6134) | S |
| 3 | E2E encryption that interoperates (OpenPGP + WKD + Autocrypt) | Proton, Thunderbird | OpenPGP.js; keys via WKD and Autocrypt headers; encrypted search index local. Gmail CSE is Workspace-only and closed | L |
| 4 | Tracking report: per-email "who tried to track you", pixel + link-param counts, weekly digest | HEY, Apple Mail | Already strip trackers; persist counts in a keyword/prefs blob; inbox badge + Privacy page | S |
| 5 | Split inbox + "Done" (inbox zero) workflow with keyboard-first triage | Superhuman, HEY Imbox/Feed/Paper Trail | Saved-search sections as tabs; `e` = Done; Feed view for newsletters (reader layout) using existing `$updates` | S |
| 6 | Local/BYO AI: summaries, ask-your-inbox, drafting run on-device or your own key; nothing leaves without consent | (nobody mainstream) | WebLLM / Chrome built-in AI / Ollama endpoint; prompts visible; off by default | M |
| 7 | Rules as readable, portable Sieve with a live "test against my last 100 mails" preview | Fastmail (partly) | Run rules client-side (rules.ts exists) over recent mail before saving; export/import `.sieve` | S |
| 8 | Instant everything: offline-first local store, <50 ms actions, works on a plane | Superhuman, Fastmail | IndexedDB + `Email/changes` sync + outbox; optimistic UI already partial | L |
| 9 | Bundles / newsletter digest: one daily email or page of all newsletters, read like a feed | Spark, HEY Feed, Inbox by Gmail (dead) | Sieve routes `$updates` to Feed; scheduled server job (or client) renders digest | M |
| 10 | Open everything: JMAP API + webhooks + MCP server so users script their mail and plug in agents | Fastmail (JMAP API) | Document JMAP access with scoped app passwords (exist); add an MCP server wrapping JMAP for read/search/draft (no send without confirm) | M |

Honourable mentions: send later "when they're likely awake" (recipient timezone from past replies), shared
links with expiry for any attachment, per-thread private notes (Spark; store as `$note` + hidden draft), reminders on
any message (`Remind me tomorrow`), read-later queue, PGP-signed "verified by key" badges, privacy-preserving
image proxy (Gmail's proxy still leaks open events; ours blocks by default and could proxy without that leak).

## Sources

- Gmail "Gemini era" (AI Inbox, AI Overviews/Ask your inbox, suggested replies, Proofread): https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/ (Jan 2026)
- Gemini summary cards: https://9to5google.com/2025/05/29/gmail-gemini-summary-cards
- Emoji reactions default-on for Workspace (Feb 2026), Manage Subscriptions: https://releasebot.io/updates/google/gmail
- RFCs: 8620/8621 JMAP core/mail, 9404 Blob, 9610 Contacts, 9661 Sieve-over-JMAP, 9670 Sharing, 9078 Reactions, 8058 one-click unsubscribe, 6134 Sieve extlists
