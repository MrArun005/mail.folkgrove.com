// "Keep me signed in" against the local dev Stalwart: a real OAuth sign-in, then only the HttpOnly cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { cookieName, readCookies, secureCookie } from '../session.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const b64url = (b) => b.toString('base64url');

/** The app's sign-in flow (web/src/oauth.ts authorize), from Node. */
async function signIn(user, pass) {
  const verifier = b64url(randomBytes(48)), state = b64url(randomBytes(16));
  const query = new URLSearchParams({ response_type: 'code', client_id: 'openmail-web', redirect_uri: 'http://localhost:5173/',
    scope: 'openid offline_access urn:ietf:params:oauth:scope:mail', code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256', state }).toString();
  const post = (b) => fetch(`${STALWART}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  let r = await post({ type: 'authCode', accountName: user, accountSecret: pass, query });
  if (r.type === 'consentRequired') r = await post({ type: 'authConsent', token: r.token, query, consent: true });
  const code = new URL(r.location).searchParams.get('code');
  const t = await fetch(`${STALWART}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'openmail-web', grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:5173/', code_verifier: verifier }) }).then((x) => x.json());
  return t.refresh_token;
}

test('the cookie is Secure except on plain http to this machine (WebKit drops a Secure cookie sent over http)', () => {
  const req = (host, proto, encrypted = false) => ({ headers: { host, ...(proto && { 'x-forwarded-proto': proto }) }, socket: { encrypted } });
  for (const host of ['localhost:5173', 'localhost', '127.0.0.1:3000', '[::1]:5175']) assert.equal(secureCookie({}, req(host)), false, host);
  assert.equal(secureCookie({}, req('localhost:5173', 'https')), true); // behind a proxy that served it over https
  assert.equal(secureCookie({}, req('localhost:3000', null, true)), true);
  for (const host of ['mail.example.org', 'localhost.example.org', 'mail.example.org:443', '']) assert.equal(secureCookie({}, req(host)), true, host);
  assert.equal(secureCookie({ secureCookies: false }, req('mail.example.org', 'https')), false); // INSECURE_COOKIES=true
});

test('keep me signed in: remember, refresh from the cookie only (also two tabs at once), forget', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }),
    turnstileSecret: null, quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], secureCookies: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}/api/session`;
  const user = 'alice@openmail.test';
  let jar = '';
  const call = async (path, body, headers = { 'X-OpenMail': '1' }) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar, ...headers }, body: JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) { const [kv] = set.split(';'); jar = kv.endsWith('=') ? '' : kv; }
    return { status: r.status, ...(await r.json()) };
  };
  const works = async (token) => (await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: `Bearer ${token}` } })).status === 200;

  assert.equal((await call('/refresh', { username: user }, {})).status, 403, 'no CSRF header → refused');
  assert.equal((await call('/refresh', { username: user })).status, 401, 'nothing remembered yet');

  const rt = await signIn(user, 'alice-dev-pass');
  const rem = await call('/remember', { username: user, refreshToken: rt });
  assert.equal(rem.status, 200);
  assert.ok(jar.startsWith(`${cookieName(user)}=`));
  assert.ok(await works(rem.access_token));

  const r1 = await call('/refresh', { username: user });
  assert.equal(r1.status, 200);
  assert.ok(await works(r1.access_token));

  // Two tabs at once with the same cookie: both must get in (the rotated token isn't used twice).
  const [a, b] = await Promise.all([call('/refresh', { username: user }), call('/refresh', { username: user })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal((await call('/refresh', { username: user })).status, 200, 'and the cookie still works after');

  assert.equal((await call('/forget', { username: user })).status, 200);
  assert.equal((await call('/refresh', { username: user })).status, 401, 'forgotten');
  assert.deepEqual(readCookies('a=1; b=x%3Dy'), { a: '1', b: 'x=y' });
});

test('a busy mail server does not end a remembered session: the cookie is kept, the answer is "try again"', async (t) => {
  // A stand-in for Stalwart that is having a bad minute, then recovers.
  const { createServer } = await import('node:http');
  let mode = 503;
  const fake = createServer((req, res) => {
    if (req.url !== '/auth/token') { res.writeHead(404); return res.end(); }
    if (mode !== 200) { res.writeHead(mode, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'kept-refresh', expires_in: 3600 }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const app = createApp({ stalwartUrl: `http://127.0.0.1:${fake.address().port}`, admin: { user: 'a', pass: 'b' }, domain: 'openmail.test', signupEnabled: false, inviteRequired: false,
    invites: new Invites({ text: '' }), turnstileSecret: null, quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], secureCookies: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); fake.close(); });
  const user = 'alice@openmail.test';
  const refresh = (token = 'kept-refresh') => fetch(`http://127.0.0.1:${app.address().port}/api/session/refresh`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenMail': '1', Cookie: `${cookieName(user)}=${token}` }, body: JSON.stringify({ username: user }) });

  for (const status of [503, 429, 500]) {
    mode = status;
    const r = await refresh();
    assert.equal(r.status, 503, `mail server ${status} → "try again", not "signed out"`);
    assert.equal(r.headers.get('set-cookie'), null, 'the cookie is left alone');
  }
  mode = 200;
  const ok = await refresh();
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).access_token, 'new-access', 'and the same cookie works once the server is back');
  // A token the server refuses outright still ends the session and clears the cookie.
  mode = 400;
  const dead = await refresh('another-token'); // not the one just refreshed: that answer is reused for a moment (two tabs)
  assert.equal(dead.status, 401);
  assert.match(dead.headers.get('set-cookie') ?? '', /Max-Age=0/);
});
