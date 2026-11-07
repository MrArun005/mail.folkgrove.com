#!/usr/bin/env node
// One-command local dev environment:
//   node deploy/dev-setup.mjs          start Stalwart, bootstrap it, create alice, seed her inbox
//   node deploy/dev-setup.mjs --reset  wipe everything first
// Dev only: fixed passwords, plain HTTP, fake domain.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8080';
const DOMAIN = 'openmail.test';
const USER = { name: 'alice', pass: 'alice-dev-pass' };
const SECRET_FILE = join(here, '.dev-admin.json'); // gitignored
const sh = (cmd) => execSync(cmd, { cwd: here, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jmap(auth, methodCalls, using = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']) {
  const res = await fetch(`${BASE}/jmap/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basic(auth) },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`JMAP ${res.status}: ${await res.text()}`);
  return (await res.json()).methodResponses;
}
const basic = ({ user, pass }) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }); return; } catch {}
    await sleep(1000);
  }
  throw new Error('Stalwart did not come up on :8080 (docker logs openmail-stalwart)');
}

if (process.argv.includes('--reset')) {
  sh('docker compose down -v');
  rmSync(SECRET_FILE, { force: true });
}
sh('docker compose up -d');
await waitForServer();

// 1. Bootstrap (first run only). Stalwart returns the permanent admin's password once; keep it.
if (!existsSync(SECRET_FILE)) {
  const [[, r]] = await jmap({ user: 'admin', pass: 'devadmin' }, [
    ['x:Bootstrap/set', { update: { singleton: {
      defaultHostname: `mail.${DOMAIN}`, defaultDomain: DOMAIN, requestTlsCertificate: false,
    } } }, 'b'],
  ]);
  const admin = r.updated?.singleton;
  if (!admin?.secret) throw new Error('Bootstrap failed: ' + JSON.stringify(r));
  writeFileSync(SECRET_FILE, JSON.stringify({ user: admin.username, pass: admin.secret }, null, 2));
  sh('docker restart openmail-stalwart');
  await sleep(3000);
  await waitForServer();
}
const admin = JSON.parse(readFileSync(SECRET_FILE, 'utf8'));

// 2. The web app as an OAuth client (sign-in with tokens + two-factor). Idempotent.
{
  const [[, cl]] = await jmap(admin, [['x:OAuthClient/get', { ids: null, properties: ['clientId'] }, 'c']]);
  const existing = cl.list.find((c) => c.clientId === 'openmail-web');
  const fields = { redirectUris: { 'http://localhost:5173/': true }, scopes: { mail: true, contacts: true, calendars: true, security: true }, description: 'OpenMail web (dev)' };
  await jmap(admin, [['x:OAuthClient/set', existing
    ? { update: { [existing.id]: fields } }
    : { create: { c: { clientId: 'openmail-web', ...fields } } }, 'c']]);
}

// Dev only: switch off inbound rate limits. The test suite sends bursts of mail to one mailbox and would hit
// "25 per hour per sender domain and recipient" within a couple of runs. Production keeps Stalwart's defaults.
{
  const [[, th]] = await jmap(admin, [['x:MtaInboundThrottle/get', { ids: null, properties: ['enable'] }, 't']]);
  const on = th.list.filter((t) => t.enable);
  if (on.length) {
    await jmap(admin, [['x:MtaInboundThrottle/set', { update: Object.fromEntries(on.map((t) => [t.id, { enable: false }])) }, 't']]);
    await jmap(admin, [['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'r']]);
    console.log('Dev: inbound rate limits off');
  }
}

// 3. Test user.
const [[, doms]] = await jmap(admin, [['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
const domainId = doms.list.find((d) => d.name === DOMAIN).id;
const [[, made]] = await jmap(admin, [['x:Account/set', { create: { u: {
  '@type': 'User', name: USER.name, domainId,
  credentials: { 0: { '@type': 'Password', secret: USER.pass } },
} } }, 'a']]);
const created = !!made.created;
console.log(created ? `Created ${USER.name}@${DOMAIN}` : `${USER.name}@${DOMAIN} already exists`);

// 4. Seed inbox (only for a freshly created user). Import skips the spam filter, so it lands in Inbox.
if (created) {
  const alice = { user: `${USER.name}@${DOMAIN}`, pass: USER.pass };
  const session = await (await fetch(`${BASE}/jmap/session`, { headers: { Authorization: basic(alice) } })).json();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const mail = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
  const [[, boxes]] = await jmap(alice, [['Mailbox/get', { accountId, properties: ['role'] }, 'm']], mail);
  const inbox = boxes.list.find((b) => b.role === 'inbox').id;
  const sentBox = boxes.list.find((b) => b.role === 'sent').id;
  async function importRaw(raw, hoursAgo) {
    const up = await fetch(`${BASE}/jmap/upload/${accountId}/`, {
      method: 'POST', headers: { Authorization: basic(alice), 'Content-Type': 'message/rfc822' }, body: raw,
    });
    const { blobId } = await up.json();
    const [[, imp]] = await jmap(alice, [['Email/import', { accountId, emails: { e: {
      blobId, mailboxIds: { [inbox]: true }, keywords: {},
      receivedAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z'),
    } } }, 'i']], mail);
    if (!imp.created) throw new Error('Import failed: ' + JSON.stringify(imp));
  }

  // [from, subject, content-type, body, hours ago, in-reply-to seed index, read?]
  const seeds = [
    ['Bob Builder <bob@example.org>', 'Welcome to OpenMail', 'text/plain', 'If you can read this, delivery and the web client both work.', 72, null, true],
    ['Priya Raman <priya@example.org>', 'Venue for the March offsite', 'text/plain',
      'Hi Alice,\n\nI shortlisted two places for the offsite: the lake house (fits 30, has a kitchen) and the old printworks downtown (fits 50, needs catering).\n\nCan you check with finance which one fits the budget?\n\nPriya', 50, null, true],
    ['Alice <alice@openmail.test>', 'Re: Venue for the March offsite', 'text/plain',
      'Finance says the lake house is fine if we stay under 28 people. Printworks would need sign-off.\n\nAlice', 30, 1, true],
    ['Priya Raman <priya@example.org>', 'Re: Venue for the March offsite', 'text/plain',
      'Perfect, lake house it is. I will send the booking form tomorrow. Can you confirm the headcount by Friday?\n\nThanks!\nPriya', 3, 2, false],
    ['Carol Diaz <carol@example.org>', 'Lunch on Friday?', 'text/plain', 'Are you free Friday at 1pm? There is a new ramen place near the office that everyone keeps talking about.', 5, null, false],
    ['GitHub <noreply@example.org>', '[openmail] New issue: Dark mode for compose window', 'text/plain',
      'sam-k opened an issue:\n\nThe compose window is bright white at night. Could it follow the system theme?', 9, null, true],
    ['Newsletter <news@example.org>', 'This week in open source', 'text/html',
      '<h2>This week</h2><p>Remote images like the one below must be <b>blocked</b> by the client:</p><img src="https://example.org/track.gif" width="1" height="1"><script>alert("scripts must never run")</script><p>Three projects hit 1.0, and the email standards JMAP keeps growing.</p><p>Bye!</p>', 20, null, false],
    ['Northwind Bank <alerts@example.org>', 'Your November statement is ready', 'text/plain', 'Your statement for November is available in online banking. We will never ask for your password by email.', 26, null, true],
  ];
  for (const [i, [from, subject, type, body, hoursAgo, parent, read]] of seeds.entries()) {
    const to = from.includes(alice.user) ? 'Priya Raman <priya@example.org>' : alice.user;
    const raw = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
      `Date: ${new Date(Date.now() - hoursAgo * 3600e3).toUTCString()}`,
      `Message-ID: <seed-${i}@${DOMAIN}>`, ...(parent !== null ? [`In-Reply-To: <seed-${parent}@${DOMAIN}>`, `References: <seed-${parent}@${DOMAIN}>`] : []),
      'MIME-Version: 1.0', `Content-Type: ${type}; charset=utf-8`, '', body, ''].join('\r\n');
    const up = await fetch(`${BASE}/jmap/upload/${accountId}/`, {
      method: 'POST', headers: { Authorization: basic(alice), 'Content-Type': 'message/rfc822' }, body: raw,
    });
    const { blobId } = await up.json();
    const [[, imp]] = await jmap(alice, [['Email/import', { accountId, emails: {
      e: { blobId, mailboxIds: { [from.includes(alice.user) ? sentBox : inbox]: true }, keywords: read ? { $seen: true } : {},
        receivedAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z') },
    } }, 'i']], mail);
    if (!imp.created) throw new Error('Import failed: ' + JSON.stringify(imp));
  }
  // A newsletter with RFC 8058 one-click unsubscribe headers and a 1×1 tracking pixel.
  await importRaw([
    'From: Product Digest <digest@example.org>', `To: ${alice.user}`, 'Subject: Weekly digest: 5 tools we loved',
    `Date: ${new Date(Date.now() - 30 * 3600e3).toUTCString()}`, `Message-ID: <seed-digest@${DOMAIN}>`,
    'List-Unsubscribe: <https://example.org/unsub?u=alice>, <mailto:unsub@example.org>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
    '<h2>5 tools we loved</h2><p>Read the <a href="https://example.org/post?utm_source=digest&amp;utm_medium=email&amp;id=42&amp;fbclid=abc">full post</a>.</p><img src="https://tracker.example.net/open.gif?u=alice" width="1" height="1" alt="">',
    '',
  ].join('\r\n'), 30);

  // A meeting invitation (text/calendar), to exercise "Add to calendar".
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenMail seed//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:seed-review@${DOMAIN}`, 'DTSTAMP:20261107T090000Z', 'DTSTART:20261110T093000Z', 'DTEND:20261110T103000Z',
    'SUMMARY:Quarterly design review', 'LOCATION:Room 4 or video call', 'ORGANIZER:mailto:priya@example.org',
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${alice.user}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await importRaw([
    'From: Priya Raman <priya@example.org>', `To: ${alice.user}`, 'Subject: Invitation: Quarterly design review',
    `Date: ${new Date(Date.now() - 2 * 3600e3).toUTCString()}`, `Message-ID: <seed-invite@${DOMAIN}>`, 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="inv"', '',
    '--inv', 'Content-Type: text/plain; charset=utf-8', '', 'Hi Alice, please join the quarterly design review on Tuesday.', '',
    '--inv', 'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', '',
    ics, '--inv--', '',
  ].join('\r\n'), 2);

  // One message with an inline image (cid:) and two attachments, to exercise the reader.
  const map = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200"><rect width="480" height="200" fill="#e7ebfb"/><path d="M40 160 C140 40 260 180 440 50" stroke="#2340c4" stroke-width="6" fill="none"/><circle cx="440" cy="50" r="12" fill="#2340c4"/><text x="40" y="40" font-family="Georgia" font-size="22" fill="#18202b">Lake house, 40 min from the office</text></svg>';
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const rich = [
    'From: Priya Raman <priya@example.org>', `To: ${alice.user}`, 'Subject: Offsite agenda and directions',
    `Date: ${new Date(Date.now() - 1 * 3600e3).toUTCString()}`, `Message-ID: <seed-rich@${DOMAIN}>`, 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"', '',
    '--mix', 'Content-Type: multipart/related; boundary="rel"', '',
    '--rel', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Hi Alice,</p><p>Here is how to get there:</p><p><img src="cid:map@seed" alt="Route to the lake house" width="480"></p><p>The <b>agenda</b> and <b>budget</b> are attached.</p><p>Priya</p>',
    '--rel', 'Content-Type: image/svg+xml', 'Content-ID: <map@seed>', 'Content-Disposition: inline; filename="map.svg"', 'Content-Transfer-Encoding: base64', '', b64(map),
    '--rel--',
    '--mix', 'Content-Type: text/plain; charset=utf-8; name="agenda.txt"', 'Content-Disposition: attachment; filename="agenda.txt"', '',
    '09:00 Arrive and coffee\n10:00 Roadmap review\n12:30 Lunch by the lake\n14:00 Team workshops\n17:00 Wrap up',
    '--mix', 'Content-Type: text/csv; name="budget.csv"', 'Content-Disposition: attachment; filename="budget.csv"', '',
    'item,cost\nvenue,4200\ncatering,1800\ntransport,650',
    '--mix--', '',
  ].join('\r\n');
  await importRaw(rich, 1);
  console.log(`Seeded ${seeds.length + 3} emails`);
}

console.log(`
Ready.
  Web client:  cd web && npm run dev   → http://localhost:5173
  Login:       ${USER.name}@${DOMAIN} / ${USER.pass}
  Admin UI:    ${BASE}/admin  (${admin.user} / see deploy/.dev-admin.json)`);
