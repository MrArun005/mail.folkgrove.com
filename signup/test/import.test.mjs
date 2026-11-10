// Adding accounts from a CSV (POST /api/admin/users/check and users/import) against the local dev Stalwart: each row
// gets its own result, a bad row in the middle doesn't stop the rest, reserved and retired names are refused,
// generated passwords come back once and never reach the audit log. Admins only.
// Uses throwaway t-imp-* accounts it creates and deletes (never alice/bob). Skips if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('CSV import: per-row results, bad rows skipped, reserved and retired names refused', { skip, timeout: 60_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8);
  const pass = `throwaway pass ${tag} river`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const boss = `t-imp-${tag}-a`, desk = `t-imp-${tag}-h`, plain = `t-imp-${tag}-p`;
  const made = await Promise.all([boss, desk, plain].map(mk));
  const name = (s) => `t-imp-${tag}-${s}`;
  t.after(async () => {
    const { ids } = await jmap([['x:Account/query', { filter: { text: `t-imp-${tag}` } }, 'q']]);
    await jmap([['x:Account/set', { destroy: [...new Set([...made, ...ids])] }, 'x']]).catch(() => {});
  });

  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], helpdesk: [desk] });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const as = (user, p = pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}@openmail.test:${p}`).toString('base64'), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, user = boss) => fetch(`http://127.0.0.1:${app.address().port}/api/admin/${path}`, { method, headers: as(user), body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const signIn = (user, p) => fetch(`${STALWART}/jmap/session`, { headers: as(user, p) }).then((r) => r.status);

  // A deleted account's name is retired: the import must refuse it like sign-up does.
  const gone = await call('users', 'POST', { name: name('gone') });
  assert.equal((await call(`users/${gone.user.id}`, 'DELETE')).status, 200);

  const rows = [
    { name: ` ${name('one').toUpperCase()} `, description: 'Sam One', quotaBytes: 5_000_000 }, // generated password
    { name: 'postmaster' }, // reserved
    { name: 'ab' }, // too short
    { name: boss }, // an admin's name
    { name: name('gone') }, // retired
    { name: name('one') }, // twice in the list
    { name: name('weak'), password: 'short' },
    { name: name('quota'), quotaBytes: 'lots' },
    { name: name('two'), password: `given pass ${tag} lake` }, // after all those bad rows
  ];
  const want = [null, 'username_reserved', 'username_too_short', 'username_reserved', 'username_reserved', 'duplicate', 'password_too_short', 'bad_quota', null];

  // Only admins: not the helpdesk, not anyone else.
  assert.equal((await call('users/import', 'POST', { rows }, desk)).status, 403);
  assert.equal((await call('users/check', 'POST', { rows }, desk)).status, 403);
  assert.equal((await call('users/import', 'POST', { rows }, plain)).status, 403);

  // The check gives the same verdicts and creates nothing.
  const check = await call('users/check', 'POST', { rows });
  assert.deepEqual(check.results.map((r) => r.error ?? null), want);
  assert.equal((await call(`users?q=${name('one')}`)).users.length, 0);

  const r = await call('users/import', 'POST', { rows });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => x.error ?? null), want);
  assert.equal(r.created, 2);
  const [one, two] = [r.results[0], r.results.at(-1)];
  assert.equal(one.email, `${name('one')}@openmail.test`);
  assert.ok(one.password && !two.password); // only generated passwords come back
  assert.equal(await signIn(name('one'), one.password), 200);
  assert.equal(await signIn(name('two'), `given pass ${tag} lake`), 200);
  const u = (await call(`users?q=${name('one')}`)).users[0];
  assert.deepEqual([u.description, u.quota], ['Sam One', 5_000_000]);
  assert.ok(r.results.every((x) => x.email || x.message));

  // Again: both now exist, so each row fails on its own (Stalwart says taken), the batch still answers.
  const again = await call('users/import', 'POST', { rows: [{ name: name('one') }, { name: name('two') }] });
  assert.deepEqual([again.created, again.results.map((x) => x.error).join()], [0, 'username_taken,username_taken']);

  // Limits: nothing to add, more than 1,000 rows.
  assert.equal((await call('users/import', 'POST', { rows: [] })).status, 400);
  assert.equal((await call('users/import', 'POST', { rows: Array.from({ length: 1001 }, (_, i) => ({ name: name(`n${i}`) })) })).status, 400);

  // The audit log: the import with its counts, never a password.
  const log = (await call('audit?limit=200')).entries.filter((e) => e.action === 'user.import');
  assert.deepEqual(log.map((e) => [e.target, e.detail, e.outcome]), [['openmail.test', undefined, 'too_many_rows'], ['openmail.test', undefined, 'no_rows'],
    ['openmail.test', ['created:0', 'failed:2'], 'ok'], ['openmail.test', ['created:2', 'failed:7'], 'ok']]);
  assert.ok(!JSON.stringify(log).includes(one.password));
  assert.ok(!(await call('audit?limit=200')).entries.some((e) => /users\/check/.test(e.action))); // the check isn't a change
});
