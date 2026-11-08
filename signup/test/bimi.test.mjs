// BIMI logos: the SVG clean-up, the address check and the route (DNS and the fetch are stand-ins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib.mjs';
import { bimiRoutes, privateAddress, sanitizeSvg } from '../bimi.mjs';

test('SVG: shapes stay; scripts, handlers, external references and other markup go', () => {
  const svg = sanitizeSvg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10" onload="alert(1)">
    <title>Acme &amp; Co &x;</title><script>alert(1)</script><style>@import url(https://t.example/a.css)</style>
    <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
    <rect width="10" height="10" fill="url(#g)"/><path d="M0 0h5" fill="url(https://t.example/p)" style="fill:red"/>
    <use href="#g"/><use xlink:href="https://t.example/x.svg#a"/><a href="javascript:alert(1)"><circle r="1"/></a>
    <image href="https://t.example/i.png"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><svg><path d="evil"/></svg></div></foreignObject>
    <path d="M1 1" href="&#106;avascript:alert(1)"/></svg>`);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10">'), svg);
  assert.match(svg, /<title>Acme &amp; Co &amp;x;<\/title>/); // no entity expansion
  assert.match(svg, /<rect width="10" height="10" fill="url\(#g\)"\/>/);
  assert.match(svg, /<path d="M0 0h5" style="fill:red"\/>/); // the external fill is dropped, the rest kept
  assert.match(svg, /<use href="#g"\/><use\/>/);
  for (const bad of ['script', 'alert', 'onload', 'import', 't.example', 'image', 'foreignObject', 'evil', '<a', 'javascript']) assert.ok(!svg.includes(bad), `${bad} in ${svg}`);
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(sanitizeSvg('<html><body>not svg</body></html>'), null);
  assert.equal(sanitizeSvg('<svg><g><path d="M0 0"></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"></path></g></svg>'); // closes what it opened
});

test('only public addresses are fetched', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) assert.equal(privateAddress(ip), false, ip);
});

test('route: logo only with a quarantine/reject DMARC policy; cached; rate limited', async () => {
  const dns = {
    '_dmarc.brand.example': [['v=DMARC1; p=reject; rua=mailto:d@brand.example']],
    'default._bimi.brand.example': [['v=BIMI1; l=https://cdn.brand.example/logo.svg; a=']],
    '_dmarc.loose.example': [['v=DMARC1; p=none']],
    'default._bimi.loose.example': [['v=BIMI1; l=https://loose.example/l.svg']],
    '_dmarc.org.example': [['v=DMARC1; p=quarantine']], // a subdomain uses its organization's records
    'default._bimi.org.example': [['v=BIMI1; ', 'l=https://org.example/l.svg']],
    '_dmarc.declined.example': [['v=DMARC1; p=reject']],
    'default._bimi.declined.example': [['v=BIMI1; l=']],
  };
  const fetched = [];
  let clock = 0;
  const handle = bimiRoutes({ RateLimiter, ipOf: () => 'ip', now: () => clock,
    txt: async (name) => { if (!dns[name]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return dns[name]; },
    fetchSvg: async (url) => { fetched.push(url); return '<svg viewBox="0 0 1 1"><script>x</script><circle r="1"/></svg>'; } });
  const get = async (path) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { Object.assign(this, { s, h }); }, end(b) { this.b = b; } };
    return (await handle({ method: 'GET' }, res, new URL(`http://x${path}`))) ? res : null;
  };
  const ok = await get('/api/bimi/Brand.Example');
  assert.equal(ok.s, 200);
  assert.equal(ok.h['Content-Type'], 'image/svg+xml; charset=utf-8');
  assert.match(ok.h['Content-Security-Policy'], /sandbox/);
  assert.equal(ok.b, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle r="1"/></svg>');
  await get('/api/bimi/brand.example');
  assert.deepEqual(fetched, ['https://cdn.brand.example/logo.svg']); // second time from the cache
  assert.equal((await get('/api/bimi/loose.example')).s, 404); // p=none: no logo
  assert.equal((await get('/api/bimi/mail.org.example')).s, 200);
  assert.equal((await get('/api/bimi/declined.example')).s, 404);
  assert.equal((await get('/api/bimi/nothing.example')).s, 404);
  assert.equal((await get('/api/bimi/not_a..domain')).s, 400);
  assert.equal((await get('/api/bimi/10.0.0.1')).s, 400);
  assert.equal(await get('/api/bimi/a/b'), null);
  for (let i = 0; i < 40; i++) await get(`/api/bimi/n${i}.example`);
  const limited = await get('/api/bimi/one-more.example');
  assert.equal(limited.s, 429);
  assert.equal((await get('/api/bimi/brand.example')).s, 200); // cached answers aren't limited
  clock += 86400e3 + 1;
  assert.equal((await get('/api/bimi/brand.example')).s, 429); // a day later it's a fresh lookup again
});
