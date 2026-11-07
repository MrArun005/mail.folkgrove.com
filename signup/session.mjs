// "Keep me signed in": the refresh token lives in an HttpOnly cookie that page scripts can't read, so an XSS bug
// can't steal a long-lived credential. The browser asks here for short-lived access tokens; this service refreshes
// with Stalwart (rotating the cookie each time) and returns only the access token.
//
// One cookie per account (name derived from the username), so several remembered accounts can coexist.
// CSRF: SameSite=Strict, plus every call must send `X-OpenMail: 1`, which a cross-site form or image can't set.
import { createHash } from 'node:crypto';

export const CLIENT_ID = 'openmail-web';
const MAX_AGE = 30 * 86400; // seconds; each refresh extends it (sliding 30 days)

export const cookieName = (username) => `om_rt_${createHash('sha256').update(String(username).toLowerCase()).digest('hex').slice(0, 16)}`;

export function readCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(name, value, maxAge, secure = true) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/api/session; Max-Age=${maxAge}`;
}

const validUser = (u) => typeof u === 'string' && /^[^\s@<>()]{1,64}@[^\s@<>()]{1,253}$/.test(u);
const validToken = (t) => typeof t === 'string' && t.length >= 10 && t.length <= 4096 && /^[\w.~+/=-]+$/.test(t);

export function sessionRoutes({ cfg, send, fail, readJson, RateLimiter, ipOf, sso = null }) {
  const limit = new RateLimiter(cfg.sessionPerMinute ?? 60, 60e3); // refreshes per network per minute
  const secure = cfg.secureCookies !== false;
  // Two tabs refreshing at once send the same cookie; the second would carry a token Stalwart already rotated away and
  // be signed out. So one refresh per token at a time, and its result is reused for a short while.
  // ponytail: in this process only; with several replicas, route /api/session to one of them (or move this to Valkey).
  // The reuse window is a few seconds (tabs opening together), not longer: a replayed old cookie after that gets nothing.
  const REUSE_MS = 5_000;
  const recent = new Map(); // old refresh token → { at, promise }
  const refreshOnce = (token, username) => {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > REUSE_MS) recent.delete(k);
    if (!recent.has(token)) {
      // Single sign-on sessions (sso.mjs) refresh with the outside provider instead.
      const promise = (token.startsWith('sso:') ? (sso ? sso.refresh(token, username) : Promise.resolve({ ok: false, body: {} })) : stalwart('/auth/token', { grant_type: 'refresh_token', refresh_token: token }))
        .then((r) => { if (!r.ok) recent.delete(token); return r; }, (e) => { recent.delete(token); throw e; });
      recent.set(token, { at: now, promise });
    }
    return recent.get(token).promise;
  };

  async function stalwart(path, form) {
    const r = await fetch(`${cfg.stalwartUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...form }), signal: AbortSignal.timeout(10_000),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  }

  return async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/session\/(remember|refresh|forget)$/);
    if (!m) return false;
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    if (req.headers['x-openmail'] !== '1') return fail(res, 403, 'csrf', 'Missing request header.'), true;
    const wait = limit.take(ipOf(req));
    if (wait) return fail(res, 429, 'rate_limited', 'Too many requests. Try again shortly.', { retryAfter: wait }), true;
    const body = await readJson(req).catch(() => ({}));
    if (!validUser(body.username)) return fail(res, 400, 'bad_request', 'Missing account.'), true;
    const name = cookieName(body.username);

    if (m[1] === 'remember') {
      // Proof the caller holds this account's refresh token: use it once now (Stalwart rotates it).
      if (!validToken(body.refreshToken)) return fail(res, 400, 'bad_request', 'Missing token.'), true;
      const r = await stalwart('/auth/token', { grant_type: 'refresh_token', refresh_token: body.refreshToken });
      if (!r.ok || !r.body.refresh_token) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
      res.setHeader('Set-Cookie', setCookie(name, r.body.refresh_token, MAX_AGE, secure));
      return send(res, 200, { ok: true, access_token: r.body.access_token, expires_in: r.body.expires_in ?? 3600 }), true;
    }

    const token = readCookies(req.headers.cookie)[name];
    if (m[1] === 'forget') {
      if (token) { recent.delete(token); await (token.startsWith('sso:') ? Promise.resolve(sso?.forget(token)) : stalwart('/auth/revoke', { token, token_type_hint: 'refresh_token' })).catch(() => {}); }
      res.setHeader('Set-Cookie', setCookie(name, '', 0, secure));
      return send(res, 200, { ok: true }), true;
    }

    // refresh
    if (!token) return fail(res, 401, 'unauthorized', 'Not remembered on this device.'), true;
    const r = await refreshOnce(token, body.username);
    if (!r.ok || !r.body.access_token) {
      res.setHeader('Set-Cookie', setCookie(name, '', 0, secure)); // dead token: forget it
      return fail(res, 401, 'unauthorized', 'Your session has ended. Please sign in again.'), true;
    }
    res.setHeader('Set-Cookie', setCookie(name, r.body.refresh_token ?? token, MAX_AGE, secure));
    return send(res, 200, { ok: true, access_token: r.body.access_token, expires_in: r.body.expires_in ?? 3600 }), true;
  };
}
