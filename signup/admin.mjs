// Admin console API (/api/admin/*): users, team mailboxes (groups), blocked IPs, new-account limits and the outgoing queue.
// Who is an admin: the ADMINS setting (comma-separated usernames on DOMAIN). The caller proves who they are with
// their own sign-in token (checked by Stalwart, as for aliases); then their name must be on that list.
// This is a short, explicit list of Stalwart admin operations, never a passthrough.
import { randomBytes } from 'node:crypto';
import { callerOf } from './aliases.mjs';
import { retireNames } from './account.mjs';
import { forgetFiles } from './files.mjs';
import { checkUsername } from './lib.mjs';
import { isHeld, policyStore, retentionAdmin } from './retention.mjs';
import { adminDomainList } from './domains.mjs';

const NEW = 'new-accounts'; // x:MemoryLookupKey namespace for the stricter sending tier (key = full address)
const USER_PROPS = ['name', 'emailAddress', 'description', 'createdAt', 'usedDiskQuota', 'quotas', 'aliases', 'permissions', 'roles'];
const ID = '[A-Za-z0-9_-]{1,64}';

/** One account as the console shows it. Disabled = may not sign in (Stalwart permission "authenticate" taken away). */
export function userView(a, newTier = new Set()) {
  return {
    id: a.id, name: a.name, email: a.emailAddress, description: a.description ?? '', createdAt: a.createdAt,
    used: a.usedDiskQuota ?? 0, quota: a.quotas?.maxDiskQuota ?? null,
    aliases: Object.values(a.aliases ?? {}).filter((x) => x.enable !== false).length,
    enabled: !a.permissions?.disabledPermissions?.authenticate,
    admin: a.roles?.['@type'] !== 'User', newAccount: newTier.has(String(a.emailAddress).toLowerCase()),
    sending: !a.permissions?.disabledPermissions?.emailSend, // false: suspended (abuse.mjs)
  };
}

/** The permissions object with some permissions switched on or off, keeping any other custom permissions. */
export function withPerms(p = { '@type': 'Inherit' }, keys, enabled) {
  const base = p['@type'] === 'Inherit' ? { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: {} } : structuredClone(p);
  base.disabledPermissions = { ...base.disabledPermissions };
  for (const k of keys) if (enabled) delete base.disabledPermissions[k]; else base.disabledPermissions[k] = true;
  const empty = base['@type'] === 'Merge' && !Object.keys(base.disabledPermissions).length && !Object.keys(base.enabledPermissions ?? {}).length;
  return empty ? { '@type': 'Inherit' } : base;
}
/** The permissions object with sign-in switched on or off. */
export const withSignIn = (p, enabled) => withPerms(p, ['authenticate'], enabled);

/** One queued message: who sent it, and per recipient its status, attempts and last error. */
export function queueView(m) {
  return {
    id: m.id, from: m.returnPath, createdAt: m.createdAt, nextRetry: m.nextRetry ?? null, size: m.size ?? 0,
    recipients: Object.entries(m.recipients ?? {}).map(([to, r]) => ({
      to, status: r.status?.['@type'] ?? 'Scheduled', attempts: r.retryCount ?? 0, nextAttempt: r.retryDue ?? null,
      error: r.status?.errorMessage || r.status?.responseMessage || null,
      code: [r.status?.responseCode, r.status?.responseEnhanced].filter(Boolean).join(' ') || null,
    })),
  };
}

const password = () => randomBytes(12).toString('base64url'); // 16 characters, about 96 bits

export function adminRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf, abuse, hold = null, retention = policyStore(null) }) {
  const admins = new Set(cfg.admins ?? []);
  // Admin rights go by name, so admin names can never be signed up for, and the console can't touch admin accounts.
  cfg.extraReserved = [...(cfg.extraReserved ?? []), ...admins];
  const isAdmin = (a) => a.roles?.['@type'] !== 'User' || admins.has(String(a.name).toLowerCase());
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3); // failed sign-ins per network, as for /api/aliases

  const set = async (type, args) => {
    const r = await jmap([[`${type}/set`, args, 's']]);
    const bad = r.notCreated ?? r.notUpdated ?? r.notDestroyed;
    if (bad && Object.keys(bad).length) throw Object.assign(new Error(`${type}/set refused`), { detail: Object.values(bad)[0] });
    return r;
  };
  const query = async (type, args) => jmap([[`${type}/query`, args, 'q']]);
  const get = async (type, ids, properties) => ids.length ? (await jmap([[`${type}/get`, { ids, ...(properties && { properties }) }, 'g']])).list : [];
  const newTier = async () => {
    // ponytail: Stalwart filters lookup keys by namespace only, so the whole tier is read; fine for thousands.
    const { ids } = await query('x:MemoryLookupKey', { filter: { namespace: NEW } });
    return (await get('x:MemoryLookupKey', ids)).filter((k) => k.namespace === NEW);
  };
  const account = async (id) => (await get('x:Account', [id], USER_PROPS))[0];

  const handlers = {
    'GET overview': async () => {
      const [a, q, b, n] = await Promise.all([
        query('x:Account', { filter: { '@type': 'User' }, calculateTotal: true, limit: 0 }),
        query('x:QueuedMessage', { calculateTotal: true, limit: 0 }),
        query('x:BlockedIp', { calculateTotal: true, limit: 0 }),
        newTier(),
      ]);
      const suspended = Object.values(abuse?.state.suspensions ?? {}).filter((h) => !h.at(-1)?.liftedAt).length;
      return { accounts: a.total, queued: q.total, blockedIps: b.total, newAccounts: n.length, suspended, held: hold ? hold.list().length : null };
    },

    'GET users': async (_req, url) => {
      // Stalwart's text search matches whole words (alice, not ali), so a full address is cut to its name.
      const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/@.*$/, '').slice(0, 64);
      const r = await query('x:Account', { filter: { '@type': 'User', ...(q && { text: q }) }, sort: [{ property: 'name' }], limit: 200, calculateTotal: true });
      const [list, tier] = await Promise.all([get('x:Account', r.ids, USER_PROPS), newTier()]);
      const keys = new Set(tier.map((k) => k.key.toLowerCase()));
      return { users: list.map((a) => userView(a, keys)), total: r.total };
    },

    'POST users': async (req) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      const bad = checkUsername(name);
      if (bad && bad.code !== 'username_reserved') return [400, bad.code, bad.message]; // admins may use reserved names
      const quota = body.quotaBytes == null || body.quotaBytes === '' ? (cfg.quotaBytes || null) : Number(body.quotaBytes);
      if (quota !== null && !(Number.isSafeInteger(quota) && quota >= 0)) return [400, 'bad_quota', 'Enter the storage limit as a whole number.'];
      // Single sign-on: the account signs in through the provider, so it gets no password (Stalwart refuses one).
      const secret = cfg.oidc ? null : password();
      const r = await jmap([['x:Account/set', { create: { n: {
        '@type': 'User', name, domainId: await getDomainId(),
        description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null,
        ...(secret && { credentials: { 0: { '@type': 'Password', secret } } }),
        ...(quota ? { quotas: { maxDiskQuota: quota } } : {}),
      } } }, 'c']]);
      if (r.notCreated?.n?.type === 'primaryKeyViolation') return [409, 'username_taken', 'That username is already taken.'];
      if (!r.created?.n) throw Object.assign(new Error('create refused'), { detail: r.notCreated?.n });
      return { user: userView(await account(r.created.n.id)), ...(secret && { password: secret }) };
    },

    'PATCH users/:id': async (req, _url, id, who) => {
      const body = await readJson(req).catch(() => ({}));
      let a = await account(id);
      if (!a) return [404, 'not_found', 'That account no longer exists.'];
      if (isAdmin(a)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      if (typeof body.sending === 'boolean' && abuse) { // suspend or allow sending, with the reason kept (abuse.mjs)
        if (body.sending) await abuse.liftAccount(a, who.name); else await abuse.suspendAccount(a, 'An administrator suspended sending.', who.name);
        a = await account(id);
      }
      const patch = {};
      if (typeof body.enabled === 'boolean') {
        if (!body.enabled && id === who.id) return [400, 'self', 'You can’t disable your own account.'];
        patch.permissions = withSignIn(a.permissions, body.enabled);
      }
      if ('quotaBytes' in body) {
        const q = body.quotaBytes === null ? null : Number(body.quotaBytes);
        if (q !== null && !(Number.isSafeInteger(q) && q > 0)) return [400, 'bad_quota', 'Enter the storage limit as a whole number.'];
        patch['quotas/maxDiskQuota'] = q; // null = no limit
      }
      let secret;
      if (body.resetPassword === true && cfg.oidc) return [400, 'sso', 'Passwords are managed by your identity provider.'];
      if (body.resetPassword === true) {
        // Replaces the main password only (app passwords stay). Stalwart signs the account out everywhere.
        const creds = (await get('x:Account', [id], ['credentials']))[0]?.credentials ?? {};
        const key = Object.entries(creds).find(([, c]) => c['@type'] === 'Password')?.[0];
        secret = password();
        if (key) patch[`credentials/${key}/secret`] = secret; else patch.credentials = { 0: { '@type': 'Password', secret } };
      }
      if (!Object.keys(patch).length) return typeof body.sending === 'boolean' && abuse ? { user: userView(a) } : [400, 'nothing', 'Nothing to change.'];
      await set('x:Account', { update: { [id]: patch } });
      return { user: userView(await account(id)), ...(secret && { password: secret }) };
    },

    'DELETE users/:id': async (_req, _url, id, who) => {
      const a = await account(id);
      if (!a) return [404, 'not_found', 'That account no longer exists.'];
      if (isAdmin(a)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      if (id === who.id) return [400, 'self', 'You can’t delete your own account.'];
      if (isHeld(a.permissions)) return [409, 'on_hold', 'This account is on legal hold. Release the hold first (Retention).'];
      await retireNames({ cfg, jmap }, id, a.name); // no recycling: the name and its aliases stay taken
      await set('x:Account', { destroy: [id] });
      forgetFiles(cfg, id); // its shared files went with it; so do their links
      const stale = (await newTier()).filter((k) => k.key.toLowerCase() === String(a.emailAddress).toLowerCase()).map((k) => k.id);
      if (stale.length) await set('x:MemoryLookupKey', { destroy: stale });
      return {};
    },

    // Team mailboxes (Stalwart group accounts, e.g. support@): mail to the address lands in the group's own Inbox,
    // every member opens it from their account menu with full access and sends as it (verified on 1.0.3).
    'GET groups': async () => {
      const { ids } = await query('x:Account', { filter: { '@type': 'Group' }, sort: [{ property: 'name' }], limit: 200 });
      const groups = await get('x:Account', ids, ['name', 'emailAddress', 'description']);
      const members = await Promise.all(groups.map(async (g) => {
        const r = await query('x:Account', { filter: { '@type': 'User', memberGroupIds: g.id }, limit: 500 });
        return (await get('x:Account', r.ids, ['emailAddress'])).map((u) => u.emailAddress).sort();
      }));
      return { groups: groups.map((g, i) => ({ id: g.id, name: g.name, email: g.emailAddress, description: g.description ?? '', members: members[i] })) };
    },
    'POST groups': async (req) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      const bad = checkUsername(name);
      if (bad && bad.code !== 'username_reserved') return [400, bad.code, bad.message.replace('username', 'name')]; // support@ is reserved for sign-up, fine here
      const r = await jmap([['x:Account/set', { create: { g: { '@type': 'Group', name, domainId: await getDomainId(),
        description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null } } }, 'c']]);
      if (r.notCreated?.g?.type === 'primaryKeyViolation') return [409, 'name_taken', 'That address is already taken.'];
      if (!r.created?.g) throw Object.assign(new Error('create refused'), { detail: r.notCreated?.g });
      return { group: { id: r.created.g.id, name, email: `${name}@${cfg.domain}`, members: [] } };
    },
    // { add: 'sam' } or { remove: 'sam@domain' }: membership lives on the user (memberGroupIds).
    'PATCH groups/:id': async (req, _url, id) => {
      const body = await readJson(req).catch(() => ({}));
      const [g] = await get('x:Account', [id], ['@type', 'roles', 'permissions', 'memberGroupIds']);
      if (g?.['@type'] !== 'Group') return [404, 'not_found', 'That team mailbox no longer exists.'];
      // Only plain team mailboxes (default roles, inherited permissions, as this console creates them): a group that
      // grants extra rights is managed in Stalwart's own admin, or adding someone here would hand them those rights.
      // A group inside another group inherits that one's rights, so nested groups are left to Stalwart's admin too.
      if (g.roles?.['@type'] !== 'Default' || g.permissions?.['@type'] !== 'Inherit' || Object.keys(g.memberGroupIds ?? {}).length) return [403, 'protected', 'This group grants extra rights; manage it in Stalwart’s own admin.'];
      const on = typeof body.add === 'string', who = String(on ? body.add : body.remove ?? '').trim().toLowerCase();
      const [local, domain] = who.split('@');
      if (!local || (domain && domain !== cfg.domain)) return [400, 'bad_member', `Enter a username or address on ${cfg.domain}.`];
      const { ids } = await query('x:Account', { filter: { '@type': 'User', name: local, domainId: await getDomainId() } });
      const [u] = ids.length === 1 ? await get('x:Account', ids, ['name', 'roles']) : [];
      if (!u || String(u.name).toLowerCase() !== local) return [404, 'no_such_user', `There’s no account ${local}@${cfg.domain}.`];
      if (on && isAdmin(u)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      await set('x:Account', { update: { [ids[0]]: { [`memberGroupIds/${id}`]: on ? true : null } } });
      return {};
    },
    'DELETE groups/:id': async (_req, _url, id) => {
      const [g] = await get('x:Account', [id], ['@type', 'name']);
      if (g?.['@type'] !== 'Group') return [404, 'not_found', 'That team mailbox no longer exists.'];
      // Stalwart refuses to delete a group that still has members (objectIsLinked): take them out first.
      const { ids } = await query('x:Account', { filter: { '@type': 'User', memberGroupIds: id }, limit: 500 });
      if (ids.length) await set('x:Account', { update: Object.fromEntries(ids.map((u) => [u, { [`memberGroupIds/${id}`]: null }])) });
      await retireNames({ cfg, jmap }, id, g.name); // no recycling, as for users
      await set('x:Account', { destroy: [id] });
      return {};
    },

    'GET domains': async () => ({ domains: await adminDomainList(jmap) }), // users' own domains (domains.mjs)
    // Accounts whose sending is suspended (automatically or by an admin), with why; lift with PATCH users/:id {sending: true}.
    'GET suspended': async () => {
      const open = Object.entries(abuse?.state.suspensions ?? {}).map(([email, h]) => ({ email, h, cur: h.at(-1) })).filter((x) => x.cur && !x.cur.liftedAt);
      const live = new Map((await get('x:Account', [...new Set(open.map((x) => x.cur.id))], USER_PROPS)).map((a) => [a.id, a]));
      return { suspended: open.filter((x) => live.get(x.cur.id)?.permissions?.disabledPermissions?.emailSend).map(({ email, h, cur }) => ({
        id: cur.id, email, reason: cur.reason, at: new Date(cur.at).toISOString(), by: cur.by ?? null,
        times: h.filter((r) => Date.now() - r.at < 7 * 86400e3).length })) };
    },
    // Accounts the daily job has reminded or found past the inactive limit. Nothing is blocked or deleted by itself.
    'GET inactive': async () => {
      const st = abuse?.state ?? { inactive: {}, seen: {}, since: Date.now() };
      const recs = Object.entries(st.inactive);
      const live = new Map((await get('x:Account', [...new Set(recs.map(([, r]) => r.id))], USER_PROPS)).map((a) => [a.id, a]));
      return { months: cfg.inactiveMonths ?? 0, since: new Date(st.since).toISOString(), accounts: recs.filter(([, r]) => live.has(r.id)).map(([email, r]) => ({
        id: r.id, email, lastSeen: st.seen[email] ? new Date(st.seen[email]).toISOString() : null, reminded: r.reminded ?? null,
        due: !!r.dueAt, enabled: userView(live.get(r.id)).enabled })) };
    },

    'GET blocked': async () => {
      const { ids } = await query('x:BlockedIp', { limit: 500 });
      const list = await get('x:BlockedIp', ids);
      return { blocked: list.map(({ id, address, reason, createdAt, expiresAt }) => ({ id, address, reason, createdAt, expiresAt: expiresAt ?? null })) };
    },
    'DELETE blocked/:id': async (_req, _url, id) => { await set('x:BlockedIp', { destroy: [id] }); return {}; },

    'GET new-accounts': async () => ({ keys: (await newTier()).map(({ id, key }) => ({ id, address: key })) }),
    'POST new-accounts': async (req) => {
      const body = await readJson(req).catch(() => ({}));
      const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
      const full = address.includes('@') ? address : `${address}@${cfg.domain}`;
      if (!/^[a-z0-9.-]{1,64}@[a-z0-9.-]+$/.test(full)) return [400, 'bad_address', 'Enter a username or full address, like bob@' + cfg.domain + '.'];
      const tier = await newTier();
      if (tier.some((k) => k.key.toLowerCase() === full)) return { address: full };
      await set('x:MemoryLookupKey', { create: { k: { namespace: NEW, key: full, isGlobPattern: false } } });
      return { address: full };
    },
    'DELETE new-accounts/:id': async (_req, _url, id) => {
      const [k] = await get('x:MemoryLookupKey', [id]);
      if (!k || k.namespace !== NEW) return [404, 'not_found', 'That entry no longer exists.']; // only ever this namespace
      await set('x:MemoryLookupKey', { destroy: [id] });
      return {};
    },

    'GET queue': async (_req, url) => {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 254);
      // Sender or recipient (substring). Stalwart filters support AND only, so two queries are merged.
      const ids = q
        ? [...new Set((await Promise.all([{ returnPath: q }, { to: q }].map((filter) => query('x:QueuedMessage', { filter, limit: 200 })))).flatMap((r) => r.ids))]
        : (await query('x:QueuedMessage', { limit: 200 })).ids;
      const list = (await get('x:QueuedMessage', ids.slice(0, 200), ['returnPath', 'createdAt', 'nextRetry', 'size', 'recipients'])).map(queueView);
      return { messages: list.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))) };
    },
    // Retry now: what Stalwart's own admin does (next attempt due in the past).
    'POST queue/:id/retry': async (_req, _url, id) => { await set('x:QueuedMessage', { update: { [id]: { nextRetry: '2000-01-01T00:00:00Z' } } }); return {}; },
    'DELETE queue/:id': async (_req, _url, id) => { await set('x:QueuedMessage', { destroy: [id] }); return {}; },

    // Outgoing mail held as likely spam (hold.mjs). Off (404) unless HOLD_HOOK_SECRET is set.
    'GET held': async () => (hold ? { held: hold.list() } : [404, 'not_found', 'Holding outgoing spam is off on this server.']),
    'POST held/:id/release': async (_req, _url, id) => (await hold?.release(id)) ? {} : [404, 'not_found', 'That message is no longer held.'],
    'DELETE held/:id': async (_req, _url, id) => hold?.remove(id) ? {} : [404, 'not_found', 'That message is no longer held.'],
    // Retention and legal hold (retention.mjs).
    ...Object.fromEntries(Object.entries(retentionAdmin({ jmap: (c) => jmap(c, ['urn:ietf:params:jmap:mail']), store: retention, isAdmin })).map(([k, fn]) => [k, async (req, _url, id, who) =>
      fn(req.method === 'GET' ? {} : await readJson(req).catch(() => ({})), (msg) => console.log(`${msg} (run by ${who.name})`), id)])),
  };

  return async function handle(req, res, url) {
    const m = url.pathname.match(new RegExp(`^/api/admin/(overview|users|blocked|new-accounts|queue|domains|suspended|inactive|groups|held|retention)(?:/(${ID}))?(/retry|/release)?$`));
    if (!m) return false;
    if (!admins.size) return fail(res, 404, 'not_found', 'Not found.'), true; // console off unless ADMINS is set
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);
    if (!admins.has(who.name)) return fail(res, 403, 'not_admin', 'This account isn’t an administrator.'), true;

    let key = `${req.method} ${m[1]}${m[2] ? '/:id' : ''}${m[3] ?? ''}`;
    if (key === 'POST retention/:id') key = `POST retention/${m[2]}`; // preview, run
    const fn = handlers[key];
    if (!fn) return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    let out;
    try { out = await fn(req, url, m[2], who); }
    catch (e) {
      console.error(`admin: ${key} by ${who.name} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : '');
      return fail(res, 502, 'stalwart_refused', 'The mail server refused that change. Details are in the account service log.'), true;
    }
    if (Array.isArray(out)) return fail(res, out[0], out[1], out[2]), true;
    if (req.method !== 'GET') console.log(`admin: ${who.name} ${key}${m[2] ? ` ${m[2]}` : ''}`); // ponytail: audit trail is the log
    return send(res, 200, { ok: true, ...out }), true;
  };
}
