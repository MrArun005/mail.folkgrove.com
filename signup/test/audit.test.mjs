// Admin audit log: the file format, rotation and paging on their own, then through the admin API against the local
// dev Stalwart (every change recorded with who, what, whom and how it ended; no passwords; admins only).
// Uses throwaway t-audit-* accounts it creates and deletes (never alice/bob). The API part skips without the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, configFromEnv } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { auditLog } from '../audit.mjs';
import { AUDITED } from '../admin.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('audit log file: append-only JSON lines, newest first, paged, rotated at the cap', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'openmail-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'audit.jsonl');
  const log = auditLog(file, { max: 5 });
  assert.deepEqual(log.list(), { entries: [], total: 0 });
  for (let i = 1; i <= 3; i++) log.record({ at: `t${i}`, admin: 'ann', action: 'user.create', target: `u${i}`, outcome: 'ok' });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3); // one line each
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]), { at: 't1', admin: 'ann', action: 'user.create', target: 'u1', outcome: 'ok' });
  assert.deepEqual(log.list().entries.map((e) => e.target), ['u3', 'u2', 'u1']);
  assert.deepEqual(log.list({ limit: 2 }).entries.map((e) => e.target), ['u3', 'u2']);
  assert.deepEqual(log.list({ offset: 2, limit: 2 }).entries.map((e) => e.target), ['u1']);
  assert.deepEqual(log.list({ offset: 9 }).entries, []);

  // The 6th entry starts a new file; the full one is kept as .1 and still read when paging back.
  for (let i = 4; i <= 7; i++) log.record({ at: `t${i}`, target: `u${i}`, outcome: 'ok' });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean).length, 5);
  const all = log.list({ limit: 200 });
  assert.deepEqual([all.total, all.entries.map((e) => e.target).join()], [7, 'u7,u6,u5,u4,u3,u2,u1']);
  assert.deepEqual(log.list({ offset: 1, limit: 3 }).entries.map((e) => e.target), ['u6', 'u5', 'u4']); // across the two files
  // The next rotation replaces .1: the oldest entries go. That is the bound (between max and 2 × max kept).
  for (let i = 8; i <= 12; i++) log.record({ at: `t${i}`, target: `u${i}`, outcome: 'ok' });
  const kept = log.list({ limit: 200 });
  assert.deepEqual([kept.total, kept.entries.at(-1).target, kept.entries[0].target], [7, 'u6', 'u12']);

  // A restart picks up where the file is (the count isn't lost), and a torn line is skipped, not fatal.
  appendFileSync(file, '{"at":"t13","targ');
  appendFileSync(file, '\n');
  const again = auditLog(file, { max: 5 });
  assert.equal(again.list({ limit: 200 }).entries[0].target, 'u12');
  for (const i of [14, 15, 16]) again.record({ at: `t${i}`, target: `u${i}`, outcome: 'ok' }); // u16 finds 5 lines (2, the torn one, 2 more): rotated
  assert.deepEqual(again.list({ limit: 2 }).entries.map((e) => e.target), ['u16', 'u15']);
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);

  // Without a file: kept in memory, bounded the same way. A write that fails never throws.
  const mem = auditLog(null, { max: 3 });
  for (let i = 1; i <= 7; i++) mem.record({ target: `m${i}` });
  assert.deepEqual(mem.list({ limit: 200 }).entries.map((e) => e.target), ['m7', 'm6', 'm5', 'm4']);
  auditLog(join(dir, 'no-such-dir', 'audit.jsonl')).record({ target: 'x' });

  const env = { ADMIN_USER: 'a', ADMIN_PASS: 'b', DOMAIN: 'x.test', SIGNUP: 'off' };
  assert.deepEqual([configFromEnv(env).auditFile, configFromEnv(env).auditMax], [null, 10_000]);
  assert.deepEqual([configFromEnv({ ...env, AUDIT_FILE: '/data/audit.jsonl', AUDIT_MAX_ENTRIES: '500' }).auditFile, configFromEnv({ ...env, AUDIT_MAX_ENTRIES: '500' }).auditMax], ['/data/audit.jsonl', 500]);
});

test('admin console writes the audit log: who, what, whom, outcome; no secrets; admins only', { skip, timeout: 60_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8);
  const pass = `throwaway pass ${tag} river`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const boss = `t-audit-${tag}`, plain = `t-audit-${tag}-p`;
  const made = [await mk(boss), await mk(plain)];
  const dir = mkdtempSync(join(tmpdir(), 'openmail-audit-'));
  const file = join(dir, 'audit.jsonl');

  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], auditFile: file, retentionJob: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.close(); rmSync(dir, { recursive: true, force: true });
    const { ids } = await jmap([['x:Account/query', { filter: { text: `t-audit-${tag}` } }, 'q']]); // the team mailbox too, if a failure left it
    await jmap([['x:Account/set', { destroy: [...new Set([...made, ...ids])] }, 'x']]).catch(() => {});
  });
  const base = `http://127.0.0.1:${app.address().port}/api/admin`;
  const as = (user, p = pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}@openmail.test:${p}`).toString('base64'), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, headers = as(boss)) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const log = async (q = '') => (await call(`/audit${q}`)).entries;

  // Admins only, like every other admin endpoint. Refused callers and reads leave no line.
  assert.equal((await call('/audit', 'GET', undefined, {})).status, 401);
  assert.equal((await call('/audit', 'GET', undefined, as(plain))).status, 403);
  assert.equal((await call('/users', 'POST', { name: `t-audit-${tag}-no` }, as(plain))).status, 403);
  assert.equal((await call('/audit', 'POST')).status, 405); // nobody writes or clears it over the API
  await call('/users'); await call('/overview');
  assert.deepEqual(await log(), []);
  assert.equal(existsSync(file), false);

  // Users: create, several changes in one request, a refused change, delete.
  const name = `t-audit-${tag}-u`, email = `${name}@openmail.test`;
  const c = await call('/users', 'POST', { name, quotaBytes: 5_000_000, description: 'secret plans' });
  assert.equal(c.status, 200, JSON.stringify(c));
  made.push(c.user.id);
  const reset = await call(`/users/${c.user.id}`, 'PATCH', { enabled: false, quotaBytes: null, resetPassword: true });
  assert.equal(reset.status, 200, JSON.stringify(reset));
  assert.equal((await call(`/users/${c.user.id}`, 'PATCH', { quotaBytes: -5 })).error.code, 'bad_quota');
  assert.equal((await call(`/users/${made[0]}`, 'DELETE')).error.code, 'protected'); // an admin account: refused, and that is recorded
  assert.equal((await call('/users/zzzzzz', 'DELETE')).error.code, 'not_found');

  // Team mailbox: create, add and remove a member, delete.
  const team = `t-audit-${tag}-t`;
  const g = await call('/groups', 'POST', { name: team });
  assert.equal(g.status, 200, JSON.stringify(g));
  made.push(g.group.id);
  assert.equal((await call(`/groups/${g.group.id}`, 'PATCH', { add: plain })).status, 200);
  assert.equal((await call(`/groups/${g.group.id}`, 'PATCH', { remove: `${plain}@openmail.test` })).status, 200);
  assert.equal((await call(`/groups/${g.group.id}`, 'DELETE')).status, 200);

  // New-account limits, retention and legal hold, held mail (off here: still recorded, as not found).
  const lim = await call('/new-accounts', 'POST', { address: name });
  const key = (await call('/new-accounts')).keys.find((k) => k.address === lim.address);
  assert.equal((await call(`/new-accounts/${key.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/retention/${c.user.id}`, 'PATCH', { hold: true, maxAgeDays: 90 })).status, 200);
  assert.equal((await call(`/users/${c.user.id}`, 'DELETE')).error.code, 'on_hold');
  assert.equal((await call(`/retention/${c.user.id}`, 'PATCH', { hold: false, maxAgeDays: null })).status, 200);
  assert.equal((await call('/retention/preview', 'POST', {})).status, 200); // a dry run changes nothing: not recorded
  assert.equal((await call('/held/abcdef/release', 'POST')).status, 404);
  assert.equal((await call(`/users/${c.user.id}`, 'DELETE')).status, 200);
  made.splice(made.indexOf(c.user.id), 1);

  const want = [ // oldest first
    ['user.create', email, undefined, 'ok'],
    ['user.update', email, ['disable', 'quota:none', 'password_reset'], 'ok'],
    ['user.update', email, ['quota:-5'], 'bad_quota'],
    ['user.delete', `${boss}@openmail.test`, undefined, 'protected'],
    ['user.delete', 'zzzzzz', undefined, 'not_found'], // nothing to name it by: the id that was asked for
    ['team.create', `${team}@openmail.test`, undefined, 'ok'],
    ['team.members', `${team}@openmail.test`, [`member_add:${plain}@openmail.test`], 'ok'],
    ['team.members', `${team}@openmail.test`, [`member_remove:${plain}@openmail.test`], 'ok'],
    ['team.delete', `${team}@openmail.test`, undefined, 'ok'],
    ['limits.add', email, undefined, 'ok'],
    ['limits.lift', email, undefined, 'ok'],
    ['retention.account', email, ['max_age_days:90', 'hold_on'], 'ok'],
    ['user.delete', email, undefined, 'on_hold'],
    ['retention.account', email, ['max_age_days:server', 'hold_off'], 'ok'],
    ['held.release', 'abcdef', undefined, 'not_found'],
    ['user.delete', email, undefined, 'ok'],
  ];
  const entries = await log('?limit=200');
  assert.deepEqual(entries.map((e) => [e.action, e.target, e.detail, e.outcome]).reverse(), want);
  for (const e of entries) {
    assert.equal(e.admin, boss);
    assert.ok(Math.abs(Date.now() - Date.parse(e.at)) < 60_000, e.at);
    assert.equal(e.ip, '127.0.0.1');
    assert.deepEqual(Object.keys(e).filter((k) => !['at', 'admin', 'role', 'ip', 'action', 'target', 'detail', 'outcome'].includes(k)), []);
  }
  // Every route that changes something has a name in the log.
  assert.deepEqual(Object.values(AUDITED).filter((a) => !/^[a-z]+\.[a-z]+$/.test(a)), []);

  // Paging: newest first, limit and offset, total.
  const page = await call('/audit?limit=3&offset=1');
  assert.deepEqual([page.total, page.limit, page.offset, page.entries.map((e) => e.action).join()], [want.length, 3, 1, 'held.release,retention.account,user.delete']);
  assert.equal((await call('/audit?limit=100000')).limit, 200);

  // The file is plain JSON lines, and holds no secret: not the passwords the console generated, not the admin's
  // own, not a sign-in header, and nothing typed into free-text fields.
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, want.length);
  for (const line of text.trim().split('\n')) JSON.parse(line);
  for (const secret of [c.password, reset.password, pass, admin.pass, 'Basic ', 'Bearer ', 'secret plans']) assert.ok(secret && !text.includes(secret), `the log must not contain ${secret}`);
});
