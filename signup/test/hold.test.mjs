// Outgoing spam hold, end to end against the local dev Stalwart: an MTA hook calls this service, likely spam is held
// (not delivered), normal mail goes through, an admin releases (then it's delivered) or deletes, and repeated holds
// pause the sender's sending. Throwaway accounts and its own hook (only for those accounts), removed afterwards.
// Stalwart (in Docker) must reach this machine as host.docker.internal; HOOK_HOST overrides. Skips otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outboundScore, rawOf, holdStore } from '../hold.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const SMTP_PORT = Number(process.env.SMTP_PORT || 1465);
const HOOK_HOST = process.env.HOOK_HOST || 'host.docker.internal';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;
const GTUBE = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('outbound score counts the message, not the connection', () => {
  const { score, reasons } = outboundScore({
    AUTH_NA: { score: 1, disposition: 'score' }, FROM_INVALID: { score: 2, disposition: 'score' }, HELO_NOT_FQDN: { score: 2, disposition: 'score' },
    X_HDR_FROM: { score: 0, disposition: 'reject' }, SUSPICIOUS_URL: { score: 5, disposition: 'score' }, URI_HIDDEN_PATH: { score: 1, disposition: 'score' },
    SOURCE_ASN_54113: { score: 0, disposition: 'reject' }, HAM_WORDS: { score: -1.5, disposition: 'score' },
  });
  assert.deepEqual([score, reasons], [4.5, ['SUSPICIOUS_URL', 'URI_HIDDEN_PATH']]);
  assert.equal(rawOf({ headers: [['Subject', ' hi\r\n']], contents: 'body\r\n' }), 'Subject: hi\r\n\r\nbody\r\n');
});

test('hold store keeps messages on disk (HOLD_DIR) and in memory alike', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-'));
  try {
    for (const store of [holdStore(dir), holdStore(null)]) {
      store.put({ id: 'm1', login: 'a@x.test' }, 'Subject: x\r\n\r\nhi');
      assert.deepEqual(store.list(), [{ id: 'm1', login: 'a@x.test' }]);
      assert.equal(store.raw('m1'), 'Subject: x\r\n\r\nhi');
      assert.equal(store.remove('m1'), true);
      assert.equal(store.remove('m1'), false);
      assert.deepEqual(store.list(), []);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

/** One message by SMTP submission (implicit TLS). Resolves with the server's final reply code and text. */
function smtpSend(user, pass, to, raw) {
  const steps = ['EHLO t', `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, `MAIL FROM:<${user}>`, `RCPT TO:<${to}>`, 'DATA', raw + '\r\n.', 'QUIT'];
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: 'localhost', port: SMTP_PORT, rejectUnauthorized: false });
    let buf = '', i = -1;
    s.on('error', reject);
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) {
        if (!/^\d{3} /.test(l)) continue;
        const code = Number(l.slice(0, 3));
        if (code >= 400 || i === steps.length - 2) { s.end(); return resolve({ code, text: l, step: steps[i]?.split(' ')[0] }); }
        s.write(steps[++i] + '\r\n');
      }
    });
  });
}

test('outgoing spam is held for review; release delivers it; repeated holds pause sending', { skip, timeout: 120_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses.map((r) => r[1]);
  const [doms] = await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
  const domainId = doms.list.find((d) => d.name === 'openmail.test').id;
  const tag = Date.now().toString(36);
  const pass = `throwaway pass ${tag} lantern orbit`;
  const [sender, rcpt, boss] = ['s', 'r', 'a'].map((x) => `t-spamhold-${tag}-${x}`);
  const [made] = await jmap([['x:Account/set', { create: Object.fromEntries([sender, rcpt, boss].map((name) => [name, { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } }])) }, 'c']]);
  const ids = Object.fromEntries(Object.entries(made.created).map(([k, v]) => [k, v.id]));
  assert.equal(Object.keys(ids).length, 3, JSON.stringify(made));

  let hookCalls = 0;
  const app = createApp({ stalwartUrl: STALWART, admin, domain: 'openmail.test', inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss], signupEnabled: false,
    hold: { secret: `hook-${tag}`, dir: null, score: 5, suspendAfter: 3, smtp: { host: 'localhost', port: SMTP_PORT, insecure: true } } });
  app.prependListener('request', (req) => { if (req.url === '/internal/outbound-hook') hookCalls++; });
  await new Promise((r) => app.listen(0, '0.0.0.0', r));
  const port = app.address().port;

  // The hook, for this test's sender only, so other mail on the dev server is never touched. Fail open, as in dev.
  // Released mail is sent as the admin login with the sender's address: the dev server must allow that (dev-setup.mjs).
  const [auth] = await jmap([['x:MtaStageAuth/get', { ids: ['singleton'], properties: ['mustMatchSender'] }, 'a']]);
  const mustMatch = auth.list[0].mustMatchSender;
  const exempt = { match: { 0: { if: `authenticated_as == '${admin.user}'`, then: 'false' } }, else: 'true' };
  const [hookSet] = await jmap([
    ['x:MtaHook/set', { create: { h: { url: `http://${HOOK_HOST}:${port}/internal/outbound-hook`, stages: { data: true }, timeout: 20000, tempFailOnError: false,
      enable: { match: { 0: { if: `authenticated_as == '${sender}@openmail.test'`, then: 'true' } }, else: 'false' },
      httpAuth: { '@type': 'Bearer', bearerToken: { '@type': 'Value', secret: `hook-${tag}` } } } } }, 'h'],
    ['x:MtaStageAuth/set', { update: { singleton: { mustMatchSender: exempt } } }, 's'],
    ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'r']]);
  const hookId = hookSet.created?.h?.id;
  t.after(async () => {
    await jmap([['x:MtaHook/set', { destroy: [hookId] }, 'h'], ['x:MtaStageAuth/set', { update: { singleton: { mustMatchSender: mustMatch } } }, 's'],
      ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'r'], ['x:Account/set', { destroy: Object.values(ids) }, 'x']]).catch(() => {});
    app.close();
  });
  assert.ok(hookId, JSON.stringify(hookSet));

  const S = `${sender}@openmail.test`, R = `${rcpt}@openmail.test`;
  const msg = (subject, body) => [`From: <${S}>`, `To: <${R}>`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${subject.replace(/\W/g, '')}-${tag}@openmail.test>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const inbox = async () => {
    const h = { Authorization: basic(R, pass), 'Content-Type': 'application/json' };
    const accountId = (await (await fetch(`${STALWART}/jmap/session`, { headers: h })).json()).primaryAccounts['urn:ietf:params:jmap:mail'];
    const r = await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: h, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [
      ['Email/query', { accountId }, 'q'], ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g']] }) })).json();
    return r.methodResponses[1][1].list.map((e) => e.subject);
  };
  const arrives = async (subject) => { for (let i = 0; i < 20; i++) { if ((await inbox()).includes(subject)) return true; await sleep(500); } return false; };
  const base = `http://127.0.0.1:${port}/api/admin`;
  const call = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: basic(`${boss}@openmail.test`, pass), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Normal mail goes through (and did pass the hook).
  // ponytail: Stalwart sometimes answers a fresh account's first sign-in with 454 (temporary); one retry.
  let ok = await smtpSend(S, pass, R, msg('Lunch on Friday', 'Are you free at 1pm?'));
  if (ok.code === 454) { await sleep(1000); ok = await smtpSend(S, pass, R, msg('Lunch on Friday', 'Are you free at 1pm?')); }
  assert.equal(ok.code, 250, JSON.stringify(ok));

  // A From line that isn't theirs (here: the recipient's address) is refused, though the envelope is their own.
  const forged = await smtpSend(S, pass, R, msg('Forged', 'Hi').replace(`From: <${S}>`, `From: Boss <${R}>`));
  assert.equal(forged.code, 550, JSON.stringify(forged));
  assert.match(forged.text, /can't send as/);
  assert.ok(await arrives('Lunch on Friday'));
  if (!hookCalls) return t.skip(`Stalwart couldn't reach the hook at ${HOOK_HOST}:${port} (set HOOK_HOST)`);

  // Spam by the test string, and spam by content (Stalwart's own filter: a hidden path on a bare IP, a redirector).
  const held1 = await smtpSend(S, pass, R, msg('Test spam', GTUBE));
  assert.equal(held1.code, 550, JSON.stringify(held1));
  assert.match(held1.text, /held for review/);
  const held2 = await smtpSend(S, pass, R, msg('Claim your prize', 'Click http://bit.ly/abc http://1.2.3.4/../wp-admin/ now to claim your prize.'));
  assert.equal(held2.code, 550, JSON.stringify(held2));
  await sleep(2000);
  const subjects = await inbox();
  assert.ok(!subjects.includes('Test spam') && !subjects.includes('Claim your prize'), 'held mail was delivered');

  let held = await call('/held');
  assert.equal(held.status, 200);
  const [a, b] = ['Test spam', 'Claim your prize'].map((s) => held.held.find((m) => m.subject === s && m.login === S));
  assert.ok(a && b, JSON.stringify(held));
  assert.deepEqual(a.to, [R]);
  assert.ok(b.score >= 5 && b.reasons.includes('SUSPICIOUS_URL'), JSON.stringify(b));
  assert.equal((await call('/overview')).held, held.held.length);

  // From the web app (JMAP, with the undo-send hold) it's held too, with the same words; the same message (same
  // Message-ID) isn't held twice.
  const sh = { Authorization: basic(S, pass), 'Content-Type': 'application/json' };
  const sAcc = (await (await fetch(`${STALWART}/jmap/session`, { headers: sh })).json()).primaryAccounts['urn:ietf:params:jmap:mail'];
  const sj = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: sh,
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'], methodCalls }) })).json()).methodResponses;
  const [[, idents], [, boxes]] = await sj([['Identity/get', { accountId: sAcc }, 'i'], ['Mailbox/get', { accountId: sAcc, properties: ['role'] }, 'm']]);
  const web = await sj([
    ['Email/set', { accountId: sAcc, create: { e: { mailboxIds: { [boxes.list.find((x) => x.role === 'drafts').id]: true }, from: [{ email: S }], to: [{ email: R }],
      subject: 'Test spam', messageId: [`Testspam-${tag}@openmail.test`], bodyValues: { b: { value: GTUBE } }, textBody: [{ partId: 'b', type: 'text/plain' }] } } }, 'e'],
    ['EmailSubmission/set', { accountId: sAcc, create: { s: { emailId: '#e', identityId: idents.list[0].id,
      envelope: { mailFrom: { email: S, parameters: { HOLDFOR: '5' } }, rcptTo: [{ email: R }] } } } }, 's']]);
  assert.match(web[1][1].notCreated?.s?.description ?? '', /held for review/, JSON.stringify(web[1][1]));
  assert.equal((await call('/held')).held.filter((m) => m.login === S).length, 2);

  // Release: delivered as written. Delete: gone.
  assert.equal((await call(`/held/${a.id}/release`, 'POST')).status, 200);
  assert.ok(await arrives('Test spam'), 'released mail was not delivered');
  assert.equal((await call(`/held/${b.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/held/${b.id}/release`, 'POST')).status, 404);
  assert.equal((await call('/held')).held.filter((m) => m.login === S).length, 0);

  // Three held at once pause sending (sign-in still works); the admin lets them send again.
  for (const n of [1, 2, 3]) assert.equal((await smtpSend(S, pass, R, msg(`Spam wave ${n}`, GTUBE))).code, 550);
  const paused = (await call(`/users?q=${sender}`)).users.find((u) => u.id === ids[sender]);
  assert.equal(paused.sending, false);
  assert.equal(paused.enabled, true);
  const refused = await smtpSend(S, pass, R, msg('While paused', 'hello'));
  assert.ok(refused.code >= 500 && refused.step === 'AUTH', JSON.stringify(refused));
  assert.equal((await call(`/users/${ids[sender]}`, 'PATCH', { sending: true })).user.sending, true);
  assert.equal((await smtpSend(S, pass, R, msg('After the pause', 'hello again'))).code, 250);
  assert.ok(await arrives('After the pause'));
});
