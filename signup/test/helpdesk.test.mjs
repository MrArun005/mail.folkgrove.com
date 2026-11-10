// Helpdesk role (HELPDESK) against the local dev Stalwart: the listed support actions work, everything else is 403,
// admin and other helpdesk accounts are off limits, and the audit log records the role.
// Uses throwaway t-hd-* accounts it creates and deletes (never alice/bob). Skips if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, configFromEnv } from '../server.mjs';
import { Invites } from '../lib.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('HELPDESK is parsed like ADMINS', () => {
  const env = { ADMIN_USER: 'a', ADMIN_PASS: 'b', DOMAIN: 'x.test', SIGNUP: 'off', HELPDESK: ' Sam, raj@x.test ,' };
  assert.deepEqual(configFromEnv(env).helpdesk, ['sam', 'raj']);
});

test('helpdesk: support actions only, never on admin or helpdesk accounts', { skip, timeout: 60_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8);
  const pass = `throwaway pass ${tag} river`;
  const mk = async (name, extra = {}, type = 'User') => (await jmap([['x:Account/set', { create: { n: { '@type': type, name, domainId,
    ...(type === 'User' && { credentials: { 0: { '@type': 'Password', secret: pass } } }), ...extra } } }, 'c']])).created.n.id;
  // Rights beyond the User role, given directly or through a group: a password reset there would be a takeover.
  const grant = { permissions: { '@type': 'Merge', enabledPermissions: { impersonate: true }, disabledPermissions: {} } };
  const [richTeam, plainTeam] = [await mk(`t-hd-${tag}-g1`, grant, 'Group'), await mk(`t-hd-${tag}-g2`, {}, 'Group')];
  const boss = `t-hd-${tag}-a`, desk = `t-hd-${tag}-h`, desk2 = `t-hd-${tag}-h2`, plain = `t-hd-${tag}-p`, nobody = `t-hd-${tag}-n`;
  const made = await Promise.all([boss, desk, desk2, plain, nobody].map((n) => mk(n)));
  const [bossId, , desk2Id, plainId] = made;
  const granted = await mk(`t-hd-${tag}-x1`, grant), viaGroup = await mk(`t-hd-${tag}-x2`, { memberGroupIds: { [richTeam]: true } });
  const teamMember = await mk(`t-hd-${tag}-x3`, { memberGroupIds: { [plainTeam]: true } });
  made.push(granted, viaGroup, teamMember);
  t.after(async () => { await jmap([['x:Account/set', { destroy: made }, 'x']]).catch(() => {}); await jmap([['x:Account/set', { destroy: [richTeam, plainTeam] }, 'x']]).catch(() => {}); });

  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], helpdesk: [desk, desk2] });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const as = (user, p = pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}@openmail.test:${p}`).toString('base64'), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, user = desk) => fetch(`${base}/api/admin/${path}`, { method, headers: as(user), body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Roles: the first call says which; anyone not listed gets 403.
  assert.equal((await call('overview', 'GET', undefined, nobody)).status, 403);
  assert.equal((await call('users', 'GET', undefined, nobody)).status, 403);
  assert.equal((await call('overview')).role, 'helpdesk');
  assert.equal((await call('overview', 'GET', undefined, boss)).role, 'admin');
  const users = (await call(`users?q=${tag}`)).users;
  assert.equal(users.find((u) => u.id === desk2Id)?.helpdesk, true);

  // Allowed: sign-in off/on, password reset, lifting a suspension, held mail (off here: 404, not 403), suspended list, audit.
  assert.equal((await call(`users/${plainId}`, 'PATCH', { enabled: false })).user.enabled, false);
  assert.equal((await call(`users/${plainId}`, 'PATCH', { enabled: true })).user.enabled, true);
  const reset = await call(`users/${plainId}`, 'PATCH', { resetPassword: true });
  assert.equal(reset.status, 200);
  assert.equal(await fetch(`${STALWART}/jmap/session`, { headers: as(plain, reset.password) }).then((r) => r.status), 200);
  assert.equal((await call(`users/${plainId}`, 'PATCH', { sending: false }, boss)).status, 200);
  assert.equal((await call('suspended')).status, 200);
  assert.equal((await call(`users/${plainId}`, 'PATCH', { sending: true })).user.sending, true);
  assert.equal((await call('held')).status, 404);
  assert.equal((await call('held/x', 'DELETE')).status, 404);

  // Forbidden: anything else, and any change to an admin or helpdesk account (their own included).
  for (const [path, method, body] of [['users', 'POST', { name: `t-hd-${tag}-x` }], [`users/${plainId}`, 'DELETE'], [`users/${plainId}`, 'PATCH', { quotaBytes: 5 }],
    [`users/${plainId}`, 'PATCH', { sending: false }], [`users/${plainId}`, 'PATCH', { enabled: true, quotaBytes: null }], ['groups'], ['groups', 'POST', { name: `t-hd-${tag}-g` }],
    ['blocked'], ['blocked/x', 'DELETE'], ['new-accounts'], ['new-accounts', 'POST', { address: plain }], ['queue'], ['domains'], ['inactive'],
    ['retention'], ['retention', 'PUT', { trashJunkDays: 30 }], [`retention/${plainId}`, 'PATCH', { hold: true }],
    [`users/${desk2Id}`, 'PATCH', { resetPassword: true }], [`users/${bossId}`, 'PATCH', { enabled: false }]]) {
    assert.equal((await call(path, method, body)).status, 403, `${method ?? 'GET'} ${path} ${JSON.stringify(body ?? '')}`);
  }
  assert.ok(!(await call(`users?q=${tag}`)).users.some((u) => u.name === `t-hd-${tag}-x`)); // nothing was created
  // Accounts with rights of their own or from a group are off limits; a plain team mailbox member is not.
  for (const id of [granted, viaGroup]) for (const body of [{ resetPassword: true }, { enabled: false }, { sending: true }])
    assert.equal((await call(`users/${id}`, 'PATCH', body)).status, 403, `${id} ${JSON.stringify(body)}`);
  assert.equal((await call(`users/${teamMember}`, 'PATCH', { resetPassword: true })).status, 200);
  assert.equal((await call(`users/${granted}`, 'PATCH', { resetPassword: true }, boss)).status, 200); // admins still can

  // The audit log says who acted in which role; helpdesk names are reserved at sign-up like admin names.
  const log = (await call('audit?limit=200')).entries.filter((e) => e.admin === desk);
  assert.ok(log.length >= 4 && log.every((e) => e.role === 'helpdesk'), JSON.stringify(log));
  assert.ok((await call('audit?limit=200')).entries.some((e) => e.admin === boss && e.role === 'admin'));
  assert.equal((await fetch(`${base}/api/username-available?u=${desk2}`).then((r) => r.json())).available, false);

  // Changes per helpdesk account are capped (each is an audit line): the 101st in the hour is refused, unrecorded.
  let last, tries = 0;
  do last = await call(`users/${bossId}`, 'PATCH', { enabled: true }); while (last.status === 403 && ++tries < 200);
  assert.equal(last.status, 429);
  assert.equal((await call('audit?limit=200')).entries.filter((e) => e.admin === desk).length, 100);
  assert.equal((await call(`users/${plainId}`, 'PATCH', { enabled: true }, boss)).status, 200); // admins aren't capped
});
