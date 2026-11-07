// Custom domains: verification logic with a fake DNS resolver, then the whole flow against the local dev Stalwart
// (claim, DKIM, addresses, mail delivered, pause after 7 days, removal, retirement). Throwaway t-domains-* accounts
// and a t-domains-*.test domain, all removed at the end. Never touches alice or bob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  const cfg = { stalwartUrl: STALWART, admin, domain: 'openmail.test', signupEnabled: false, inviteRequired: false, invites: new Invites({ text: '' }), turnstileSecret: null,
    quotaBytes: 0, signupsPerHour: 10, checksPerMinute: 10, clientIpHeader: null, extraReserved: [], allowBasicAuth: true, resolver: dns, maxDomainAddresses: 3 };
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

  // 2. TXT is live: claimed, created in Stalwart, main address added.
  dns.zone[`TXT ${domain}`] = [verify.value];
  const c = await call('', 'POST', { domain });
  assert.equal(c.status, 200);
  assert.equal(c.domain.status, 'active');
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
