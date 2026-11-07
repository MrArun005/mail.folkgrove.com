## What changed

## How I checked it
- [ ] `npx tsc --noEmit -p . && npm test && npm run build` in `web/`
- [ ] UI: screenshots at 1440px and 390px, light and dark (see web/DESIGN.md checklist)
- [ ] Untrusted input (message HTML, headers, pasted content) still goes through safeHtml / cleanHtml
