# OpenMail (working name)

An open-source email platform you can self-host or sign up for. The goal is everything people expect from Gmail and Zoho Mail, plus being faster, private by default, and owned by its users.

- **Mail engine:** [Stalwart](https://stalw.art), which provides SMTP, IMAP, JMAP, spam filtering, DKIM and CalDAV/CardDAV. We don't write a mail server.
- **Web client (this repo, `web/`):** a JMAP-native, local-first web app. It talks to Stalwart directly, so there's no backend of our own.
- **License:** AGPL-3.0

Status: **early scaffold.** You can sign in, browse folders, read mail (safely rendered) and mark mail as read. See [PLAN.md](PLAN.md) for the roadmap.

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
deploy/   docker-compose + dev bootstrap script (dev only, not production)
web/      React + TypeScript + Vite client
  src/jmap.ts      tiny JMAP client
  src/safeHtml.ts  hostile-HTML rendering (sandboxed iframe + CSP)
  src/App.tsx      UI
```

## Security model for displaying email

Email HTML is untrusted. Each message renders in a sandboxed `<iframe>` with no scripts and no same-origin access. A Content-Security-Policy blocks all network requests and blocks remote images (tracking pixels) until you click **Load images**. If you find a way around this, please report it privately rather than opening a public issue.

## Contributing

Pick an unchecked item in [PLAN.md](PLAN.md), open an issue saying you're on it, and send a PR. Keep changes small; prefer platform features over new dependencies.
