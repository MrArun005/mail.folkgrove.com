#!/usr/bin/env node
// Turns the legal drafts here into plain pages the web server serves at /legal/<name>.html (web/public/legal/).
// Run after editing a draft: node docs/legal/build.mjs
// ponytail: knows only the Markdown these files use (headings, paragraphs, lists, tables, bold, links, code).
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const here = new URL('./', import.meta.url), out = new URL('../../web/public/legal/', import.meta.url);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u.replace(/\.md$/, '.html')}">${t}</a>`);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

export function toHtml(md) {
  const html = [], lines = md.split('\n');
  let title = 'OpenMail';
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) { if (h[1] === '#') title = h[2]; html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    const take = (re) => { const block = []; while (i < lines.length && re.test(lines[i])) block.push(lines[i++]); return block; };
    if (/^\|/.test(l)) {
      const [head, , ...rows] = take(/^\|/);
      html.push(`<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^(- |\d+\. )/.test(l)) {
      const tag = /^- /.test(l) ? 'ul' : 'ol';
      html.push(`<${tag}>${take(/^(- |\d+\. )/).map((x) => `<li>${inline(x.replace(/^(- |\d+\. )/, ''))}</li>`).join('')}</${tag}>`);
    } else html.push(`<p>${inline(take(/^(?!#|\||- |\d+\. )\S/).join(' '))}</p>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)} · OpenMail</title>
<style>
:root { --ink: #1b1d22; --ink-2: #5a5f6b; --line: #dfe2e8; --bg: #fff; --accent: #2340c4; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6e7ea; --ink-2: #a3a8b3; --line: #353943; --bg: #17191d; --accent: #9db0ff; } }
body { margin: 0; padding: 24px 32px; background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, sans-serif; }
@media (max-width: 600px) { body { padding: 16px; } }
h1 { font-size: 28px; margin: 0 0 16px; } h2 { font-size: 20px; margin: 32px 0 8px; } h1, h2, h3 { font-style: normal; }
a { color: var(--accent); } code { font-family: ui-monospace, monospace; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--ink-2); font-weight: 600; } nav { margin-bottom: 24px; color: var(--ink-2); }
</style></head><body>
<nav><a href="/">OpenMail</a> · <a href="terms-of-service.html">Terms</a> · <a href="privacy-policy.html">Privacy</a> · <a href="acceptable-use.html">Acceptable use</a> · <a href="law-enforcement.html">Law enforcement</a> · <a href="inactive-accounts.html">Inactive accounts</a></nav>
<main>
${html.join('\n')}
</main></body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(here).filter((f) => f.endsWith('.md'))) {
    writeFileSync(new URL(f.replace(/\.md$/, '.html'), out), toHtml(readFileSync(new URL(f, here), 'utf8')));
    console.log(`web/public/legal/${f.replace(/\.md$/, '.html')}`);
  }
}
