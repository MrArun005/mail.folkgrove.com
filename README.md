# OpenMail (working name)

An open-source email platform you can self-host or sign up for. The goal is everything people expect from Gmail and Zoho Mail, plus being faster, private by default, and owned by its users.

- **Mail engine:** [Stalwart](https://stalw.art), which provides SMTP, IMAP, JMAP, spam filtering, DKIM and CalDAV/CardDAV. We don't write a mail server.
- **Web client (this repo, `web/`):** a JMAP-native web app. It talks to Stalwart directly. The only service of our own is a small account service (`signup/`) for the few admin-only actions: masked addresses and, on a hosted instance, sign-up.
- **License:** AGPL-3.0

Status: **pre-release.** Mail, calendar, contacts, filters, the Screener, masked addresses, import from Gmail and self-hosting work; delivery from a real server is not proven yet (PLAN.md, Phase 1). Feature status: [PARITY.md](PARITY.md). Plan and decisions: [PLAN.md](PLAN.md).

## Run it locally (about 2 minutes)

Requires Docker and Node 20+.

```sh
node deploy/dev-setup.mjs        # starts Stalwart, bootstraps it, creates alice, seeds her inbox
cd web && npm install && npm run dev
```

Open http://localhost:5173 and sign in as `alice@openmail.test` / `alice-dev-pass`.

- Start over: `node deploy/dev-setup.mjs --reset`
- Stalwart admin UI: http://localhost:8080/admin. The credentials are in `deploy/.dev-admin.json`.
- Tests: `cd web && npm test`. These are integration tests against the local server; they skip if it isn't running.

## Layout

```
web/                 React + TypeScript + Vite client (design rules: web/DESIGN.md)
  src/jmap.ts        JMAP client: mail, submission, push, Sieve filters
  src/safeHtml.ts    hostile-HTML rendering (sandboxed iframe + CSP, tracker removal)
  src/Mail.tsx       the mailbox screen
deploy/              local dev mail server (docker-compose + dev-setup.mjs)
deploy/production/   self-hosting kit: install.sh, check-dns.sh, backup.sh, Caddy
signup/              public sign-up API for a hosted instance
docs/                self-hosting guide
PLAN.md, PARITY.md   roadmap; feature-by-feature plan to beat Zoho Mail and Gmail
```

## Security model for displaying email

Email HTML is untrusted. Each message renders in a sandboxed `<iframe>` with no scripts and no same-origin access. A Content-Security-Policy blocks all network requests and blocks remote images (tracking pixels) until you click **Load images**. If you find a way around this, please report it privately rather than opening a public issue.

## Data rights and legal drafts

Settings → **Export your data** downloads everything (mail as .mbox, contacts .vcf, calendar .ics, settings .json); Settings → **Delete your account** erases it, and the address is retired, never reused. Drafts of the terms of service, privacy policy, acceptable use policy, law enforcement guidelines and inactive-account policy are in [docs/legal/](docs/legal/) (served at `/legal/*.html`; rebuild with `node docs/legal/build.mjs`). **They are drafts: have a lawyer review them before public launch.**

## Contributing

Pick a ⬜ or 🟡 row in [PARITY.md](PARITY.md), open an issue saying you're on it, and send a PR. Keep changes small; prefer platform features over new dependencies.

## Self-hosting

To run your own mail server with this webmail on a fresh Ubuntu 24.04 VPS with a domain:

```sh
git clone <this repo> && cd openmail/deploy/production
sudo ./install.sh
```

It sets up Stalwart with Caddy for HTTPS, creates your first mailbox, and prints the exact DNS records to add. `./check-dns.sh` then verifies them, and `./backup.sh` makes encrypted backups. Many clouds block outgoing port 25; the installer can send through a relay such as Brevo or SMTP2GO instead. Read [docs/self-hosting.md](docs/self-hosting.md) first: it covers requirements (port 25, reverse DNS), testing with mail-tester.com, upgrades, restore and troubleshooting.
