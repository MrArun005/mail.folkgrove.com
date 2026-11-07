// Retention: how long mail is kept, and legal hold.
//
// What Stalwart (1.0.3, open source) does itself, and we only expose:
// - Trash and Junk empty themselves after `x:DataRetention.expungeTrashAfter` (default 30 days), server-wide.
// What this service adds, because Stalwart has no setting for it:
// - "Delete mail older than N days", server-wide or per account, and a user's own "empty my Trash and Junk after N days"
//   (shorter than the server's). A daily job asks each account's JMAP for mail received before the cut-off and destroys
//   it. Admins see a dry-run count before a rule is saved, and every run logs what it removed.
// - Legal hold: Stalwart's own permissions. A held account loses the right to destroy mail or folders (JMAP destroy,
//   IMAP EXPUNGE / mailbox DELETE, POP3 DELE), so the person can move mail to Trash but not erase it; this job skips
//   it; the account can't be deleted here or by its owner. Verified on the dev server, 2026-11-08.
//   ponytail: Stalwart's own Trash/Junk auto-empty is a server-wide task and isn't per account; it is NOT stopped
//   by the hold (not verifiable without emptying every account's Trash). Archiving deleted items (undelete) is
//   Stalwart Enterprise. Turn auto-empty off while an account is on hold, or wait for per-account expunge upstream.
//
// Dates: "received before" (JMAP `before`, the receivedAt date). ponytail: JMAP has no "moved to Trash at", so a
// user's Trash rule removes an old message on the next run after it's moved there. Good enough for "auto-empty".
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { callerOf } from './aliases.mjs';

export const HOLD = ['jmapEmailDestroy', 'jmapMailboxDestroy', 'imapExpunge', 'imapDelete', 'pop3Dele'];
export const isHeld = (p) => !!p?.disabledPermissions?.jmapEmailDestroy;
const DAY = 86400e3;

/** The permissions object with these permissions taken away (off) or given back, keeping all others. */
export function withPermissions(p = { '@type': 'Inherit' }, names, off) {
  const base = p['@type'] === 'Inherit' ? { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: {} } : structuredClone(p);
  base.disabledPermissions = { ...base.disabledPermissions };
  for (const n of names) if (off) base.disabledPermissions[n] = true; else delete base.disabledPermissions[n];
  const empty = base['@type'] === 'Merge' && !Object.keys(base.disabledPermissions).length && !Object.keys(base.enabledPermissions ?? {}).length;
  return empty ? { '@type': 'Inherit' } : base;
}

/** Policy file: { maxAgeDays, accounts: { [id]: { maxAgeDays?, trashDays? } } }. maxAgeDays 0/null = keep forever. */
export function policyStore(file) {
  let p = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  p.accounts ??= {};
  return {
    get: () => p,
    save(next) {
      for (const [id, r] of Object.entries(next.accounts ?? {})) if (!Object.values(r).some((v) => v != null)) delete next.accounts[id];
      p = next;
      if (file) { writeFileSync(file + '.tmp', JSON.stringify(p, null, 1)); renameSync(file + '.tmp', file); }
    },
  };
}

/** Rules for one account: { maxAgeDays, trashDays } (0 = none). An account-level 0 exempts it from the server rule. */
export const rulesFor = (policy, id) => ({ maxAgeDays: policy.accounts?.[id]?.maxAgeDays ?? policy.maxAgeDays ?? 0, trashDays: policy.accounts?.[id]?.trashDays ?? 0 });

/**
 * Count (dryRun) or destroy what the rules say has expired, account by account. Returns one row per account with a rule:
 * { id, email, held, old, trash } (messages over the age limit; messages in Trash/Junk past the user's limit).
 * ponytail: accounts one after another, at most 50,000 messages each per run; a big first run finishes over a few days.
 */
export async function sweep({ jmap, policy, dryRun = true, now = Date.now(), log = () => {} }) {
  if (!policy.maxAgeDays && !Object.keys(policy.accounts ?? {}).length) return [];
  const { ids } = await jmap([['x:Account/query', { filter: { '@type': 'User' }, limit: 100_000 }, 'q']]);
  const list = ids.length ? (await jmap([['x:Account/get', { ids, properties: ['emailAddress', 'permissions'] }, 'g']])).list : [];
  const rows = [];
  for (const a of list) {
    const r = rulesFor(policy, a.id);
    if (!r.maxAgeDays && !r.trashDays) continue;
    const row = { id: a.id, email: a.emailAddress, held: isHeld(a.permissions), old: 0, trash: 0 };
    rows.push(row);
    if (row.held) continue; // legal hold: nothing is removed
    const filters = [];
    if (r.maxAgeDays) filters.push(['old', { before: new Date(now - r.maxAgeDays * DAY).toISOString() }]);
    if (r.trashDays) {
      const boxes = (await jmap([['Mailbox/get', { accountId: a.id, properties: ['role'] }, 'm']])).list.filter((b) => b.role === 'trash' || b.role === 'junk');
      if (boxes.length) filters.push(['trash', { operator: 'AND', conditions: [
        { operator: 'OR', conditions: boxes.map((b) => ({ inMailbox: b.id })) }, { before: new Date(now - r.trashDays * DAY).toISOString() }] }]);
    }
    for (const [kind, filter] of filters) {
      if (dryRun) { row[kind] = (await jmap([['Email/query', { accountId: a.id, filter, calculateTotal: true, limit: 1 }, 'q']])).total ?? 0; continue; }
      for (let n = 0; n < 100; n++) { // 100 × 500
        const page = (await jmap([['Email/query', { accountId: a.id, filter, limit: 500 }, 'q']])).ids;
        if (!page.length) break;
        const d = await jmap([['Email/set', { accountId: a.id, destroy: page }, 'd']]);
        row[kind] += d.destroyed?.length ?? 0;
        if (!d.destroyed?.length) break; // refused: stop rather than loop
      }
    }
    if (!dryRun && (row.old || row.trash)) log(`retention: ${row.email}: removed ${row.old} past the age limit, ${row.trash} from Trash/Junk`);
  }
  return rows;
}

const days = (v, min, max) => v === null || v === 0 || (Number.isInteger(v) && v >= min && v <= max);

/** /api/retention: the signed-in person's own rule ("empty my Trash and Junk after N days"). */
export function retentionRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf, store }) {
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3);
  const serverTrashDays = async () => {
    const ms = (await jmap([['x:DataRetention/get', { ids: ['singleton'], properties: ['expungeTrashAfter'] }, 'r']])).list[0]?.expungeTrashAfter;
    return ms ? Math.round(ms / DAY) : null;
  };
  return async function handle(req, res, url) {
    if (url.pathname !== '/api/retention') return false;
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);
    const policy = store.get();
    if (req.method === 'PUT') {
      const body = await readJson(req).catch(() => ({}));
      if (!days(body.trashDays, 1, 365)) return fail(res, 400, 'bad_days', 'Choose a number of days between 1 and 365.'), true;
      store.save({ ...policy, accounts: { ...policy.accounts, [who.id]: { ...policy.accounts[who.id], trashDays: body.trashDays || null } } });
    } else if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    const r = rulesFor(store.get(), who.id);
    const [a] = (await jmap([['x:Account/get', { ids: [who.id], properties: ['permissions'] }, 'g']])).list;
    return send(res, 200, { ok: true, trashDays: r.trashDays || null, serverTrashDays: await serverTrashDays(), maxAgeDays: r.maxAgeDays || null, held: isHeld(a?.permissions) }), true;
  };
}

/** Admin console handlers (mounted by admin.mjs under /api/admin/retention). */
export function retentionAdmin({ jmap, store, isAdmin }) {
  const set = async (type, args) => {
    const r = await jmap([[`${type}/set`, args, 's']]);
    const bad = r.notCreated ?? r.notUpdated ?? r.notDestroyed;
    if (bad && Object.keys(bad).length) throw Object.assign(new Error(`${type}/set refused`), { detail: Object.values(bad)[0] });
  };
  const view = async () => {
    const policy = store.get();
    const ms = (await jmap([['x:DataRetention/get', { ids: ['singleton'], properties: ['expungeTrashAfter'] }, 'r']])).list[0]?.expungeTrashAfter ?? null;
    const { ids } = await jmap([['x:Account/query', { filter: { '@type': 'User' }, limit: 100_000 }, 'q']]);
    const list = ids.length ? (await jmap([['x:Account/get', { ids, properties: ['emailAddress', 'permissions'] }, 'g']])).list : [];
    const accounts = list.filter((a) => isHeld(a.permissions) || policy.accounts[a.id])
      .map((a) => ({ id: a.id, email: a.emailAddress, held: isHeld(a.permissions), maxAgeDays: policy.accounts[a.id]?.maxAgeDays ?? null, trashDays: policy.accounts[a.id]?.trashDays ?? null }));
    return { trashJunkDays: ms === null ? null : Math.round(ms / DAY), maxAgeDays: policy.maxAgeDays || null, accounts };
  };
  /** Body → a policy (not saved): server rule and/or one account's rule. Returns [policy] or [status, code, message]. */
  const proposed = (body) => {
    const p = structuredClone(store.get());
    if ('maxAgeDays' in body) { if (!days(body.maxAgeDays, 30, 36500)) return [400, 'bad_days', 'Keep mail at least 30 days.']; p.maxAgeDays = body.maxAgeDays || null; }
    if (body.accountId) {
      if (!('accountMaxAgeDays' in body) || !(body.accountMaxAgeDays === null || days(body.accountMaxAgeDays, 30, 36500))) return [400, 'bad_days', 'Keep mail at least 30 days, or choose 0 to keep it forever.'];
      p.accounts[body.accountId] = { ...p.accounts[body.accountId], maxAgeDays: body.accountMaxAgeDays };
    }
    return [p];
  };
  const account = async (id) => (await jmap([['x:Account/get', { ids: [id], properties: ['name', 'emailAddress', 'permissions', 'roles'] }, 'g']])).list[0];

  return {
    'GET retention': view,
    'PUT retention': async (body) => {
      if ('trashJunkDays' in body) {
        if (!days(body.trashJunkDays, 1, 3650)) return [400, 'bad_days', 'Choose a number of days between 1 and 3650, or 0 to never empty them.'];
        await set('x:DataRetention', { update: { singleton: { expungeTrashAfter: body.trashJunkDays ? body.trashJunkDays * DAY : null } } });
      }
      const [p, ...err] = proposed(body);
      if (err.length) return [p, ...err];
      store.save(p);
      return view();
    },
    /** Dry run: what the proposed rules would remove now. Nothing is deleted. */
    'POST retention/preview': async (body) => {
      const [p, ...err] = proposed(body);
      if (err.length) return [p, ...err];
      const rows = await sweep({ jmap, policy: p, dryRun: true });
      return { accounts: rows, messages: rows.reduce((n, r) => n + r.old + r.trash, 0) };
    },
    'POST retention/run': async (_body, log) => {
      const rows = await sweep({ jmap, policy: store.get(), dryRun: false, log });
      return { accounts: rows, messages: rows.reduce((n, r) => n + r.old + r.trash, 0) };
    },
    /** One account: { maxAgeDays: N | 0 (keep forever) | null (server rule) } and/or { hold: true | false }. */
    'PATCH retention/:id': async (body, _log, id) => {
      const a = await account(id);
      if (!a) return [404, 'not_found', 'That account no longer exists.'];
      if ('maxAgeDays' in body) {
        const [p, ...err] = proposed({ accountId: id, accountMaxAgeDays: body.maxAgeDays });
        if (err.length) return [p, ...err];
        store.save(p);
      }
      if (typeof body.hold === 'boolean') {
        if (isAdmin(a)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
        await set('x:Account', { update: { [id]: { permissions: withPermissions(a.permissions, HOLD, body.hold) } } });
      }
      return view();
    },
  };
}
