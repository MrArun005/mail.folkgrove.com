# Security policy

Email clients are a favourite target. Thank you for helping keep users safe.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub's
"Report a vulnerability" button (Security tab → Advisories), or email the maintainers at the address in the
repository profile. Include steps to reproduce and, if you can, a sample message.

We aim to acknowledge reports within 3 days and to ship a fix for confirmed high-severity issues within 14 days.
We'll credit you in the release notes unless you prefer otherwise.

## What we especially want to hear about

- Ways for a received email to run script, read app data, make network requests, or detect that it was opened
  (see `web/src/safeHtml.ts` and its tests for the current defences).
- Ways for pasted or quoted content to run inside the compose editor (`cleanHtml` in `web/src/mailutil.ts`).
- Header-driven actions doing something the user didn't intend (for example `List-Unsubscribe`).
- Sign-up abuse paths in `signup/` (rate limits, invites, reserved names).

## Known limitations (not vulnerabilities)

- Sign-in uses OAuth (authorization code + PKCE). The rotating refresh token is kept in `sessionStorage` for the
  life of the tab and revoked at sign-out; a backend-held httpOnly cookie would shorten exposure further.
- "Sign in with a password instead" (for servers without the OAuth client registered) uses HTTP Basic and keeps
  the password in memory only.
- Snoozed mail wakes only while a client is open.
