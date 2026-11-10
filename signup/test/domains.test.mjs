// Custom domains: verification logic with a fake DNS resolver, then the whole flow against the local dev Stalwart
// (claim, DKIM, addresses, mail delivered, pause after 7 days, removal, retirement), then a shared domain (addresses
// given to other accounts). Throwaway t-domains-* accounts and t-domains-*.test domains, all removed at the end.
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
import { checkDomain, checkLocal, cleanDomain, parseZone, wantedRecords, hasRecord, tokenFor, readMeta, adminDomainList, RELEASE_DAYS } from '../domains.mjs';
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

test('shared domain on the dev server: the owner gives addresses to other accounts, takes them back; nothing dangles', { skip, timeout: 90_000 }, async (t) => {
  const admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const jmap = async (methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(admin.user, admin.pass) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
  const mainId = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d) => d.name === 'openmail.test').id;
  const tag = Math.random().toString(36).slice(2, 8), pass = `throwaway pass ${tag} river`;
  const owner = `t-domains-${tag}-o`, sam = `t-domains-${tag}-s`, kim = `t-domains-${tag}-k`, domain = `t-domains-${tag}-org.test`;
  const mk = async (name) => (await jmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId: mainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']])).created.n.id;
  const [oid, sid, kid] = [await mk(owner), await mk(sam), await mk(kim)];
  const at = (name) => `${name}@openmail.test`;

  const dns = fakeDns({});
  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, resolver: dns, maxDomainAddresses: 4, retentionJob: false };
  const app = createApp(cfg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const domainRow = async () => (await jmap([['x:Domain/get', { ids: null, properties: ['name', 'description'] }, 'd']])).list.find((x) => x.name === domain);
  t.after(async () => { // whatever the test left behind
    app.close();
    const d = await domainRow();
    await jmap([['x:Account/set', { destroy: [oid, sid, kid] }, 'x']]);
    if (d) {
      const { ids } = await jmap([['x:DkimSignature/query', { filter: { domainId: d.id } }, 'q']]);
      if (ids.length) await jmap([['x:DkimSignature/set', { destroy: ids }, 'k']]);
      await jmap([['x:Domain/set', { destroy: [d.id] }, 'x']]);
    }
  });
  const base = `http://127.0.0.1:${app.address().port}/api/domains`;
  const as = (name) => (path = '', method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: basic(at(name), pass), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const asOwner = as(owner), asSam = as(sam), asKim = as(kim);
  const userJmap = async (name, using, methodCalls) => (await (await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: basic(at(name), pass), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', ...using], methodCalls }) })).json()).methodResponses[0][1];
  const identities = async (name, id) => (await userJmap(name, ['urn:ietf:params:jmap:submission'], [['Identity/get', { accountId: id }, 'i']])).list.map((i) => i.email).sort();
  const aliasesOn = async (id) => Object.values((await jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']])).list[0]?.aliases ?? {}).map((a) => a.name).sort();
  const claim = async () => readMeta((await domainRow()).description);
  const members = (r) => r.domain.members.map((m) => [m.account, m.email, m.enabled]);

  // The owner claims the domain as before: their own address on it, and no members.
  const verify = (await asOwner('', 'POST', { domain })).domain.records[0].value;
  dns.zone[`TXT ${domain}`] = [verify];
  const c = await asOwner('', 'POST', { domain });
  assert.deepEqual([c.domain.status, c.domain.addresses.map((a) => a.email), c.domain.members, c.domain.maxAddresses], ['active', [`${owner}@${domain}`], [], 4]);
  assert.deepEqual((await asSam()).memberOf, []);

  // 1. Who can be given an address: an existing account here, by its exact address. Only the owner may.
  const add = (account, name, call = asOwner) => call(`/${domain}/members`, 'POST', { account, name });
  for (const [account, code] of [[sam, 'bad_account'], [`${sam}@elsewhere.test`, 'bad_account'], [`${sam}@${domain}`, 'bad_account'], ['', 'bad_account'], [at(`${sam}-nobody`), 'no_such_account'], [at(owner), 'self']])
    assert.equal((await add(account, 'sam')).error?.code, code, account);
  assert.equal((await add(at(sam), 'bad..name')).error.code, 'bad_name');
  assert.equal((await add(at(sam), owner)).error.code, 'exists'); // the owner's own address there
  assert.equal((await add(at(kim), 'kim', asSam)).status, 404); // not Sam's domain
  assert.equal((await asOwner(`/${domain}/members`, 'DELETE')).status, 405);
  assert.equal((await asOwner(`/${domain}/members/sam`, 'POST', {})).status, 405);
  assert.deepEqual([await aliasesOn(sid), (await claim()).members], [[], undefined]); // nothing happened yet

  // 2. Given: an alias of the member's account. Mail lands in their mailbox, and it's in their From menu, not the owner's.
  const g = await add(at(sam).toUpperCase(), 'Sam@ignored');
  assert.equal(g.status, 200, JSON.stringify(g));
  assert.deepEqual(members(g), [[at(sam), `sam@${domain}`, true]]);
  assert.deepEqual(g.domain.addresses.map((a) => a.email), [`${owner}@${domain}`]);
  assert.deepEqual((await claim()).members, { [sid]: ['sam'] });
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
  assert.equal((await asSam('', 'POST', { domain })).error.code, 'taken');

  // 4. One name once on the domain, and one cap for all of it (4 here): the owner's addresses and the members' together.
  assert.equal((await add(at(kim), 'sam')).error.code, 'exists');
  assert.equal((await asOwner(`/${domain}/addresses`, 'POST', { name: 'sam' })).error.code, 'exists');
  assert.equal((await add(at(kim), 'kim')).status, 200);
  assert.equal((await add(at(sam), 'sales')).status, 200); // a second address for the same member
  assert.deepEqual((await claim()).members, { [sid]: ['sam', 'sales'], [kid]: ['kim'] });
  assert.equal((await add(at(kim), 'fifth')).error.code, 'too_many');
  assert.equal((await asOwner(`/${domain}/addresses`, 'POST', { name: 'fifth' })).error.code, 'too_many');
  assert.deepEqual([await aliasesOn(kid), (await claim()).members[kid]], [['kim'], ['kim']]); // a refusal leaves no trace
  const listed = (await adminDomainList(jmap)).find((d) => d.name === domain);
  assert.deepEqual([listed.owner, listed.addresses, listed.members], [at(owner), 4, 2]);
  // Kim can't touch Sam's address (and learns nothing: the same answer as for one that doesn't exist).
  assert.equal((await asKim(`/${domain}/members/sam`, 'DELETE')).error.code, 'not_found');
  assert.deepEqual(await aliasesOn(sid), ['sales', 'sam']);

  // 5. The domain pauses (TXT gone for 7 days): members' addresses stop too, and come back with it.
  delete dns.zone[`TXT ${domain}`];
  const t0 = Date.now();
  await app.domains.recheckAll(t0);
  await app.domains.recheckAll(t0 + 8 * 86400e3);
  assert.deepEqual([(await claim()).paused, (await claim()).members], [true, { [sid]: ['sam', 'sales'], [kid]: ['kim'] }]); // the re-check keeps the list
  assert.deepEqual([await rcptCode(`sam@${domain}`), await rcptCode(`kim@${domain}`)], [550, 550]);
  assert.deepEqual(await identities(sam, sid), [at(sam)]);
  assert.equal((await asSam()).memberOf.every((m) => m.enabled === false), true);
  dns.zone[`TXT ${domain}`] = [verify];
  const back = (await asOwner()).domains[0]; // "Check again"
  assert.deepEqual([back.status, back.members.every((m) => m.enabled), await rcptCode(`sam@${domain}`), await rcptCode(`kim@${domain}`)], ['active', true, 250, 250]);

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

  // 8. A member's account is deleted (account.mjs / admin.mjs call retireNames first): its address is retired and
  // it leaves the list, so a later account that gets the same id is nobody here.
  assert.equal((await add(at(kim), 'kim2')).status, 200);
  await retireNames({ cfg, jmap }, kid, kim);
  assert.deepEqual([(await claim()).members, await aliasesOn(kid), cfg.extraReserved.includes(`kim2@${domain}`), cfg.extraReserved.includes(kim)], [{ [sid]: ['sam'] }, [], true, true]);
  // …and one deleted behind our back (Stalwart's own admin): its listed address is retired the next time the list
  // is written, instead of quietly becoming free again.
  const ghost = `t-domains-${tag}-g`, gid = await mk(ghost);
  assert.equal((await add(at(ghost), 'ghost')).status, 200);
  await jmap([['x:Account/set', { destroy: [gid] }, 'x']]);
  assert.deepEqual([(await asOwner()).domains[0].members.map((m) => m.email), cfg.extraReserved.includes(`ghost@${domain}`)], [[`sam@${domain}`], false]);
  assert.equal((await add(at(sam), 'ghost')).error.code, 'retired');
  assert.equal((await add(at(sam), 'team')).status, 200);
  assert.deepEqual((await claim()).members, { [sid]: ['sam', 'team'] });

  // 9. The owner removes the domain: members' addresses go with it, retired like the owner's.
  assert.equal((await asOwner(`/${domain}`, 'DELETE')).status, 200);
  assert.deepEqual([await aliasesOn(sid), await domainRow(), (await asSam()).memberOf], [[], undefined, []]);
  for (const a of [`sam@${domain}`, `team@${domain}`, `${owner}@${domain}`]) assert.ok(cfg.extraReserved.includes(a), a);
  assert.deepEqual(await identities(sam, sid), [at(sam)]);

  // 10. The owner's account is deleted while members still have addresses: those are retired and removed at once
  // (nobody is left to manage them), and the ownerless domain is released after RELEASE_DAYS as before.
  assert.equal((await asOwner('', 'POST', { domain })).domain.status, 'active'); // claimed again (the TXT is still there)
  assert.equal((await add(at(sam), 'sam2')).status, 200);
  assert.equal(await rcptCode(`sam2@${domain}`), 250);
  await retireNames({ cfg, jmap }, oid, owner);
  const orphan = await claim();
  assert.deepEqual([orphan.owner, orphan.paused, !!orphan.orphaned, orphan.members], [null, true, true, {}]);
  assert.deepEqual([await aliasesOn(sid), await rcptCode(`sam2@${domain}`), cfg.extraReserved.includes(`sam2@${domain}`)], [[], 550, true]);
  assert.deepEqual((await asSam()).memberOf, []);
  await jmap([['x:Account/set', { destroy: [oid] }, 'x']]); // the deletion itself
  await app.domains.recheckAll(Date.now() + (RELEASE_DAYS + 1) * 86400e3);
  assert.equal(await domainRow(), undefined);
});
