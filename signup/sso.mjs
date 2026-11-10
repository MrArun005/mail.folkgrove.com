// Single sign-on with an outside OpenID Connect provider (Google Workspace, Microsoft Entra ID, Okta, Keycloak…).
//
// Who checks what:
// - Stalwart (open-source edition) has an OIDC directory: it accepts the provider's signed ID token as a Bearer token
//   (allowIdTokenClaims), checks signature, issuer, audience and expiry itself, and creates the account on first sign-in.
//   Only addresses in the server's own domains get in (verified on Stalwart 1.0.3). install.sh switches it on.
// - This service is the relying party: a confidential client (it holds the client secret, which Google requires and
//   a browser can't keep). It runs the authorization-code flow with PKCE, state and nonce, verifies the ID token
//   (JWKS signature via node:crypto, issuer, audience, expiry, nonce), asks Stalwart which account it maps to, and
//   keeps the provider's refresh token in the same HttpOnly cookie "Keep me signed in" uses (session.mjs).
//   The browser only ever holds the short-lived ID token, as its access token.
//
// ponytail: switching the directory on is server-wide (per-domain directories are Stalwart Enterprise), so with SSO
// on, nobody signs in with a Stalwart password any more: mail apps need app passwords, which an external directory
// doesn't allow either. Webmail only, until Stalwart's OAUTHBEARER for IMAP/SMTP is wired up.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { cookieName, readCookies, secureCookie, setCookie } from './session.mjs';
import { checkUsername } from './lib.mjs';

/**
 * Which address a verified ID token may sign in as, or { error } saying why not. Must agree with Stalwart's
 * claimUsername (install.sh sets both from OIDC_CLAIM). Rules:
 * - an `email` claim counts only when the provider says it's verified: `email_verified: true`, or Microsoft Entra's
 *   `xms_edov: true` (email domain owner verified; add it as an optional claim). Entra's `preferred_username` is
 *   editable by users in some tenants, so install.sh never uses it for Microsoft.
 * - with OIDC_TENANT set, the token's Google Workspace domain (`hd`) or Entra tenant id (`tid`) must match.
 * - never an admin name (ADMINS), a reserved name, or a retired one (cfg.extraReserved holds all three).
 */
export function ssoIdentity(claims, { claim = 'email', tenant = null, admins = [], extraReserved = [] } = {}) {
  if (tenant && claims.hd !== tenant && claims.tid !== tenant) return { error: 'wrong tenant' };
  const value = claims[claim];
  if (typeof value !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(value)) return { error: `no address in the ${claim} claim` };
  if (claim === 'email' && claims.email_verified !== true && claims.xms_edov !== true) return { error: 'email not verified' };
  const address = value.toLowerCase(), name = address.split('@')[0];
  if (admins.includes(name)) return { error: 'admin name' };
  if (checkUsername(name, extraReserved)?.code === 'username_reserved') return { error: 'reserved or retired name' };
  return { address };
}

const SKEW = 60; // seconds of clock difference we tolerate
const ALGS = { RS256: ['sha256', {}], RS384: ['sha384', {}], RS512: ['sha512', {}], PS256: ['sha256', { padding: 6, saltLength: 32 }],
  ES256: ['sha256', { dsaEncoding: 'ieee-p1363' }], ES384: ['sha384', { dsaEncoding: 'ieee-p1363' }] }; // padding 6 = RSA_PKCS1_PSS_PADDING
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Verify an ID token. Returns its claims, or throws Error('…') naming the check that failed.
 * nonce: the value sent in the authorization request; undefined for a refreshed token (providers may omit it then).
 */
export function verifyIdToken(jwt, { keys, issuer, clientId, nonce, now = Date.now() / 1000 }) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = b64json(h), claims = b64json(p);
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`algorithm ${header.alg} not accepted`); // never "none", never HMAC with a public key
  const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === 'sig'));
  if (!jwk) throw new Error('unknown signing key');
  const ok = verify(alg[0], Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), ...alg[1] }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== issuer) throw new Error('wrong issuer');
  const aud = [].concat(claims.aud);
  if (!aud.includes(clientId)) throw new Error('wrong audience');
  if (aud.length > 1 && claims.azp !== clientId) throw new Error('wrong authorized party');
  if (!(claims.exp > now - SKEW)) throw new Error('expired');
  if (claims.iat > now + SKEW) throw new Error('issued in the future');
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('wrong nonce');
  return claims;
}

export function ssoRoutes({ cfg, send, fail, RateLimiter, ipOf }) {
  const o = cfg.oidc; // { issuer, clientId, secret, name, publicUrl }
  const redirectUri = `${o.publicUrl}/api/sso/callback`;
  const limit = new RateLimiter(30, 60e3); // sign-in starts and callbacks per network per minute
  // ponytail: pending sign-ins live in this process for 10 minutes (one instance, as for sign-up codes).
  const pending = new Map(); // state → { nonce, verifier, at }
  let meta = null, keys = [], keysAt = 0;

  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  };
  const discovery = async () => (meta ??= await get(`${o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`));
  // Keys are cached; an unknown key id refetches them (providers rotate), at most once a minute.
  const jwks = async (force = false) => {
    if (!keys.length || (force && Date.now() - keysAt > 60e3)) { keys = (await get((await discovery()).jwks_uri)).keys ?? []; keysAt = Date.now(); }
    return keys;
  };
  const check = async (jwt, nonce) => {
    try { return verifyIdToken(jwt, { keys: await jwks(), issuer: o.issuer, clientId: o.clientId, nonce }); }
    catch (e) { if (e.message !== 'unknown signing key') throw e; return verifyIdToken(jwt, { keys: await jwks(true), issuer: o.issuer, clientId: o.clientId, nonce }); }
  };
  const tokenCall = async (form) => {
    const r = await fetch((await discovery()).token_endpoint, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.secret, ...form }) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };
  /** Which Stalwart account this token opens (and Stalwart creates it on first sign-in). null if Stalwart says no. */
  const stalwartUser = async (idToken) => {
    const r = await fetch(`${cfg.stalwartUrl}/jmap/session`, { headers: { Authorization: `Bearer ${idToken}` }, signal: AbortSignal.timeout(10_000) });
    return r.ok ? (await r.json()).username ?? null : null;
  };
  // Cookie values: "sso:r:<refresh token>" or, when the provider gave none, "sso:i:<ID token>" (works until it expires).
  const cookieFor = (t) => (t.refresh_token ? `sso:r:${t.refresh_token}` : `sso:i:${t.id_token}`);
  const expiresIn = (claims) => Math.max(0, Math.floor(claims.exp - Date.now() / 1000));

  const back = (res, query) => { res.writeHead(302, { Location: `/?${new URLSearchParams(query)}`, 'Cache-Control': 'no-store' }); res.end(); };
  const STATE_COOKIE = 'om_sso_state';

  async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/sso(\/start|\/callback)?$/);
    if (!m) return false;
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    if (!m[1]) return send(res, 200, { ok: true, name: o.name }), true; // the login page shows the button
    const wait = limit.take(ipOf(req));
    if (wait) return back(res, { sso_error: 'rate_limited' }), true;
    const secure = secureCookie(cfg, req);

    if (m[1] === '/start') {
      const now = Date.now(), net = ipOf(req);
      let mine = 0;
      for (const [k, v] of pending) if (now - v.at > 600e3) pending.delete(k); else if (v.net === net) mine++;
      // At most 20 unfinished sign-ins per network: the rate limit alone lets one network leave 300 in 10 minutes,
      // and a few dozen networks would fill the table and turn everyone away.
      if (mine >= 20) return back(res, { sso_error: 'rate_limited' }), true;
      if (pending.size > 10_000) return back(res, { sso_error: 'busy' }), true;
      const state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url');
      pending.set(state, { nonce, verifier, at: now, net });
      let d;
      try { d = await discovery(); } catch (e) { console.error('sso: discovery failed:', e.message); return back(res, { sso_error: 'unavailable' }), true; }
      // ponytail: Google wants access_type=offline for a refresh token and rejects the offline_access scope; others want the scope.
      const google = o.issuer === 'https://accounts.google.com';
      const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, redirect_uri: redirectUri, state, nonce,
        scope: google ? 'openid email profile' : 'openid email profile offline_access',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        ...(google && { access_type: 'offline', prompt: 'consent' }) });
      // The state cookie ties the answer to this browser (no one can finish their sign-in in yours). Lax: it must come
      // back on the provider's top-level redirect.
      res.writeHead(302, { Location: `${d.authorization_endpoint}?${q}`, 'Cache-Control': 'no-store',
        'Set-Cookie': `${STATE_COOKIE}=${state}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/api/sso; Max-Age=600` });
      res.end();
      return true;
    }

    // Callback.
    const state = url.searchParams.get('state') || '', p = pending.get(state);
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/api/sso; Max-Age=0`);
    if (!p || readCookies(req.headers.cookie)[STATE_COOKIE] !== state) return back(res, { sso_error: 'expired' }), true;
    pending.delete(state); // one use
    if (url.searchParams.get('error')) return back(res, { sso_error: url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'refused' }), true;
    let t, claims, username;
    try {
      t = await tokenCall({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri, code_verifier: p.verifier });
      if (!t.ok || !t.body.id_token) { console.error('sso: code exchange refused:', t.status, t.body.error, t.body.error_description ?? ''); return back(res, { sso_error: 'refused' }), true; }
      try { claims = await check(t.body.id_token, p.nonce); }
      catch (e) { console.error('sso: ID token rejected:', e.message); return back(res, { sso_error: 'refused' }), true; }
      const id = ssoIdentity(claims, { claim: o.claim, tenant: o.tenant, admins: cfg.admins, extraReserved: cfg.extraReserved });
      // Refused before Stalwart sees the token, so no account gets created for it.
      if (id.error) { console.log(`sso: refused ${claims.email ?? claims.sub}: ${id.error}`); return back(res, { sso_error: 'no_account' }), true; }
      username = await stalwartUser(t.body.id_token);
      // Stalwart must have opened the same account (and it must pass the same checks).
      if (username && username.toLowerCase() !== id.address) {
        console.error(`sso: Stalwart mapped ${id.address} to ${username}; refused`); return back(res, { sso_error: 'no_account' }), true;
      }
    } catch (e) { console.error('sso: provider or Stalwart unreachable:', e.message); return back(res, { sso_error: 'unavailable' }), true; }
    if (!username) {
      // Usually: the address isn't in one of this server's domains, or Stalwart's directory isn't set up for this provider.
      console.log(`sso: Stalwart refused ${claims.email ?? claims.sub} (not in a local domain, or directory not configured)`);
      return back(res, { sso_error: 'no_account' }), true;
    }
    res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), setCookie(cookieName(username), cookieFor(t.body), 30 * 86400, secure)]);
    console.log(`sso: ${username} signed in`);
    return back(res, { sso: username }), true;
  }

  /** session.mjs refresh for an "sso:" cookie. Same shape as a Stalwart /auth/token answer. */
  async function refresh(cookie, username) {
    // A refreshed token must still pass every check and name the same account (an address changed at the provider
    // must not open someone else's mailbox).
    const same = (claims) => ssoIdentity(claims, { claim: o.claim, tenant: o.tenant, admins: cfg.admins, extraReserved: cfg.extraReserved }).address === String(username).toLowerCase();
    const kind = cookie.slice(4, 5), value = cookie.slice(6);
    try {
      if (kind === 'i') { // no refresh token: the ID token itself, until it expires
        const claims = await check(value, undefined);
        return { ok: same(claims) && expiresIn(claims) > SKEW, body: { access_token: value, refresh_token: cookie, expires_in: expiresIn(claims) } };
      }
      const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: value });
      if (!t.ok || !t.body.id_token) return { ok: false, body: {} };
      const claims = await check(t.body.id_token, undefined);
      if (!same(claims)) { console.error(`sso: refreshed token no longer matches ${username}`); return { ok: false, body: {} }; }
      return { ok: true, body: { access_token: t.body.id_token, refresh_token: t.body.refresh_token ? `sso:r:${t.body.refresh_token}` : cookie, expires_in: expiresIn(claims) } };
    } catch (e) { console.error('sso: refresh failed:', e.message); return { ok: false, body: {} }; }
  }

  /** Sign-out: revoke the refresh token at the provider when it offers revocation (Google, Okta, Keycloak do). */
  async function forget(cookie) {
    if (!cookie.startsWith('sso:r:')) return;
    const endpoint = (await discovery().catch(() => ({}))).revocation_endpoint;
    if (endpoint) await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.secret, token: cookie.slice(6), token_type_hint: 'refresh_token' }) }).catch(() => {});
  }

  return { handle, refresh, forget };
}
