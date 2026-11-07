// Creates a real account on the local dev Stalwart (node deploy/dev-setup.mjs), logs in as it, then deletes it.
// Skips if the server or deploy/.dev-admin.json isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const DOMAIN = 'openmail.test';
const QUOTA = 50 * 1024 * 1024;

const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
  .then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('signup creates a working, quota-limited account on the real server, then cleans up', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const adminJmap = async (methodCalls) => {
    const r = await fetch(`${STALWART}/jmap/`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) });
    return (await r.json()).methodResponses[0][1];
  };

  const username = `t-signup-${Date.now().toString(36)}`;
  const password = 'integration test passphrase 42';
  const invites = new Invites({ text: 'itest:1' });
  const app = createApp({ stalwartUrl: STALWART, admin, domain: DOMAIN, inviteRequired: true, invites,
    turnstileSecret: null, quotaBytes: QUOTA, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [] });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const signup = (body) => fetch(`${base}/api/signup`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const available = (u) => fetch(`${base}/api/username-available?u=${u}`).then((r) => r.json());

  // Always delete what we made, even if an assertion fails halfway.
  t.after(async () => {
    const q = await adminJmap([['x:Account/query', { filter: { name: username } }, 'q']]);
    if (q.ids?.length) {
      const d = await adminJmap([['x:Account/set', { destroy: q.ids }, 'd']]);
      assert.deepEqual(d.destroyed, q.ids, 'cleanup: account destroyed');
    }
  });

  assert.equal((await available('alice')).available, false, 'existing account is reported taken');
  assert.equal((await available(username)).available, true);

  const res = await signup({ username, password, inviteCode: 'itest' });
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, email: `${username}@${DOMAIN}` });
  assert.equal(invites.codes.get('itest'), 0, 'invite use spent');

  const session = await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: basic(`${username}@${DOMAIN}`, password) } });
  assert.equal(session.status, 200, 'new account can log in');
  assert.ok((await session.json()).primaryAccounts['urn:ietf:params:jmap:mail']);

  const got = await adminJmap([['x:Account/query', { filter: { name: username } }, 'q']]);
  const acct = (await adminJmap([['x:Account/get', { ids: got.ids }, 'g']])).list[0];
  assert.equal(acct.quotas.maxDiskQuota, QUOTA, 'disk quota applied');
  assert.equal(acct.roles['@type'], 'User', 'plain user role, not admin');

  assert.equal((await available(username)).available, false);
  invites.refund('itest');
  const dup = await signup({ username, password, inviteCode: 'itest' });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error.code, 'username_taken');
  assert.equal(invites.codes.get('itest'), 1, 'failed signup refunds the invite');

  // Long enough for us (12+) but Stalwart's own strength check (minPasswordStrength) may reject it.
  const weak = await signup({ username: `${username}-w`, password: 'aaaaaaaaaaaa', inviteCode: 'itest' });
  const weakBody = await weak.json();
  if (weak.status === 201) await adminJmap([['x:Account/set', { destroy: (await adminJmap([['x:Account/query', { filter: { name: `${username}-w` } }, 'q']])).ids }, 'd']]);
  assert.equal(weak.status, 400, JSON.stringify(weakBody));
  assert.equal(weakBody.error.code, 'password_weak');
});
