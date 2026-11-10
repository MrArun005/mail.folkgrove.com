#!/usr/bin/env node
// Public signup service: POST /api/signup and GET /api/username-available, backed by Stalwart's admin JMAP API.
// Run: DOMAIN=example.com ADMIN_FILE=/run/secrets/admin.json node server.mjs   (see README.md for all settings)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkUsername, checkPassword, RateLimiter, ipKey, Invites } from './lib.mjs';
import { aliasRoutes } from './aliases.mjs';
import { sessionRoutes } from './session.mjs';
import { accountRoutes } from './account.mjs';
import { adminRoutes } from './admin.mjs';
import { ssoRoutes } from './sso.mjs';
import { policyStore, retentionRoutes, sweep } from './retention.mjs';
import { sharingRoutes } from './sharing.mjs';
import { fileRoutes } from './files.mjs';
import { domainRoutes } from './domains.mjs';
import { abuseRoutes } from './abuse.mjs';
import { holdRoutes } from './hold.mjs';
import { arfJob } from './arf.mjs';
import { wkdRoutes } from './wkd.mjs';
import { bimiRoutes } from './bimi.mjs';
import { sendMail } from './mailer.mjs';
import { tiers as makeTiers } from './tiers.mjs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** A comma-separated list of usernames on DOMAIN ("ann, raj@example.com" → ['ann', 'raj']). */
const names = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase().replace(/@.*$/, '')).filter(Boolean);

export function configFromEnv(env = process.env) {
  // ADMIN_FILE: JSON {"user","pass"}, or install.sh's .admin-credentials ("user:pass").
  const adminText = env.ADMIN_FILE ? readFileSync(env.ADMIN_FILE, 'utf8').trim() : '';
  const admin = !env.ADMIN_FILE ? { user: env.ADMIN_USER, pass: env.ADMIN_PASS }
    : adminText.startsWith('{') ? JSON.parse(adminText)
    : { user: adminText.slice(0, adminText.indexOf(':')), pass: adminText.slice(adminText.indexOf(':') + 1) };
  if (!admin.user || !admin.pass) throw new Error('Set ADMIN_USER and ADMIN_PASS, or ADMIN_FILE (JSON {"user","pass"})');
  if (!env.DOMAIN) throw new Error('Set DOMAIN (the mail domain new accounts are created in)');
  if (env.OIDC_ISSUER && !(env.OIDC_CLIENT_ID && (env.OIDC_SECRET || env.OIDC_SECRET_FILE) && env.PUBLIC_URL))
    throw new Error('Single sign-on (OIDC_ISSUER) also needs OIDC_CLIENT_ID, OIDC_SECRET (or OIDC_SECRET_FILE) and PUBLIC_URL');
  // SIGNUP=off: an account service for an existing server (masked aliases) with public sign-up switched off.
  const signupEnabled = env.SIGNUP !== 'off';
  const inviteRequired = env.INVITE_REQUIRED !== 'false';
  if (signupEnabled && inviteRequired && !env.INVITE_CODES && !env.INVITE_FILE)
    throw new Error('INVITE_REQUIRED is on (the default) but neither INVITE_CODES nor INVITE_FILE is set');
  return {
    signupEnabled,
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
    // System mail (sign-up codes) goes out through our own server as a system account (install.sh creates it).
    systemMail: env.SYSTEM_SMTP_USER ? {
      host: env.SYSTEM_SMTP_HOST || 'stalwart', port: Number(env.SYSTEM_SMTP_PORT || 465), user: env.SYSTEM_SMTP_USER,
      pass: env.SYSTEM_SMTP_PASS, servername: env.SYSTEM_SMTP_TLS_NAME || undefined, insecure: env.SYSTEM_SMTP_INSECURE === 'true',
      from: env.SYSTEM_MAIL_FROM || `OpenMail <${env.SYSTEM_SMTP_USER}>`,
    } : null,
    // New accounts confirm an existing email address first (on by default whenever system mail is set up).
    verifyEmail: env.VERIFY_EMAIL ? env.VERIFY_EMAIL !== 'off' : !!env.SYSTEM_SMTP_USER,
    maxAliases: Number(env.MAX_ALIASES || 200),
    secureCookies: env.INSECURE_COOKIES !== 'true', // only for plain-http testing
    maxAliasesTotal: Number(env.MAX_ALIASES_TOTAL || 1000), // lifetime, retired included
    aliasesPerHour: Number(env.ALIASES_PER_HOUR || 30),
    retiredFile: env.RETIRED_FILE || null,
    bimiLogos: env.BIMI_LOGOS === 'on', // brand logos (bimi.mjs): off until VMC certificates are checked // names of deleted accounts, never given out again (account.mjs)
    // Admin console (/admin): usernames on DOMAIN allowed to use it. Empty = console off.
    admins: names(env.ADMINS),
    // Helpdesk (admin.mjs): usernames who may open /admin for day-to-day support only (password resets, sign-in on/off,
    // lifting suspensions, held mail, the audit log). A name in both lists is an admin.
    helpdesk: names(env.HELPDESK),
    // Large-file links (files.mjs): where links are kept, biggest file, total per user, uploads per user and downloads
    // per network an hour.
    filesDb: env.FILES_DB || null,
    maxFileBytes: Number(env.MAX_FILE_BYTES || 2 * 1024 ** 3),
    filesQuotaBytes: Number(env.FILES_QUOTA_BYTES || 5 * 1024 ** 3),
    filesPerHour: Number(env.FILES_PER_HOUR || 20),
    downloadsPerHour: Number(env.DOWNLOADS_PER_HOUR || 200),
    // Users' own domains (domains.mjs). CUSTOM_DOMAINS=off switches the feature off.
    customDomains: env.CUSTOM_DOMAINS !== 'off',
    maxDomains: Number(env.MAX_DOMAINS || 3),
    maxDomainAddresses: Number(env.MAX_DOMAIN_ADDRESSES || 10),
    pendingDomainsFile: env.PENDING_DOMAINS_FILE || null, // domains waiting for their TXT record
    // An address offered to another account waits this many days for an answer; one account can have this many waiting.
    domainInviteDays: Number(env.DOMAIN_INVITE_DAYS || 14),
    maxDomainInvites: Number(env.MAX_DOMAIN_INVITES || 5),
    reservedDomains: (env.RESERVED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    dnsServers: (env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    extraReserved: (env.RESERVED_NAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    retentionFile: env.RETENTION_FILE || null, // retention rules (retention.mjs)
    // Admin audit log (audit.mjs): JSON lines; rotated to AUDIT_FILE.1 once it holds AUDIT_MAX_ENTRIES lines.
    auditFile: env.AUDIT_FILE || null,
    auditMax: Number(env.AUDIT_MAX_ENTRIES || 10_000),
    // Single sign-on (sso.mjs): an outside OpenID Connect provider. PUBLIC_URL is the webmail address (callback).
    oidc: env.OIDC_ISSUER ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, name: env.OIDC_NAME || 'your organisation',
      secret: env.OIDC_SECRET_FILE ? readFileSync(env.OIDC_SECRET_FILE, 'utf8').trim() : env.OIDC_SECRET, publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
      claim: env.OIDC_CLAIM || 'email', tenant: env.OIDC_TENANT || null } : null, // tenant: Google hd / Entra tid that must match
    // Abuse and inactive accounts (abuse.mjs): Stalwart posts events to EVENTS_URL; state survives restarts in STATE_FILE.
    eventsUrl: env.EVENTS_URL || null,
    stateFile: env.STATE_FILE || null,
    abuseLimitHits: Number(env.ABUSE_LIMIT_HITS || 10), // throttle refusals per hour before sending is suspended
    abuseBounces: Number(env.ABUSE_BOUNCES || 20), // hard bounces per hour before sending is suspended
    inactiveMonths: env.INACTIVE_MONTHS ? Number(env.INACTIVE_MONTHS) : signupEnabled ? 12 : 0, // 0 = off
    // Spam complaints (arf.mjs): ARF reports in the abuse@ team mailbox; ARF_LIMIT of them in ARF_WINDOW_HOURS suspend sending.
    arf: env.ARF_MAILBOX === 'off' ? null : { mailbox: (env.ARF_MAILBOX || 'abuse').toLowerCase(),
      reporters: (env.ARF_REPORTERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) },
    arfLimit: Number(env.ARF_LIMIT || 5),
    arfWindowHours: Number(env.ARF_WINDOW_HOURS || 24),
    // Outgoing spam held for review (hold.mjs): on when HOLD_HOOK_SECRET is set (install.sh sets it and the hook).
    hold: env.HOLD_HOOK_SECRET ? {
      secret: env.HOLD_HOOK_SECRET, dir: env.HOLD_DIR || null, score: Number(env.HOLD_SCORE || 5), suspendAfter: Number(env.HOLD_SUSPEND_AFTER || 3),
      // Released mail goes back in by SMTP submission as the admin login, like system mail.
      smtp: { host: env.SYSTEM_SMTP_HOST || 'stalwart', port: Number(env.SYSTEM_SMTP_PORT || 465), servername: env.SYSTEM_SMTP_TLS_NAME || undefined, insecure: env.SYSTEM_SMTP_INSECURE === 'true' },
    } : null,
  };
}

const MSG = {
  unavailable: 'Sign-up is temporarily unavailable. Please try again in a few minutes.',
  taken: 'That username is already taken. Please pick another one.',
};

export function createApp(cfg) {
  const signupLimit = new RateLimiter(cfg.signupsPerHour, 3600e3);
  // Email verification: a 6-digit code, kept only as a hash, valid 15 minutes, 5 tries. Codes per network and per
  // address are limited so this can't be used to spam someone's inbox.
  // ponytail: pending codes live in this process; a restart means asking for a new code. Valkey if we run replicas.
  const pending = new Map(); // username → { hash, email, expires, tries }
  const codeLimitIp = new RateLimiter(10, 3600e3), codeLimitEmail = new RateLimiter(3, 3600e3);
  const hashCode = (code) => createHash('sha256').update(`openmail-signup:${code}`).digest();
  const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/.test(e);
  const checkLimit = new RateLimiter(cfg.checksPerMinute, 60e3);
  const auth = 'Basic ' + Buffer.from(`${cfg.admin.user}:${cfg.admin.pass}`).toString('base64');
  let domainId = null;

  async function jmap(methodCalls, extra = []) {
    const res = await fetch(`${cfg.stalwartUrl}/jmap/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap', ...extra], methodCalls }),
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
        if (size > limit) reject(413); // keep draining (bounded by the request timer in createApp) so the 413 can still be sent
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

    // Step 1 of 2 (when verification is on): send a code to the person's existing address, create nothing yet.
    const recoveryEmail = typeof body.recoveryEmail === 'string' ? body.recoveryEmail.trim().toLowerCase() : '';
    let verifiedEmail = ''; // only ever set after a code check passes
    if (cfg.verifyEmail) {
      if (!validEmail(recoveryEmail)) return fail(res, 400, 'email_required', 'Enter an email address you already use. We’ll send it a code.', { field: 'recoveryEmail' });
      if (recoveryEmail.endsWith(`@${cfg.domain}`)) return fail(res, 400, 'email_same_domain', `Use an address outside ${cfg.domain}.`, { field: 'recoveryEmail' });
      const given = typeof body.verifyCode === 'string' ? body.verifyCode.replace(/\s/g, '') : '';
      if (!given) {
        if (await exists(username).catch(() => false)) return fail(res, 409, 'username_taken', MSG.taken, { field: 'username' });
        const w = codeLimitIp.take(ipKey(ip)) || codeLimitEmail.take(recoveryEmail);
        if (w) return tooMany(res, w);
        const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
        pending.set(username, { hash: hashCode(c), email: recoveryEmail, expires: Date.now() + 15 * 60e3, tries: 0 });
        try {
          await (cfg.mailer ?? sendMail)(cfg.systemMail, { from: cfg.systemMail.from, to: recoveryEmail, subject: `Your ${cfg.domain} code: ${c}`,
            text: `Your code to create ${username}@${cfg.domain} is ${c}.\n\nIt works for 15 minutes. If you didn’t ask for this, ignore this email: nothing was created.` });
        } catch (e) {
          pending.delete(username);
          console.error('signup: sending the code failed:', e.message);
          return fail(res, 503, 'unavailable', 'We couldn’t send the code right now. Please try again in a few minutes.');
        }
        return send(res, 202, { ok: true, needCode: true, sentTo: recoveryEmail.replace(/^(.)[^@]*/, '$1•••') });
      }
      const p = pending.get(username);
      if (!p || p.expires < Date.now() || p.email !== recoveryEmail) return fail(res, 400, 'code_expired', 'That code has expired. Ask for a new one.', { field: 'verifyCode' });
      if (++p.tries > 5) { pending.delete(username); return fail(res, 429, 'code_tries', 'Too many wrong codes. Ask for a new one.', { field: 'verifyCode' }); }
      const ok = /^\d{6}$/.test(given) && timingSafeEqual(hashCode(given), p.hash);
      if (!ok) return fail(res, 400, 'code_wrong', 'That code isn’t right. Check the latest email.', { field: 'verifyCode' });
      pending.delete(username);
      verifiedEmail = p.email;
    }

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
        description: `Self sign-up ${new Date().toISOString()}${cfg.inviteRequired ? ` (invite ${code})` : ''}${verifiedEmail ? ` · verified ${verifiedEmail}` : ''}`,
        credentials: { 0: { '@type': 'Password', secret: password } },
        ...(cfg.quotaBytes > 0 && { quotas: { maxDiskQuota: cfg.quotaBytes } }),
      } } }, 'c']]);
    } catch (e) {
      refund();
      console.error('signup: create failed:', e.message);
      return fail(res, 503, 'unavailable', MSG.unavailable);
    }
    if (r.created?.n) {
      // New accounts start on the lower sending tier (install.sh rules); failing to mark one is logged, not fatal.
      // Fail safe: retry once; if it still fails, the hourly job adds it (any self-sign-up still inside the window).
      await tiers.markNew(`${username}@${cfg.domain}`).catch(() => tiers.markNew(`${username}@${cfg.domain}`))
        .catch((e) => console.error('signup: tier mark failed, the hourly job will add it:', e.message));
      return send(res, 201, { ok: true, email: `${username}@${cfg.domain}` });
    }

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

  const aliases = aliasRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf: (req) => ipKey(clientIp(req)) });
  const tiers = makeTiers({ jmap, getDomainId, cfg });
  // Promote aged-out new accounts once an hour (and shortly after start); this also adds young self-sign-ups missing
  // from the list. unref: never keeps the process alive.
  if (cfg.signupEnabled !== false) {
    const run = () => tiers.promote().then((p) => p.length && console.log('tiers: promoted', p.length), (e) => console.error('tiers:', e.message));
    setTimeout(run, 60_000).unref(); setInterval(run, 3600e3).unref();
  }
  const account = accountRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, clientIp, ipOf: (req) => ipKey(clientIp(req)) });
  const retentionStore = policyStore(cfg.retentionFile);
  const files = fileRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter, ipOf: (req) => ipKey(clientIp(req)) });
  const abuse = abuseRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter, clientIp, ipOf: (req) => ipKey(clientIp(req)) });
  const arf = cfg.arf ? arfJob({ cfg, jmap, getDomainId, complaint: abuse.complaint }) : null;
  if (arf && cfg.eventsUrl) { // with the rest of the abuse jobs (a service started without EVENTS_URL is a test or a sidecar)
    const run = () => arf().catch((e) => console.error('arf:', e.message));
    setTimeout(run, 30_000).unref(); setInterval(run, 5 * 60e3).unref();
  }
  const hold = holdRoutes({ cfg, jmap, getDomainId, send, fail, readJson, abuse });
  const admin = adminRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, abuse, hold, ipOf: (req) => ipKey(clientIp(req)), retention: retentionStore });
  const domains = cfg.customDomains === false ? null : domainRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf: (req) => ipKey(clientIp(req)) });
  // Re-check every claimed domain's TXT record every 6 hours (a missing one pauses the domain after 7 days).
  if (domains) setInterval(() => domains.recheckAll().catch((e) => console.error('domains:', e.message)), 6 * 3600e3).unref();
  const wkd = wkdRoutes({ cfg, jmap, getDomainId, RateLimiter, ipOf: (req) => ipKey(clientIp(req)) });
  const bimi = bimiRoutes({ RateLimiter, ipOf: (req) => ipKey(clientIp(req)), enabled: cfg.bimiLogos === true });
  const sharing = sharingRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter });
  const mailJmap = (calls) => jmap(calls, ['urn:ietf:params:jmap:mail']); // retention reads and destroys mail
  const retention = retentionRoutes({ cfg, jmap: mailJmap, getDomainId, send, fail, readJson, RateLimiter, ipOf: (req) => ipKey(clientIp(req)), store: retentionStore });
  // The retention job: daily, first run a few minutes after start. Only does work when a rule is set.
  if (cfg.retentionJob !== false) {
    const run = () => sweep({ jmap: mailJmap, policy: retentionStore.get(), dryRun: false, log: console.log }).catch((e) => console.error('retention:', e.message));
    setTimeout(run, 5 * 60e3).unref(); setInterval(run, 86400e3).unref();
  }
  const sso = cfg.oidc ? ssoRoutes({ cfg, send, fail, RateLimiter, ipOf: (req) => ipKey(clientIp(req)) }) : null;
  const session = sessionRoutes({ cfg, send, fail, readJson, RateLimiter, ipOf: (req) => ipKey(clientIp(req)), sso });

  const server = Object.assign(createServer(async (req, res) => {
    // Our own request timeout instead of server.requestTimeout, so that one route can lengthen it: a client gets
    // 15 s to send the whole request. Only a signed-in file upload (files.mjs) may ask for more, by size.
    const limit = (ms) => setTimeout(() => { if (!req.complete) req.destroy(); }, ms).unref();
    let timer = limit(cfg.requestTimeoutMs ?? 15_000);
    req.allowSlowBody = (ms) => { clearTimeout(timer); timer = limit(ms); };
    res.once('close', () => clearTimeout(timer));
    try {
      // Route only on the path as sent. Caddy's /f/* matches "//f/api/events", which new URL() reads as host "f" and
      // path /api/events; "/f/..\\internal/…" and "/f/%2e%2e/…" are cleaned to "/internal/…" the same way. Either way
      // the internal-only routes (events, MTA hook) would be reachable from outside.
      const url = new URL(req.url, 'http://x');
      if (!/^\/(?!\/)/.test(req.url) || url.pathname !== req.url.split('?')[0]) return fail(res, 400, 'bad_request', 'Bad request.');
      if (url.pathname.startsWith('/api/aliases') && await aliases(req, res, url)) return;
      if (url.pathname === '/api/account' && await account(req, res, url)) return;
      if (url.pathname.startsWith('/api/session/') && await session(req, res, url)) return;
      if (url.pathname.startsWith('/api/admin/') && await admin(req, res, url)) return;
      if (url.pathname === '/api/principal' && await sharing(req, res, url)) return;
      if ((url.pathname.startsWith('/api/files') || url.pathname.startsWith('/f/')) && await files(req, res, url)) return;
      if (domains && url.pathname.startsWith('/api/domains') && await domains(req, res, url)) return;
      if (/^\/api\/(events|blocked|sending)/.test(url.pathname) && await abuse(req, res, url)) return;
      if (url.pathname === '/api/retention' && await retention(req, res, url)) return;
      if (sso && url.pathname.startsWith('/api/sso') && await sso.handle(req, res, url)) return;
      // Called by Stalwart only (not under /api/, so the proxy never forwards it), with the hook secret.
      if (url.pathname === '/internal/outbound-hook' && req.method === 'POST' && hold) return await hold.hook(req, res);
      if (url.pathname.startsWith('/.well-known/openpgpkey/') && await wkd(req, res, url)) return;
      if (url.pathname.startsWith('/api/bimi/') && await bimi(req, res, url)) return;
      if (cfg.signupEnabled !== false) {
        if (url.pathname === '/api/signup' && req.method === 'POST') return await signup(req, res);
        if (url.pathname === '/api/username-available' && req.method === 'GET') return await available(req, res, url);
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      fail(res, 404, 'not_found', 'Not found.');
    } catch (e) {
      console.error('unhandled:', e);
      if (!res.headersSent) fail(res, 500, 'internal', 'Something went wrong on our side. Please try again.');
    }
  }), { domains, abuse, arf }); // tests drive the domain re-check and the abuse jobs directly
  server.requestTimeout = 0; // the timer above replaces it (headersTimeout still applies)
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = configFromEnv();
  const server = createApp(cfg);
  server.headersTimeout = 10_000;
  server.listen(cfg.port, cfg.host, () =>
    console.log(`signup service on ${cfg.host}:${cfg.port} → ${cfg.stalwartUrl}, domain ${cfg.domain}, invites ${cfg.inviteRequired ? 'required' : 'off'}, captcha ${cfg.turnstileSecret ? 'on' : 'off'}`));
}
