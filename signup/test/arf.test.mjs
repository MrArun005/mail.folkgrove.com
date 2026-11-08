// Spam complaints (arf.mjs): parsing and trust rules (unit), then the whole loop on the local dev Stalwart: ARF reports
// built here go over SMTP to a throwaway abuse@ team mailbox; forged ones change nothing, genuine ones suspend a
// throwaway sender until an admin lifts it. Skips the live part if the server or admin file isn't there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArf, headersOf, reporterTrusted, fromOurServer, handleReport } from '../arf.mjs';
import { Invites } from '../lib.mjs';
import { createApp } from '../server.mjs';
import { sendRaw } from '../mailer.mjs';

const D = 'openmail.test';
/** An ARF report (RFC 5965) about one message from `sender`, as a feedback loop sends it. */
function arf({ from = 'fbl@yahoo.example', sender, messageId, dkim = false, top = [] }) {
  const original = [...(dkim ? [`DKIM-Signature: v=1; a=rsa-sha256; d=${D}; s=x; h=From; bh=x; b=x`] : []),
    `From: <${sender}>`, 'To: <someone@yahoo.example>', 'Subject: Big sale', `Message-ID: <${messageId}>`, '', 'Buy now!', ''].join('\r\n');
  return [...top, `From: <${from}>`, `To: <abuse@${D}>`, 'Subject: FW: Big sale', `Message-ID: <${Math.random().toString(36).slice(2)}@yahoo.example>`,
    'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=feedback-report; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain', '', 'This is an email abuse report.', '',
    '--b1', 'Content-Type: message/feedback-report', '', 'Feedback-Type: abuse', 'User-Agent: test/1.0', 'Version: 1',
    `Original-Mail-From: <${sender}>`, 'Original-Rcpt-To: <someone@yahoo.example>', '',
    '--b1', 'Content-Type: message/rfc822', 'Content-Disposition: inline', '', original, '--b1--', ''].join('\r\n');
}
const STALWART_TOP = (ar) => [`Received: from mta.yahoo.example (mta.yahoo.example [203.0.113.7]) by mail.${D} (Stalwart SMTP) with ESMTPS id 1`,
  `Authentication-Results: mail.${D}; ${ar}`];

test('arf: parses a feedback report; anything else is not one', () => {
  const r = parseArf(arf({ sender: `eve@${D}`, messageId: `1@${D}` }));
  assert.equal(r.type, 'abuse');
  assert.equal(r.mailFrom, `eve@${D}`);
  assert.match(r.original, /Message-ID: <1@openmail.test>/);
  assert.equal(parseArf('From: a@b\r\nContent-Type: text/plain\r\n\r\nhi'), null);
  assert.equal(parseArf(arf({ sender: 'x@y', messageId: 'z' }).replace('report-type=feedback-report', 'report-type=delivery-status')), null);
  // base64 parts, as some loops send them
  const b64 = arf({ sender: `eve@${D}`, messageId: `2@${D}` }).replace(/(Content-Type: message\/feedback-report\r\n)\r\n([\s\S]*?)\r\n--b1/,
    (_, h, body) => `${h}Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}\r\n--b1`);
  assert.equal(parseArf(b64).mailFrom, `eve@${D}`);
});

test('arf: only a reporter authenticated by our server (or on the list) is trusted', () => {
  const cfg = { domain: D, reporters: ['yahoo.example'] };
  const h = (top, from) => headersOf(arf({ from, sender: `eve@${D}`, messageId: 'm', top }));
  // No list: nothing counts automatically, however well authenticated.
  assert.match(reporterTrusted(h(STALWART_TOP('dmarc=pass header.from=yahoo.example'), 'fbl@yahoo.example'), { domain: D }).why, /ARF_REPORTERS is not set/);
  // A report signed here (one of our users, on any domain) is never trusted.
  assert.equal(reporterTrusted(h([`DKIM-Signature: v=1; d=custom.example; s=x; b=x`, ...STALWART_TOP('dmarc=pass header.from=yahoo.example')], 'fbl@yahoo.example'), cfg).why, 'sent from this server');
  // Two From lines: ignored.
  assert.ok(!reporterTrusted([...h(STALWART_TOP('dmarc=pass header.from=yahoo.example'), 'fbl@yahoo.example'), ['from', 'x@evil.example']], cfg).ok);
  assert.ok(reporterTrusted(h(STALWART_TOP('dmarc=pass header.from=yahoo.example'), 'fbl@yahoo.example'), cfg).ok);
  assert.ok(reporterTrusted(h(STALWART_TOP('dkim=pass header.d=yahoo.example header.s=s1'), 'fbl@mail.yahoo.example'), cfg).ok); // aligned
  assert.ok(!reporterTrusted(h(STALWART_TOP('dkim=pass header.d=evil.example'), 'fbl@yahoo.example'), cfg).ok); // not aligned
  assert.ok(!reporterTrusted(h(STALWART_TOP('dmarc=fail header.from=yahoo.example'), 'fbl@yahoo.example'), cfg).ok);
  // Forged: the sender's own "pass" sits below Stalwart's real result.
  assert.ok(!reporterTrusted(h([...STALWART_TOP('dmarc=fail header.from=yahoo.example'), 'Authentication-Results: mail.openmail.test; dmarc=pass header.from=yahoo.example'], 'fbl@yahoo.example'), cfg).ok);
  // Forged: a result from another host, or none at all.
  assert.ok(!reporterTrusted(h([STALWART_TOP('')[0], 'Authentication-Results: mx.other.example; dmarc=pass header.from=yahoo.example'], 'fbl@yahoo.example'), cfg).ok);
  assert.ok(!reporterTrusted(h(['Authentication-Results: mail.openmail.test; dmarc=pass header.from=yahoo.example'], 'fbl@yahoo.example'), cfg).ok);
  // Forged by one of our own users: written Received + result, but our DKIM signature (added before local delivery) is above.
  assert.equal(reporterTrusted(h([`DKIM-Signature: v=1; d=${D}; s=x; b=x`, ...STALWART_TOP('dmarc=pass header.from=yahoo.example')], 'fbl@yahoo.example'), cfg).why, 'sent from this server');
  // The list: only those domains, or an IP on it by itself.
  assert.ok(!reporterTrusted(h(STALWART_TOP('dmarc=pass header.from=yahoo.example'), 'fbl@yahoo.example'), { domain: D, reporters: ['hotmail.example'] }).ok);
  assert.ok(reporterTrusted(h(STALWART_TOP('dmarc=pass header.from=yahoo.example'), 'fbl@yahoo.example'), { domain: D, reporters: ['yahoo.example'] }).ok);
  assert.ok(reporterTrusted(h(STALWART_TOP('none'), 'fbl@yahoo.example'), { domain: D, reporters: ['203.0.113.7'] }).ok);
  // An HELO name made to look like a listed IP doesn't count.
  assert.ok(!reporterTrusted(h([`Received: from [203.0.113.7] (evil.example [198.51.100.9]) by mail.${D} (Stalwart SMTP)`, `Authentication-Results: mail.${D}; none`], 'x@evil.example'), { domain: D, reporters: ['203.0.113.7'] }).ok);
});

test('arf: the reported message must have left this server', () => {
  assert.ok(fromOurServer(`Message-ID: <a@${D}>\r\n\r\nx`, D));
  assert.ok(fromOurServer(`Message-ID: <a@mail.${D}>\r\n\r\nx`, D));
  assert.ok(fromOurServer(`DKIM-Signature: v=1; d=${D}; s=x\r\nMessage-ID: <a@x.example>\r\n\r\nx`, D));
  assert.ok(!fromOurServer('Message-ID: <a@x.example>\r\n\r\nx', D));
  assert.ok(!fromOurServer(`Message-ID: <a@not${D}>\r\n\r\nx`, D));
});

test('arf: a genuine report counts against the envelope sender, once per message', async () => {
  const seen = [];
  const complaint = async (who, mid) => (seen.push([who, mid]), 'counted');
  const raw = (o) => [...STALWART_TOP('dmarc=pass header.from=yahoo.example'), arf(o)].join('\r\n');
  assert.equal((await handleReport(raw({ sender: `eve@${D}`, messageId: `1@${D}` }), { domain: D, arf: { reporters: ['yahoo.example'] } }, complaint)).counted, true);
  assert.deepEqual(seen, [[`eve@${D}`, `<1@${D}>`]]);
  assert.match((await handleReport(raw({ sender: `eve@${D}`, messageId: '1@x.example' }), { domain: D, arf: { reporters: ['yahoo.example'] } }, complaint)).why, /not from this server/);
  assert.match((await handleReport(raw({ sender: 'bob@x.example', messageId: `2@${D}` }), { domain: D, arf: { reporters: ['yahoo.example'] } }, complaint)).why, /not ours/);
  assert.equal(seen.length, 1);
});

// ── Live ──
const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no admin file (set ADMIN_FILE)' : false;

/** Port 25 delivery from outside: the whole SMTP conversation, resolving with the final reply code. */
function smtp25(to, raw) {
  return new Promise((resolve, reject) => {
    const s = connect(Number(process.env.SMTP_PORT || 2525), 'localhost'); let buf = '', step = 0;
    const cmds = ['EHLO mta.yahoo.example', 'MAIL FROM:<fbl@yahoo.example>', `RCPT TO:<${to}>`, 'DATA', raw.replace(/^\./gm, '..') + '\r\n.', 'QUIT'];
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) if (/^\d{3} /.test(l)) {
        const code = Number(l.slice(0, 3));
        if (code >= 400 || step === cmds.length - 1) { resolve(code); s.end(); return; }
        s.write(cmds[step++] + '\r\n');
      }
    });
    s.on('error', reject);
  });
}

test('live: forged reports change nothing, genuine ones suspend the sender until an admin lifts it', { skip, timeout: 120_000 }, async (t) => {
  const text = readFileSync(ADMIN_FILE, 'utf8').trim();
  const admin = text.startsWith('{') ? JSON.parse(text) : { user: text.slice(0, text.indexOf(':')), pass: text.slice(text.indexOf(':') + 1) };
  const auth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const domainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === D).id;
  const tag = Math.random().toString(36).slice(2, 8), pass = `throwaway pass ${tag} river`;
  const sender = `t-arf-${tag}`, boss = `t-arf-boss-${tag}`, box = `t-arf-abuse-${tag}`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const [sid, bid] = [await mk(sender), await mk(boss)];
  const gid = (await jmap([['x:Account/set', { create: { g: { '@type': 'Group', name: box, domainId } } }, 'c']])).created.g.id;
  const cfg = { stalwartUrl: STALWART, admin, domain: D, signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, admins: [boss],
    arf: { mailbox: box, reporters: [] }, arfLimit: 3, arfWindowHours: 24 };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.close();
    await jmap([['x:Account/set', { update: { [bid]: { [`memberGroupIds/${gid}`]: null } } }, 'u']]).catch(() => {});
    await jmap([['x:Account/set', { destroy: [sid, bid] }, 'x']]).catch(() => {});
    await jmap([['x:Account/set', { destroy: [gid] }, 'x']]).catch(() => {});
  });
  const call = (path, method = 'GET', body, who = sender) => fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${who}@${D}:${pass}`).toString('base64') } }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  /** Runs the job until it has looked at n new messages (delivery takes a moment). */
  const scan = async (n) => {
    const out = [];
    for (let i = 0; i < 40 && out.length < n; i++) { out.push(...(await app.arf()) ?? []); if (out.length < n) await new Promise((r) => setTimeout(r, 500)); }
    assert.equal(out.length, n);
    return out;
  };
  const to = `${box}@${D}`, me = `${sender}@${D}`;

  // 1. Forged: claims a DMARC pass in its own header; Stalwart's result above it says otherwise.
  const forged = arf({ sender: me, messageId: `f1-${tag}@${D}`, top: ['Authentication-Results: mail.openmail.test; dmarc=pass header.from=yahoo.example'] });
  assert.equal(await smtp25(to, forged), 250);
  // Forged by a user of this server: a made-up Received and result on top, sent through submission.
  const inside = arf({ from: me, sender: me, messageId: `f2-${tag}@${D}`, top: STALWART_TOP('dmarc=pass header.from=yahoo.example') });
  await sendRaw({ host: 'localhost', port: Number(process.env.SUBMISSION_PORT || 1465), user: me, pass, insecure: true, servername: 'localhost' }, { from: me, to: [to], raw: inside });
  const r1 = await scan(2);
  assert.ok(r1.every((r) => !r.counted && /untrusted reporter/.test(r.why)), JSON.stringify(r1));
  assert.ok(r1.some((r) => /sent from this server/.test(r.why)), JSON.stringify(r1));
  const ip = r1.find((r) => r.ip)?.ip;
  assert.ok(ip, 'Stalwart’s Received line names the client IP');
  // The admins were put in the team mailbox.
  assert.equal((await jmap([['x:Account/get', { ids: [bid], properties: ['memberGroupIds'] }, 'g']])).list[0].memberGroupIds?.[gid], true);

  // 2. From a trusted loop (this machine's address on the list), but about a message that never left our server.
  cfg.arf.reporters = [ip];
  assert.equal(await smtp25(to, arf({ sender: me, messageId: `x-${tag}@elsewhere.example` })), 250);
  assert.match((await scan(1))[0].why, /not from this server/);
  assert.equal((await call('/api/sending')).suspended, false);

  // 3. Genuine: two complaints (one message reported twice counts once), not yet enough.
  for (const m of ['g1', 'g1', 'g2']) assert.equal(await smtp25(to, arf({ sender: me, messageId: `${m}-${tag}@${D}`, dkim: m === 'g2' })), 250);
  assert.deepEqual((await scan(3)).map((r) => r.why), ['counted', 'duplicate', 'counted']);
  assert.equal((await call('/api/sending')).suspended, false);
  // The third suspends sending; only an admin can lift it.
  assert.equal(await smtp25(to, arf({ sender: me, messageId: `g3-${tag}@${D}` })), 250);
  assert.equal((await scan(1))[0].why, 'suspended');
  const s = await call('/api/sending');
  assert.equal(s.suspended, true);
  assert.equal(s.unblock, 'admin');
  assert.match(s.reason, /reported mail from this account as spam/);
  assert.equal((await call('/api/sending/unblock', 'POST')).status, 403);
  const listed = (await call('/api/admin/suspended', 'GET', undefined, boss)).suspended.find((x) => x.email === me);
  assert.equal(listed.by, 'spam complaints');
  assert.equal((await call(`/api/admin/users/${sid}`, 'PATCH', { sending: true }, boss)).ok, true);
  assert.equal((await call('/api/sending')).suspended, false);
  assert.deepEqual(await app.arf(), []); // everything was marked as looked at
});
