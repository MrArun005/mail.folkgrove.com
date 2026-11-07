import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUsername, checkPassword, RateLimiter, ipKey, parseInvites, Invites } from '../lib.mjs';
import { createApp } from '../server.mjs';

const code = (u, extra) => checkUsername(u, extra)?.code ?? null;

test('username rules', () => {
  for (const ok of ['bob', 'jane.doe', 'a-b', 'x1y2z3', 'a'.repeat(32), 'admin2', 'rooted']) assert.equal(code(ok), null, ok);
  assert.equal(code(''), 'username_required');
  assert.equal(code(undefined), 'username_required');
  assert.equal(code(42), 'username_required');
  assert.equal(code('ab'), 'username_too_short');
  assert.equal(code('a'.repeat(33)), 'username_too_long');
  for (const bad of ['Bob', 'bo b', 'bob_', 'bob+x', 'bób', 'bob@x', 'b\u0000b']) assert.equal(code(bad), 'username_invalid_chars', bad);
  for (const bad of ['.bob', 'bob.', 'bo..b']) assert.equal(code(bad), 'username_bad_dots', bad);
  for (const bad of ['-bob', 'bob-']) assert.equal(code(bad), 'username_bad_hyphen', bad);
});

test('reserved names, including dotted/hyphenated look-alikes and extras', () => {
  for (const r of ['admin', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'root', 'noreply', 'no-reply',
    'no.reply', 'security', 'support', 'info', 'mailer-daemon', 'mailerdaemon', 'post.master', 'ad-min'])
    assert.equal(code(r), 'username_reserved', r);
  assert.equal(code('ceo'), null);
  assert.equal(code('ceo', ['ceo']), 'username_reserved');
});

test('password rules', () => {
  const c = (p, u = 'bob') => checkPassword(p, u)?.code ?? null;
  assert.equal(c('correct horse battery'), null);
  assert.equal(c(''), 'password_required');
  assert.equal(c(null), 'password_required');
  assert.equal(c('short-pass1'), 'password_too_short'); // 11 chars
  assert.equal(c('x'.repeat(129)), 'password_too_long');
  assert.equal(c('my-name-is-BOB-ok'), 'password_contains_username');
  assert.equal(c('xxxxxxxxxxxxxxxx', 'jane.doe'), null);
});

test('rate limiter: allows N per window, then reports wait, then resets', () => {
  let t = 0;
  const rl = new RateLimiter(3, 3600e3, () => t);
  assert.deepEqual([rl.take('a'), rl.take('a'), rl.take('a')], [0, 0, 0]);
  assert.equal(rl.take('a'), 3600);
  assert.equal(rl.take('b'), 0, 'other keys are independent');
  t = 1800e3;
  assert.equal(rl.take('a'), 1800);
  t = 3600e3;
  assert.equal(rl.take('a'), 0, 'window reset');
});

test('rate limiter sweeps expired keys once large', () => {
  let t = 0;
  const rl = new RateLimiter(1, 1000, () => t);
  for (let i = 0; i <= 10_001; i++) rl.take('ip' + i);
  t = 2000;
  rl.take('new');
  assert.equal(rl.hits.size, 1);
});

test('ipKey groups IPv6 by /64 and unwraps v4-mapped addresses', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
});

test('invites: counts, reservation, refund, file persistence', () => {
  assert.deepEqual([...parseInvites('a:2, b ,c:0\nd:x')], [['a', 2], ['b', 1], ['c', 0], ['d', 0]]);
  const inv = new Invites({ text: 'a:2,b' });
  assert.equal(inv.reserve('a'), true);
  assert.equal(inv.reserve(' a '), true);
  assert.equal(inv.reserve('a'), false, 'used up');
  inv.refund('a');
  assert.equal(inv.reserve('a'), true, 'refund restores a use');
  assert.equal(inv.reserve('nope'), false);
  assert.equal(inv.reserve(undefined), false);
  assert.equal(inv.reserve('constructor'), false, 'no prototype lookups');

  const file = join(mkdtempSync(join(tmpdir(), 'inv-')), 'invites.txt');
  writeFileSync(file, 'x:2\n');
  new Invites({ file }).reserve('x');
  assert.equal(readFileSync(file, 'utf8'), 'x:1\n');
  assert.equal(new Invites({ file }).codes.get('x'), 1, 'survives restart');
});

// HTTP-level checks that never reach Stalwart (validation, limits, body handling).
async function start(t, overrides = {}) {
  const cfg = {
    stalwartUrl: 'http://127.0.0.1:9', admin: { user: 'admin', pass: 'SECRET-ADMIN-PASS' }, domain: 'example.test',
    inviteRequired: true, invites: new Invites({ text: 'good:1' }), turnstileSecret: null, quotaBytes: 0,
    signupsPerHour: 2, checksPerMinute: 2, clientIpHeader: null, extraReserved: [], ...overrides,
  };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (body, type = 'application/json') =>
    fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { cfg, base, post };
}
const codeOf = async (r) => [r.status, (await r.json()).error?.code];

test('HTTP: trust-boundary rejections and per-IP signup limit', async (t) => {
  const { post } = await start(t);
  assert.deepEqual(await codeOf(await post('{}', 'text/plain')), [415, 'json_required']);
  assert.deepEqual(await codeOf(await post('{nope')), [400, 'bad_json']);
  assert.deepEqual(await codeOf(await post('[]')), [400, 'bad_json']);
  assert.deepEqual(await codeOf(await post({ username: 'x'.repeat(5000) })), [413, 'body_too_large']);
  assert.deepEqual(await codeOf(await post({ username: 'Admin', password: 'long-enough-pass' })), [400, 'username_reserved']);
  assert.deepEqual(await codeOf(await post({ username: 'bob', password: 'short' })), [400, 'password_too_short']);
  const ok = { username: 'bob', password: 'long-enough-pass' };
  assert.deepEqual(await codeOf(await post(ok)), [403, 'invite_required']);
  assert.deepEqual(await codeOf(await post({ ...ok, inviteCode: 'bad' })), [403, 'invite_invalid']);
  const limited = await post(ok);
  assert.equal(limited.headers.get('retry-after'), '3600');
  assert.deepEqual(await codeOf(limited), [429, 'rate_limited']);
});

test('HTTP: mail server down gives a generic message, leaks nothing, refunds the invite', async (t) => {
  const { cfg, base, post } = await start(t, { signupsPerHour: 5 });
  const r = await post({ username: 'bob', password: 'long-enough-pass', inviteCode: 'good' });
  const text = await r.text();
  assert.equal(r.status, 503);
  assert.match(text, /temporarily unavailable/);
  assert.doesNotMatch(text, /SECRET|admin|127\.0\.0\.1|ECONNREFUSED|fetch/i);
  assert.equal(cfg.invites.codes.get('good'), 1);

  const avail = (u) => fetch(`${base}/api/username-available?u=${u}`).then((x) => x.json());
  assert.deepEqual(await avail('ab'), { ok: true, available: false, code: 'username_too_short', message: 'Your username needs at least 3 characters.' });
  assert.equal((await avail('root')).code, 'username_reserved');
  assert.equal((await avail('fine')).error?.code, 'rate_limited', 'availability checks are rate limited too');
});

test('HTTP: Turnstile token required when a secret is configured', async (t) => {
  const { post } = await start(t, { turnstileSecret: 'x', inviteRequired: false });
  assert.deepEqual(await codeOf(await post({ username: 'bob', password: 'long-enough-pass' })), [400, 'captcha_failed']);
});
