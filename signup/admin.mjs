// Admin console API (/api/admin/*): users, team mailboxes (groups), blocked IPs, new-account limits and the outgoing queue.
// Who is an admin: the ADMINS setting (comma-separated usernames on DOMAIN). The caller proves who they are with
// their own sign-in token (checked by Stalwart, as for aliases); then their name must be on that list.
// HELPDESK lists support staff: they get only the routes in HELPDESK_ROUTES (deny by default), and never act on an
// admin or another helpdesk account.
// This is a short, explicit list of Stalwart admin operations, never a passthrough.
// Every change made here (anything but a GET) goes into the audit log (audit.mjs), written in handle() below.
import { randomBytes } from 'node:crypto';
import { callerOf } from './aliases.mjs';
import { retireNames } from './account.mjs';
import { forgetFiles } from './files.mjs';
import { checkPassword, checkUsername } from './lib.mjs';
import { HOLD, isHeld, policyStore, retentionAdmin } from './retention.mjs';
import { SEND } from './abuse.mjs';
import { adminDomainList } from './domains.mjs';
import { auditLog } from './audit.mjs';

const NEW = 'new-accounts'; // x:MemoryLookupKey namespace for the stricter sending tier (key = full address)
const USER_PROPS = ['name', 'emailAddress', 'description', 'createdAt', 'usedDiskQuota', 'quotas', 'aliases', 'permissions', 'roles'];
const ID = '[A-Za-z0-9_-]{1,64}';
const IMPORT_MAX = 1000; // accounts per CSV import request

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

// What the audit log calls each change. A route missing here isn't recorded: only retention/preview (a dry run).
// Handlers add the target by name and what was asked for through note(); see handle().
export const AUDITED = {
  'POST users': 'user.create', 'POST users/import': 'user.import', 'PATCH users/:id': 'user.update', 'DELETE users/:id': 'user.delete',
  'POST groups': 'team.create', 'PATCH groups/:id': 'team.members', 'DELETE groups/:id': 'team.delete',
  'DELETE blocked/:id': 'ip.unblock', 'POST new-accounts': 'limits.add', 'DELETE new-accounts/:id': 'limits.lift',
  'POST queue/:id/retry': 'queue.retry', 'DELETE queue/:id': 'queue.cancel',
  'POST held/:id/release': 'held.release', 'DELETE held/:id': 'held.delete',
  'PUT retention': 'retention.rules', 'POST retention/run': 'retention.run', 'PATCH retention/:id': 'retention.account',
};

// What a helpdesk account may call. Anything not here is refused (403) before its handler runs.
export const HELPDESK_ROUTES = new Set(['GET overview', 'GET users', 'PATCH users/:id', 'GET suspended', 'GET held', 'POST held/:id/release', 'DELETE held/:id', 'GET audit']);
// ...and of PATCH users/:id only these (sending: true only: lift a suspension, never impose one).
const HELPDESK_PATCH = ['enabled', 'resetPassword', 'sending'];

/** Permissions as this console leaves them: inherited, or only its own switches off (sign-in, sending, legal hold).
 *  Anything else (a right granted, or one taken away by hand) was set deliberately in Stalwart's own admin.
 *  The list is built per call: abuse.mjs imports this file, so SEND may not exist yet while it loads. */
export const plainPerms = (p) => !p || p['@type'] === 'Inherit' || (p['@type'] === 'Merge' && !Object.keys(p.enabledPermissions ?? {}).length
  && Object.keys(p.disabledPermissions ?? {}).every((k) => ['authenticate', ...SEND, ...HOLD].includes(k)));

// 16 characters, about 95 bits. Never starts with "-": spreadsheets read a leading "-" in the downloaded CSV as a formula.
const password = () => randomBytes(12).toString('base64url').replace(/^-/, 'x');

export function adminRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf, abuse, hold = null, retention = policyStore(null) }) {
  const admins = new Set(cfg.admins ?? []);
  const helpdesk = new Set((cfg.helpdesk ?? []).filter((n) => !admins.has(n))); // on both lists: an admin
  // Admin rights go by name, so admin (and helpdesk) names can never be signed up for, and the console can't touch admin accounts.
  cfg.extraReserved = [...(cfg.extraReserved ?? []), ...admins, ...helpdesk];
  const reloadLookups = () => jmap([['x:Action/set', { create: { r: { '@type': 'ReloadLookupStores' } } }, 'r']]);
  const isAdmin = (a) => a.roles?.['@type'] !== 'User' || admins.has(String(a.name).toLowerCase());
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3); // failed sign-ins per network, as for /api/aliases
  // Changes per helpdesk account an hour: every one is an audit line, and a bounded log must not be flushable by
  // the lower role (10,000 lines would take 100 hours of nothing else).
  const deskWrites = new RateLimiter(100, 3600e3);
  const audit = cfg.audit ?? auditLog(cfg.auditFile, { max: cfg.auditMax || undefined });

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
  const quotaOf = (v) => (v == null || v === '' ? (cfg.quotaBytes || null) : Number(v)); // empty: the server default
  const badQuota = (q) => q !== null && !(Number.isSafeInteger(q) && q >= 0);
  /** Create one user account; [status, code, message] when Stalwart refuses the name, else its id. */
  const createUser = async ({ name, description, quota, secret }) => {
    const r = await jmap([['x:Account/set', { create: { n: {
      '@type': 'User', name, domainId: await getDomainId(),
      description: typeof description === 'string' && description.trim() ? description.trim().slice(0, 200) : null,
      ...(secret && { credentials: { 0: { '@type': 'Password', secret } } }),
      ...(quota ? { quotas: { maxDiskQuota: quota } } : {}),
    } } }, 'c']]);
    if (r.notCreated?.n?.type === 'primaryKeyViolation') return [409, 'username_taken', 'That username is already taken.'];
    if (!r.created?.n) throw Object.assign(new Error('create refused'), { detail: r.notCreated?.n });
    return r.created.n.id;
  };
  // CSV import rows ({name, description?, password?, quotaBytes?}), checked as one list. Stricter than POST users:
  // reserved and retired names are refused too (no admin judgement per row), and so is a name twice in the list.
  const checkRows = (rows) => {
    const seen = new Set();
    return rows.map((row) => {
      const name = typeof row?.name === 'string' ? row.name.trim().toLowerCase() : '';
      const given = typeof row?.password === 'string' && row.password !== '' ? row.password : null;
      const quota = quotaOf(row?.quotaBytes);
      const bad = checkUsername(name, cfg.extraReserved)
        ?? (seen.has(name) ? { code: 'duplicate', message: 'This username is in the list twice.' } : null)
        ?? (given && cfg.oidc ? { code: 'sso', message: 'Passwords are managed by your identity provider; leave it empty.' } : null)
        ?? (given && checkPassword(given, name))
        ?? (badQuota(quota) ? { code: 'bad_quota', message: 'Enter the storage limit as a number of GB.' } : null);
      seen.add(name);
      return { name, given, quota, description: row?.description, bad };
    });
  };
  const importRows = async (req) => {
    const body = await readJson(req, 512 * 1024).catch((s) => s); // 1,000 rows of name, display name and password fit
    if (body === 413) return [413, 'body_too_large', 'The list is too large.'];
    if (!Array.isArray(body?.rows) || !body.rows.length) return [400, 'no_rows', 'Add at least one account.'];
    if (body.rows.length > IMPORT_MAX) return [400, 'too_many_rows', `At most ${IMPORT_MAX.toLocaleString('en')} accounts at a time.`];
    return { rows: checkRows(body.rows) };
  };
  // The helpdesk may only act on a plain account, or a password reset could take over one with extra rights: the
  // User role, plain permissions, and only in plain team mailboxes (a group's roles and permissions pass to its
  // members, as in PATCH groups/:id). Deny by default: anything unknown or missing is not plain.
  const plainAccount = async (id) => {
    const [u] = await get('x:Account', [id], ['roles', 'permissions', 'memberGroupIds']);
    if (u?.roles?.['@type'] !== 'User' || !plainPerms(u.permissions)) return false;
    const ids = Object.keys(u.memberGroupIds ?? {});
    const groups = await get('x:Account', ids, ['roles', 'permissions', 'memberGroupIds']);
    return groups.length === ids.length && groups.every((g) => g.roles?.['@type'] === 'Default' && g.permissions?.['@type'] === 'Inherit' && !Object.keys(g.memberGroupIds ?? {}).length);
  };

  const handlers = {
    'GET overview': async (_req, _url, _id, who) => { // the console's first call, so it also tells the UI the caller's role
      const [a, q, b, n] = await Promise.all([
        query('x:Account', { filter: { '@type': 'User' }, calculateTotal: true, limit: 0 }),
        query('x:QueuedMessage', { calculateTotal: true, limit: 0 }),
        query('x:BlockedIp', { calculateTotal: true, limit: 0 }),
        newTier(),
      ]);
      const suspended = Object.values(abuse?.state.suspensions ?? {}).filter((h) => !h.at(-1)?.liftedAt).length;
      return { accounts: a.total, queued: q.total, blockedIps: b.total, newAccounts: n.length, suspended, held: hold ? hold.list().length : null, role: who.role };
    },

    'GET users': async (_req, url) => {
      // Stalwart's text search matches whole words (alice, not ali), so a full address is cut to its name.
      const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/@.*$/, '').slice(0, 64);
      const r = await query('x:Account', { filter: { '@type': 'User', ...(q && { text: q }) }, sort: [{ property: 'name' }], limit: 200, calculateTotal: true });
      const [list, tier] = await Promise.all([get('x:Account', r.ids, USER_PROPS), newTier()]);
      const keys = new Set(tier.map((k) => k.key.toLowerCase()));
      return { users: list.map((a) => ({ ...userView(a, keys), admin: isAdmin(a), helpdesk: helpdesk.has(String(a.name).toLowerCase()) })), total: r.total };
    },

    'POST users': async (req, _url, _id, _who, note) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      note(`${name.slice(0, 64)}@${cfg.domain}`);
      const bad = checkUsername(name);
      if (bad && bad.code !== 'username_reserved') return [400, bad.code, bad.message]; // admins may use reserved names
      const quota = quotaOf(body.quotaBytes);
      if (badQuota(quota)) return [400, 'bad_quota', 'Enter the storage limit as a whole number.'];
      // Single sign-on: the account signs in through the provider, so it gets no password (Stalwart refuses one).
      const secret = cfg.oidc ? null : password();
      const id = await createUser({ name, description: body.description, quota, secret });
      if (Array.isArray(id)) return id;
      return { user: userView(await account(id)), ...(secret && { password: secret }) };
    },

    // Add accounts from a CSV (the console parses it): check first (nothing created, not audited), then import.
    // The import creates them one by one and reports each row; a bad row never stops the others. Generated passwords
    // are returned once; the audit log gets the counts only.
    'POST users/check': async (req) => {
      const got = await importRows(req);
      return got.rows ? { results: got.rows.map(({ name, bad }) => ({ name, ...(bad && { error: bad.code, message: bad.message }) })) } : got;
    },
    'POST users/import': async (req, _url, _id, who, note) => {
      note(cfg.domain); // accounts on DOMAIN (names stay out of the log: the counts say enough)
      const got = await importRows(req);
      if (!got.rows) return got;
      const results = [];
      for (const { name, given, quota, description, bad } of got.rows) {
        if (bad) { results.push({ name, error: bad.code, message: bad.message }); continue; }
        const secret = cfg.oidc ? null : given ?? password();
        try {
          const id = await createUser({ name, description, quota, secret });
          results.push(Array.isArray(id) ? { name, error: id[1], message: id[2] } : { name, email: `${name}@${cfg.domain}`, ...(secret && !given && { password: secret }) });
        } catch (e) {
          console.error(`admin: import of ${name} by ${who.name} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : '');
          results.push({ name, error: 'stalwart_refused', message: 'The mail server refused this account.' });
        }
      }
      const created = results.filter((r) => r.email).length;
      note(null, `created:${created}`, `failed:${results.length - created}`);
      return { results, created };
    },

    'PATCH users/:id': async (req, _url, id, who, note) => {
      const body = await readJson(req).catch(() => ({}));
      let a = await account(id);
      if (!a) return [404, 'not_found', 'That account no longer exists.'];
      // What was asked for, in the audit log's words. The new password itself is never noted.
      note(a.emailAddress, ...[typeof body.sending === 'boolean' && abuse && (body.sending ? 'sending_allow' : 'sending_suspend'),
        typeof body.enabled === 'boolean' && (body.enabled ? 'enable' : 'disable'),
        'quotaBytes' in body && `quota:${body.quotaBytes === null ? 'none' : Number(body.quotaBytes) || 0}`, body.resetPassword === true && 'password_reset'].filter(Boolean));
      if (isAdmin(a)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      if (who.role === 'helpdesk' && (helpdesk.has(String(a.name).toLowerCase()) || body.sending === false || Object.keys(body).some((k) => !HELPDESK_PATCH.includes(k)) || !(await plainAccount(id))))
        return [403, 'not_allowed', 'The helpdesk can’t make that change. Ask an administrator.'];
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
      // Blocking an account that is due under the inactive-account policy also refuses its mail (abuse.mjs);
      // enabling any account accepts its mail again.
      const email = String(a.emailAddress).toLowerCase();
      if (body.enabled === false && abuse?.state.inactive[email]?.dueAt) await abuse.refuseMail(a, true);
      if (body.enabled === true && abuse) await abuse.refuseMail(a, false);
      return { user: userView(await account(id)), ...(secret && { password: secret }) };
    },

    'DELETE users/:id': async (_req, _url, id, who, note) => {
      const a = await account(id);
      if (!a) return [404, 'not_found', 'That account no longer exists.'];
      note(a.emailAddress);
      if (isAdmin(a)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      if (id === who.id) return [400, 'self', 'You can’t delete your own account.'];
      if (isHeld(a.permissions)) return [409, 'on_hold', 'This account is on legal hold. Release the hold first (Retention).'];
      await retireNames({ cfg, jmap }, id, a.name); // no recycling: the name and its aliases stay taken
      await set('x:Account', { destroy: [id] });
      await abuse?.refuseMail(a, false); // the address no longer exists anyway; don't keep its keys
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
    'POST groups': async (req, _url, _id, _who, note) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      note(`${name.slice(0, 64)}@${cfg.domain}`);
      const bad = checkUsername(name);
      if (bad && bad.code !== 'username_reserved') return [400, bad.code, bad.message.replace('username', 'name')]; // support@ is reserved for sign-up, fine here
      const r = await jmap([['x:Account/set', { create: { g: { '@type': 'Group', name, domainId: await getDomainId(),
        description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null } } }, 'c']]);
      if (r.notCreated?.g?.type === 'primaryKeyViolation') return [409, 'name_taken', 'That address is already taken.'];
      if (!r.created?.g) throw Object.assign(new Error('create refused'), { detail: r.notCreated?.g });
      return { group: { id: r.created.g.id, name, email: `${name}@${cfg.domain}`, members: [] } };
    },
    // { add: 'sam' } or { remove: 'sam@domain' }: membership lives on the user (memberGroupIds).
    'PATCH groups/:id': async (req, _url, id, _who, note) => {
      const body = await readJson(req).catch(() => ({}));
      const [g] = await get('x:Account', [id], ['@type', 'emailAddress', 'roles', 'permissions', 'memberGroupIds']);
      if (g?.['@type'] !== 'Group') return [404, 'not_found', 'That team mailbox no longer exists.'];
      note(g.emailAddress);
      // Only plain team mailboxes (default roles, inherited permissions, as this console creates them): a group that
      // grants extra rights is managed in Stalwart's own admin, or adding someone here would hand them those rights.
      // A group inside another group inherits that one's rights, so nested groups are left to Stalwart's admin too.
      if (g.roles?.['@type'] !== 'Default' || g.permissions?.['@type'] !== 'Inherit' || Object.keys(g.memberGroupIds ?? {}).length) return [403, 'protected', 'This group grants extra rights; manage it in Stalwart’s own admin.'];
      const on = typeof body.add === 'string', who = String(on ? body.add : body.remove ?? '').trim().toLowerCase();
      const [local, domain] = who.split('@');
      if (!local || (domain && domain !== cfg.domain)) return [400, 'bad_member', `Enter a username or address on ${cfg.domain}.`];
      note(null, `${on ? 'member_add' : 'member_remove'}:${local.slice(0, 64)}@${cfg.domain}`);
      const { ids } = await query('x:Account', { filter: { '@type': 'User', name: local, domainId: await getDomainId() } });
      const [u] = ids.length === 1 ? await get('x:Account', ids, ['name', 'roles']) : [];
      if (!u || String(u.name).toLowerCase() !== local) return [404, 'no_such_user', `There’s no account ${local}@${cfg.domain}.`];
      if (on && isAdmin(u)) return [403, 'protected', 'Administrator accounts are managed in Stalwart’s own admin.'];
      await set('x:Account', { update: { [ids[0]]: { [`memberGroupIds/${id}`]: on ? true : null } } });
      return {};
    },
    'DELETE groups/:id': async (_req, _url, id, _who, note) => {
      const [g] = await get('x:Account', [id], ['@type', 'name', 'emailAddress']);
      if (g?.['@type'] !== 'Group') return [404, 'not_found', 'That team mailbox no longer exists.'];
      note(g.emailAddress);
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
      const refused = new Set(abuse ? (await abuse.refusedKeys()).map((k) => k.key) : []);
      return { months: cfg.inactiveMonths ?? 0, since: new Date(st.since).toISOString(), accounts: recs.filter(([, r]) => live.has(r.id)).map(([email, r]) => ({
        id: r.id, email, lastSeen: st.seen[email] ? new Date(st.seen[email]).toISOString() : null, reminded: r.reminded ?? null,
        due: !!r.dueAt, enabled: userView(live.get(r.id)).enabled, refusingMail: refused.has(email) })) };
    },

    'GET blocked': async () => {
      const { ids } = await query('x:BlockedIp', { limit: 500 });
      const list = await get('x:BlockedIp', ids);
      return { blocked: list.map(({ id, address, reason, createdAt, expiresAt }) => ({ id, address, reason, createdAt, expiresAt: expiresAt ?? null })) };
    },
    'DELETE blocked/:id': async (_req, _url, id, _who, note) => {
      note((await get('x:BlockedIp', [id]))[0]?.address); // the address, not Stalwart's id for the block
      await set('x:BlockedIp', { destroy: [id] });
      return {};
    },

    'GET new-accounts': async () => ({ keys: (await newTier()).map(({ id, key }) => ({ id, address: key })) }),
    'POST new-accounts': async (req, _url, _id, _who, note) => {
      const body = await readJson(req).catch(() => ({}));
      const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
      const full = address.includes('@') ? address : `${address}@${cfg.domain}`;
      if (!/^[a-z0-9.-]{1,64}@[a-z0-9.-]+$/.test(full)) return [400, 'bad_address', 'Enter a username or full address, like bob@' + cfg.domain + '.'];
      note(full);
      const tier = await newTier();
      if (tier.some((k) => k.key.toLowerCase() === full)) return { address: full };
      await set('x:MemoryLookupKey', { create: { k: { namespace: NEW, key: full, isGlobPattern: false } } });
      await reloadLookups(); // Stalwart only sees lookup-key changes after this
      return { address: full };
    },
    'DELETE new-accounts/:id': async (_req, _url, id, _who, note) => {
      const [k] = await get('x:MemoryLookupKey', [id]);
      if (!k || k.namespace !== NEW) return [404, 'not_found', 'That entry no longer exists.']; // only ever this namespace
      note(k.key);
      await set('x:MemoryLookupKey', { destroy: [id] });
      await reloadLookups();
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
    'POST queue/:id/retry': async (_req, _url, id, _who, note) => { note(await queuedFrom(id)); await set('x:QueuedMessage', { update: { [id]: { nextRetry: '2000-01-01T00:00:00Z' } } }); return {}; },
    'DELETE queue/:id': async (_req, _url, id, _who, note) => { note(await queuedFrom(id)); await set('x:QueuedMessage', { destroy: [id] }); return {}; },

    // Outgoing mail held as likely spam (hold.mjs). Off (404) unless HOLD_HOOK_SECRET is set.
    'GET held': async () => (hold ? { held: hold.list() } : [404, 'not_found', 'Holding outgoing spam is off on this server.']),
    // The audit log names a held or queued message by its sender (never its subject or text).
    'POST held/:id/release': async (_req, _url, id, _who, note) => { note(heldFrom(id)); return (await hold?.release(id)) ? {} : [404, 'not_found', 'That message is no longer held.']; },
    'DELETE held/:id': async (_req, _url, id, _who, note) => { note(heldFrom(id)); return hold?.remove(id) ? {} : [404, 'not_found', 'That message is no longer held.']; },
    // Retention and legal hold (retention.mjs).
    ...Object.fromEntries(Object.entries(retentionAdmin({ jmap: (c) => jmap(c, ['urn:ietf:params:jmap:mail']), store: retention, isAdmin })).map(([k, fn]) => [k, async (req, _url, id, who, note) => {
      const body = req.method === 'GET' ? {} : await readJson(req).catch(() => ({}));
      // For the audit log: whose rule (by address), and the numbers asked for.
      const whose = id ?? (typeof body.accountId === 'string' ? body.accountId : null), days = (v) => (v === null ? 'server' : Number(v) || 0);
      if (req.method !== 'GET' && k !== 'POST retention/preview') note(whose && ((await get('x:Account', [whose], ['emailAddress']).catch(() => []))[0]?.emailAddress ?? whose),
        ...['trashJunkDays' in body && `trash_days:${days(body.trashJunkDays)}`, 'maxAgeDays' in body && `max_age_days:${days(body.maxAgeDays)}`,
          'accountMaxAgeDays' in body && `max_age_days:${days(body.accountMaxAgeDays)}`, typeof body.hold === 'boolean' && (body.hold ? 'hold_on' : 'hold_off')].filter(Boolean));
      return fn(body, (msg) => console.log(`${msg} (run by ${who.name})`), id);
    }])),
    // The audit log itself, newest first: ?limit= (50, at most 200) and ?offset= to page back.
    'GET audit': async (_req, url) => {
      const n = (k, d, max) => Math.min(max, Math.max(0, Math.floor(Number(url.searchParams.get(k) ?? d)) || 0));
      const limit = n('limit', 50, 200) || 50, offset = n('offset', 0, Number.MAX_SAFE_INTEGER);
      return { ...audit.list({ offset, limit }), offset, limit };
    },
  };
  const heldFrom = (id) => hold?.list().find((x) => x.id === id)?.from;
  const queuedFrom = async (id) => (await get('x:QueuedMessage', [id], ['returnPath']).catch(() => []))[0]?.returnPath; // audit log: the sender

  return async function handle(req, res, url) {
    const m = url.pathname.match(new RegExp(`^/api/admin/(overview|users|blocked|new-accounts|queue|domains|suspended|inactive|groups|held|retention|audit)(?:/(${ID}))?(/retry|/release)?$`));
    if (!m) return false;
    if (!admins.size && !helpdesk.size) return fail(res, 404, 'not_found', 'Not found.'), true; // console off unless ADMINS (or HELPDESK) is set
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);
    who.role = admins.has(who.name) ? 'admin' : helpdesk.has(who.name) ? 'helpdesk' : null;
    if (!who.role) return fail(res, 403, 'not_admin', 'This account isn’t an administrator.'), true;

    let key = `${req.method} ${m[1]}${m[2] ? '/:id' : ''}${m[3] ?? ''}`;
    if (key === 'POST retention/:id' || key === 'POST users/:id') key = `POST ${m[1]}/${m[2]}`; // retention preview, run; users check, import
    const fn = handlers[key];
    if (!fn) return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    if (who.role === 'helpdesk' && !HELPDESK_ROUTES.has(key)) return fail(res, 403, 'not_allowed', 'The helpdesk can’t do that. Ask an administrator.'), true;
    // The audit log: every change an administrator asks for passes here, so this is the one place that records it,
    // whatever its outcome ('ok', or the error code the admin was shown). Handlers only say whom it was about and
    // what was asked (note): names, addresses and numbers, never the request body or a password.
    // Not recorded: reads (GET), and requests refused before this point. Anyone signed in can earn a 403 here, and
    // letting them write lines would let them push the real ones out of a bounded log.
    const entry = AUDITED[key] ? { at: new Date().toISOString(), admin: who.name, role: who.role, ip, action: AUDITED[key], target: m[2] ?? null } : null;
    // Refused before this point (role, route, rate): not recorded. A helpdesk account's changes are capped per hour.
    const wait = entry && who.role === 'helpdesk' && deskWrites.take(who.name);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many changes. Try again later.', { retryAfter: wait }), true;
    const note = (target, ...detail) => { if (entry && target) entry.target = String(target); if (entry && detail.length) entry.detail = [...(entry.detail ?? []), ...detail.map(String)]; };
    const done = (outcome) => { if (entry) audit.record({ ...entry, outcome }); };
    let out;
    try { out = await fn(req, url, m[2], who, note); }
    catch (e) {
      console.error(`admin: ${key} by ${who.name} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : '');
      done('stalwart_refused');
      return fail(res, 502, 'stalwart_refused', 'The mail server refused that change. Details are in the account service log.'), true;
    }
    if (Array.isArray(out)) return done(out[1]), fail(res, out[0], out[1], out[2]), true;
    done('ok');
    if (req.method !== 'GET') console.log(`admin: ${who.name} ${key}${m[2] ? ` ${m[2]}` : ''}`); // the service log keeps a copy
    return send(res, 200, { ok: true, ...out }), true;
  };
}
