// Large-file links against the local dev Stalwart: upload (bigger than Stalwart's own 50 MB upload limit), link,
// download, revoke then 404, expiry, limits, and a deleted account's links. A throwaway account (made with the
// admin API) does it all and is deleted at the end. Skips if the server or deploy/.dev-admin.json isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { forgetFiles } from '../files.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const DOMAIN = 'openmail.test';
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('a client gets 15 s to send its whole request (configurable); slow senders are cut off', async (t) => {
  const app = createApp({ stalwartUrl: 'http://127.0.0.1:9', admin: { user: 'a', pass: 'b' }, domain: 'x.test', inviteRequired: false,
    invites: new Invites({ text: '' }), signupsPerHour: 10, checksPerMinute: 10, extraReserved: [], requestTimeoutMs: 300 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const { connect } = await import('node:net');
  const started = Date.now();
  const closed = await new Promise((resolve) => {
    const c = connect(app.address().port, '127.0.0.1');
    c.write('POST /api/signup HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"user');
    c.on('close', () => resolve(Date.now() - started));
    setTimeout(() => { c.destroy(); resolve(null); }, 3000);
  });
  assert.ok(closed !== null && closed < 2000, `cut off after ${closed} ms`);
  assert.equal(app.requestTimeout, 0, 'node’s own limit is off: the timer replaces it, so uploads can be allowed longer');
});

test('large-file links: upload, download, revoke, expiry, limits', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const call = async (using, methodCalls, auth = basic(admin.user, admin.pass)) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ using, methodCalls }) })).json()).methodResponses[0][1];
  const adminJmap = (calls) => call(['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], calls);
  const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === DOMAIN).id;
  const user = `t-files-${Date.now().toString(36)}`, password = 'throwaway passphrase 42', email = `${user}@${DOMAIN}`;
  const made = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name: user, domainId,
    credentials: { 0: { '@type': 'Password', secret: password } }, quotas: { maxDiskQuota: 300e6 } } } }, 'c']]);
  const acct = made.created.n.id;
  t.after(() => adminJmap([['x:Account/set', { destroy: [acct] }, 'x']]));

  const cfg = { stalwartUrl: STALWART, admin, domain: DOMAIN, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 30, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, signupEnabled: false,
    filesDb: join(mkdtempSync(join(tmpdir(), 'om-files-')), 'files.json'), maxFileBytes: 200e6, filesQuotaBytes: 250e6, filesPerHour: 100 };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const me = { Authorization: basic(email, password) };
  const json = async (r) => ({ status: r.status, ...(await r.json()) });
  const up = (body, query = '', headers = me) => fetch(`${base}/api/files?${query}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/html' }, body }).then(json);
  const list = () => fetch(`${base}/api/files`, { headers: me }).then(json);
  const used = async () => (await call(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:quota'], [['Quota/get', { accountId: acct, ids: null }, 'q']])).list[0].used;

  assert.equal((await up('x', 'name=a.txt', {})).status, 401);
  assert.equal((await fetch(`${base}/f/AAAAAAAAAAAAAAAAAAAAAAAA`)).status, 404);

  // 60 MB of HTML: over Stalwart's 50 MB upload limit for users, and a type a browser would render.
  const big = Buffer.alloc(60e6, 'a'); big.write('<script>alert(1)</script>');
  const before = await used();
  const made1 = await up(big, 'name=Q3%20report%20%C3%A9.html&expires=30');
  assert.equal(made1.status, 201, JSON.stringify(made1));
  const f = made1.file;
  assert.match(f.id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(f.url, `/f/${f.id}`);
  assert.equal(f.size, 60e6);
  assert.ok(Math.abs(f.expires - (Date.now() + 30 * 864e5)) < 60e3, 'expires in 30 days');
  assert.ok((await used()) - before >= 60e6, 'counts toward the sender’s storage');

  // Stored in their own storage, in "Shared files".
  const nodes = (await call(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode'], [['FileNode/get', { accountId: acct, ids: null, properties: ['name', 'parentId', '@type'] }, 'g']])).list;
  const dir = nodes.find((n) => n['@type'] === 'Directory');
  assert.equal(dir.name, 'Shared files');
  assert.equal(nodes.find((n) => n['@type'] === 'File').parentId, dir.id);

  const dl = await fetch(`${base}${f.url}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.headers.get('content-disposition'), `attachment; filename="Q3 report _.html"; filename*=UTF-8''Q3%20report%20%C3%A9.html`);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(big), 'same bytes back');
  let mine = await list();
  assert.deepEqual(mine.files.map((x) => [x.id, x.name, x.size, x.downloads]), [[f.id, 'Q3 report é.html', 60e6, 1]]);

  // Same name again: stored next to it under another name; never-expiring.
  const again = await up('small', 'name=Q3%20report%20%C3%A9.html&expires=0');
  assert.equal(again.status, 201);
  assert.equal(again.file.expires, null);

  // Limits: expiry choices, biggest file, total per user, length required.
  assert.equal((await up('x', 'name=a&expires=5')).error.code, 'bad_expiry');
  assert.equal((await up(Buffer.alloc(201e6), 'name=a')).error.code, 'too_large');
  assert.equal((await up(Buffer.alloc(195e6), 'name=a')).error.code, 'quota');

  // Two uploads at once can't both fit under the per-user total: the one still streaming counts.
  const both = await Promise.all([up(Buffer.alloc(100e6), 'name=a.bin'), up(Buffer.alloc(100e6), 'name=b.bin')]);
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 413], JSON.stringify(both.map((x) => x.error)));
  const won = both.find((x) => x.status === 201).file;
  assert.equal((await fetch(`${base}/api/files/${won.id}`, { method: 'DELETE', headers: me })).status, 200);
  assert.equal((await up('fits again', 'name=c.txt')).status, 201, 'the reservation was released');

  // Something fails after the file is stored (here: the link list can't be written): no file is left behind.
  const files = async () => (await call(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode'], [['FileNode/get', { accountId: acct, ids: null, properties: ['id'] }, 'g']])).list.length;
  const count = await files(), db = cfg.filesDb;
  cfg.filesDb = mkdtempSync(join(tmpdir(), 'om-files-')); // a folder: saving over it fails
  assert.equal((await up('doomed', 'name=doomed.txt')).status, 500);
  cfg.filesDb = db;
  assert.equal(await files(), count, 'the stored file was deleted again');
  assert.ok((await list()).files.every((x) => x.name !== 'doomed.txt'));

  // Somebody else can't revoke it (alice: a read-only attempt on an id that isn't hers).
  const alice = { Authorization: basic('alice@openmail.test', 'alice-dev-pass') };
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { method: 'DELETE', headers: alice })).status, 404);

  // Revoke: the link stops working and the file leaves their storage.
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { method: 'DELETE', headers: me }).then(json)).ok, true);
  assert.equal((await fetch(`${base}${f.url}`)).status, 404);
  assert.ok((await used()) - before < 1e6, 'storage given back');

  // Expiry: a link past its date is gone (the hourly sweep then deletes the file).
  const short = (await up('soon gone', 'name=soon.txt&expires=7')).file;
  assert.equal((await fetch(`${base}${short.url}`)).status, 200);
  cfg.links.get(short.id).expires = Date.now() - 1000;
  assert.equal((await fetch(`${base}${short.url}`)).status, 404);
  mine = await list();
  assert.deepEqual(mine.files.map((x) => x.id).sort(), [again.file.id, ...mine.files.filter((x) => x.name === 'c.txt').map((x) => x.id)].sort());

  // Kept across restarts (FILES_DB).
  const app2 = createApp({ ...cfg, links: undefined });
  await new Promise((r) => app2.listen(0, '127.0.0.1', r));
  t.after(() => app2.close());
  assert.equal((await fetch(`http://127.0.0.1:${app2.address().port}${again.file.url}`)).status, 200);

  // A deleted account's links stop working (account.mjs and admin.mjs call this after the destroy).
  forgetFiles(cfg, acct);
  assert.equal((await fetch(`${base}${again.file.url}`)).status, 404);
});
