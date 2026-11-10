// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { buildSrcdoc, cleanLink } from './safeHtml';

it('strips tracking parameters but keeps the rest of the link', () => {
  expect(cleanLink('https://ex.org/p?utm_source=x&id=42&fbclid=abc&utm_medium=email#top')).toBe('https://ex.org/p?id=42#top');
  expect(cleanLink('mailto:a@b.c?subject=hi')).toBe('mailto:a@b.c?subject=hi');
  expect(cleanLink('not a url')).toBe('not a url');
});

const html = `<p>Hi</p><img src="https://t.example.net/o.gif" width="1" height="1">
  <img src="https://cdn.example.org/photo.jpg" width="600"><img src="//px.example.com/x" style="display: none">
  <a href="https://ex.org/?utm_campaign=z&q=1" ping="https://beacon.example/p">go</a><link rel="dns-prefetch" href="//leak.example"><link rel="stylesheet" href="https://css.example/a.css"><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil">`;

it('removes tracking pixels always, blocks other remote images until allowed', () => {
  const r = buildSrcdoc(html, false);
  expect(r.trackers.sort()).toEqual(['px.example.com', 't.example.net']);
  expect(r.blockedImages).toBe(1); // the real photo
  expect(r.srcdoc).not.toContain('o.gif');
  expect(r.srcdoc).toContain("img-src data:;");
  expect(r.srcdoc).toContain('href="https://ex.org/?q=1"');
  for (const bad of ['<script', 'http-equiv="refresh"', 'leak.example', 'css.example', 'beacon.example']) expect(r.srcdoc).not.toContain(bad);
  expect(r.srcdoc).toContain('x-dns-prefetch-control');

  const loaded = buildSrcdoc(html, true);
  expect(loaded.blockedImages).toBe(0);
  expect(loaded.srcdoc).toContain('photo.jpg');
  expect(loaded.srcdoc).not.toContain('o.gif'); // pixels stay gone even after "Load images"
});

it('resolves inline cid: images to data URLs', () => {
  const r = buildSrcdoc('<img src="cid:map@x"><img src="cid:missing">', false, { 'map@x': 'data:image/png;base64,AA==' });
  expect(r.srcdoc).toContain('src="data:image/png;base64,AA=="');
  expect(r.srcdoc).not.toContain('cid:missing');
});

it('keeps only web, mail and phone links', () => {
  const { srcdoc } = buildSrcdoc('<a href="javascript:alert(1)">https://bank.com</a><a href=" data:text/html,x">d</a><a href="mailto:a@b.c">m</a><a href="https://ok.example/">w</a>', false);
  expect(srcdoc).not.toMatch(/javascript:|data:text/);
  expect(srcdoc).toContain('href="mailto:a@b.c"');
  expect(srcdoc).toContain('href="https://ok.example/"');
});

it('cleans every link: <area>, SVG xlink:href, and no target or opener', () => {
  const { srcdoc } = buildSrcdoc('<map><area href="javascript:alert(1)"><area href="https://ok.example/?utm_source=x" target="_top"></map>'
    + '<svg><a xlink:href="javascript:alert(2)"><text>x</text></a><a href="data:text/html,x"><text>y</text></a></svg>'
    + '<a href="https://w.example/" target="foo" rel="opener">w</a>', false);
  expect(srcdoc).not.toMatch(/javascript:|data:text|utm_source|target="(foo|_top)"|opener"/);
  const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
  expect([...doc.querySelectorAll('area, a')].map((a) => [a.getAttribute('href') ?? a.getAttribute('xlink:href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
    [null, null, 'noopener noreferrer'], ['https://ok.example/', null, 'noopener noreferrer'], [null, null, 'noopener noreferrer'],
    [null, null, 'noopener noreferrer'], ['https://w.example/', null, 'noopener noreferrer']]);
  expect(srcdoc).toContain('<base target="_blank">'); // ours stays: links still open in a new tab
});

it('falls back to plain text if the result would re-parse into something we removed (mutation XSS)', () => {
  // happy-dom's parser doesn't reproduce the browser's <form><math><mtext></form><form><mglyph><style></math>… mutation,
  // so the re-parse is made to bring back a <meta refresh> the way a browser's would.
  const real = DOMParser.prototype.parseFromString;
  let calls = 0;
  const spy = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (this: DOMParser, s: string, type: DOMParserSupportedType) {
    return real.call(this, ++calls === 1 ? s : s + '<meta http-equiv="refresh" content="0;url=https://evil.example">', type);
  });
  try {
    const r = buildSrcdoc('<p>Hello <b>&lt;there&gt;</b></p><style>p{color:red}</style><img src="https://cdn.example/x.png">', false);
    expect(calls).toBe(2);
    expect(r.blockedImages).toBe(0);
    expect(r.srcdoc).not.toMatch(/evil|<p>|<b>|<img|color:red/);
    expect(r.srcdoc).toContain('Hello &lt;there&gt;</pre>');
    expect(r.srcdoc).toContain("default-src 'none'"); // same CSP
  } finally { spy.mockRestore(); }
  // Without a mutation the HTML is kept.
  expect(buildSrcdoc('<p>Hello</p>', false).srcdoc).toContain('<p>Hello</p>');
});
