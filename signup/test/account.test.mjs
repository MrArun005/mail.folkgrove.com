// Delete my account against the local dev Stalwart: a throwaway account (made with the admin API) deletes itself,
// and neither its username nor its alias can be signed up for again, even after a restart. Skips if the server or
// deploy/.dev-admin.json isn't there. Never touches alice or bob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const DOMAIN = 'openmail.test';
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
/** RFC 6238 code for a base32 secret, `step` 30-second windows from now. */
function totp(secret, step = 0) {
  const bits = [...secret].map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30e3) + step));
  const h = createHmac('sha1', Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))).update(counter).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('delete my account: checks, erasure, and the name is never given out again', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const adminJmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];

  const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === DOMAIN).id;
  const user = `t-erase-${Date.now().toString(36)}`, alias = `${user}-alias`, email = `${user}@${DOMAIN}`;
  const password = 'throwaway passphrase 42';
  const made = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name: user, domainId,
    credentials: { 0: { '@type': 'Password', secret: password } }, aliases: { 0: { name: alias, domainId, enable: true } } } } }, 'c']]);
  const id = made.created.n.id;
  t.after(() => adminJmap([['x:Account/set', { destroy: [id] }, 'x']]).catch(() => {})); // if the test fails midway

  const retiredFile = join(mkdtempSync(join(tmpdir(), 'om-retired-')), 'retired-names.txt');
  const cfg = () => ({ stalwartUrl: STALWART, admin, domain: DOMAIN, inviteRequired: false, invites: new Invites({ text: '' }),
    turnstileSecret: null, quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 30, clientIpHeader: null, extraReserved: [],
    allowBasicAuth: true, retiredFile });
  const start = async () => { const app = createApp(cfg()); await new Promise((r) => app.listen(0, '127.0.0.1', r)); t.after(() => app.close()); return `http://127.0.0.1:${app.address().port}`; };
  let base = await start();
  const del = (body, auth = basic(email, password)) => fetch(`${base}/api/account`, { method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await del({ password, confirm: email }, null)).status, 401);
  assert.equal((await del({ password, confirm: 'someone@else.test' })).error.code, 'confirm_mismatch');
  assert.equal((await del({ password: 'not the password', confirm: email })).error.code, 'wrong_password');
  assert.equal((await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: basic(email, password) } })).status, 200, 'still there after refusals');

  // An app password (as a phone's mail app holds) and two-factor sign-in: the user's own security calls.
  const own = async (calls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(email, password) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }) })).json()).methodResponses[0][1];
  const appPass = (await own([['x:AppPassword/set', { accountId: id, create: { p: { description: 'test' } } }, 'c']])).created.p.secret;
  const otp = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const on = await own([['x:AccountPassword/set', { accountId: id, update: { singleton: { currentSecret: password,
    otpAuth: { otpUrl: `otpauth://totp/t:${email}?secret=${otp}`, otpCode: totp(otp, -1) } } } }, 's']]);
  assert.ok('singleton' in (on.updated ?? {}), JSON.stringify(on));
  const asApp = basic(email, appPass); // stands in for the caller's token from here on (password sign-in now needs a code)
  assert.equal((await del({ password: appPass, confirm: email }, asApp)).error.code, 'wrong_password', 'an app password is not the password');
  assert.equal((await del({ password, confirm: email }, asApp)).error.code, 'code_required');
  assert.equal((await del({ password, code: '000000', confirm: email }, asApp)).error.code, 'wrong_password');

  const ok = await del({ password, code: totp(otp), confirm: ` ${email.toUpperCase()} ` }, asApp);
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal((await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: asApp } })).status, 401, 'gone');
  assert.deepEqual((await adminJmap([['x:Account/query', { filter: { name: user, domainId } }, 'q']])).ids, []);
  assert.deepEqual(readFileSync(retiredFile, 'utf8').trim().split('\n').sort(), [alias, user].sort());

  // Stalwart itself would now accept these names again; our sign-up must not, also after a restart.
  for (const b of [base, (base = await start())]) {
    for (const name of [user, alias]) {
      const r = await fetch(`${b}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'a brand new passphrase 9' }) }).then((x) => x.json());
      assert.equal(r.error?.code, 'username_reserved', `${name} must stay retired`);
      assert.equal((await fetch(`${b}/api/username-available?u=${name}`).then((x) => x.json())).available, false);
    }
  }
  assert.deepEqual((await adminJmap([['x:Account/query', { filter: { name: user, domainId } }, 'q']])).ids, [], 'nothing re-created');
});
