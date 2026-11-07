// Sign-up with email verification, and the system mailer, against the local dev Stalwart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { sendMail } from '../mailer.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('system mailer delivers through our own server (SMTP submission, TLS, AUTH)', { skip }, async () => {
  const subject = `mailer test ${Date.now()}`;
  await sendMail({ host: 'localhost', port: 1465, user: 'alice@openmail.test', pass: 'alice-dev-pass', insecure: true },
    { from: 'OpenMail <alice@openmail.test>', to: 'alice@openmail.test', subject, text: 'Your code is 123456.\n.leading dot line' });
  const jmap = async (m) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic('alice@openmail.test', 'alice-dev-pass'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: m }) })).json()).methodResponses;
  let found = [];
  for (let i = 0; i < 30 && !found.length; i++) {
    await new Promise((r) => setTimeout(r, 300));
    found = (await jmap([['Email/query', { accountId: 'c', filter: { subject } }, 'q']]))[0][1].ids;
  }
  assert.equal(found.length, 1, 'delivered');
  await jmap([['Email/set', { accountId: 'c', destroy: found }, 'd']]);
  await assert.rejects(() => sendMail({ host: 'localhost', port: 1465, user: 'x', pass: 'y', insecure: true }, { from: 'a@b.c', to: 'x@y.z\r\nBcc: evil@z', subject: 's', text: 't' }), /header injection/);
});

test('sign-up needs a code sent to an existing address; wrong code refused; right code creates the account', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const sent = [];
  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: true, inviteRequired: false, invites: new Invites({ text: '' }),
    turnstileSecret: null, quotaBytes: 0, signupsPerHour: 20, checksPerMinute: 30, clientIpHeader: null, extraReserved: [],
    verifyEmail: true, systemMail: { from: 'OpenMail <noreply@openmail.test>' }, mailer: async (_cfg, m) => { sent.push(m); } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const username = `t-verify-${Date.now().toString(36)}`, password = 'verification test pass 42';
  t.after(async () => {
    app.close();
    const H = { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) };
    const q = await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: H, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [['x:Account/query', { filter: { name: username } }, 'q']] }) })).json();
    const ids = q.methodResponses[0][1].ids;
    if (ids.length) await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: H, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [['x:Account/set', { destroy: ids }, 'd']] }) });
  });
  const signup = (body) => fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await signup({ username, password })).error.field, 'recoveryEmail', 'an existing address is required');
  assert.equal((await signup({ username, password, recoveryEmail: 'me@openmail.test' })).error.code, 'email_same_domain');

  const step1 = await signup({ username, password, recoveryEmail: 'Real.Person@Example.com' });
  assert.equal(step1.status, 202);
  assert.equal(step1.sentTo, 'r•••@example.com');
  const code = /(\d{6})/.exec(sent[0].subject)[1];
  assert.equal(sent[0].to, 'real.person@example.com');

  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.equal((await signup({ username, password, recoveryEmail: 'real.person@example.com', verifyCode: wrong })).error.code, 'code_wrong');
  const ok = await signup({ username, password, recoveryEmail: 'real.person@example.com', verifyCode: code });
  assert.equal(ok.status, 201, JSON.stringify(ok));
  assert.equal((await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: basic(`${username}@openmail.test`, password) } })).status, 200, 'the new account works');
  assert.equal((await signup({ username, password, recoveryEmail: 'real.person@example.com', verifyCode: code })).status, 400, 'a code works once');
});

test('tiers: a new sign-up lands on the new-accounts list; promotion after the window removes it', { skip }, async () => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const H = { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) };
  const api = async (m) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: H, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: m }) })).json()).methodResponses[0][1];
  const { tiers } = await import('../tiers.mjs');
  const domainId = (await api([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const name = `t-tier-${Date.now().toString(36)}`, addr = `${name}@openmail.test`;
  const created = await api([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: 'tier test pass 1234' } } } } }, 'c']]);
  const t = tiers({ jmap: api, getDomainId: async () => domainId, cfg: {} });
  try {
    await t.markNew(addr);
    const onList = async () => (await api([['x:MemoryLookupKey/query', { filter: { namespace: 'new-accounts' } }, 'q']])).ids.length &&
      (await api([['x:MemoryLookupKey/get', { ids: (await api([['x:MemoryLookupKey/query', { filter: { namespace: 'new-accounts' } }, 'q']])).ids }, 'g']])).list.some((k) => k.key === addr);
    assert.ok(await onList(), 'marked new');
    assert.ok(!(await t.promote(Date.now())).includes(addr), 'not yet: still inside the window');
    let promoted = [];
    for (let i = 0; i < 20 && !promoted.includes(addr); i++) { await new Promise((r) => setTimeout(r, 250)); promoted = await t.promote(Date.now() + 15 * 86400e3); }
    assert.ok(promoted.includes(addr), 'promoted after 14 days');
    assert.ok(!(await onList()), 'off the list');
  } finally {
    await api([['x:Account/set', { destroy: [created.created.n.id] }, 'd']]);
  }
});
