// Confidential mode against the local dev Stalwart: the web app encrypts (web/src/seal.ts), stores the ciphertext as
// a 1-day large-file link, and the viewer (/confidential.html) fetches /f/<id> and decrypts with the key from the
// link. Here: encrypt → store → open with the key → a wrong key fails → revoked gives 404 → expired gives 404.
// The crypto below is the same format as seal.ts (IV, then AES-256-GCM ciphertext; key = 32 random bytes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const DOMAIN = 'openmail.test';
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

const { subtle } = globalThis.crypto;
async function seal(text) {
  const k = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']), new TextEncoder().encode(text)));
  return { blob: Buffer.concat([iv, ct]), key: k };
}
async function unseal(blob, k) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, await subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt']), blob.subarray(12));
  return new TextDecoder().decode(pt);
}

test('confidential messages: stored encrypted, opened with the key, revoked and expired give 404', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const adminJmap = async (calls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }) })).json()).methodResponses[0][1];
  const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === DOMAIN).id;
  const user = `t-secure-${Date.now().toString(36)}`, password = 'throwaway passphrase 42';
  const made = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name: user, domainId,
    credentials: { 0: { '@type': 'Password', secret: password } }, quotas: { maxDiskQuota: 50e6 } } } }, 'c']]);
  const acct = made.created.n.id;
  t.after(() => adminJmap([['x:Account/set', { destroy: [acct] }, 'x']]));

  const cfg = { stalwartUrl: STALWART, admin, domain: DOMAIN, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 30, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, signupEnabled: false,
    filesDb: join(mkdtempSync(join(tmpdir(), 'om-secret-')), 'files.json'), filesPerHour: 100 };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const me = { Authorization: basic(`${user}@${DOMAIN}`, password) };
  const store = async (blob) => {
    const r = await fetch(`${base}/api/files?name=Confidential%20message.bin&expires=1`, { method: 'POST', headers: { ...me, 'Content-Type': 'application/octet-stream' }, body: blob });
    return { status: r.status, ...(await r.json()) };
  };

  // Encrypt → store: only ciphertext reaches the service, for 1 day.
  const secret = JSON.stringify({ subject: 'Offer', sent: new Date().toISOString(), text: 'The salary is 100' });
  const { blob, key } = await seal(secret);
  const s = await store(blob);
  assert.equal(s.status, 201, JSON.stringify(s));
  assert.ok(Math.abs(s.file.expires - (Date.now() + 864e5)) < 60e3, 'expires in 1 day');
  assert.ok(!readFileSync(cfg.filesDb, 'utf8').includes('salary'));

  // Open with the key (what the viewer does): the public link serves the bytes as they were stored.
  const got = Buffer.from(await (await fetch(`${base}/f/${s.file.id}`)).arrayBuffer());
  assert.ok(!got.toString('latin1').includes('salary'), 'served encrypted');
  assert.equal(await unseal(got, key), secret);
  // A wrong key fails (GCM authenticates), and so does a changed byte.
  await assert.rejects(unseal(got, crypto.getRandomValues(new Uint8Array(32))));
  const bent = Buffer.from(got); bent[30] ^= 1;
  await assert.rejects(unseal(bent, key));

  // Revoked → 404.
  assert.equal((await fetch(`${base}/api/files/${s.file.id}`, { method: 'DELETE', headers: me })).status, 200);
  assert.equal((await fetch(`${base}/f/${s.file.id}`)).status, 404);

  // Expired → 404 (the hourly sweep deletes the file later; the link stops at once).
  const e = await store((await seal(secret)).blob);
  assert.equal((await fetch(`${base}/f/${e.file.id}`)).status, 200);
  cfg.links.get(e.file.id).expires = Date.now() - 1000;
  assert.equal((await fetch(`${base}/f/${e.file.id}`)).status, 404);

  // Only 1, 7, 30 days or never.
  const bad = await fetch(`${base}/api/files?name=x&expires=2`, { method: 'POST', headers: me, body: 'x' });
  assert.equal((await bad.json()).error.code, 'bad_expiry');
});
