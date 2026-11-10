// Custom domains: verification logic with a fake DNS resolver, then the whole flow against the local dev Stalwart
// (claim, DKIM, addresses, mail delivered, pause after 7 days, removal, retirement), then a shared domain (addresses
// offered to other accounts, who accept or decline). Throwaway t-domains-* accounts and t-domains-*.test domains, all removed at the end.
// Never touches alice or bob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { Invites } from '../lib.mjs';
import { checkDomain, checkLocal, cleanDomain, parseZone, wantedRecords, hasRecord, tokenFor, readMeta, writeMeta, adminDomainList, RELEASE_DAYS } from '../domains.mjs';
import { retireNames } from '../account.mjs';

const STALWART = process.env.STALWART_URL || 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE || fileURLToPath(new URL('../../deploy/.dev-admin.json', import.meta.url));
const reachable = await fetch(`${STALWART}/.well-known/jmap`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const skip = !reachable ? `Stalwart not reachable at ${STALWART}` : !existsSync(ADMIN_FILE) ? 'no deploy/.dev-admin.json' : false;

/** A DNS stand-in: { 'TXT name': [...], 'MX name': [...] }; names missing → ENOTFOUND; 'down' → timeout. */
function fakeDns(zone) {
  const miss = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return {
    zone,
    async resolveTxt(n) { if (zone.down) throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }); if (!zone[`TXT ${n}`]) throw miss(); return zone[`TXT ${n}`].map((v) => [v.slice(0, 255), v.slice(255)].filter(Boolean)); },
    async resolveMx(n) { if (!zone[`MX ${n}`]) throw miss(); return zone[`MX ${n}`].map((exchange) => ({ exchange, priority: 10 })); },
  };
}

test('domain and address rules', () => {
  const ours = ['openmail.test', 'mail.openmail.test'];
  assert.equal(cleanDomain('  Ann.DEV. '), 'ann.dev');
  assert.equal(checkDomain('ann.dev', ours), null);
  assert.equal(checkDomain('xn--bcher-kva.example', ours), null);
  for (const bad of ['ann', 'https://ann.dev', 'ann..dev', '-ann.dev', 'ann.dev/x', 'a.b c']) assert.equal(checkDomain(bad, ours)?.code, 'bad_domain', bad);
  for (const r of ['openmail.test', 'sub.openmail.test', 'mail.openmail.test']) assert.equal(checkDomain(r, ours)?.code, 'reserved', r);
  assert.equal(checkDomain('notopenmail.test', ours), null); // suffix match is by label, not by string
  assert.equal(checkLocal('ann'), null); assert.equal(checkLocal('a'), null); assert.equal(checkLocal('first.last_x-1'), null);
  for (const bad of ['', '.ann', 'ann.', 'a..b', 'Ann', 'a b', 'a@b']) assert.ok(checkLocal(bad), bad);
  assert.equal(tokenFor('s', 'acc1', 'ann.dev'), tokenFor('s', 'acc1', 'ann.dev'));
  assert.notEqual(tokenFor('s', 'acc1', 'ann.dev'), tokenFor('s', 'acc2', 'ann.dev')); // another account gets another token
  assert.deepEqual(readMeta('openmail-custom-domain {"owner":"x"}'), { owner: 'x' });
  assert.equal(readMeta('Main domain'), null);
});

test('records: parsed from Stalwart’s zone, checked against (fake) DNS', async () => {
  const zone = 'v1-ed25519-20261107._domainkey.ann.dev. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=abc="\nv1-rsa-20261107._domainkey.ann.dev. IN TXT (\n    "v=DKIM1; k=rsa; p=AAAA"\n    "BBBB"\n)\nann.dev. IN MX 10 mail.openmail.test.\n';
  assert.deepEqual(parseZone(zone)[1], { name: 'v1-rsa-20261107._domainkey.ann.dev', type: 'TXT', value: 'v=DKIM1; k=rsa; p=AAAABBBB' });
  const recs = wantedRecords('ann.dev', { token: 'tok', mailHost: 'mail.openmail.test', spfDomain: 'openmail.test', zone });
  assert.deepEqual(recs.map((r) => r.kind), ['verify', 'mx', 'spf', 'dkim', 'dkim', 'dmarc']);
  assert.equal(wantedRecords('ann.dev', { token: 'tok', mailHost: 'h', spfDomain: 'o', zone: '' }).some((r) => r.kind === 'dkim'), false);

  const dns = fakeDns({});
  const check = () => Promise.all(recs.map((r) => hasRecord(dns, r)));
  assert.deepEqual(await check(), [false, false, false, false, false, false]);
  Object.assign(dns.zone, {
    'TXT ann.dev': ['google-site-verification=xyz', 'openmail-verify=tok', 'v=spf1 include:_spf.google.com include:openmail.test ~all'],
    'MX ann.dev': ['MAIL.openmail.test.'],
    'TXT v1-ed25519-20261107._domainkey.ann.dev': ['v=DKIM1; k=ed25519; h=sha256; p=abc='],
    'TXT v1-rsa-20261107._domainkey.ann.dev': ['v=DKIM1; k=rsa; p=AAAABBBB'.padEnd(300, 'x')], // long: split in 255-byte strings, wrong key
    'TXT _dmarc.ann.dev': ['v=DMARC1; p=reject; rua=mailto:d@ann.dev'],
  });
  assert.deepEqual(await check(), [true, true, true, true, false, true]); // SPF may list others; any DMARC policy counts
  dns.zone['TXT v1-rsa-20261107._domainkey.ann.dev'] = ['v=DKIM1; k=rsa; p=AAAA', 'BBBB']; // two records, neither whole
  assert.equal(await hasRecord(dns, recs[4]), false);
  dns.zone['TXT v1-rsa-20261107._domainkey.ann.dev'] = ['v=DKIM1; k=rsa; p=AAAABBBB'];
  assert.equal(await hasRecord(dns, recs[4]), true);
  dns.zone['TXT ann.dev'] = ['openmail-verify=other', 'v=spf1 mx -all'];
  assert.deepEqual([await hasRecord(dns, recs[0]), await hasRecord(dns, recs[2])], [false, false]); // someone else's token; SPF without us
  dns.zone.down = true;
  assert.equal(await hasRecord(dns, recs[0]), null); // DNS trouble says nothing either way
});

/** The dev MX's answer to RCPT TO for this address (250 = would deliver, 550 = no such mailbox). */
function rcptCode(addr) {
  return new Promise((resolve, reject) => {
    const s = connect(2525, 'localhost'); let buf = '', step = 0;
    const cmds = ['EHLO example.org', 'MAIL FROM:<t@example.org>', `RCPT TO:<${addr}>`, 'QUIT'];
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) if (/^\d{3} /.test(l)) { if (step === 3) { resolve(Number(l.slice(0, 3))); s.end(); return; } s.write(cmds[step++] + '\r\n'); }
    });
    s.on('error', reject);
  });
}

test('custom domain on the dev server: claim, DKIM, addresses, delivery, pause, removal', { skip, timeout: 60_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const mainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8), pass = `throwaway pass ${tag} river`;
  const user = `t-domains-${tag}`, other = `t-domains-${tag}-b`, domain = `t-domains-${tag}.test`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId: mainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const [uid, oid] = [await mk(user), await mk(other)];

  const dns = fakeDns({});
  const pendingDomainsFile = join(mkdtempSync(join(tmpdir(), 'om-pending-')), 'pending-domains.json');
  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, resolver: dns, maxDomainAddresses: 3, pendingDomainsFile, domainSecret: `secret-${tag}` };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => { // whatever the test left behind
    app.close();
    const d = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((x) => x.name === domain);
    await jmap([['x:Account/set', { destroy: [uid, oid] }, 'x']]);
    if (d) {
      const { ids } = await jmap([['x:DkimSignature/query', { filter: { domainId: d.id } }, 'q']]);
      if (ids.length) await jmap([['x:DkimSignature/set', { destroy: ids }, 'k']]);
      await jmap([['x:Domain/set', { destroy: [d.id] }, 'x']]);
    }
  });
  const base = `http://127.0.0.1:${app.address().port}/api/domains`;
  const as = (name) => (path = '', method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: basic(`${name}@openmail.test`, pass), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const call = as(user), call2 = as(other);
  const identities = async () => {
    const r = await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic(`${user}@openmail.test`, pass), 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'], methodCalls: [['Identity/get', { accountId: uid }, 'i']] }) })).json();
    return r.methodResponses[0][1].list.map((i) => i.email).sort();
  };

  assert.equal((await call('', 'GET', undefined)).status, 200);
  assert.equal((await fetch(base)).status, 401);
  for (const bad of ['openmail.test', 'mail.openmail.test', 'x.openmail.test']) assert.equal((await call('', 'POST', { domain: bad })).error.code, 'reserved', bad);

  // 1. Not verified yet: the records to add, nothing created.
  const p = await call('', 'POST', { domain: domain.toUpperCase() });
  assert.equal(p.domain.status, 'pending');
  const verify = p.domain.records[0];
  assert.deepEqual([verify.kind, verify.name, verify.ok], ['verify', domain, false]);
  assert.match(verify.value, /^openmail-verify=[\w-]{32}$/);
  assert.equal(p.domain.records.find((r) => r.kind === 'mx').value, '10 mail.openmail.test.');
  assert.equal(p.domain.records.find((r) => r.kind === 'spf').value, 'v=spf1 include:openmail.test -all');
  assert.ok(!(await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.some((d) => d.name === domain));
  // The other account sees a different token, so this account's TXT record doesn't let them claim it.
  assert.notEqual((await call2('', 'POST', { domain })).domain.records[0].value, verify.value);
  // Still pending after a restart: a new service on the same PENDING_DOMAINS_FILE lists it, with the same record.
  const app2 = createApp(cfg);
  await new Promise((r) => app2.listen(0, '127.0.0.1', r));
  const again = await (await fetch(`http://127.0.0.1:${app2.address().port}/api/domains`, { headers: { Authorization: basic(`${user}@openmail.test`, pass) } })).json();
  app2.close();
  assert.deepEqual(again.domains.map((d) => [d.name, d.status, d.records[0].value]), [[domain, 'pending', verify.value]]);
  // Removing a pending domain forgets it.
  assert.equal((await call2(`/${domain}`, 'DELETE')).status, 200);
  assert.deepEqual((await call2()).domains, []);

  // 2. TXT is live: claimed, created in Stalwart, main address added.
  dns.zone[`TXT ${domain}`] = [verify.value];
  const c = await call('', 'POST', { domain });
  assert.equal(c.status, 200);
  assert.equal(c.domain.status, 'active');
  assert.deepEqual(JSON.parse(readFileSync(pendingDomainsFile, 'utf8')), {}); // claimed: no longer pending
  assert.deepEqual(c.domain.addresses.map((a) => [a.email, a.main]), [[`${user}@${domain}`, true]]);
  assert.equal(await rcptCode(`${user}@${domain}`), 250);
  assert.deepEqual(await identities(), [`${user}@openmail.test`, `${user}@${domain}`]); // Compose's From menu
  assert.equal((await call2('', 'POST', { domain })).error.code, 'taken'); // one account per domain
  assert.equal((await call('', 'POST', { domain })).domain.status, 'active'); // "Check again" on your own: fine

  // 3. DKIM keys come a moment after the domain; then they're among the records.
  let recs = [];
  for (let i = 0; i < 20 && !recs.some((r) => r.kind === 'dkim'); i++) { await new Promise((r) => setTimeout(r, 500)); recs = (await call()).domains[0].records; }
  const dkim = recs.filter((r) => r.kind === 'dkim');
  assert.ok(dkim.length >= 1 && dkim.every((r) => r.name.endsWith(`._domainkey.${domain}`) && r.value.startsWith('v=DKIM1;') && r.ok === false), JSON.stringify(dkim));
  for (const r of dkim) dns.zone[`TXT ${r.name}`] = [r.value];
  assert.ok((await call()).domains[0].records.filter((r) => r.kind === 'dkim').every((r) => r.ok));

  // 4. More addresses, up to the cap; removing one retires it.
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'Hello' })).status, 200);
  assert.equal(await rcptCode(`hello@${domain}`), 250);
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'hello' })).error.code, 'exists');
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'bad..name' })).error.code, 'bad_name');
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'shop' })).status, 200);
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'fourth' })).error.code, 'too_many');
  assert.equal((await call(`/${domain}/addresses/${user}`, 'DELETE')).error.code, 'main');
  assert.equal((await call(`/${domain}/addresses/shop`, 'DELETE')).status, 200);
  assert.equal(await rcptCode(`shop@${domain}`), 550);
  assert.equal((await call(`/${domain}/addresses`, 'POST', { name: 'shop' })).error.code, 'retired'); // never recycled
  assert.equal((await call2(`/${domain}/addresses`, 'POST', { name: 'mine' })).status, 404); // not theirs
  // The masked-address list (Settings → Addresses) only shows addresses on the main domain.
  const masked = await (await fetch(`http://127.0.0.1:${app.address().port}/api/aliases`, { headers: { Authorization: basic(`${user}@openmail.test`, pass) } })).json();
  assert.deepEqual(masked.aliases, []);

  // 5. Admin console sees it.
  const listed = (await adminDomainList(jmap)).find((d) => d.name === domain);
  assert.deepEqual([listed.owner, listed.status, listed.addresses], [`${user}@openmail.test`, 'active', 2]);

  // 6. Re-verification: TXT gone. Missing first, paused after 7 days (addresses off), back on when it returns.
  delete dns.zone[`TXT ${domain}`];
  const t0 = Date.now();
  await app.domains.recheckAll(t0);
  let v = (await call()).domains[0];
  assert.equal(v.status, 'missing');
  assert.equal(await rcptCode(`${user}@${domain}`), 250); // still working inside the grace period
  await app.domains.recheckAll(t0 + 8 * 86400e3);
  const meta = readMeta((await jmap([['x:Domain/get', { ids: null, properties: ['name', 'description'] }, 'd']])).list.find((d) => d.name === domain).description);
  assert.equal(meta.paused, true);
  assert.equal(await rcptCode(`${user}@${domain}`), 550);
  assert.deepEqual(await identities(), [`${user}@openmail.test`]); // can't send from it either
  dns.zone.down = true; await app.domains.recheckAll(t0 + 9 * 86400e3); dns.zone.down = false; // DNS outage: no change
  dns.zone[`TXT ${domain}`] = [verify.value];
  v = (await call()).domains[0]; // "Check again"
  assert.equal(v.status, 'active');
  assert.equal(await rcptCode(`${user}@${domain}`), 250);
  assert.ok(v.addresses.every((a) => a.enabled));

  // 7. Remove the domain: addresses retired, DKIM keys and the domain gone from Stalwart.
  assert.equal((await call(`/${domain}`, 'DELETE')).status, 200);
  assert.equal(await rcptCode(`hello@${domain}`), 550);
  assert.ok(!(await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.some((d) => d.name === domain));
  assert.ok(cfg.extraReserved.includes(`${user}@${domain}`) && cfg.extraReserved.includes(`hello@${domain}`));
  assert.deepEqual((await call()).domains, []);

  // 8. Account deletion: its domain addresses are retired as full addresses, the domain loses its owner (a later
  // account with the same id must not match), and after RELEASE_DAYS it's released for someone else.
  assert.equal((await call('', 'POST', { domain })).domain.status, 'active'); // claim it again (TXT is still in the fake DNS)
  await retireNames({ cfg: { domain: 'openmail.test' }, jmap }, uid, user); // (its address there was retired in step 7, so not given back)
  const orphan = readMeta((await jmap([['x:Domain/get', { ids: null, properties: ['name', 'description'] }, 'd']])).list.find((d) => d.name === domain).description);
  assert.deepEqual([orphan.owner, orphan.paused, !!orphan.orphaned], [null, true, true]);
  assert.deepEqual((await call()).domains, []); // not theirs any more
  await jmap([['x:Account/set', { destroy: [uid] }, 'x']]); // the deletion itself (account.mjs does this next)
  await app.domains.recheckAll(Date.now() + (RELEASE_DAYS + 1) * 86400e3);
  assert.ok(!(await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.some((d) => d.name === domain));
});

/** Hand the dev MX a message for this address (as an outside server would). Resolves to its answer to the message. */
function deliver(addr, subject) {
  return new Promise((resolve, reject) => {
    const s = connect(2525, 'localhost'); let buf = '', step = 0;
    const cmds = ['EHLO example.org', 'MAIL FROM:<t@example.org>', `RCPT TO:<${addr}>`, 'DATA',
      `From: t@example.org\r\nTo: ${addr}\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nhello\r\n.`, 'QUIT'];
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) if (/^\d{3} /.test(l)) { if (step === 5 || l[0] === '5') { resolve(Number(l.slice(0, 3))); s.end(); return; } s.write(cmds[step++] + '\r\n'); }
    });
    s.on('error', reject);
  });
}

test('shared domain on the dev server: the owner invites other accounts to addresses, they accept or decline; nothing dangles', { skip, timeout: 120_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const mainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8), pass = `throwaway pass ${tag} river`;
  const owner = `t-domains-${tag}-o`, sam = `t-domains-${tag}-s`, kim = `t-domains-${tag}-k`, ghost = `t-domains-${tag}-g`, domain = `t-domains-${tag}-org.test`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId: mainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const [oid, sid, kid, gid] = [await mk(owner), await mk(sam), await mk(kim), await mk(ghost)];
  const at = (name) => `${name}@openmail.test`;

  const dns = fakeDns({});
  // 5 addresses on the domain, 2 invitations waiting per invited account; the per-day invitation limit is tested on
  // its own service below (the flow here invites the same accounts many times).
  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, resolver: dns, maxDomainAddresses: 5, maxDomainInvites: 2,
    domainInvitesPerDay: 100, domainChecksPerHour: 1000, aliasesPerHour: 1000, retentionJob: false };
  const apps = [];
  const start = async (over) => { const a = createApp(over ? { ...cfg, ...over } : cfg); // (a copy keeps its own list of retired names from then on)
    apps.push(a); await new Promise((r) => a.listen(0, '127.0.0.1', r)); return a; };
  const app = await start();
  const domainRow = async () => (await jmap([['x:Domain/get', { ids: null, properties: ['name', 'description'] }, 'd']])).list.find((x) => x.name === domain);
  t.after(async () => { // whatever the test left behind
    for (const a of apps) a.close();
    const d = await domainRow();
    await jmap([['x:Account/set', { destroy: [oid, sid, kid, gid] }, 'x']]);
    if (d) {
      const { ids } = await jmap([['x:DkimSignature/query', { filter: { domainId: d.id } }, 'q']]);
      if (ids.length) await jmap([['x:DkimSignature/set', { destroy: ids }, 'k']]);
      await jmap([['x:Domain/set', { destroy: [d.id] }, 'x']]);
    }
  });
  const on = (a) => (name) => (path = '', method = 'GET', body) => fetch(`http://127.0.0.1:${a.address().port}/api/domains${path}`, { method, headers: { Authorization: basic(at(name), pass), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const as = on(app);
  const asOwner = as(owner), asSam = as(sam), asKim = as(kim), asGhost = as(ghost);
  const userJmap = async (name, using, methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic(at(name), pass), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', ...using], methodCalls }) })).json()).methodResponses[0][1];
  const identities = async (name, id) => (await userJmap(name, ['urn:ietf:params:jmap:submission'], [['Identity/get', { accountId: id }, 'i']])).list.map((i) => i.email).sort();
  const aliasesOn = async (id) => Object.values((await jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']])).list[0]?.aliases ?? {}).map((a) => a.name).sort();
  const claim = async () => readMeta((await domainRow()).description);
  /** Rewrite the claim behind the service's back (time passing, a race, Stalwart's own admin). */
  const setClaim = async (change) => { const d = await domainRow(); await jmap([['x:Domain/set', { update: { [d.id]: { description: writeMeta(change(readMeta(d.description))) } } }, 'm']]); };
  const members = (r) => r.domain.members.map((m) => [m.account, m.email, m.enabled]);
  const offered = (r) => r.domain.invitations.map((i) => [i.account, i.email]);
  const invitedTo = async (call) => (await call()).invitations.map((i) => i.email);

  // The owner claims the domain as before: their own address on it, no members, no invitations.
  const verify = (await asOwner('', 'POST', { domain })).domain.records[0].value;
  dns.zone[`TXT ${domain}`] = [verify];
  const c = await asOwner('', 'POST', { domain });
  assert.deepEqual([c.domain.status, c.domain.addresses.map((a) => a.email), c.domain.members, c.domain.invitations, c.domain.maxAddresses], ['active', [`${owner}@${domain}`], [], [], 5]);
  assert.deepEqual([(await asSam()).memberOf, (await asSam()).invitations], [[], []]);

  // 1. Who can be offered an address: an existing account here, by its exact address. Only the owner may.
  const add = (account, name, call = asOwner) => call(`/${domain}/members`, 'POST', { account, name }); // "Give address": an invitation
  const answer = (call, name, method = 'POST') => call(`/${domain}/invitations/${name}`, method); // POST accepts, DELETE declines or withdraws
  const give = async (call, account, name) => { const r = await add(account, name); return r.status === 200 ? answer(call, name) : r; }; // offered and accepted
  for (const [account, code] of [[sam, 'bad_account'], [`${sam}@elsewhere.test`, 'bad_account'], [`${sam}@${domain}`, 'bad_account'], ['', 'bad_account'], [at(`${sam}-nobody`), 'no_such_account'], [at(owner), 'self']])
    assert.equal((await add(account, 'sam')).error?.code, code, account);
  assert.equal((await add(at(sam), 'bad..name')).error.code, 'bad_name');
  assert.equal((await add(at(sam), owner)).error.code, 'exists'); // the owner's own address there
  assert.equal((await add(at(kim), 'kim', asSam)).status, 404); // not Sam's domain
  assert.equal((await asOwner(`/${domain}/members`, 'DELETE')).status, 405);
  assert.equal((await asOwner(`/${domain}/members/sam`, 'POST', {})).status, 405);
  for (const method of ['POST', 'DELETE', 'GET']) assert.equal((await asOwner(`/${domain}/invitations`, method)).status, 405, method);
  assert.deepEqual([await aliasesOn(sid), (await claim()).members, (await claim()).invites], [[], undefined, undefined]); // nothing happened yet

  // 2. Offered: an invitation in the claim and nothing else. The other account is untouched until its owner accepts.
  const g = await add(at(sam).toUpperCase(), 'Sam@ignored');
  assert.equal(g.status, 200, JSON.stringify(g));
  assert.deepEqual([members(g), offered(g), g.domain.addresses.map((a) => a.email)], [[], [[at(sam), `sam@${domain}`]], [`${owner}@${domain}`]]);
  const waiting = (await claim()).invites;
  assert.deepEqual([Object.keys(waiting), waiting.sam.to, waiting.sam.by, (await claim()).members], [['sam'], sid, oid, undefined]);
  assert.deepEqual([await aliasesOn(sid), await identities(sam, sid), await rcptCode(`sam@${domain}`)], [[], [at(sam)], 550]); // no alias, no identity, no mail
  // The invited person sees who offers what, and until when (14 days).
  const [seen, ...more] = (await asSam()).invitations;
  assert.deepEqual([more, seen.domain, seen.name, seen.email, seen.owner, seen.invited], [[], domain, 'sam', `sam@${domain}`, at(owner), waiting.sam.at]);
  assert.equal(Date.parse(seen.expires) - Date.parse(seen.invited), 14 * 86400e3);
  assert.deepEqual([(await asSam()).domains, (await asSam()).memberOf, await invitedTo(asKim)], [[], [], []]); // not a member yet; nobody else's business
  // It survives a restart: a new service (nothing but Stalwart to read) shows it to both sides.
  const restarted = await start({});
  assert.deepEqual([await invitedTo(on(restarted)(sam)), offered({ domain: (await on(restarted)(owner)()).domains[0] })], [[`sam@${domain}`], [[at(sam), `sam@${domain}`]]]);
  // An invitation holds its address: not offered twice, not taken by the owner meanwhile.
  assert.equal((await add(at(kim), 'sam')).error.code, 'invited');
  assert.equal((await asOwner(`/${domain}/addresses`, 'POST', { name: 'sam' })).error.code, 'invited');
  // Only the invited account can answer it. Being invited gives no say over the domain.
  assert.equal((await answer(asKim, 'sam')).status, 404);
  assert.equal((await answer(asKim, 'sam', 'DELETE')).status, 404);
  assert.equal((await answer(asOwner, 'sam')).status, 404); // the owner can't accept for them
  assert.equal((await answer(asSam, 'other')).error.code, 'not_found');
  assert.equal((await asSam(`/${domain}/addresses`, 'POST', { name: 'mine' })).status, 404);
  assert.equal((await add(at(kim), 'kim', asSam)).status, 404);
  assert.equal((await asSam(`/${domain}/members/sam`, 'DELETE')).status, 404);
  assert.equal((await asSam(`/${domain}`, 'DELETE')).status, 404);
  assert.deepEqual([Object.keys((await claim()).invites), await aliasesOn(sid)], [['sam'], []]);

  // 2a. Declined: the invitation is gone, for both. Nothing was made, so nothing is retired; the owner may ask again.
  assert.equal((await answer(asSam, 'sam', 'DELETE')).status, 200);
  assert.deepEqual([await invitedTo(asSam), (await asOwner()).domains[0].invitations, (await claim()).invites, await aliasesOn(sid), cfg.extraReserved], [[], [], undefined, [], []]);
  assert.equal((await answer(asSam, 'sam')).status, 404); // can't accept what was declined
  assert.equal((await answer(asSam, 'sam', 'DELETE')).status, 404);

  // 2b. Withdrawn by the owner: gone just the same.
  assert.equal((await add(at(sam), 'sam')).status, 200);
  const w = await answer(asOwner, 'sam', 'DELETE');
  assert.deepEqual([w.status, w.domain.invitations, await invitedTo(asSam), (await claim()).invites], [200, [], [], undefined]);
  assert.equal((await answer(asSam, 'sam')).status, 404);
  assert.equal((await answer(asOwner, 'sam', 'DELETE')).error.code, 'not_found');

  // 2c. Expired (14 days without an answer): no longer shown to either, can't be accepted, and the address is free
  // to offer again; the stale entry leaves the claim with the next write.
  assert.equal((await add(at(sam), 'sam')).status, 200);
  await setClaim((m) => ({ ...m, invites: { sam: { ...m.invites.sam, at: new Date(Date.now() - 14 * 86400e3 - 60e3).toISOString() } } }));
  assert.deepEqual([await invitedTo(asSam), (await asOwner()).domains[0].invitations], [[], []]);
  assert.equal((await answer(asSam, 'sam')).status, 404);
  assert.deepEqual(await aliasesOn(sid), []);
  await setClaim((m) => ({ ...m, invites: { ...m.invites, sam: { ...waiting.sam, at: new Date(Date.now() - 13 * 86400e3).toISOString() } } })); // a day left: still good
  assert.deepEqual(await invitedTo(asSam), [`sam@${domain}`]);
  await setClaim((m) => ({ ...m, invites: { old: { ...waiting.sam, at: new Date(Date.now() - 20 * 86400e3).toISOString() } } }));
  assert.equal((await add(at(sam), 'sam')).status, 200);
  assert.deepEqual(Object.keys((await claim()).invites), ['sam']);

  // 2d. Accepted: now it is an alias of the member's account. Mail lands in their mailbox, and it's in their From menu, not the owner's.
  assert.equal((await answer(asSam, 'sam')).status, 200);
  assert.equal((await answer(asSam, 'sam')).status, 404); // answered: there is no invitation left
  const accepted = (await asOwner()).domains[0];
  assert.deepEqual([members({ domain: accepted }), accepted.invitations, accepted.addresses.map((a) => a.email)], [[[at(sam), `sam@${domain}`, true]], [], [`${owner}@${domain}`]]);
  assert.deepEqual([(await claim()).members, (await claim()).invites], [{ [sid]: ['sam'] }, undefined]);
  assert.deepEqual(await aliasesOn(sid), ['sam']);
  assert.deepEqual(await identities(sam, sid), [at(sam), `sam@${domain}`].sort());
  assert.deepEqual(await identities(owner, oid), [at(owner), `${owner}@${domain}`].sort());
  assert.equal(await deliver(`sam@${domain}`, `t-domains-${tag}-hello`), 250);
  const inbox = async (name, id) => (await userJmap(name, ['urn:ietf:params:jmap:mail'], [['Email/query', { accountId: id, filter: { subject: `t-domains-${tag}-hello` } }, 'q']])).ids.length;
  let got = 0;
  for (let i = 0; i < 40 && !got; i++) { got = await inbox(sam, sid); if (!got) await new Promise((r) => setTimeout(r, 250)); }
  assert.deepEqual([got, await inbox(owner, oid)], [1, 0]); // the member's mailbox, nobody else's
  // …and the member really can send from it: a message from sam@<domain> reaches Kim's inbox with that sender.
  const mail = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic(at(sam), pass), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'], methodCalls }) })).json()).methodResponses;
  const [[, boxes], [, ids]] = await mail([['Mailbox/get', { accountId: sid, properties: ['role'] }, 'm'], ['Identity/get', { accountId: sid }, 'i']]);
  const sent = await mail([
    ['Email/set', { accountId: sid, create: { e: { mailboxIds: { [boxes.list.find((m) => m.role === 'drafts').id]: true }, from: [{ email: `sam@${domain}` }], to: [{ email: at(kim) }],
      subject: `t-domains-${tag}-from-sam`, textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'hi' } } } } }, 'e'],
    ['EmailSubmission/set', { accountId: sid, create: { s: { identityId: ids.list.find((i) => i.email === `sam@${domain}`).id, emailId: '#e' } } }, 's'],
  ]);
  assert.ok(sent[1][1].created?.s, JSON.stringify(sent));
  let from = null;
  for (let i = 0; i < 40 && !from; i++) {
    const r = await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic(at(kim), pass), 'Content-Type': 'application/json' }, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/query', { accountId: kid, filter: { subject: `t-domains-${tag}-from-sam` } }, 'q'], ['Email/get', { accountId: kid, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['from'] }, 'g']] }) })).json();
    from = r.methodResponses[1][1].list?.[0]?.from?.[0]?.email ?? null;
    if (!from) await new Promise((r2) => setTimeout(r2, 250));
  }
  assert.equal(from, `sam@${domain}`);
  // The owner can't send as the member's address (Stalwart has no such identity for them, checked above).

  // 3. The member sees what they were given and by whom. They can't manage the domain.
  assert.deepEqual([(await asSam()).domains, (await asSam()).memberOf], [[], [{ domain, name: 'sam', email: `sam@${domain}`, enabled: true, owner: at(owner) }]]);
  assert.equal((await asSam(`/${domain}/addresses`, 'POST', { name: 'mine' })).status, 404);
  assert.equal((await add(at(kim), 'kim', asSam)).status, 404);
  assert.equal((await asSam(`/${domain}/addresses/${owner}`, 'DELETE')).status, 404);
  assert.equal((await asSam(`/${domain}`, 'DELETE')).status, 404);
  assert.equal((await answer(asSam, 'sam', 'DELETE')).status, 404); // an accepted address is not an invitation
  assert.equal((await asSam('', 'POST', { domain })).error.code, 'taken');

  // 4. One name once on the domain, and one cap for all of it (5 here): the owner's addresses, the members' and the
  // invitations still waiting. And nobody can be buried in invitations: 2 waiting per invited account here.
  assert.equal((await add(at(kim), 'sam')).error.code, 'exists');
  assert.equal((await asOwner(`/${domain}/addresses`, 'POST', { name: 'sam' })).error.code, 'exists');
  assert.equal((await add(at(kim), 'kim')).status, 200);
  assert.equal((await add(at(kim), 'k2')).status, 200);
  assert.equal((await add(at(kim), 'k3')).error.code, 'too_many_invites'); // Kim has two to answer first
  assert.deepEqual((await invitedTo(asKim)).sort(), [`k2@${domain}`, `kim@${domain}`]);
  assert.equal((await answer(asKim, 'k2', 'DELETE')).status, 200);
  assert.equal((await add(at(sam), 'sales')).status, 200); // a second address for the same member
  assert.equal((await add(at(sam), 'extra')).status, 200); // owner + sam, and kim, sales, extra waiting: 5
  assert.equal((await add(at(kim), 'sixth')).error.code, 'too_many');
  assert.equal((await asOwner(`/${domain}/addresses`, 'POST', { name: 'sixth' })).error.code, 'too_many');
  assert.deepEqual([await aliasesOn(kid), Object.keys((await claim()).invites).sort()], [[], ['extra', 'kim', 'sales']]); // a refusal leaves no trace
  assert.equal((await answer(asKim, 'kim')).status, 200);
  assert.equal((await answer(asSam, 'sales')).status, 200);
  assert.deepEqual([(await claim()).members, Object.keys((await claim()).invites)], [{ [sid]: ['sam', 'sales'], [kid]: ['kim'] }, ['extra']]);
  assert.deepEqual(offered({ domain: (await asOwner()).domains[0] }), [[at(sam), `extra@${domain}`]]);
  // The admin console counts addresses that exist: an invitation is neither an address nor a member.
  const listed = (await adminDomainList(jmap)).find((d) => d.name === domain);
  assert.deepEqual([listed.owner, listed.addresses, listed.members], [at(owner), 4, 2]);
  // Kim can't touch Sam's address (and learns nothing: the same answer as for one that doesn't exist).
  assert.equal((await asKim(`/${domain}/members/sam`, 'DELETE')).error.code, 'not_found');
  assert.deepEqual(await aliasesOn(sid), ['sales', 'sam']);

  // 5. The domain pauses (TXT gone for 7 days): members' addresses stop too, and come back with it. Invitations
  // still waiting are dropped (what they offer no longer works), and none can be made while it is paused.
  delete dns.zone[`TXT ${domain}`];
  const t0 = Date.now();
  await app.domains.recheckAll(t0);
  assert.deepEqual(await invitedTo(asSam), [`extra@${domain}`]); // only missing, inside the grace period: still offered
  await app.domains.recheckAll(t0 + 8 * 86400e3);
  assert.deepEqual([(await claim()).paused, (await claim()).members, (await claim()).invites], [true, { [sid]: ['sam', 'sales'], [kid]: ['kim'] }, undefined]); // the re-check keeps the list
  assert.deepEqual([await rcptCode(`sam@${domain}`), await rcptCode(`kim@${domain}`)], [550, 550]);
  assert.deepEqual(await identities(sam, sid), [at(sam)]);
  assert.equal((await asSam()).memberOf.every((m) => m.enabled === false), true);
  assert.deepEqual(await invitedTo(asSam), []);
  assert.equal((await answer(asSam, 'extra')).status, 404);
  assert.equal((await add(at(sam), 'extra')).error.code, 'paused');
  dns.zone[`TXT ${domain}`] = [verify];
  const back = (await asOwner()).domains[0]; // "Check again"
  assert.deepEqual([back.status, back.members.every((m) => m.enabled), back.invitations, await rcptCode(`sam@${domain}`), await rcptCode(`kim@${domain}`)], ['active', true, [], 250, 250]);

  // 6. The owner takes one back: gone from the member's account, retired for good (never recycled, for anyone).
  const r = await asOwner(`/${domain}/members/sales`, 'DELETE');
  assert.equal(r.status, 200);
  assert.deepEqual(members(r).map((m) => m[1]).sort(), [`kim@${domain}`, `sam@${domain}`]);
  assert.deepEqual([await aliasesOn(sid), (await claim()).members[sid], await rcptCode(`sales@${domain}`)], [['sam'], ['sam'], 550]);
  assert.ok(cfg.extraReserved.includes(`sales@${domain}`));
  for (const again of [add(at(sam), 'sales'), add(at(kim), 'sales'), asOwner(`/${domain}/addresses`, 'POST', { name: 'sales' })]) assert.equal((await again).error.code, 'retired');
  assert.equal((await asOwner(`/${domain}/members/sales`, 'DELETE')).error.code, 'not_found');
  assert.equal((await asOwner(`/${domain}/members/${owner}`, 'DELETE')).error.code, 'not_found'); // the owner's own isn't a member address

  // 7. A member gives theirs up: the one thing they can change. Retired just the same.
  assert.deepEqual([(await asKim(`/${domain}/members/kim`, 'DELETE')).status, await aliasesOn(kid), (await claim()).members, await rcptCode(`kim@${domain}`)], [200, [], { [sid]: ['sam'] }, 550]);
  assert.ok(cfg.extraReserved.includes(`kim@${domain}`));
  assert.deepEqual((await asKim()).memberOf, []);
  assert.equal((await asKim(`/${domain}/members/kim`, 'DELETE')).status, 404); // not a member any more: not their domain at all

  // 7a. Accepting checks everything again, as it is at that moment. (Owner + sam: 2 of 5 used from here.)
  // The address was taken meanwhile (here: put on the owner's account in Stalwart's own admin, behind the service).
  const did = (await domainRow()).id;
  assert.equal((await add(at(kim), 'taken')).status, 200);
  await jmap([['x:Account/set', { update: { [oid]: { 'aliases/1500': { name: 'taken', domainId: did, enable: true } } } }, 'u']]);
  assert.equal((await answer(asKim, 'taken')).error.code, 'gone');
  assert.deepEqual([await aliasesOn(kid), await invitedTo(asKim), (await claim()).invites, (await claim()).members], [[], [], undefined, { [sid]: ['sam'] }]); // and it isn't offered any more
  assert.equal((await asOwner(`/${domain}/addresses/taken`, 'DELETE')).status, 200);
  // The address was retired meanwhile.
  assert.equal((await add(at(kim), 'former')).status, 200);
  cfg.extraReserved.push(`former@${domain}`);
  assert.equal((await answer(asKim, 'former')).error.code, 'gone');
  assert.deepEqual([await aliasesOn(kid), await invitedTo(asKim), await rcptCode(`former@${domain}`)], [[], [], 550]);
  // The domain is paused, or is no longer the inviter's (neither can happen through the service without the
  // invitation going first, so the claim is rewritten by hand here).
  for (const change of [{ paused: true }, { owner: sid }]) {
    assert.equal((await add(at(kim), 'later')).status, 200);
    const before = await claim();
    await setClaim((m) => ({ ...m, ...change }));
    assert.equal((await answer(asKim, 'later')).error.code, 'unavailable', JSON.stringify(change));
    assert.deepEqual([await aliasesOn(kid), (await claim()).invites], [[], undefined]);
    await setClaim((m) => ({ ...m, paused: before.paused, owner: before.owner }));
  }
  // The cap was reached meanwhile (the administrator lowered MAX_DOMAIN_ADDRESSES to what is already used, and
  // restarted): refused, but still offered, since room may come back.
  assert.equal((await add(at(kim), 'roomy')).status, 200);
  const smaller = await start({ maxDomainAddresses: 2 });
  assert.equal((await on(smaller)(kim)(`/${domain}/invitations/roomy`, 'POST')).error.code, 'too_many');
  assert.deepEqual([await aliasesOn(kid), await invitedTo(asKim)], [[], [`roomy@${domain}`]]);
  // The invited account is not the one that was invited (deleted, and its id given to a newcomer): it sees nothing
  // and can't accept; the owner's list drops the invitation.
  await setClaim((m) => ({ ...m, invites: { roomy: { ...m.invites.roomy, made: '2001-01-01T00:00:00Z' } } }));
  assert.deepEqual([await invitedTo(asKim), (await answer(asKim, 'roomy')).status, (await answer(asKim, 'roomy', 'DELETE')).status], [[], 404, 404]);
  assert.deepEqual([(await asOwner()).domains[0].invitations, (await claim()).invites, await aliasesOn(kid)], [[], undefined, []]);

  // 7b. One owner can invite the same account only so often in a day (2 on this service), so "invite, withdraw,
  // invite again" can't be used to pester someone. Refusals don't count.
  const strict = on(await start({ domainInvitesPerDay: 2 }));
  const again = (name) => strict(owner)(`/${domain}/members`, 'POST', { account: at(kim), name });
  assert.equal((await again('sam')).error.code, 'exists');
  for (const n of ['n1', 'n2']) assert.deepEqual([(await again(n)).status, (await answer(asOwner, n, 'DELETE')).status], [200, 200]);
  const limited = await again('n3');
  assert.deepEqual([limited.status, limited.error.code, limited.error.retryAfter > 0], [429, 'rate_limited', true]);
  assert.equal((await strict(owner)(`/${domain}/members`, 'POST', { account: at(sam), name: 'n3' })).status, 200); // per invited account
  assert.equal((await answer(asSam, 'n3', 'DELETE')).status, 200);
  assert.deepEqual([(await claim()).invites, await invitedTo(asKim), cfg.extraReserved.some((n) => /^n\d@/.test(n))], [undefined, [], false]);

  // 8. A member's account is deleted (account.mjs / admin.mjs call retireNames first): its address is retired and
  // it leaves the list, so a later account that gets the same id is nobody here. Its invitations go too.
  assert.equal((await give(asKim, at(kim), 'kim2')).status, 200);
  assert.equal((await add(at(kim), 'kim3')).status, 200);
  assert.equal((await add(at(sam), 'sam3')).status, 200);
  await retireNames({ cfg, jmap }, kid, kim);
  assert.deepEqual([(await claim()).members, await aliasesOn(kid), cfg.extraReserved.includes(`kim2@${domain}`), cfg.extraReserved.includes(kim)], [{ [sid]: ['sam'] }, [], true, true]);
  assert.deepEqual([Object.keys((await claim()).invites), await invitedTo(asKim), (await answer(asKim, 'kim3')).status], [['sam3'], [], 404]); // Sam's stays
  assert.equal((await answer(asSam, 'sam3', 'DELETE')).status, 200);
  // …and one deleted behind our back (Stalwart's own admin): its listed address is retired the next time the list
  // is written, instead of quietly becoming free again; an invitation it hadn't answered is dropped when the owner
  // next looks, so the address it held can be offered to someone else.
  assert.equal((await give(asGhost, at(ghost), 'ghost')).status, 200);
  assert.equal((await add(at(ghost), 'ghost2')).status, 200);
  await jmap([['x:Account/set', { destroy: [gid] }, 'x']]);
  const after = (await asOwner()).domains[0];
  assert.deepEqual([after.members.map((m) => m.email), after.invitations, (await claim()).invites, cfg.extraReserved.includes(`ghost@${domain}`)], [[`sam@${domain}`], [], undefined, false]);
  assert.equal((await add(at(sam), 'ghost')).error.code, 'retired');
  assert.equal((await give(asSam, at(sam), 'ghost2')).status, 200); // never existed, so not retired
  assert.deepEqual((await claim()).members, { [sid]: ['sam', 'ghost2'] });

  // 9. The owner removes the domain: members' addresses go with it, retired like the owner's; invitations are gone
  // with the claim (nothing to accept, nothing retired).
  assert.equal((await add(at(sam), 'unanswered')).status, 200);
  assert.equal((await asOwner(`/${domain}`, 'DELETE')).status, 200);
  assert.deepEqual([await aliasesOn(sid), await domainRow(), (await asSam()).memberOf, await invitedTo(asSam)], [[], undefined, [], []]);
  assert.equal((await answer(asSam, 'unanswered')).status, 404); // the domain was removed meanwhile
  for (const a of [`sam@${domain}`, `ghost2@${domain}`, `${owner}@${domain}`]) assert.ok(cfg.extraReserved.includes(a), a);
  assert.ok(!cfg.extraReserved.includes(`unanswered@${domain}`));
  assert.deepEqual(await identities(sam, sid), [at(sam)]);

  // 10. The owner's account is deleted while members still have addresses: those are retired and removed at once
  // (nobody is left to manage them), invitations are dropped, and the ownerless domain is released after
  // RELEASE_DAYS as before.
  assert.equal((await asOwner('', 'POST', { domain })).domain.status, 'active'); // claimed again (the TXT is still there)
  assert.equal((await give(asSam, at(sam), 'sam2')).status, 200);
  assert.equal((await add(at(sam), 'sam4')).status, 200);
  assert.equal(await rcptCode(`sam2@${domain}`), 250);
  await retireNames({ cfg, jmap }, oid, owner);
  const orphan = await claim();
  assert.deepEqual([orphan.owner, orphan.paused, !!orphan.orphaned, orphan.members, orphan.invites], [null, true, true, {}, undefined]);
  assert.deepEqual([await aliasesOn(sid), await rcptCode(`sam2@${domain}`), cfg.extraReserved.includes(`sam2@${domain}`)], [[], 550, true]);
  assert.deepEqual([(await asSam()).memberOf, await invitedTo(asSam), (await answer(asSam, 'sam4')).status], [[], [], 404]);
  await jmap([['x:Account/set', { destroy: [oid] }, 'x']]); // the deletion itself
  await app.domains.recheckAll(Date.now() + (RELEASE_DAYS + 1) * 86400e3);
  assert.equal(await domainRow(), undefined);
});
