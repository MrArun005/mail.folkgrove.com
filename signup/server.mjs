#!/usr/bin/env node
// Public signup service: POST /api/signup and GET /api/username-available, backed by Stalwart's admin JMAP API.
// Run: DOMAIN=example.com ADMIN_FILE=/run/secrets/admin.json node server.mjs   (see README.md for all settings)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkUsername, checkPassword, RateLimiter, ipKey, Invites } from './lib.mjs';

export function configFromEnv(env = process.env) {
  const admin = env.ADMIN_FILE
    ? JSON.parse(readFileSync(env.ADMIN_FILE, 'utf8'))
    : { user: env.ADMIN_USER, pass: env.ADMIN_PASS };
  if (!admin.user || !admin.pass) throw new Error('Set ADMIN_USER and ADMIN_PASS, or ADMIN_FILE (JSON {"user","pass"})');
  if (!env.DOMAIN) throw new Error('Set DOMAIN (the mail domain new accounts are created in)');
  const inviteRequired = env.INVITE_REQUIRED !== 'false';
  if (inviteRequired && !env.INVITE_CODES && !env.INVITE_FILE)
    throw new Error('INVITE_REQUIRED is on (the default) but neither INVITE_CODES nor INVITE_FILE is set');
  return {
    stalwartUrl: (env.STALWART_URL || 'http://localhost:8080').replace(/\/$/, ''),
    admin,
    domain: env.DOMAIN.toLowerCase(),
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    inviteRequired,
    invites: new Invites({ text: env.INVITE_CODES, file: env.INVITE_FILE || null }),
    turnstileSecret: env.TURNSTILE_SECRET || null,
    quotaBytes: Number(env.QUOTA_BYTES ?? 1024 ** 3), // 0 = no disk quota
    signupsPerHour: Number(env.SIGNUPS_PER_HOUR || 3),
    checksPerMinute: Number(env.CHECKS_PER_MINUTE || 30),
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || null, // e.g. cf-connecting-ip behind Cloudflare
    extraReserved: (env.RESERVED_NAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

const MSG = {
  unavailable: 'Sign-up is temporarily unavailable. Please try again in a few minutes.',
  taken: 'That username is already taken. Please pick another one.',
};

export function createApp(cfg) {
  const signupLimit = new RateLimiter(cfg.signupsPerHour, 3600e3);
  const checkLimit = new RateLimiter(cfg.checksPerMinute, 60e3);
  const auth = 'Basic ' + Buffer.from(`${cfg.admin.user}:${cfg.admin.pass}`).toString('base64');
  let domainId = null;

  async function jmap(methodCalls) {
    const res = await fetch(`${cfg.stalwartUrl}/jmap/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Stalwart JMAP HTTP ${res.status}`);
    const [[name, r]] = (await res.json()).methodResponses;
    if (name === 'error') throw new Error(`Stalwart JMAP error ${r.type}: ${r.description ?? ''}`);
    return r;
  }
  async function getDomainId() {
    if (domainId) return domainId;
    const r = await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
    domainId = r.list.find((d) => d.name === cfg.domain)?.id;
    if (!domainId) throw new Error(`Domain ${cfg.domain} not found in Stalwart`);
    return domainId;
  }
  async function exists(name) {
    const r = await jmap([['x:Account/query', { filter: { name, domainId: await getDomainId() } }, 'q']]);
    return r.ids.length > 0;
  }
  async function verifyTurnstile(token, ip) {
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: cfg.turnstileSecret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok && (await res.json()).success === true;
  }

  const clientIp = (req) =>
    (cfg.clientIpHeader && String(req.headers[cfg.clientIpHeader] || '').split(',')[0].trim()) ||
    req.socket.remoteAddress || '';

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }
  const fail = (res, status, code, message, extra = {}) =>
    send(res, status, { ok: false, error: { code, message, ...extra } }, extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {});
  const tooMany = (res, wait) =>
    fail(res, 429, 'rate_limited', `Too many attempts from your network. Please try again in ${Math.ceil(wait / 60)} minute(s).`, { retryAfter: wait });

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(415);
      if (Number(req.headers['content-length'] || 0) > limit) return reject(413);
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) reject(413); // keep draining (bounded by requestTimeout) so the 413 can still be sent
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          v && typeof v === 'object' && !Array.isArray(v) ? resolve(v) : reject(400);
        } catch { reject(400); }
      });
      req.on('error', () => reject(400));
    });
  }

  async function signup(req, res) {
    let body;
    try { body = await readJson(req); } catch (status) {
      if (status === 415) return fail(res, 415, 'json_required', 'Send the form as JSON (Content-Type: application/json).');
      if (status === 413) return fail(res, 413, 'body_too_large', 'The request is too large.');
      return fail(res, 400, 'bad_json', 'The request could not be read. Please reload the page and try again.');
    }
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : body.username;
    const { password, inviteCode, captchaToken } = body;
    const invalid = checkUsername(username, cfg.extraReserved) || checkPassword(password, username);
    if (invalid) return fail(res, 400, invalid.code, invalid.message, { field: invalid.field });

    // Only well-formed attempts count against the limit, so typos in the form don't lock people out.
    const ip = clientIp(req);
    const wait = signupLimit.take(ipKey(ip));
    if (wait) return tooMany(res, wait);

    if (cfg.turnstileSecret && !(await verifyTurnstile(captchaToken, ip)))
      return fail(res, 400, 'captcha_failed', 'Please complete the "I am human" check and try again.', { field: 'captchaToken' });

    const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    if (cfg.inviteRequired) {
      if (!code) return fail(res, 403, 'invite_required', 'Sign-up is invite-only right now. Please enter your invite code.', { field: 'inviteCode' });
      if (!cfg.invites.reserve(code))
        return fail(res, 403, 'invite_invalid', "That invite code isn't valid or has been used up. Check it for typos, or ask for a new one.", { field: 'inviteCode' });
    }
    const refund = () => cfg.inviteRequired && cfg.invites.refund(code);

    let r;
    try {
      r = await jmap([['x:Account/set', { create: { n: {
        '@type': 'User',
        name: username,
        domainId: await getDomainId(),
        description: `Self sign-up ${new Date().toISOString()}${cfg.inviteRequired ? ` (invite ${code})` : ''}`,
        credentials: { 0: { '@type': 'Password', secret: password } },
        ...(cfg.quotaBytes > 0 && { quotas: { maxDiskQuota: cfg.quotaBytes } }),
      } } }, 'c']]);
    } catch (e) {
      refund();
      console.error('signup: create failed:', e.message);
      return fail(res, 503, 'unavailable', MSG.unavailable);
    }
    if (r.created?.n) return send(res, 201, { ok: true, email: `${username}@${cfg.domain}` });

    refund();
    const err = r.notCreated?.n ?? {};
    if (err.type === 'primaryKeyViolation') return fail(res, 409, 'username_taken', MSG.taken, { field: 'username' });
    if (err.type === 'invalidProperties' && err.properties?.includes('secret'))
      return fail(res, 400, 'password_weak', 'That password is too easy to guess. Try a longer one, for example a few unrelated words.', { field: 'password' });
    console.error('signup: Stalwart refused create:', JSON.stringify(err));
    return fail(res, 503, 'unavailable', MSG.unavailable);
  }

  async function available(req, res, url) {
    const wait = checkLimit.take(ipKey(clientIp(req)));
    if (wait) return tooMany(res, wait);
    const u = (url.searchParams.get('u') || '').trim().toLowerCase();
    const invalid = checkUsername(u, cfg.extraReserved);
    if (invalid) return send(res, 200, { ok: true, available: false, code: invalid.code, message: invalid.message });
    try {
      if (await exists(u)) return send(res, 200, { ok: true, available: false, code: 'username_taken', message: MSG.taken });
    } catch (e) {
      console.error('availability: lookup failed:', e.message);
      return fail(res, 503, 'unavailable', MSG.unavailable);
    }
    send(res, 200, { ok: true, available: true, email: `${u}@${cfg.domain}` });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/signup' && req.method === 'POST') return await signup(req, res);
      if (url.pathname === '/api/username-available' && req.method === 'GET') return await available(req, res, url);
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      fail(res, 404, 'not_found', 'Not found.');
    } catch (e) {
      console.error('unhandled:', e);
      if (!res.headersSent) fail(res, 500, 'internal', 'Something went wrong on our side. Please try again.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = configFromEnv();
  const server = createApp(cfg);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(cfg.port, cfg.host, () =>
    console.log(`signup service on ${cfg.host}:${cfg.port} → ${cfg.stalwartUrl}, domain ${cfg.domain}, invites ${cfg.inviteRequired ? 'required' : 'off'}, captcha ${cfg.turnstileSecret ? 'on' : 'off'}`));
}
