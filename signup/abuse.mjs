// Outgoing abuse: an account that trips the sending limits hard gets its sending suspended automatically (reading
// still works), can lift that itself once, and needs an admin the second time. Also: last sign-in per account, for
// the inactive-account policy (docs/legal/inactive-accounts.md), and "is my network blocked?" for the sign-in form.
//
// The signal: Stalwart 1.0.3 has no last-login field and no per-account counters; its log (x:Log) needs a log-file
// tracer and its delivery history (x:Trace) is Enterprise. What it does have is a webhook (x:WebHook) that posts
// events as they happen. This service registers one for itself at start (EVENTS_URL), with a fresh signing key:
//   auth.success                        accountName, spanId   → last sign-in; who owns an SMTP session
//   queue.authenticated-message-queued  from, queueId         → mail an account sent
//   smtp.rate-limit-exceeded            from, spanId          → a throttle refused a message (spanId 0 = JMAP)
//   delivery.dsn-perm-fail              queueId               → a hard bounce of that mail
// Rate-limit and bounce events count only when they belong to a signed-in sender (by session or by queued message),
// so mail forged with someone's address on port 25 can't get them suspended.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { callerOf } from './aliases.mjs';
import { withPerms } from './admin.mjs';
import { sendMail } from './mailer.mjs';

/** What a suspension takes away (verified on 1.0.3): SMTP submission, JMAP EmailSubmission, calendar invitations. */
export const SEND = ['emailSend', 'jmapEmailSubmissionCreate', 'calendarSchedulingSend'];
const EVENTS = ['auth.success', 'queue.authenticated-message-queued', 'smtp.rate-limit-exceeded', 'delivery.dsn-perm-fail'];
const DAY = 86400e3;

/** Whether the account may lift its own suspension now: 'ok', 'wait' (one per 24 hours) or 'admin'. */
export function selfUnblock(history = [], now = Date.now()) {
  const cur = history.at(-1);
  if (!cur || cur.liftedAt) return 'ok';
  if (cur.by) return 'admin'; // an administrator suspended it
  if (history.filter((h) => now - h.at < 7 * DAY).length >= 2) return 'admin'; // second time within 7 days
  const lastSelf = history.findLast((h) => h.liftedBy === 'self')?.liftedAt;
  return lastSelf && now - lastSelf < DAY ? 'wait' : 'ok';
}

/** The daily job's step for one account: null, a reminder (its days-before threshold), or 'due' (the time is up). */
export function inactiveStep({ last, now, days, remind = [60, 30, 7], reminded }) {
  const left = Math.ceil((last + days * DAY - now) / DAY);
  if (left <= 0) return 'due';
  const r = Math.min(...remind.filter((d) => left <= d)); // the most urgent reminder that applies (Infinity: none)
  return r !== Infinity && !(reminded <= r) ? r : null;
}

/** Signature check for a webhook body: base64 HMAC-SHA256 in X-Signature (verified against Stalwart 1.0.3). */
export function signed(key, body, sig) {
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(String(sig ?? ''), 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Event ids are 64-bit integers: keep them as strings so two messages never round to the same number. */
export const parseEvents = (text) => JSON.parse(text.replace(/"(spanId|queueId)":(\d+)/g, '"$1":"$2"')).events ?? [];

// ponytail: one JSON file, rewritten whole (a couple of seconds after a change). Fine for tens of thousands of
// accounts and one service instance; a table in the database when it isn't.
function loadState(file) {
  const s = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  s.since ??= Date.now(); // when tracking started: nobody counts as inactive from before this
  s.seen ??= {}; s.suspensions ??= {}; s.inactive ??= {};
  let timer = null;
  const write = () => { timer = null; writeFileSync(file + '.tmp', JSON.stringify(s)); renameSync(file + '.tmp', file); };
  Object.defineProperty(s, 'save', { value: () => { if (file && !timer) (timer = setTimeout(write, 2000)).unref(); } });
  if (file && !existsSync(file)) write();
  return s;
}

const bounded = (max) => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); } };
};

export function abuseRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter, ipOf, clientIp = () => '' }) {
  const state = loadState(cfg.stateFile);
  if (!cfg.stateFile) console.warn('abuse: STATE_FILE is not set; suspensions and sign-in times are only kept until restart');
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  const addr = (s) => (s = lower(s)) && (s.includes('@') ? s : `${s}@${cfg.domain}`);
  const admins = new Set(cfg.admins ?? []);
  const systemAddr = lower(cfg.systemMail?.user);
  const isProtected = (a) => a.roles?.['@type'] !== 'User' || admins.has(lower(a.name)) || lower(a.emailAddress) === systemAddr;
  const PROPS = ['name', 'emailAddress', 'aliases', 'permissions', 'roles', 'createdAt', 'description'];
  const getAccounts = async (ids) => { // 500 at a time (Stalwart's maxObjectsInGet)
    const out = [];
    for (let i = 0; i < ids.length; i += 500) out.push(...(await jmap([['x:Account/get', { ids: ids.slice(i, i + 500), properties: PROPS }, 'g']])).list);
    return out;
  };
  const update = async (id, patch) => {
    const r = await jmap([['x:Account/set', { update: { [id]: patch } }, 'u']]);
    if (!r.updated || !(id in r.updated)) throw Object.assign(new Error('update refused'), { detail: r.notUpdated?.[id] });
  };
  const sendingOff = (a) => !!a.permissions?.disabledPermissions?.emailSend;

  /** The account an address belongs to: its own name, or an alias (Stalwart's text search covers aliases). */
  async function findAccount(address) {
    const [local, domain] = address.split('@');
    if (domain !== cfg.domain) return null;
    const domainId = await getDomainId();
    let { ids } = await jmap([['x:Account/query', { filter: { name: local, domainId } }, 'q']]);
    if (!ids.length) ids = (await jmap([['x:Account/query', { filter: { text: local, domainId } }, 'q']])).ids.slice(0, 20);
    return (await getAccounts(ids)).find((a) => lower(a.emailAddress) === address
      || Object.values(a.aliases ?? {}).some((x) => lower(x.name) === local && x.domainId === domainId)) ?? null;
  }

  // ── Suspend and lift ──
  const hits = new RateLimiter(cfg.abuseLimitHits ?? 10, 3600e3);
  const bounces = new RateLimiter(cfg.abuseBounces ?? 20, 3600e3);
  const busy = new Set();

  /** Switch sending off for an account (fetched with PROPS) and remember why. by = admin name, or none (automatic). */
  async function suspendAccount(a, reason, by) {
    if (sendingOff(a)) return false;
    await update(a.id, { permissions: withPerms(a.permissions, SEND, false) });
    const key = lower(a.emailAddress);
    (state.suspensions[key] ??= []).push({ id: a.id, at: Date.now(), reason, ...(by && { by }) });
    state.suspensions[key] = state.suspensions[key].slice(-20);
    state.save();
    console.log(`abuse: sending suspended for ${key}: ${reason}${by ? ` (by ${by})` : ''}`);
    return true;
  }
  async function liftAccount(a, by) {
    await update(a.id, { permissions: withPerms(a.permissions, SEND, true) });
    const key = lower(a.emailAddress), cur = state.suspensions[key]?.at(-1);
    if (cur && !cur.liftedAt) Object.assign(cur, { liftedAt: Date.now(), liftedBy: by });
    for (const l of [hits, bounces]) l.hits.delete(key); // a fresh start, not an instant re-suspension
    state.save();
    console.log(`abuse: sending allowed again for ${key} (${by === 'self' ? 'by the account itself' : `by ${by}`})`);
  }
  async function autoSuspend(address, reason) {
    if (busy.has(address)) return;
    busy.add(address);
    try {
      const a = await findAccount(address);
      if (!a) return;
      for (const l of [hits, bounces]) l.hits.delete(address);
      if (!isProtected(a)) await suspendAccount(a, reason);
    } catch (e) { console.error(`abuse: suspending ${address} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : ''); }
    finally { busy.delete(address); }
  }

  // ── Events from Stalwart ──
  const spans = bounded(50_000); // SMTP session → signed-in account
  const queued = bounded(200_000); // queued message → sender; ponytail: a bounce later than ~200k messages is missed
  const hookKey = randomBytes(32).toString('base64url');
  function onEvent(e) {
    const d = e.data ?? {};
    if (e.type === 'auth.success' && d.accountName) {
      const who = addr(d.accountName);
      spans.set(d.spanId, who);
      // To the hour is plenty (and keeps the file quiet).
      if (!(Date.now() - (state.seen[who] ?? 0) < 3600e3)) { state.seen[who] = Date.now(); state.save(); }
    } else if (e.type === 'queue.authenticated-message-queued' && d.from) queued.set(d.queueId, addr(d.from));
    else if (e.type === 'smtp.rate-limit-exceeded' && d.from) {
      const who = d.spanId === '0' ? addr(d.from) : spans.get(d.spanId); // 0: submitted over JMAP (always signed in)
      if (who?.endsWith(`@${cfg.domain}`) && hits.take(who)) autoSuspend(who, `The sending limit refused more than ${hits.limit} messages in an hour.`);
    } else if (e.type === 'delivery.dsn-perm-fail') {
      const who = queued.get(d.queueId);
      if (who?.endsWith(`@${cfg.domain}`) && bounces.take(who)) autoSuspend(who, `More than ${bounces.limit} messages bounced (addresses that don’t exist) in an hour.`);
    }
  }

  let hookReady = false;
  async function ensureHook() {
    if (!cfg.eventsUrl || hookReady) return;
    const { list } = await jmap([['x:WebHook/get', { ids: null, properties: ['url'] }, 'g']]);
    const id = list.find((h) => h.url === cfg.eventsUrl)?.id;
    const hook = { url: cfg.eventsUrl, enable: true, eventsPolicy: 'include', events: Object.fromEntries(EVENTS.map((e) => [e, true])),
      lossy: false, signatureKey: { '@type': 'Value', secret: hookKey } };
    const r = await jmap([['x:WebHook/set', id ? { update: { [id]: hook } } : { create: { h: hook } }, 'w']]);
    if (!(id ? r.updated && id in r.updated : r.created?.h)) throw new Error(`webhook refused: ${JSON.stringify(r.notUpdated ?? r.notCreated)}`);
    await jmap([['x:Action/set', { create: { a: { '@type': 'ReloadSettings' } } }, 'a']]);
    hookReady = true;
    console.log(`abuse: Stalwart sends events to ${cfg.eventsUrl}`);
  }

  // ── Inactive accounts (daily) ──
  const months = cfg.inactiveMonths ?? 0;
  const days = Math.round((months * 365) / 12);
  async function inactiveJob(now = Date.now()) {
    // ponytail: one query and one get for every account. Fine to a few thousand; page through past Stalwart's query limit.
    const { ids, total } = await jmap([['x:Account/query', { filter: { '@type': 'User', domainId: await getDomainId() }, calculateTotal: true }, 'q']]);
    const accounts = await getAccounts(ids), out = [];
    // Deleted accounts leave nothing behind here (a day later at most). Only from a complete list.
    const live = new Set(accounts.map((a) => lower(a.emailAddress)));
    if (ids.length && ids.length === total && accounts.length === ids.length) for (const map of [state.seen, state.suspensions, state.inactive]) for (const k of Object.keys(map)) if (!live.has(k)) delete map[k];
    for (const a of months ? accounts : []) {
      const key = lower(a.emailAddress);
      if (isProtected(a)) continue;
      const last = Math.max(state.seen[key] ?? 0, Date.parse(a.createdAt) || 0, state.since);
      let rec = state.inactive[key];
      if (rec && last > rec.at) { delete state.inactive[key]; rec = undefined; } // signed in since: the clock restarts
      const step = inactiveStep({ last, now, days, reminded: rec?.reminded });
      if (step === 'due') {
        if (!rec?.dueAt) { state.inactive[key] = { ...rec, id: a.id, at: now, dueAt: now }; out.push(key); console.log(`inactive: ${key} is due for blocking (no sign-in since ${new Date(last).toISOString().slice(0, 10)})`); }
      } else if (step) {
        if (!cfg.systemMail) { console.warn('inactive: SYSTEM_SMTP_USER is not set, so reminders can’t be sent'); continue; }
        const by = new Date(last + days * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const verified = /· verified (\S+)/.exec(a.description ?? '')?.[1];
        try {
          for (const to of [key, verified].filter(Boolean)) await (cfg.mailer ?? sendMail)(cfg.systemMail, { from: cfg.systemMail.from, to,
            subject: `Your mailbox ${key} will be blocked on ${by}`,
            text: `Hello,\n\nNobody has signed in to ${key} for a long time. To keep it, sign in once before ${by}: the web app, a mail app or your phone all count.\n\nIf nobody signs in by then, the mailbox is blocked: new mail to it is refused and signing in is switched off. The address is never given to anyone else.\n\nThis is our inactive-account policy. If you don’t need this mailbox any more, you can ignore this email.` });
          state.inactive[key] = { id: a.id, reminded: step, at: now };
          out.push(key);
          console.log(`inactive: reminded ${key} (${step} days left)`);
        } catch (e) { console.error(`inactive: reminder to ${key} failed:`, e.message); }
      }
    }
    state.save();
    return out;
  }

  // Jobs. unref: they never keep the process alive.
  if (cfg.eventsUrl) {
    const hook = () => ensureHook().catch((e) => console.error('abuse: registering the webhook failed (retrying hourly):', e.message));
    setTimeout(hook, 3000).unref(); setInterval(hook, 3600e3).unref();
  }
  if (months && !cfg.eventsUrl) console.warn('inactive: INACTIVE_MONTHS needs EVENTS_URL (sign-ins come from Stalwart events); reminders are off');
  if (cfg.eventsUrl) {
    const run = () => inactiveJob().catch((e) => console.error('inactive:', e.message));
    setTimeout(run, 120_000).unref(); setInterval(run, DAY).unref();
  }

  // ── HTTP ──
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3); // bad tokens per network (as in aliases.mjs)
  const asks = new RateLimiter(10, 3600e3); // unblock requests per account
  const ipChecks = new RateLimiter(30, 60e3); // "am I blocked?" per network
  const readRaw = (req, limit = 2 << 20) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => (size > limit ? reject(413) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });

  /** The caller's sending status, as the web app's banner shows it. */
  function status(a) {
    const history = state.suspensions[lower(a.emailAddress)] ?? [];
    const cur = history.at(-1);
    if (!sendingOff(a)) return { suspended: false };
    const known = cur && !cur.liftedAt;
    const can = known ? selfUnblock(history) : 'admin'; // switched off in Stalwart directly: an admin's doing
    const lastSelf = history.findLast((h) => h.liftedBy === 'self')?.liftedAt;
    return { suspended: true, reason: known ? cur.reason : 'An administrator switched off sending for this account.', since: known ? new Date(cur.at).toISOString() : null,
      unblock: can, ...(can === 'wait' && { retryAfter: Math.ceil((lastSelf + DAY - Date.now()) / 1000) }) };
  }

  const handle = async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/events') {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
      const body = await readRaw(req).catch(() => null);
      if (!body || !signed(hookKey, body, req.headers['x-signature'])) return fail(res, 401, 'unauthorized', 'Bad signature.'), true;
      let events;
      try { events = parseEvents(body.toString('utf8')); } catch { return fail(res, 400, 'bad_json', 'Bad events.'), true; }
      for (const e of events) onEvent(e);
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/blocked') { // public: is the caller's own network blocked for failed sign-ins?
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
      const wait = ipChecks.take(ipOf(req));
      if (wait) return fail(res, 429, 'rate_limited', 'Too many requests. Try again shortly.', { retryAfter: wait }), true;
      const ip = clientIp(req).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
      // ponytail: exact address only (what Stalwart's automatic bans store); a manually blocked range isn't matched.
      const r = ip ? await jmap([['x:BlockedIp/query', { filter: { address: ip } }, 'q']]).catch(() => ({ ids: [] })) : { ids: [] };
      const [b] = r.ids.length ? (await jmap([['x:BlockedIp/get', { ids: r.ids.slice(0, 1) }, 'g']])).list : [];
      const live = b && (!b.expiresAt || Date.parse(b.expiresAt) > Date.now());
      return send(res, 200, { ok: true, blocked: !!live, ...(live && { until: b.expiresAt ?? null, reason: b.reason }) }), true;
    }

    const m = p.match(/^\/api\/sending(\/unblock)?$/);
    if (!m) return false;
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);
    const [a] = await getAccounts([who.id]);
    if (!a) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;

    if (!m[1] && req.method === 'GET') return send(res, 200, { ok: true, ...status(a) }), true;
    if (!(m[1] && req.method === 'POST')) return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    const wait = asks.take(who.id);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many requests. Try again later.', { retryAfter: wait }), true;
    const s = status(a);
    if (!s.suspended) return send(res, 200, { ok: true, suspended: false }), true;
    if (s.unblock === 'wait') return fail(res, 429, 'wait', 'You can ask once a day. Try again tomorrow.', { retryAfter: s.retryAfter }), true;
    if (s.unblock === 'admin') return fail(res, 403, 'needs_admin', 'Sending was blocked again within a week, so an administrator has to look at it. Write to support.'), true;
    await liftAccount(a, 'self');
    return send(res, 200, { ok: true, suspended: false }), true;
  };
  return Object.assign(handle, { state, suspendAccount, liftAccount, inactiveJob, onEvent, ensureHook, hookKey, sendingOff });
}
