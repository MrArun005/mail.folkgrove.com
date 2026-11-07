# How Zoho Mail is built (and what we should take from it)

Researched 2026-11-08. Sources: Zoho docs/press, review sites, Zoho community forum, and our own DNS/banner checks
(marked **[observed]**). Anything not confirmed by a primary source is marked **[unverified]**.

## 1. Architecture

| Topic | Finding | Source |
|---|---|---|
| Mail server software | **Built in-house, not an off-the-shelf MTA/IMAP server.** The IMAP greeting is `Zoho Mail IMAP4rev1 Server version 1.0` (not Dovecot/Cyrus); SMTP greets `220 smtp.zohomail.com SMTP Server ready November 7, 2026 10:42:48 AM PST`, with a long-form date that looks like Java's `DateFormat` output. No Zoho engineering post describes the mail engine itself. | [observed] `openssl s_client imap.zoho.com:993`, `smtp.zoho.com:465`; claim of in-house SMTP/IMAP only in a promotional blog [unverified]: [codroiditlabs](https://codroiditlabs.com/is-zoho-mail-an-indian-product/) |
| Web front end | Web server header `server: ZGS` (Zoho's own gateway, presumably) | [observed] `curl -I https://mail.zoho.com` |
| Language | Java for applications, Linux for servers. Zoho's stack is company-wide, not specific to Mail; language for Mail itself is inferred, not stated. | [Saltmarch, "Zoho at 25"](https://saltmarch.com/insight/zoho-at-25-the-untold-secrets-of-a-software-saga) |
| Storage | A proprietary database used across Zoho apps (row store + columnar + in-memory + graph index), per a 2020 analyst summit; another source also mentions PostgreSQL. How mail blobs are stored is **not public**. | [Constellation Research 2020](https://www.constellationr.com/research/blog/zoho-analyst-summit-2020-what-full-tech-stack-really-means-customer-relationships), [Saltmarch](https://saltmarch.com/insight/zoho-at-25-the-untold-secrets-of-a-software-saga) |
| Data centres | Zoho owns and operates its infrastructure; "not on AWS, Azure, or GCP". 16 DCs (Zoho CRM docs); press says 18–20 in 2025–26. Each region has a primary + secondary DC pair for failover. | [Zoho CRM architecture](https://help.zoho.com/portal/en/kb/crm/getting-started/articles/zoho-crm-saas-architecture-and-deployment-options), [datacenternews](https://datacenternews.asia/story/zoho-launches-nathu-la-server-to-deepen-hardware-push) |
| Own hardware | June 2026: "Nathu La", an in-house designed server (Intel Xeon 6, OCP-style), a few hundred deployed, target ~2,000 by end of 2026; OEM servers stay alongside. | [BusinessWire](https://www.businesswire.com/news/home/20260609950105/en/), [Inc42](https://inc42.com/buzz/zoho-launches-in-house-server-nathu-la-to-lower-ai-inference-costs/) |
| IP space | Zoho owns its address block (ARIN `ZOHOC`, 136.143.172.0–136.143.191.255); `spf.zoho.com` lists ~50 ranges, **plus two AWS IPs** (52.6.74.205, 34.241.242.183), so "no public cloud" is not absolute for every sending path (purpose unknown). | [observed] `whois`, `dig TXT spf.zoho.com` |
| Regions (account DCs) | US (zoho.com), EU (zoho.eu), IN (zoho.in), AU (zoho.com.au), JP (zoho.jp), CA (zohocloud.ca), SA (zoho.sa); China also listed; UAE DCs opened 2026. Region is fixed by the domain you sign up on. | [Zoho Accounts DCs](https://help.zoho.com/portal/en/kb/accounts/manage-your-zoho-account/articles/data-center-for-zoho-account), [Mail GDPR page](https://www.zoho.com/mail/help/zoho-mail-gdpr-compliance.html), [Khaleej Times](https://www.khaleejtimes.com/business/tech/zoho-corporation-opens-its-first-data-centres-in-uae) |
| Multi-tenancy | Shared hardware and code; every query filtered by org ID. | [Zoho CRM architecture](https://help.zoho.com/portal/en/kb/crm/getting-started/articles/zoho-crm-saas-architecture-and-deployment-options) |
| Scale | Zoho Corp: >1M paying orgs, >150M users (Feb 2026, all products). Zoho Mail alone: "15 million users" (2020 blog). No newer Mail-only figure; ~10M (third party) is **[unverified]**. | [BusinessWire Feb 2026](https://www.businesswire.com/news/home/20260218799668/en), [Zoho Mail blog 2020](https://blog.zoho.com/mail/heres-to-11-years-of-zoho-mail-and-our-growing-user-base.html) |

**Takeaway:** Zoho is "own everything" (DCs, IPs, servers, MTA, DB, now an LLM). We get the same independence from
Stalwart + self-hosting without building it; the lesson is about owning **IP reputation** and **regional data residency**, not writing an MTA.

## 2. Deliverability and abuse

### DNS they publish [observed, `dig`, 2026-11-08]

| Domain | MX | SPF | DMARC |
|---|---|---|---|
| zoho.com | smtpin/smtpin2/smtpin3.zoho.com | `include:spf.zoho.com include:zcsend.net include:spf.zohomail.com include:popspf.zohomail.com -all` | `p=reject; sp=reject` + rua/ruf |
| zohomail.com (free personal) | same | `include:spf.zohomail.com -all` (8 ranges, separate from corporate) | `p=reject; sp=reject` |
| zoho.eu / zoho.in | mx.zoho.eu… / smtpin.zoho.in… | per-region SPF (`spf.zoho.eu` uses `~all`, the rest `-all`) | `p=reject` |

- `_smtp._tls.zohomail.com` → `v=TLSRPTv1;rua=mailto:tls-reports@zohomail.com` (TLS-RPT published). No `_mta-sts` record seen. [observed]
- **Separate sending pools per product and region:** Zoho Mail (`spf.zohomail.com`), Campaigns/marketing (`zcsend.net`), transactional ZeptoMail (`zeptomail.net`), plus a dedicated IP for POP-fetch forwarding (`popspf.zohomail.com`). [observed]; the usage policy routes bulk/transactional mail to those products: [usage policy](https://www.zoho.com/mail/help/usage-policy.html)

### Limits and abuse handling

| Control | Zoho's rule | Source |
|---|---|---|
| External sending rate | **50–500 emails/hour, dynamic by sender reputation**; internal 1,000/h; lock out up to 1 h when hit | [Limits page](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html) |
| Recipients/message | 100 free, 150 paid (to+cc+bcc), 500 internal | same |
| Daily caps | "No fixed daily limits"; reputation = quality, frequency, engagement, bounces, complaints. **Paying does not guarantee higher limits.** | [usage policy](https://www.zoho.com/mail/help/usage-policy.html) |
| Auto-block triggers | many bounces; many sends in short time; many recipients; unusual daily volume; spam; suspicious logins from several locations | same |
| Unblock | Self-service "UnblockMe" page; auto-lift in hours; org admin can unblock (except suspicious-login blocks); personal accounts must change password first | same |
| Forwarding | 1 forward for personal, 3 paid; 30 filter-based forwards | [Limits page](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html) |
| Incoming | 100 msgs/min; 40 MB max; over limit → delivery suspended ~24 h | same |
| Sign-up | Mobile number + 7-digit SMS code required; unverified accounts can't sign in. One number per account is **[unverified]**. | [Zoho how-to](https://www.zoho.com/mail/how-to/create-an-email-account.html), [Zoho KB](https://help.zoho.com/portal/kb/articles/i-couldn-t-complete-my-mobile-verification-process-for-my-account-how-do-i-verify-it-now) |
| Inactivity | Blocked after 180 days idle; personal data deleted at 300 days | [usage policy](https://www.zoho.com/mail/help/usage-policy.html) |
| Storage full | Alert at 75%; account locked 48 h after 100% | same |
| Banned use | Bulk, marketing, newsletters, **automated/transactional** mail | same |
| Error codes users see | `550 5.4.6 Unusual sending activity detected`, `554 5.1.8 Email Outgoing Blocked` | [community](https://help.zoho.com/portal/es/community/topic/getting-my-mail-sending-ability-blocked-multiple-times?page=19) |

## 3. Product architecture

| Area | What Zoho has | Source |
|---|---|---|
| Shared platform | Calendar, Contacts, ToDo, Notes, Bookmarks built in; WorkDrive, Cliq, CRM, Projects integrations; Zapier | [features](https://www.zoho.com/mail/features.html) |
| Streams | Social-style comments, tasks, notes on emails/folders shared with a team; separate Streams mobile app. **Not supported on shared mailboxes.** | [features](https://www.zoho.com/mail/features.html), [shared mailbox admin](https://zstatic.zohostatic.com/mail/help/adminconsole/collaborative-inbox-settings.html) |
| Shared mailboxes / delegation | Shared mailboxes (20/org, 40 GB); admin or user delegation with per-permission grants; groups with moderation (30/org) | [shared mailbox](https://www.zoho.com/mail/help/collaborative-inbox.html), [delegation](https://zstatic.zohostatic.com/mail/help/adminconsole/mailbox-delegation-admin-settings.html), [limits](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html) |
| Zia AI | Compose from prompt, autocomplete, summarize, auto-reply suggestions; paid org users only; **summarize unavailable in the US DC**; content may go to third-party LLMs (OpenAI; BYOK for GPT/Gemini/Claude). July 2025: own "Zia LLM" (1.3B/2.6B/7B) on Zoho DCs. | [Zia for Mail admin](https://zstatic.zohostatic.com/mail/help/adminconsole/zia-for-mail.html), [Workplace AI](https://www.zoho.com/workplace/ai.html), [Zia LLM release](https://www.businesswire.com/news/home/20250717118204/en/) |
| Protocols | IMAP/POP/SMTP (paid only), Exchange ActiveSync (not Outlook for Mac/Apple Mail), CalDAV/CardDAV (org address book **not** on CardDAV, no VTODO). **EWS: no evidence** [unverified]. | [ActiveSync](https://prezohoweb.zoho.com/mail/help/zoho-mail-active-sync.html), [DAVx5](https://davx5.com/tested-with/zoho) |
| Mobile | Zoho Mail, Zoho Mail Admin, Streams apps (iOS/Android) | [features](https://www.zoho.com/mail/features.html) |
| Offline | Browser offline mode (Chrome/Firefox/Opera; PWA): read, draft, reply to drafts only; tab must stay open; per browser | [offline help](https://cdn.zoho.com/mail/help/zohomail-offline.html), [PWA](https://zstatic.zohostatic.com/mail/help/progressive-web-application.html) |
| Encryption | At rest AES-256 all plans, keys rotated every 6 months, BYOK via Zoho Directory; TLS 1.2/1.3 + forced TLS; S/MIME (Premium/Professional); **OpenPGP E2E on all paid plans**; per-message "encryption level" indicator | [email encryption](https://www.zoho.com/mail/security/email-encryption.html) |
| eDiscovery / retention | Retention policies (longest wins), investigations, litigation holds, legal-staff role; Mail Premium + Workplace Professional only; exports ≤450 MB, 90-day expiry; message trace 6 months | [eDiscovery setup](https://www.zoho.com/mail/help/adminconsole/ediscovery-setup.html), [holds](https://www.zoho.com/mail/help/adminconsole/email-investigations.html) |
| Admin console | Users, groups, aliases (30/mailbox), policies, 2FA enforcement, audit logs, blocked accounts, bulk import (1,000), migration | [features](https://www.zoho.com/mail/features.html), [limits](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html) |
| Migration | Admin-console "Data Migration": one-click (API) from Google Workspace and Microsoft 365 incl. calendars/contacts; Exchange via EWS; generic IMAP/POP (mail only); 50 concurrent, 1,000 users/batch; EML import 500 MB | [migration](https://www.zoho.com/mail/help/migration.html), [Workplace migration](https://www.zoho.com/workplace/help/admin-guide/migrate-to-zoho-workplace.html), [Exchange](https://zoho.com/mail/help/adminconsole/exchange-migration.html) |
| API | 30 requests/min | [limits](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html) |

## 4. Pricing and limits (2026)

| Plan | Price (user/mo, annual) | Mail storage | Attachment / large-file link | Notes |
|---|---|---|---|---|
| Forever Free | $0, up to 5 users, 1 domain | 5 GB | 25 MB | **No IMAP/POP/ActiveSync**; web + mobile apps only; "select data centres only" |
| Mail Lite | $1 (5 GB) / $1.25 (10 GB) | 5 or 10 GB | 30 MB / 250 MB | annual only |
| Mail Premium | $4 | 50 GB + 50 GB retention | 40 MB / 1 GB | S/MIME, eDiscovery |
| Workplace Standard | $3–4 (sources disagree) | 30 GB | 30 MB / 500 MB | + WorkDrive, Cliq, Office |
| Workplace Professional | $6–7 (sources disagree) | 100 GB + 100 GB retention | 40 MB / 1 GB | S/MIME, eDiscovery |

Sources: [pricing page](https://www.zoho.com/mail/pricing), [pricing PDF](https://www.zoho.com/mail/images/mail-pricing-usd.pdf) (prices not machine-readable there),
dollar figures from [Capterra](https://www.capterra.com/p/233604/Zoho-Workplace/pricing/) and [aiproductivity.ai](https://aiproductivity.ai/pricing/zoho-mail/) **[third-party]**.
All plans ad-free: [Zoho how-to](https://www.zoho.com/mail/how-to/create-an-email-account.html). Free tier was 25 users before Aug 2018 and lost IMAP/POP later
([community](https://help.zoho.com/portal/fr/community/topic/no-more-imap-pop-smtp-on-free-plans-even-on-referrals-with-no-notice?page=3)).

## 5. Weak spots (where we can be clearly better)

| Complaint | Evidence | Our angle |
|---|---|---|
| Spam filter misfiles both ways | Capterra summary: "spam filtering is unreliable"; GetApp: "not as effective as Gmail's" | Sieve + per-user learning visible to the user; Screener; show *why* a message was junked |
| Mail lands in Outlook/O365 junk; IP ranges on SpamCop | [community](https://help.zoho.com/portal/en-gb/community/zoho-mail?page=218), [Zoho problems thread](https://help.zoho.com/portal/fr/community/topic/zoho-mail-problems?page=46) | Publish our placement results (PLAN Phase 1) |
| Opaque outgoing blocks, slow unblock | `554 5.1.8` threads, "blocked for almost a week" ([thread](https://help.zoho.com/portal/en/community/topic/outgoing-blocked-for-almost-a-week-%E2%80%93-ticket-2472334-%E2%80%93-no-response-yet?page=1)) | Show the user their current limit, usage, and the exact reason before and after a block |
| Support slow / hard to reach | [Capterra](https://www.capterra.com/p/174694/Zoho-Mail/reviews?page=5), [GetApp](https://www.getapp.com/it-communications-software/a/zoho-mail/reviews/) | Public docs + self-host; status page |
| Free plan: no IMAP/POP, removed without notice | [community](https://help.zoho.com/portal/fr/community/topic/no-more-imap-pop-smtp-on-free-plans-even-on-referrals-with-no-notice?page=3) | Open protocols on every tier (already ✅) |
| Offline is weak (tab must stay open, read/draft only) | [offline help](https://cdn.zoho.com/mail/help/zohomail-offline.html) | Real offline-first sync (Phase 2.5) |
| AI sends mail content to third parties; not in US DC | [Zia admin](https://zstatic.zohostatic.com/mail/help/adminconsole/zia-for-mail.html) | Our AI is on-device (already ✅) |
| DNS setup hard for beginners | [GetApp](https://www.getapp.com/it-communications-software/a/zoho-mail/reviews/) | `install.sh` prints records, `check-dns.sh` verifies (already ✅) |
| CardDAV lacks org address book; no ActiveSync for Mac | [DAVx5](https://davx5.com/tested-with/zoho), [ActiveSync](https://prezohoweb.zoho.com/mail/help/zoho-mail-active-sync.html) | Stalwart exposes shared address books over CardDAV |

Ratings for context: Capterra ~4.5/5 over ~1,060 reviews ([Capterra](https://capterra.com/p/174694/Zoho-Mail/)). Reddit not searched directly (no hits); complaints above come from review sites and Zoho's forum.

## 6. What OpenMail should take

| # | Take this | Maps to our gap | Concrete step |
|---|---|---|---|
| 1 | **Reputation-based, per-hour sending limits** (50→500/h) with a 1-hour cool-down, not just a daily counter | PLAN "new-account sending tiers" (scale.md §10.2) | Add an hourly window to the existing per-account recipient counter; tier rises with age + low bounce/complaint rate; paying does not skip it |
| 2 | **Lower recipient cap for free accounts** (Zoho: 100 free / 150 paid; we allow 500) | Sending limits decision in PLAN | 100 for new/free accounts, 500 only after the account earns it |
| 3 | **Auto-block triggers** = bounces, burst volume, many recipients, logins from many places; block outbound only, keep read access | Phase 4 abuse controls | Implement as Stalwart throttles + account-service job; say which trigger fired |
| 4 | **Self-service unblock** (with password change if the trigger was suspicious login) | none yet | "Unblock me" in Settings → Security after the cool-down; repeat offences go to review |
| 5 | **Forwarding cap: 1 for free accounts** | PLAN already says one confirmed forwarding address | Keep it; also count Sieve `redirect` |
| 6 | **Phone or equivalent verification at sign-up** | PLAN "email verification step" | Keep invites + Turnstile; add one-time verification (email or SMS) before outbound is enabled |
| 7 | **Inactivity policy** (block at 180 days, delete free data at ~300 with reminders) | Terms (Phase 4) | Write it into the terms; never recycle the address (our rule stands) |
| 8 | **Separate sending identities per purpose** and ban bulk/transactional mail from user mailboxes | Phase 1 relay setup | Policy text in terms; separate IP/relay for system mail (sign-up, resets) so user abuse can't hurt it |
| 9 | **`p=reject` DMARC + TLS-RPT** on our own domains from launch | Phase 1 DNS | Ramp p=none → reject as planned, but publish TLS-RPT immediately (Zoho publishes TLS-RPT but no MTA-STS record was seen for zohomail.com; we should publish both) |
| 10 | **Admin console basics**: users, groups, aliases, policies, 2FA enforcement, audit log, blocked-accounts list, message trace | PARITY §6 admin console (🟡) | Build "blocked accounts + why" and "message trace" first: highest support value |
| 11 | **Shared mailboxes + delegation with per-permission grants** | PARITY §5 (⬜) | Stalwart groups + JMAP sharing; make team comments work on shared mailboxes (Zoho's Streams can't) |
| 12 | **One-click migration from Google/M365 incl. calendar + contacts** | We import .mbox/.eml only | Add server-side IMAP pull + CalDAV/CardDAV import |
| 13 | **eDiscovery / retention / holds** as a business-tier feature | PARITY §6 (⬜) | Later; Stalwart retention + hold flag is enough to start |
| 14 | **Separate admin mobile app** | Native mobile (⬜) | Skip; make the admin console work at phone width instead |
| 15 | **Encryption-level indicator per message** (TLS / plain) | PARITY §4 | Cheap: show received-over-TLS from `Received` headers in the reader |
