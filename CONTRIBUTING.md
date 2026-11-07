# Contributing

Thanks for helping build a private, open email service. This guide gets you from clone to pull request.

## Run it

Requires Docker and Node 20+.

```sh
node deploy/dev-setup.mjs          # local mail server with a seeded test mailbox
cd web && npm install && npm run dev
```

Sign in at http://localhost:5173 as `alice@openmail.test` / `alice-dev-pass`.

## Pick something to do

- Unchecked items in [PLAN.md](PLAN.md) and the "⬜" rows in [PARITY.md](PARITY.md) are the roadmap.
- Comment on (or open) an issue saying you're taking it, so two people don't build the same thing.

## Rules of the road

- **Design:** read [web/DESIGN.md](web/DESIGN.md). Use `<Button>`, tokens from `styles.css`, and check your change
  at 1440px and 390px wide, in light and dark.
- **Small and boring:** prefer browser features and the existing helpers over new dependencies.
  Any new dependency needs a sentence in the PR on why a few lines of code wouldn't do.
- **Tests:** logic gets a unit test; anything that talks to the server gets an integration test in
  `web/src/jmap.test.ts` (it runs against the local Stalwart). `npm test` must pass.
- **Untrusted input:** message HTML, headers and attachments come from strangers. Never put them into the page
  without going through `safeHtml.ts` (reading) or `cleanHtml` (editing). If in doubt, ask in the PR.
- **Plain language:** buttons say what they do; errors say what went wrong and how to fix it.

## Pull requests

1. Branch from `main`, keep the PR focused on one change.
2. `cd web && npx tsc --noEmit -p . && npm test && npm run build` passes.
3. Describe what changed and how you checked it (screenshots for UI).

By contributing you agree your work is licensed under the AGPL-3.0, like the rest of the project.
Be kind: we follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
