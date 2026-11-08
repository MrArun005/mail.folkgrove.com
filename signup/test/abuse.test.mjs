// Abuse blocking and inactive accounts: the rules (unit), then the whole loop against the local dev Stalwart:
// a throwaway account trips a temporary throttle, Stalwart's webhook reports it, sending is suspended, the account
// lifts it once, the second time needs an admin. Skips the live part if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { abuseRoutes, selfUnblock, inactiveStep, signed, parseEvents, SEND } from '../abuse.mjs';
import { RateLimiter, Invites } from '../lib.mjs';
import { createApp } from '../server.mjs';
import { sendMail } from '../mailer.mjs';
import { connect } from 'node:net';

const DAY = 86400e3, now = Date.parse('2026-11-08T12:00:00Z');

test('self-unblock: once a day, and a second suspension within a week needs an admin', () => {
  assert.equal(selfUnblock([], now), 'ok');
  assert.equal(selfUnblock([{ at: now - 3600e3 }], now), 'ok');
  assert.equal(selfUnblock([{ at: now - 3600e3, by: 'ann' }], now), 'admin');
  assert.equal(selfUnblock([{ at: now - 3 * DAY, liftedAt: now - 3 * DAY, liftedBy: 'self' }, { at: now - 3600e3 }], now), 'admin');
  assert.equal(selfUnblock([{ at: now - 9 * DAY, liftedAt: now - 9 * DAY, liftedBy: 'self' }, { at: now - 3600e3 }], now), 'ok');
  // An admin lifted the first one recently; a self-unblock less than a day ago still waits.
  assert.equal(selfUnblock([{ at: now - 8 * DAY, liftedAt: now - 2 * 3600e3, liftedBy: 'self' }, { at: now - 3600e3 }], now), 'wait');
});

test('inactive: reminders at 60, 30 and 7 days before, once each, then due', () => {
  const days = 365, at = (d) => now - (days - d) * DAY; // last sign-in so that d days are left
  assert.equal(inactiveStep({ last: at(90), now, days }), null);
  assert.equal(inactiveStep({ last: at(60), now, days }), 60);
  assert.equal(inactiveStep({ last: at(45), now, days, reminded: 60 }), null);
  assert.equal(inactiveStep({ last: at(30), now, days, reminded: 60 }), 30);
  assert.equal(inactiveStep({ last: at(10), now, days }), 30); // first seen late: only the most urgent one
  assert.equal(inactiveStep({ last: at(5), now, days, reminded: 30 }), 7);
  assert.equal(inactiveStep({ last: at(5), now, days, reminded: 7 }), null);
  assert.equal(inactiveStep({ last: at(0), now, days, reminded: 7 }), 'due');
});

test('webhook body: signature and 64-bit ids', () => {
  const body = Buffer.from('{"events":[{"type":"x","data":{"queueId":339320800293214700,"spanId":0}}]}');
  const sig = createHmac('sha256', 'k').update(body).digest('base64');
  assert.ok(signed('k', body, sig));
  assert.ok(!signed('k', body, sig.slice(1)) && !signed('other', body, sig) && !signed('k', body, undefined));
  assert.deepEqual(parseEvents(body.toString()), [{ type: 'x', data: { queueId: '339320800293214700', spanId: '0' } }]);
});

/** A pretend Stalwart with one user, enough for the event → suspension path. */
function fakeServer() {
  const acct = { id: 'a1', name: 'eve', emailAddress: 'eve@x.test', roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, aliases: {}, createdAt: '2026-01-01T00:00:00Z' };
  const jmap = async ([[method, args]]) => {
    if (method === 'x:Account/query') return { ids: args.filter.name === 'eve' ? ['a1'] : [] };
    if (method === 'x:Account/get') return { list: args.ids.includes('a1') ? [structuredClone(acct)] : [] };
    if (method === 'x:Account/set') { Object.assign(acct, args.update.a1); return { updated: { a1: null } }; }
    throw new Error(`unexpected ${method}`);
  };
  const app = abuseRoutes({ cfg: { domain: 'x.test', abuseLimitHits: 2, abuseBounces: 2 }, jmap, getDomainId: async () => 'd', send() {}, fail() {}, RateLimiter, ipOf: () => '' });
  return { acct, app };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('events: refusals in a signed-in session suspend sending; forged port-25 mail does not', async () => {
  const { acct, app } = fakeServer();
  // Port 25: someone else's session using eve's address (no sign-in for that span).
  for (let i = 0; i < 5; i++) app.onEvent({ type: 'smtp.rate-limit-exceeded', data: { spanId: '7', from: 'eve@x.test' } });
  await settle();
  assert.deepEqual(acct.permissions, { '@type': 'Inherit' });
  // Eve's own session.
  app.onEvent({ type: 'auth.success', data: { spanId: '8', accountName: 'eve@x.test' } });
  for (let i = 0; i < 3; i++) app.onEvent({ type: 'smtp.rate-limit-exceeded', data: { spanId: '8', from: 'eve@x.test' } });
  await settle();
  assert.deepEqual(Object.keys(acct.permissions.disabledPermissions).sort(), [...SEND].sort());
  assert.match(app.state.suspensions['eve@x.test'][0].reason, /sending limit/);
  assert.ok(app.state.seen['eve@x.test'] > 0);
});

test('events: only bounces of mail the account sent count', async () => {
  const { acct, app } = fakeServer();
  for (let i = 0; i < 5; i++) app.onEvent({ type: 'delivery.dsn-perm-fail', data: { queueId: '1', from: 'eve@x.test' } }); // not queued by eve
  await settle();
  assert.deepEqual(acct.permissions, { '@type': 'Inherit' });
  for (let i = 0; i < 3; i++) {
    app.onEvent({ type: 'queue.authenticated-message-queued', data: { queueId: `q${i}`, from: 'eve@x.test' } });
    app.onEvent({ type: 'delivery.dsn-perm-fail', data: { queueId: `q${i}` } });
  }
  await settle();
  assert.ok(acct.permissions.disabledPermissions?.emailSend);
  assert.match(app.state.suspensions['eve@x.test'][0].reason, /bounced/);
});

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
// The webhook needs Stalwart (in Docker) to reach this test's server: EVENTS_HOST, default host.docker.internal.
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no admin file (set ADMIN_FILE)' : false;

test('live: throttle refusals → suspended → self-unblock once → admin needed', { skip, timeout: 120_000 }, async (t) => {
  const text = readFileSync(ADMIN_FILE, 'utf8').trim();
  const admin = text.startsWith('{') ? JSON.parse(text) : { user: text.slice(0, text.indexOf(':')), pass: text.slice(text.indexOf(':') + 1) };
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Date.now().toString(36), name = `t-abuse-${tag}`, email = `${name}@openmail.test`, pass = `throwaway pass ${tag} river`;
  const mk = async (n) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name: n, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const boss = `t-abuse-boss-${tag}`;
  const id = await mk(name), bossId = await mk(boss);
  // A throttle for this account only: one recipient an hour (dev has its throttles switched off).
  const th = (await jmap([['x:MtaInboundThrottle/set', { create: { t: { description: `test ${name}`, enable: true, key: { authenticatedAs: true },
    match: { match: {}, else: `authenticated_as == '${email}'` }, rate: { count: 1, period: 3600000 } } } }, 't']])).created.t.id;
  const reload = () => jmap([['x:Action/set', { create: { a: { '@type': 'ReloadSettings' } } }, 'a']]);
  await reload();

  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], signupEnabled: false,
    abuseLimitHits: 2, abuseBounces: 100, inactiveMonths: 12 };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '0.0.0.0', r));
  const port = app.address().port;
  // Point a webhook at this test server (the service does this itself when EVENTS_URL is set).
  const hookUrl = `http://${process.env.EVENTS_HOST || 'host.docker.internal'}:${port}/api/events`;
  t.after(async () => {
    const hooks = (await jmap([['x:WebHook/get', { ids: null, properties: ['url'] }, 'g']])).list.filter((h) => h.url === hookUrl).map((h) => h.id);
    await jmap([['x:WebHook/set', { destroy: hooks }, 'w']]).catch(() => {});
    await jmap([['x:MtaInboundThrottle/set', { destroy: [th] }, 't']]).catch(() => {});
    await jmap([['x:Account/set', { destroy: [id, bossId] }, 'x']]).catch(() => {});
    await reload().catch(() => {});
    app.close();
  });
  const base = `http://127.0.0.1:${port}`;
  const me = { Authorization: 'Basic ' + Buffer.from(`${email}:${pass}`).toString('base64') };
  const call = (path, method = 'GET', body, headers = me) => fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const asBoss = { Authorization: 'Basic ' + Buffer.from(`${boss}@openmail.test:${pass}`).toString('base64') };
  cfg.eventsUrl = hookUrl; // the service registers its webhook itself when EVENTS_URL is set; here the port is only known now
  await app.abuse.ensureHook();

  const smtp = { host: 'localhost', port: Number(process.env.SUBMISSION_PORT || 1465), user: email, pass, insecure: true, servername: 'localhost' };
  const burst = async (n) => { for (let i = 0; i < n; i++) await sendMail(smtp, { from: email, to: email, subject: `t ${i}`, text: 'hi' }).catch(() => {}); };
  const waitFor = async (cond) => { for (let i = 0; i < 40; i++) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 500)); } return false; };

  assert.equal((await call('/api/sending')).suspended, false);
  await burst(4); // 1 accepted, 3 refused by the throttle → more than 2 refusals
  assert.ok(await waitFor(async () => (await call('/api/sending')).suspended), 'suspended after repeated refusals');
  const s = await call('/api/sending');
  assert.equal(s.unblock, 'ok');
  assert.match(s.reason, /sending limit/);
  // Sending is really off (SMTP), reading still works.
  await assert.rejects(sendMail(smtp, { from: email, to: email, subject: 'blocked?', text: 'hi' }), /5\.7\.1|not authorized/);
  const session = await fetch(`${STALWART}/jmap/session`, { headers: me });
  assert.equal(session.status, 200);

  assert.equal((await call('/api/sending/unblock', 'POST')).suspended, false);
  assert.equal((await call('/api/sending')).suspended, false);

  await burst(4);
  assert.ok(await waitFor(async () => (await call('/api/sending')).suspended), 'suspended again');
  assert.equal((await call('/api/sending')).unblock, 'admin');
  const again = await call('/api/sending/unblock', 'POST');
  assert.equal(again.status, 403);
  assert.equal(again.error.code, 'needs_admin');

  // The admin console lists it with the reason, and lifts it.
  const list = await call('/api/admin/suspended', 'GET', undefined, asBoss);
  const row = list.suspended.find((x) => x.email === email);
  assert.ok(row && row.times === 2 && /sending limit/.test(row.reason), JSON.stringify(list));
  const lifted = await call(`/api/admin/users/${id}`, 'PATCH', { sending: true }, asBoss);
  assert.equal(lifted.user.sending, true);
  assert.equal((await call('/api/sending')).suspended, false);
  const off = await call(`/api/admin/users/${id}`, 'PATCH', { sending: false }, asBoss);
  assert.equal(off.user.sending, false);
  assert.equal((await call('/api/sending')).unblock, 'admin'); // an admin's suspension: only an admin lifts it
  await call(`/api/admin/users/${id}`, 'PATCH', { sending: true }, asBoss);

  // Inactive accounts: the daily job reminds (30 days left), later marks it due; nothing is blocked by itself.
  const mails = [];
  cfg.systemMail = { from: 'OpenMail <noreply@openmail.test>' };
  cfg.mailer = async (_c, m) => { mails.push(m); };
  assert.ok((await app.abuse.inactiveJob(Date.now() + 340 * DAY)).includes(email));
  assert.ok(mails.some((m) => m.to === email && /will be blocked on/.test(m.subject)));
  assert.equal(app.abuse.state.inactive[email].reminded, 30);
  assert.ok(!(await app.abuse.inactiveJob(Date.now() + 341 * DAY)).includes(email)); // once per reminder
  assert.ok((await app.abuse.inactiveJob(Date.now() + 366 * DAY)).includes(email));
  const ia = (await call('/api/admin/inactive', 'GET', undefined, asBoss)).accounts.find((x) => x.email === email);
  assert.deepEqual([ia.due, ia.enabled, ia.id], [true, true, id]);
  assert.ok(!app.abuse.state.inactive[`${boss}@openmail.test`]); // admins are never listed
});

/** The dev MX's whole answer to RCPT TO for this address, e.g. "550 5.2.1 This mailbox is inactive ...". */
function rcptReply(addr) {
  return new Promise((resolve, reject) => {
    const s = connect(Number(process.env.SMTP_PORT || 2525), 'localhost'); let buf = '', step = 0;
    const cmds = ['EHLO example.org', 'MAIL FROM:<t@example.org>', `RCPT TO:<${addr}>`, 'QUIT'];
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) if (/^\d{3} /.test(l)) { if (step === 3) { resolve(l); s.end(); return; } s.write(cmds[step++] + '\r\n'); }
    });
    s.on('error', reject);
  });
}

test('live: blocking a due inactive account refuses its mail at RCPT; enabling it accepts mail again', { skip, timeout: 60_000 }, async (t) => {
  const text = readFileSync(ADMIN_FILE, 'utf8').trim();
  const admin = text.startsWith('{') ? JSON.parse(text) : { user: text.slice(0, text.indexOf(':')), pass: text.slice(text.indexOf(':') + 1) };
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const reload = () => jmap([['x:Action/set', { create: { a: { '@type': 'ReloadSettings' } } }, 'a']]);
  // What install.sh (and dev-setup) configure; set up here if this server doesn't have it yet, and put back after.
  const rcpt = (await jmap([['x:MtaStageRcpt/get', { ids: ['singleton'], properties: ['script'] }, 'r']])).list[0].script;
  const script = (await jmap([['x:SieveSystemScript/query', { filter: { name: 'openmail-inactive' } }, 'q']])).ids[0];
  const madeScript = !script && (await jmap([['x:SieveSystemScript/set', { create: { s: { name: 'openmail-inactive', isActive: true,
    contents: 'require "reject";\nreject "550 5.2.1 This mailbox is inactive and no longer receives mail.";\n' } } }, 's']])).created.s.id;
  const setRcpt = !JSON.stringify(rcpt).includes('inactive-accounts');
  if (setRcpt) await jmap([['x:MtaStageRcpt/set', { update: { singleton: { script: { match: { 0: { if: "key_exists('inactive-accounts', rcpt)", then: "'openmail-inactive'" } }, else: 'false' } } } }, 'r']]);
  await reload();

  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8), pass = `throwaway pass ${tag} river`;
  const name = `t-arf-idle-${tag}`, boss = `t-arf-boss-${tag}`, email = `${name}@openmail.test`;
  const mk = async (n, extra = {}) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name: n, domainId, credentials: { 0: { '@type': 'Password', secret: pass } }, ...extra } } }, 'c']])).created.n.id;
  const id = await mk(name, { aliases: { 0: { name: `${name}-alias`, domainId, enable: true } } }), bossId = await mk(boss);
  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], signupEnabled: false };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.close();
    await jmap([['x:Account/set', { destroy: [id, bossId] }, 'x']]).catch(() => {});
    if (setRcpt) await jmap([['x:MtaStageRcpt/set', { update: { singleton: { script: rcpt } } }, 'r']]).catch(() => {});
    if (madeScript) await jmap([['x:SieveSystemScript/set', { destroy: [madeScript] }, 's']]).catch(() => {});
    await reload().catch(() => {});
  });
  const call = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${boss}@openmail.test:${pass}`).toString('base64') } }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.match(await rcptReply(email), /^250 /);
  // Disabling an account that isn't due under the policy only stops sign-in, as before.
  assert.equal((await call(`/api/admin/users/${id}`, 'PATCH', { enabled: false })).ok, true);
  assert.match(await rcptReply(email), /^250 /);
  assert.equal((await call(`/api/admin/users/${id}`, 'PATCH', { enabled: true })).ok, true);

  // Due (the daily job's verdict), then the console's "Disable": every address of it is refused, +tags too.
  app.abuse.state.inactive[email] = { id, at: Date.now(), dueAt: Date.now() };
  assert.equal((await call(`/api/admin/users/${id}`, 'PATCH', { enabled: false })).ok, true);
  for (const a of [email, `${name}+news@openmail.test`, `${name}-alias@openmail.test`, email.toUpperCase()])
    assert.match(await rcptReply(a), /^550 5\.2\.1 This mailbox is inactive/, a);
  assert.match(await rcptReply(`${boss}@openmail.test`), /^250 /); // nobody else
  assert.equal((await call('/api/admin/inactive')).accounts.find((x) => x.email === email).refusingMail, true);

  // Undo: enabling it accepts mail again.
  assert.equal((await call(`/api/admin/users/${id}`, 'PATCH', { enabled: true })).ok, true);
  for (const a of [email, `${name}+news@openmail.test`, `${name}-alias@openmail.test`]) assert.match(await rcptReply(a), /^250 /, a);
  assert.equal((await call('/api/admin/inactive')).accounts.find((x) => x.email === email).refusingMail, false);
  // Deleting a blocked account leaves no keys behind.
  await call(`/api/admin/users/${id}`, 'PATCH', { enabled: false });
  assert.equal((await call(`/api/admin/users/${id}`, 'DELETE')).ok, true);
  assert.ok(!(await app.abuse.refusedKeys()).some((k) => k.key.startsWith(name)));
});
