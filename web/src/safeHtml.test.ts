// @vitest-environment happy-dom
import { expect, it } from 'vitest';
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
