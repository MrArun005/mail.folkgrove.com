// Admin console API against the local dev Stalwart: only listed admins get in; users, limits and the queue work.
// Uses throwaway accounts it creates and deletes (never alice/bob). Skips if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { userView, withSignIn, queueView } from '../admin.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('admin helpers', () => {
  const off = withSignIn({ '@type': 'Inherit' }, false);
  assert.deepEqual(off, { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } });
  assert.deepEqual(withSignIn(off, true), { '@type': 'Inherit' });
  const custom = { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { emailSend: true } };
  assert.deepEqual(withSignIn(withSignIn(custom, false), true), custom); // other permissions survive
  const u = userView({ id: 'x', name: 'a', emailAddress: 'a@x.test', permissions: off, roles: { '@type': 'User' }, aliases: { 0: { enable: true }, 1: { enable: false } }, quotas: { maxDiskQuota: 5 } }, new Set(['a@x.test']));
  assert.deepEqual([u.enabled, u.aliases, u.quota, u.newAccount, u.admin], [false, 1, 5, true, false]);
  const q = queueView({ id: 'm', returnPath: 'a@x.test', recipients: { 'b@y.test': { retryCount: 2, status: { '@type': 'TemporaryFailure', errorMessage: 'timed out', responseCode: 421 } } } });
  assert.deepEqual(q.recipients[0], { to: 'b@y.test', status: 'TemporaryFailure', attempts: 2, nextAttempt: null, error: 'timed out', code: '421' });
});

test('admin console: only admins; users, new-account limits, queue', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Date.now().toString(36);
  const pass = `throwaway pass ${tag} river`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const boss = `t-admin-${tag}`, plain = `t-plain-${tag}`;
  const made = [await mk(boss), await mk(plain)];

  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss] });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await jmap([['x:Account/set', { destroy: made }, 'x']]).catch(() => {}); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}/api/admin`;
  const as = (user, p = pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}@openmail.test:${p}`).toString('base64'), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, headers = as(boss)) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Only listed admins.
  assert.equal((await call('/users', 'GET', undefined, {})).status, 401);
  assert.equal((await call('/users', 'GET', undefined, as(plain))).status, 403);
  assert.equal((await call('/users', 'DELETE', undefined, as(plain))).status, 403);

  const o = await call('/overview');
  assert.equal(o.status, 200);
  assert.ok(o.accounts >= 2 && Number.isInteger(o.queued) && Number.isInteger(o.blockedIps));

  // Create, find, disable, enable, reset password, set quota, delete.
  const name = `t-made-${tag}`;
  const c = await call('/users', 'POST', { name, quotaBytes: 5_000_000 });
  assert.equal(c.status, 200, JSON.stringify(c));
  made.push(c.user.id);
  assert.deepEqual([c.user.email, c.user.quota, c.user.enabled], [`${name}@openmail.test`, 5_000_000, true]);
  const signIn = (p) => fetch(`${STALWART}/jmap/session`, { headers: as(name, p) }).then((r) => r.status);
  assert.equal(await signIn(c.password), 200);
  assert.ok((await call(`/users?q=${name}`)).users.some((u) => u.id === c.user.id));

  assert.equal((await call(`/users/${c.user.id}`, 'PATCH', { enabled: false })).user.enabled, false);
  assert.equal(await signIn(c.password), 403);
  assert.equal((await call(`/users/${c.user.id}`, 'PATCH', { enabled: true })).user.enabled, true);
  const reset = await call(`/users/${c.user.id}`, 'PATCH', { resetPassword: true, quotaBytes: null });
  assert.equal(reset.user.quota, null);
  assert.equal(await signIn(reset.password), 200);
  assert.equal((await call(`/users/${made[0]}`, 'PATCH', { enabled: false })).status, 400); // not yourself
  assert.equal((await call('/users/b', 'DELETE')).status, 403); // never the server administrator

  // New-account limits: add by name (stored as the full address), list, lift.
  const add = await call('/new-accounts', 'POST', { address: name });
  assert.equal(add.address, `${name}@openmail.test`);
  const entry = (await call('/new-accounts')).keys.find((k) => k.address === add.address);
  assert.ok(entry);
  assert.equal((await call(`/users?q=${name}`)).users[0].newAccount, true);
  assert.equal((await call(`/new-accounts/${entry.id}`, 'DELETE')).status, 200);
  assert.ok(!(await call('/new-accounts')).keys.some((k) => k.address === add.address));

  assert.equal((await call(`/users/${c.user.id}`, 'DELETE')).status, 200);
  assert.ok(!(await call(`/users?q=${name}`)).users.some((u) => u.id === c.user.id));
  made.pop();

  // Message trace: a message held in the queue (HOLDFOR, so example.com's null MX can't bounce it first).
  const u = as(plain);
  const s = await (await fetch(`${STALWART}/jmap/session`, { headers: u })).json();
  const acc = s.primaryAccounts['urn:ietf:params:jmap:mail'];
  const mail = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: u,
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'], methodCalls }) })).json()).methodResponses;
  const [[, mb], [, ids]] = await mail([['Mailbox/get', { accountId: acc, properties: ['role'] }, 'm'], ['Identity/get', { accountId: acc }, 'i']]);
  const from = `${plain}@openmail.test`;
  const sent = await mail([
    ['Email/set', { accountId: acc, create: { e: { mailboxIds: { [mb.list.find((m) => m.role === 'drafts').id]: true }, from: [{ email: from }], to: [{ email: 'x@example.com' }],
      subject: 'trace test', textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'hi' } } } } }, 'e'],
    ['EmailSubmission/set', { accountId: acc, create: { s: { identityId: ids.list[0].id, emailId: '#e',
      envelope: { mailFrom: { email: from, parameters: { HOLDFOR: '600' } }, rcptTo: [{ email: 'x@example.com' }] } } } }, 's'],
  ]);
  assert.ok(sent[1][1].created?.s, JSON.stringify(sent));
  let item;
  for (let i = 0; i < 20 && !item; i++) {
    item = (await call(`/queue?q=${encodeURIComponent(from)}`)).messages.find((m) => m.from === from);
    if (!item) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(item, 'queued message shows up');
  assert.deepEqual([item.recipients[0].to, item.recipients[0].status, item.recipients[0].attempts], ['x@example.com', 'Scheduled', 0]);
  assert.ok((await call('/queue?q=x@example.com')).messages.some((m) => m.id === item.id)); // by recipient too
  assert.equal((await call(`/queue/${item.id}`, 'DELETE')).status, 200);
  assert.ok(!(await call(`/queue?q=${encodeURIComponent(from)}`)).messages.some((m) => m.id === item.id));
});
