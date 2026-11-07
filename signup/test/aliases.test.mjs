// Masked aliases against the local dev Stalwart (node deploy/dev-setup.mjs): create, receive, switch off, delete.
// Uses alice's real account and removes what it creates. Skips if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { maskedName, toView, cleanLabel } from '../aliases.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

test('alias helpers', () => {
  assert.match(maskedName(), /^[a-z]+\.[a-z]+\.\d{4}$/);
  assert.deepEqual(toView({ name: 'a.b.1234', enable: false, description: 'masked: Shop' }, 'x.test'), { id: 'a.b.1234', email: 'a.b.1234@x.test', label: 'Shop', enabled: false, masked: true });
  assert.equal(toView({ name: 'sales', description: null }, 'x.test').masked, false);
  assert.equal(cleanLabel(' Shop\u0000ping '), 'Shopping');
});

test('passwords are refused unless explicitly allowed (tokens only)', async () => {
  const { aliasRoutes } = await import('../aliases.mjs');
  const { RateLimiter } = await import('../lib.mjs');
  const sent = [];
  const handle = aliasRoutes({ cfg: { stalwartUrl: 'http://127.0.0.1:9', domain: 'x.test' }, jmap: null, getDomainId: null,
    send: () => {}, fail: (_res, status) => sent.push(status), readJson: null, RateLimiter, ipOf: () => 'k' });
  await handle({ headers: { authorization: 'Basic eDp5' }, method: 'GET' }, {}, new URL('http://x/api/aliases'));
  assert.deepEqual(sent, [401]);
});

test('failed sign-ins are rate limited per network', async () => {
  const { aliasRoutes } = await import('../aliases.mjs');
  const { RateLimiter } = await import('../lib.mjs');
  const { createServer } = await import('node:http');
  const stub = createServer((_q, r) => { r.statusCode = 401; r.end(); }); // Stalwart saying "wrong password"
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const sent = [];
  const handle = aliasRoutes({ cfg: { stalwartUrl: `http://127.0.0.1:${stub.address().port}`, domain: 'x.test', allowBasicAuth: true }, jmap: null, getDomainId: null,
    send: () => {}, fail: (_res, status) => sent.push(status), readJson: null, RateLimiter, ipOf: () => '203.0.113.0/24' });
  const req = { headers: { authorization: 'Basic eDp5' }, method: 'GET' };
  const url = new URL('http://x/api/aliases');
  await Promise.all(Array.from({ length: 21 }, () => handle(req, {}, url))); // in parallel: must still be caught
  stub.close();
  assert.deepEqual([sent.filter((x) => x === 401).length, sent.filter((x) => x === 429).length], [20, 1]);
});

/** Ask the dev MX whether it would take mail for this address (RCPT TO answer code). */
function rcptCode(addr) {
  return new Promise((resolve, reject) => {
    const s = connect(2525, 'localhost'); let buf = '', step = 0;
    const cmds = ['EHLO example.org', 'MAIL FROM:<t@example.org>', `RCPT TO:<${addr}>`, 'QUIT'];
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) {
        if (/^\d{3} /.test(l)) { if (step === 3) { resolve(Number(l.slice(0, 3))); s.end(); return; } s.write(cmds[step++] + '\r\n'); }
      }
    });
    s.on('error', reject);
  });
}

test('masked aliases: create, receive, switch off, delete', { skip }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }),
    turnstileSecret: null, quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], maxAliases: 200, aliasesPerHour: 30, allowBasicAuth: true });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const cleanup = []; // aliases to delete before the server closes (after-hooks run in registration order)
  t.after(async () => { for (const f of cleanup) await f().catch(() => {}); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}/api/aliases`;
  const alice = { Authorization: 'Basic ' + Buffer.from('alice@openmail.test:alice-dev-pass').toString('base64'), 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body, headers = alice) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await call('', 'GET', undefined, {})).status, 401);
  assert.equal((await call('', 'GET', undefined, { Authorization: 'Basic ' + Buffer.from('alice@openmail.test:wrong').toString('base64') })).status, 401);

  const made = await call('', 'POST', { label: 'Shopping sites' });
  assert.equal(made.status, 201);
  const { id, email } = made.alias;
  cleanup.push(() => call(`/${id}`, 'DELETE'));
  assert.match(email, /^[a-z]+\.[a-z]+\.\d{4}@openmail\.test$/);
  assert.deepEqual({ ...made.alias, id: 0, email: 0 }, { id: 0, email: 0, label: 'Shopping sites', enabled: true, masked: true });
  assert.ok((await call('')).aliases.some((a) => a.id === id));
  assert.equal(await rcptCode(email), 250);

  assert.equal((await call(`/${id}`, 'PATCH', { enabled: false, label: 'Old shop' })).alias.label, 'Old shop');
  assert.equal(await rcptCode(email), 550); // switched off: the sender gets "no such mailbox"
  await call(`/${id}`, 'PATCH', { enabled: true });
  assert.equal(await rcptCode(email), 250);

  assert.equal((await call(`/${id}`, 'DELETE')).status, 200);
  assert.ok(!(await call('')).aliases.some((a) => a.id === id));
  assert.equal(await rcptCode(email), 550); // retired: mail bounces…
  const admin2 = (m) => fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64') },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: m }) }).then((r) => r.json());
  const [[, dom]] = (await admin2([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).methodResponses;
  const domainId = dom.list.find((d) => d.name === 'openmail.test').id;
  const [[, taken]] = (await admin2([['x:Account/set', { create: { n: { '@type': 'User', name: id, domainId, credentials: { 0: { '@type': 'Password', secret: 'recycle-attempt-123' } } } } }, 'c']])).methodResponses;
  assert.ok(taken.notCreated?.n, '…and nobody can sign up for the old address');
  assert.equal((await call(`/${id}`, 'DELETE')).status, 404);

  // Positions shift when one is deleted: the others must still be found by address.
  const [a, b] = [(await call('', 'POST', { label: 'A' })).alias, (await call('', 'POST', { label: 'B' })).alias];
  cleanup.push(() => call(`/${b.id}`, 'DELETE'));
  await call(`/${a.id}`, 'DELETE');
  assert.equal((await call(`/${b.id}`, 'PATCH', { label: 'B2' })).alias.label, 'B2');
});
