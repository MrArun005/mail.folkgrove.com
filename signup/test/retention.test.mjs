// Retention and legal hold against the local dev Stalwart, with throwaway accounts (never alice or bob).
// Only per-account rules are set, so the job can't touch anyone else's mail on the shared dev server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { withPermissions, rulesFor, HOLD } from '../retention.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('retention helpers', () => {
  const held = withPermissions({ '@type': 'Inherit' }, HOLD, true);
  assert.equal(held.disabledPermissions.jmapEmailDestroy, true);
  assert.deepEqual(withPermissions(held, HOLD, false), { '@type': 'Inherit' });
  const signInOff = { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } };
  assert.deepEqual(withPermissions(withPermissions(signInOff, HOLD, true), HOLD, false), signInOff); // other permissions survive
  const p = { maxAgeDays: 3650, accounts: { a: { maxAgeDays: 0 }, b: { trashDays: 7 } } };
  assert.deepEqual([rulesFor(p, 'a'), rulesFor(p, 'b'), rulesFor(p, 'c')], [{ maxAgeDays: 0, trashDays: 0 }, { maxAgeDays: 3650, trashDays: 7 }, { maxAgeDays: 3650, trashDays: 0 }]);
});

test('retention: a backdated message is removed by the job; a held account keeps everything', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = basic(admin.user, admin.pass);
  const jmap = async (methodCalls, a = auth) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: a },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]))[1].list.find((d) => d.name === 'openmail.test').id;
  const tag = randomBytes(3).toString('hex'), pass = `throwaway pass ${tag} river`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']]))[1].created.n.id;
  const boss = `t-sso-boss-${tag}`, A = `t-sso-a-${tag}`, B = `t-sso-b-${tag}`;
  const [bossId, a, b] = [await mk(boss), await mk(A), await mk(B)];
  t.after(async () => { await jmap([['x:Account/set', { destroy: [bossId, a, b] }, 'x']]).catch(() => {}); app.close(); });

  const boxes = async (id) => Object.fromEntries((await jmap([['Mailbox/get', { accountId: id, properties: ['role'] }, 'm']]))[1].list.map((m) => [m.role, m.id]));
  const put = async (id, subject, daysAgo, role = 'inbox') => (await jmap([['Email/set', { accountId: id, create: { e: {
    mailboxIds: { [(await boxes(id))[role]]: true }, from: [{ email: 'x@example.com' }], subject, receivedAt: new Date(Date.now() - daysAgo * 86400e3).toISOString(),
    textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: subject } } } } }, 'e']]))[1].created.e.id;
  const subjects = async (id) => {
    const r = await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/query', { accountId: id }, 'q'], ['Email/get', { accountId: id, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g']] }) })).json();
    return r.methodResponses[1][1].list.map((m) => m.subject).sort();
  };
  for (const id of [a, b]) { await put(id, 'from 2015', 365 * 11); await put(id, 'this week', 2); }
  await put(a, 'trash, 10 days', 10, 'trash'); await put(a, 'junk, 10 days', 10, 'junk'); await put(a, 'trash, 2 days', 2, 'trash');

  var app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], retentionJob: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const as = (u) => ({ Authorization: basic(`${u}@openmail.test`, pass), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, who = boss) => fetch(base + path, { method, headers: as(who), body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Server-wide Trash/Junk auto-empty is Stalwart's own setting (written back unchanged: shared dev server).
  const g = await call('/admin/retention');
  assert.equal(g.status, 200, JSON.stringify(g));
  assert.ok(g.trashJunkDays === null || g.trashJunkDays > 0);
  assert.equal((await call('/admin/retention', 'PUT', { trashJunkDays: g.trashJunkDays ?? 0 })).trashJunkDays, g.trashJunkDays);
  assert.equal((await call('/admin/retention', 'PUT', { maxAgeDays: 5 })).status, 400, 'at least 30 days');
  assert.equal((await call('/admin/retention', 'GET', undefined, A)).status, 403, 'admins only');

  // Legal hold on B: Stalwart then refuses B's own deletes, and the console won't delete the account.
  const held = await call(`/admin/retention/${b}`, 'PATCH', { hold: true });
  assert.ok(held.accounts.find((x) => x.id === b).held);
  const del = await jmap([['Email/set', { accountId: b, destroy: [(await jmap([['Email/query', { accountId: b }, 'q']]))[1].ids[0]] }, 'd']], basic(`${B}@openmail.test`, pass));
  assert.equal(del[0], 'error'); assert.equal(del[1].type, 'forbidden');
  assert.equal((await call(`/admin/users/${b}`, 'DELETE')).status, 409);

  // Rules for A and B only: delete mail older than 10 years. Dry run first: counts, nothing removed.
  for (const id of [a, b]) assert.equal((await call(`/admin/retention/${id}`, 'PATCH', { maxAgeDays: 3650 })).status, 200);
  const pre = await call('/admin/retention/preview', 'POST', {});
  const row = (rows, id) => rows.find((x) => x.id === id);
  assert.deepEqual([row(pre.accounts, a).old, row(pre.accounts, b).held, row(pre.accounts, b).old], [1, true, 0]);
  assert.equal((await subjects(a)).length, 5, 'preview deletes nothing');
  // A proposed rule is previewed without saving it: "keep A's mail forever" leaves A out.
  assert.equal(row((await call('/admin/retention/preview', 'POST', { accountId: a, accountMaxAgeDays: 0 })).accounts, a), undefined);

  // A's own rule: empty my Trash and Junk after 7 days.
  assert.equal((await call('/retention', 'PUT', { trashDays: 400 }, A)).status, 400);
  const mine = await call('/retention', 'PUT', { trashDays: 7 }, A);
  assert.deepEqual([mine.trashDays, mine.maxAgeDays, mine.held], [7, 3650, false]);
  assert.equal((await call('/retention', 'GET', undefined, B)).held, true);

  // The job.
  const run = await call('/admin/retention/run', 'POST', {});
  assert.deepEqual([row(run.accounts, a).old, row(run.accounts, a).trash, row(run.accounts, b).old], [1, 2, 0]);
  assert.deepEqual(await subjects(a), ['this week', 'trash, 2 days']);
  assert.deepEqual(await subjects(b), ['from 2015', 'this week'], 'held: nothing removed');

  // Release: B can delete again; the account can be deleted.
  const rel = await call(`/admin/retention/${b}`, 'PATCH', { hold: false, maxAgeDays: null });
  assert.ok(!rel.accounts.some((x) => x.id === b));
  const perms = (await jmap([['x:Account/get', { ids: [b], properties: ['permissions'] }, 'g']]))[1].list[0].permissions;
  assert.deepEqual(perms, { '@type': 'Inherit' });
  assert.equal((await call(`/admin/retention/${a}`, 'PATCH', { maxAgeDays: null })).status, 200);
});
