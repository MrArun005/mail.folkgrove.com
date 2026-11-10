// Sharing lookups (/api/principal) and team mailboxes in the admin console (/api/admin/groups), against the local
// dev Stalwart with throwaway t-sharing-* accounts (never alice/bob). Skips if the server or admin file isn't there.
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

test('principal lookup and team mailboxes', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = `t-sharing-${Math.random().toString(36).slice(2, 7)}`;
  const pass = `throwaway pass ${tag} river`;
  const mk = async (name, description) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, ...(description && { description }), credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const boss = `${tag}-admin`, ann = `${tag}-ann`, ben = `${tag}-ben`;
  // Ben signed himself up: his description holds the invite code and outside address, which no one else may read.
  const made = [await mk(boss), await mk(ann), await mk(ben, 'Self sign-up 2026-01-01 (invite SECRETCODE) · verified ben@outside.example')];

  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss] });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await jmap([['x:Account/set', { destroy: made }, 'x']]).catch(() => {}); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const as = (user) => ({ Authorization: 'Basic ' + Buffer.from(`${user}@openmail.test:${pass}`).toString('base64'), 'Content-Type': 'application/json' });
  const call = (path, method = 'GET', body, headers = as(boss)) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Principal lookup: one exact address on this domain, signed-in users only.
  assert.equal((await call(`/principal?email=${ben}@openmail.test`, 'GET', undefined, {})).status, 401);
  const found = await call(`/principal?email=${ben.toUpperCase()}@openmail.test`, 'GET', undefined, as(ann));
  assert.deepEqual(found.principal, { id: made[2], name: `${ben}@openmail.test`, email: `${ben}@openmail.test` });
  assert.equal((await call(`/principal?email=${ben}@example.com`, 'GET', undefined, as(ann))).status, 404);
  assert.equal((await call(`/principal?email=${tag}@openmail.test`, 'GET', undefined, as(ann))).status, 404); // no prefix matches

  // Names of the people your folders are shared with, and nobody else.
  const s = await (await fetch(`${STALWART}/jmap/session`, { headers: as(ann) })).json();
  const acc = s.primaryAccounts['urn:ietf:params:jmap:mail'];
  const mail = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: as(ann),
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }) })).json()).methodResponses[0][1];
  assert.deepEqual((await call('/principal?shared=1', 'GET', undefined, as(ann))).people, []);
  const inbox = (await mail([['Mailbox/get', { accountId: acc, properties: ['role'] }, 'm']])).list.find((b) => b.role === 'inbox').id;
  await mail([['Mailbox/set', { accountId: acc, update: { [inbox]: { [`shareWith/${made[2]}`]: { mayReadItems: true } } } }, 's']]);
  assert.deepEqual((await call('/principal?shared=1', 'GET', undefined, as(ann))).people, [{ id: made[2], name: `${ben}@openmail.test`, email: `${ben}@openmail.test` }]);

  // Team mailboxes: only admins; create, add members (they get the account), remove, delete.
  assert.equal((await call('/admin/groups', 'GET', undefined, as(ann))).status, 403);
  const team = `${tag}-support`;
  const g = await call('/admin/groups', 'POST', { name: team, description: 'Support team' });
  assert.equal(g.status, 200, JSON.stringify(g));
  made.push(g.group.id);
  assert.equal((await call('/admin/groups', 'POST', { name: team })).status, 409);
  assert.equal((await call(`/admin/groups/${g.group.id}`, 'PATCH', { add: ann })).status, 200);
  assert.equal((await call(`/admin/groups/${g.group.id}`, 'PATCH', { add: `${ben}@openmail.test` })).status, 200);
  assert.equal((await call(`/admin/groups/${g.group.id}`, 'PATCH', { add: `${tag}-nobody` })).status, 404);
  assert.equal((await call(`/admin/groups/${made[1]}`, 'PATCH', { add: ben })).status, 404); // a user isn't a team
  const listed = (await call('/admin/groups')).groups.find((x) => x.id === g.group.id);
  assert.deepEqual([listed.email, listed.description, listed.members], [`${team}@openmail.test`, 'Support team', [`${ann}@openmail.test`, `${ben}@openmail.test`]]);
  const accounts = async (u) => Object.keys((await (await fetch(`${STALWART}/jmap/session`, { headers: as(u) })).json()).accounts);
  assert.ok((await accounts(ann)).includes(g.group.id), 'members see the team mailbox in their session');
  assert.equal((await call(`/admin/groups/${g.group.id}`, 'PATCH', { remove: ann })).status, 200);
  assert.ok(!(await accounts(ann)).includes(g.group.id));
  assert.equal((await call(`/admin/groups/${g.group.id}`, 'DELETE')).status, 200);
  made.pop();
  assert.ok(!(await call('/admin/groups')).groups.some((x) => x.id === g.group.id));
  assert.equal((await call(`/username-available?u=${team}`)).available, false); // retired, never recycled
});
