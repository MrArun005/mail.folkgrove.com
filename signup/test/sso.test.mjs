// Single sign-on: the account service as an OpenID Connect relying party, against a mock provider made here
// (keys from node:crypto). The first test needs nothing else (a fake "Stalwart" answers /jmap/session). The live test
// (SSO_LIVE=1) switches the dev Stalwart's authentication to the mock provider for a few seconds and back: it is
// server-wide, so password sign-in fails for everyone meanwhile; hence opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { verifyIdToken } from '../sso.mjs';
import { cookieName } from '../session.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }), stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'r1', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'e1' }];
function jwt(claims, { key = rsa.privateKey, kid = 'r1', alg = 'RS256' } = {}) {
  const h = b64({ alg, kid, typ: 'JWT' }), p = b64(claims);
  const sig = alg === 'ES256' ? edSign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }) : createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${sig.toString('base64url')}`;
}

/** A tiny OpenID provider: discovery, JWKS, token (code + refresh), revocation. `issuer` is what tokens carry. */
async function mockProvider({ issuer: fixedIssuer, clientId = 'om-test', secret = 'shh', tweak = (c) => c } = {}) {
  const codes = new Map(), revoked = [];
  let issuer, refreshes = 0;
  const idToken = (email, nonce) => jwt(tweak({ iss: issuer, sub: `sub-${email}`, aud: clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, email, email_verified: true, ...(nonce && { nonce }) }));
  const srv = createServer(async (req, res) => {
    const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const url = new URL(req.url, 'http://x');
    let body = ''; for await (const c of req) body += c;
    const f = new URLSearchParams(body);
    if (url.pathname === '/.well-known/openid-configuration' || url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` });
    if (url.pathname === '/jwks') return json(200, { keys: KEYS });
    if (url.pathname === '/revoke') { revoked.push(f.get('token')); return json(200, {}); }
    if (url.pathname === '/token') {
      if (f.get('client_id') !== clientId || f.get('client_secret') !== secret) return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'refresh_token') {
        const email = f.get('refresh_token')?.match(/^rt-(.+)$/)?.[1];
        if (!email) return json(400, { error: 'invalid_grant' });
        refreshes++;
        return json(200, { id_token: idToken(email), refresh_token: `rt-${email}`, expires_in: 300 });
      }
      const c = codes.get(f.get('code')); codes.delete(f.get('code'));
      if (!c || f.get('redirect_uri') !== c.redirect || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' });
      return json(200, { id_token: idToken(c.email, c.nonce), refresh_token: `rt-${c.email}`, access_token: 'opaque', expires_in: 300 });
    }
    json(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  issuer = fixedIssuer?.(srv.address().port) ?? `http://127.0.0.1:${srv.address().port}`;
  /** What the provider's sign-in page does: the person signs in, and is sent back with a code. */
  const authorize = (location, email) => {
    const q = new URL(location).searchParams, code = randomBytes(8).toString('hex');
    codes.set(code, { email, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
    return `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}`;
  };
  return { srv, get issuer() { return issuer; }, clientId, secret, authorize, revoked, idToken, get refreshes() { return refreshes; } };
}

test('verifyIdToken checks signature, algorithm, issuer, audience, expiry and nonce', () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://idp.test', aud: 'cid', exp: now + 60, iat: now, nonce: 'n1', email: 'a@x.test' };
  const opts = { keys: KEYS, issuer: 'https://idp.test', clientId: 'cid', nonce: 'n1' };
  assert.equal(verifyIdToken(jwt(base), opts).email, 'a@x.test');
  assert.equal(verifyIdToken(jwt(base, { key: ec.privateKey, kid: 'e1', alg: 'ES256' }), opts).email, 'a@x.test');
  assert.equal(verifyIdToken(jwt({ ...base, aud: ['cid', 'other'], azp: 'cid' }), opts).email, 'a@x.test');
  const bad = (t, o, msg) => assert.throws(() => verifyIdToken(t, { ...opts, ...o }), new RegExp(msg));
  bad(jwt(base, { key: stranger.privateKey }), {}, 'bad signature');
  bad(jwt(base, { kid: 'nope' }), {}, 'unknown signing key');
  bad(`${b64({ alg: 'none' })}.${b64(base)}.`, {}, 'not accepted');
  bad(`${b64({ alg: 'HS256', kid: 'r1' })}.${b64(base)}.xx`, {}, 'not accepted');
  bad(jwt({ ...base, iss: 'https://evil.test' }), {}, 'wrong issuer');
  bad(jwt({ ...base, aud: 'someone-else' }), {}, 'wrong audience');
  bad(jwt({ ...base, aud: ['cid', 'other'], azp: 'other' }), {}, 'wrong authorized party');
  bad(jwt({ ...base, exp: now - 120 }), {}, 'expired');
  bad(jwt({ ...base, iat: now + 600 }), {}, 'future');
  bad(jwt({ ...base, nonce: 'n2' }), {}, 'wrong nonce');
  bad('not.a', {}, 'malformed');
  assert.equal(verifyIdToken(jwt({ ...base, nonce: undefined }), { ...opts, nonce: undefined }).email, 'a@x.test'); // refresh: no nonce
});

/** The account service with SSO on, plus a fake Stalwart session endpoint that trusts tokens the provider signed. */
async function harness(t, idp, { stalwartUrl, stalwartSays } = {}) {
  let fake;
  if (!stalwartUrl) {
    fake = createServer((req, res) => {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      let email = null;
      try { email = verifyIdToken(token, { keys: KEYS, issuer: idp.issuer, clientId: idp.clientId }).email; } catch { /* refused */ }
      if (!email || stalwartSays?.(email) === false) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ username: email }));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    stalwartUrl = `http://127.0.0.1:${fake.address().port}`;
  }
  const admin = existsSync(ADMIN_FILE) ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) : { user: 'x', pass: 'y' };
  const app = createApp({ stalwartUrl, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }),
    turnstileSecret: null, quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], secureCookies: false, retentionJob: false,
    oidc: { issuer: idp.issuer, clientId: idp.clientId, secret: idp.secret, name: 'Example SSO', publicUrl: 'http://127.0.0.1:0' } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); fake?.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  /** The whole browser round trip. Returns the final redirect and the cookies set. */
  async function signIn(email, { keepStateCookie = true, replay } = {}) {
    const start = await fetch(`${base}/api/sso/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    assert.match(start.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax; Path=\/api\/sso/);
    const loc = start.headers.get('location');
    const q = new URL(loc).searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('nonce') && q.get('state') && q.get('scope').includes('openid'));
    const back = idp.authorize(loc, email).replace('http://127.0.0.1:0', base); // the provider redirects the browser here
    const cb = await fetch(back, { redirect: 'manual', headers: keepStateCookie ? { Cookie: stateCookie } : {} });
    if (replay) await replay(back, stateCookie);
    return { location: cb.headers.get('location'), cookies: cb.headers.getSetCookie() };
  }
  const session = (path, username, cookie) => fetch(`${base}/api/session/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenMail': '1', ...(cookie && { Cookie: cookie }) }, body: JSON.stringify({ username }) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  return { base, signIn, session, stalwartUrl };
}
const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));

test('SSO relying party: code + PKCE + state + nonce, verified ID token, cookie session, refresh, sign-out', async (t) => {
  const idp = await mockProvider();
  t.after(() => idp.srv.close());
  const h = await harness(t, idp, { stalwartSays: (email) => email.endsWith('@openmail.test') });

  assert.deepEqual(await (await fetch(`${h.base}/api/sso`)).json(), { ok: true, name: 'Example SSO' });

  // Happy path: back to the app with the account name; the provider's refresh token sits in the HttpOnly cookie.
  const user = 'ann@openmail.test';
  const r = await h.signIn(user);
  assert.equal(r.location, `/?sso=${encodeURIComponent(user)}`);
  const cookie = r.cookies.find((c) => c.startsWith(cookieName(user)));
  assert.ok(cookie && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\/api\/session/.test(cookie));
  assert.ok(decodeURIComponent(cookie.split(';')[0].split('=')[1]).startsWith('sso:r:'));
  const jar = cookie.split(';')[0];

  // The page asks for an access token: a freshly refreshed, verified ID token (never the refresh token).
  const s = await h.session('refresh', user, jar);
  assert.equal(s.status, 200);
  assert.equal(verifyIdToken(s.access_token, { keys: KEYS, issuer: idp.issuer, clientId: idp.clientId }).email, user);
  assert.ok(s.expires_in > 0 && s.expires_in <= 300);
  assert.equal(idp.refreshes, 1);

  // Sign-out revokes the refresh token at the provider and clears the cookie.
  const f = await h.session('forget', user, jar);
  assert.equal(f.status, 200);
  assert.deepEqual(idp.revoked, [`rt-${user}`]);

  // Without the state cookie (someone else's sign-in link), or used twice: refused.
  assert.equal((await h.signIn(user, { keepStateCookie: false })).location, '/?sso_error=expired');
  let replayed;
  await h.signIn(user, { replay: async (back, c) => { replayed = (await fetch(back, { redirect: 'manual', headers: { Cookie: c } })).headers.get('location'); } });
  assert.equal(replayed, '/?sso_error=expired');

  // An address Stalwart won't take (not one of this server's domains): no session.
  assert.equal((await h.signIn('eve@elsewhere.test')).location, '/?sso_error=no_account');
});

test('SSO relying party refuses a token with the wrong nonce, audience or issuer', async (t) => {
  for (const [what, tweak] of [['nonce', (c) => ({ ...c, nonce: 'forged' })], ['audience', (c) => ({ ...c, aud: 'other-app' })], ['issuer', (c) => ({ ...c, iss: 'https://evil.test' })]]) {
    const idp = await mockProvider({ tweak });
    t.after(() => idp.srv.close());
    const h = await harness(t, idp);
    const r = await h.signIn('ann@openmail.test');
    assert.equal(r.location, '/?sso_error=refused', what);
    assert.ok(!r.cookies.some((c) => c.startsWith('om_rt_')), `${what}: no session cookie`);
  }
});

// Live: the real Stalwart OIDC directory pointed at the mock provider (reachable from the container as host.docker.internal).
const live = process.env.SSO_LIVE === '1' && existsSync(ADMIN_FILE)
  && await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
test('SSO live: Stalwart accepts the verified ID token, creates the account on first sign-in, refuses other domains', { skip: !live && 'set SSO_LIVE=1 (switches dev Stalwart auth for a few seconds)' }, async (t) => {
  // Password sign-in stops while the directory is on, so revert with the dev server's recovery admin.
  const auth = 'Basic ' + Buffer.from(process.env.RECOVERY_ADMIN || 'admin:devadmin').toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const idp = await mockProvider({ issuer: (port) => `http://host.docker.internal:${port}` });
  // This test process can't resolve host.docker.internal (the container can): route it to the mock here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(String(u).replace('host.docker.internal', '127.0.0.1'), o);
  const srvPort = idp.srv.address().port;
  idp.srv.close(); await new Promise((r) => idp.srv.listen(srvPort, '::', r)); // dual-stack: the container resolves it to IPv6
  const tag = randomBytes(3).toString('hex'), user = `t-sso-${tag}@openmail.test`;
  const dir = (await jmap([['x:Directory/set', { create: { d: { '@type': 'Oidc', description: `test ${tag}`, issuerUrl: idp.issuer, claimUsername: 'email',
    acceptedAudiences: { [idp.clientId]: true }, allowIdTokenClaims: true, unscopedTokens: 'interoperable' } } }, 'd']])).created.d.id;
  const reload = () => jmap([['x:Action/set', { create: { a: { '@type': 'ReloadSettings' } } }, 'a']]);
  t.after(async () => {
    await jmap([['x:Authentication/set', { update: { singleton: { directoryId: null } } }, 's']]); await reload(); // reload: else the old directory stays live
    await jmap([['x:Directory/set', { destroy: [dir] }, 'd']]);
    const made = await jmap([['x:Account/query', { filter: { text: `t-sso-${tag}` } }, 'q']]);
    if (made.ids.length) await jmap([['x:Account/set', { destroy: made.ids }, 'x']]);
    globalThis.fetch = realFetch; idp.srv.close();
  });
  await jmap([['x:Authentication/set', { update: { singleton: { directoryId: dir } } }, 's']]); await reload();
  const h = await harness(t, idp, { stalwartUrl: STALWART });
  const r = await h.signIn(user);
  assert.equal(r.location, `/?sso=${encodeURIComponent(user)}`);
  const s = await h.session('refresh', user, r.cookies.find((c) => c.startsWith(cookieName(user))).split(';')[0]);
  const js = await realFetch(`${STALWART}/jmap/session`, { headers: { Authorization: `Bearer ${s.access_token}` } });
  assert.equal(js.status, 200);
  assert.equal((await js.json()).username, user); // created on first sign-in
  assert.equal((await h.signIn(`t-sso-${tag}@elsewhere.test`)).location, '/?sso_error=no_account');
  assert.equal((await realFetch(`${STALWART}/jmap/session`, { headers: { Authorization: `Bearer ${jwt({ iss: idp.issuer, aud: 'other', exp: 9e9, email: user })}` } })).status, 401);
});
