// Your own domain ("use ann.dev with OpenMail"): /api/domains. The user proves they control the domain with a TXT
// record (openmail-verify=<token>); only then is the domain created in Stalwart (which makes its DKIM keys) and
// their address on it added as an alias of their account. Stalwart turns every alias into a sending identity, so the
// new addresses show up in Compose's From menu by themselves.
//
// State lives in Stalwart, not here: a claimed domain is an x:Domain whose description is TAG + JSON
// { owner, token, added, checked, missing, paused }. A domain still waiting for its TXT record isn't stored at all:
// its token is an HMAC of (account, domain), so the same person always sees the same record to add.
// ponytail: v1 = one owner, addresses for that owner only. Sharing a domain with other accounts (an organisation)
// would add a member list to the JSON and let the owner pick an account per address.
import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callerOf, serial } from './aliases.mjs';
import { retire } from './account.mjs';
import { sendMail } from './mailer.mjs';

const TAG = 'openmail-custom-domain ';
export const GRACE_DAYS = 7; // TXT record gone this long: addresses on the domain are paused
export const RELEASE_DAYS = 30; // paused (or its account deleted) this much longer: the domain is released for others
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const cleanDomain = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\.$/, '') : '');
const under = (d, parent) => d === parent || d.endsWith(`.${parent}`);

/** null if the user may try to add this domain, else { code, message }. `ours`: our own domains and host names. */
export function checkDomain(d, ours = []) {
  if (!DOMAIN_RE.test(d)) return { code: 'bad_domain', message: 'Enter a domain name like example.com (no https:// or slashes).' };
  if (ours.some((o) => o && under(d, o))) return { code: 'reserved', message: 'That domain can’t be added here.' };
  return null;
}

/** null if fine as the part before @, else a message. */
export function checkLocal(n) {
  if (!LOCAL_RE.test(n) || n.includes('..')) return 'Use lowercase letters, digits, dots, hyphens and underscores (not at the start or end).';
  return null;
}

export const tokenFor = (secret, accountId, domain) => createHmac('sha256', String(secret)).update(`openmail-verify\n${accountId}\n${domain}`).digest('base64url').slice(0, 32);

export const readMeta = (description) => {
  if (typeof description !== 'string' || !description.startsWith(TAG)) return null;
  try { return JSON.parse(description.slice(TAG.length)); } catch { return null; }
};
export const writeMeta = (meta) => TAG + JSON.stringify(meta);

/** Stalwart's zone text (dnsZoneFile) as rows; multi-part TXT values joined, as install.sh does. */
export function parseZone(text = '') {
  const flat = text.replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner) => inner.split(/\s+/).join(' '));
  return flat.split('\n').map((line) => {
    const [name, , type, ...rest] = line.trim().split(/\s+/);
    let value = rest.join(' ');
    if (type === 'TXT') value = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    return type ? { name: name.replace(/\.$/, ''), type, value } : null;
  }).filter(Boolean);
}

/**
 * The records the owner adds at their DNS host. DKIM comes from Stalwart's zone once the domain exists (its keys are
 * made a few seconds after the domain; with manual DNS Stalwart never rotates them, so they stay valid).
 * SPF includes our main domain's SPF, so a relay set up in install.sh is covered too.
 */
export function wantedRecords(domain, { token, mailHost, spfDomain, zone }) {
  return [
    { kind: 'verify', name: domain, type: 'TXT', value: `openmail-verify=${token}` },
    { kind: 'mx', name: domain, type: 'MX', value: `10 ${mailHost}.` },
    { kind: 'spf', name: domain, type: 'TXT', value: `v=spf1 include:${spfDomain} -all` },
    ...(zone ? parseZone(zone).filter((r) => r.type === 'TXT' && r.name.endsWith(`._domainkey.${domain}`)).map((r) => ({ kind: 'dkim', ...r })) : []),
    // ponytail: no rua= (reports would need a mailbox on the domain); p=quarantine, not reject, so other senders
    // the owner already uses (newsletters, billing tools) aren't bounced while they move over.
    { kind: 'dmarc', name: `_dmarc.${domain}`, type: 'TXT', value: 'v=DMARC1; p=quarantine' },
  ];
}

const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
const squash = (s) => s.replace(/\s+/g, '').toLowerCase();

/** Is this record live? true / false, or null when DNS didn't answer (a timeout says nothing either way). */
export async function hasRecord(dns, r) {
  try {
    if (r.type === 'MX') {
      const want = r.value.split(' ')[1].replace(/\.$/, '').toLowerCase();
      return (await dns.resolveMx(r.name)).some((m) => m.exchange.replace(/\.$/, '').toLowerCase() === want);
    }
    const txts = (await dns.resolveTxt(r.name)).map((parts) => parts.join(''));
    if (r.kind === 'spf') {
      const include = r.value.split(' ').find((p) => p.startsWith('include:'));
      // Only one SPF record counts; it may say more than ours (other senders the owner uses).
      return txts.some((t) => /^v=spf1\s/i.test(t) && t.toLowerCase().split(/\s+/).some((p) => p.replace(/^[+]/, '') === include));
    }
    if (r.kind === 'dmarc') return txts.some((t) => /^v=DMARC1\b/i.test(t.trim()));
    return txts.some((t) => squash(t) === squash(r.value)); // verify, dkim: exactly ours
  } catch (e) {
    return NOT_THERE.has(e.code) ? false : null;
  }
}

/** DNS for record checks: the system resolver, or DNS_SERVERS. Short timeouts so the Settings page stays snappy. */
export function makeResolver(servers = []) {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  if (servers.length) r.setServers(servers);
  return r;
}

/** Every claimed domain (also used by the admin console). */
export async function customDomains(jmap) {
  // ponytail: reads every domain; fine to thousands. Past that, x:Domain/query with a text filter on the tag.
  const { list } = await jmap([['x:Domain/get', { ids: null, properties: ['name', 'description'] }, 'd']]);
  return list.map((d) => ({ id: d.id, name: d.name, meta: readMeta(d.description) })).filter((d) => d.meta);
}

/** Admin console view: every custom domain with its owner (null once that account was deleted) and status. */
export async function adminDomainList(jmap) {
  const doms = await customDomains(jmap);
  const owners = [...new Set(doms.map((d) => d.meta.owner))];
  const accts = owners.length ? (await jmap([['x:Account/get', { ids: owners, properties: ['emailAddress', 'aliases'] }, 'g']])).list : [];
  const byId = new Map(accts.map((a) => [a.id, a]));
  return doms.map(({ id, name, meta }) => {
    const a = byId.get(meta.owner);
    return { name, owner: a?.emailAddress ?? null, status: meta.paused ? 'paused' : meta.missing ? 'missing' : 'active',
      added: meta.added, checked: meta.checked ?? null, missingSince: meta.missing ?? null,
      addresses: Object.values(a?.aliases ?? {}).filter((x) => x.domainId === id).length };
  });
}

/**
 * The key for verification tokens: DOMAIN_SECRET, or a random one made on first start and kept next to RETIRED_FILE.
 * Never derived from the admin password (a token in public DNS must not help anyone guess it).
 */
function domainSecret(cfg) {
  if (cfg.domainSecret) return cfg.domainSecret;
  if (!cfg.retiredFile) {
    console.warn('domains: no DOMAIN_SECRET or RETIRED_FILE; verification records change when the service restarts');
    return randomBytes(32).toString('hex');
  }
  const file = join(dirname(cfg.retiredFile), 'domain-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  return readFileSync(file, 'utf8').trim();
}

export function domainRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf }) {
  const dns = cfg.resolver ?? makeResolver(cfg.dnsServers);
  const secret = domainSecret(cfg);
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3); // as in aliases.mjs
  const lookups = new RateLimiter(cfg.domainChecksPerHour ?? 60, 3600e3); // each one is a handful of DNS queries
  const claims = new RateLimiter(cfg.domainsPerDay ?? 3, 86400e3);
  const addrLimit = new RateLimiter(cfg.aliasesPerHour ?? 30, 3600e3);
  const maxDomains = cfg.maxDomains ?? 3, maxAddresses = cfg.maxDomainAddresses ?? 10;

  // Our main domain's zone gives the mail host (its MX). Read once.
  let mailHost = null;
  const host = async () => mailHost ??= parseZone((await jmap([['x:Domain/get', { ids: [await getDomainId()], properties: ['dnsZoneFile'] }, 'z']])).list[0]?.dnsZoneFile)
    .find((r) => r.type === 'MX')?.value.split(' ')[1]?.replace(/\.$/, '') ?? `mail.${cfg.domain}`;
  const ours = async () => [cfg.domain, await host(), ...(cfg.reservedDomains ?? [])];
  const zoneOf = async (id) => (await jmap([['x:Domain/get', { ids: [id], properties: ['dnsZoneFile'] }, 'z']])).list[0]?.dnsZoneFile ?? '';
  const aliasesOf = async (id) => (await jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']])).list[0]?.aliases ?? {};
  const setAccount = async (id, patch) => {
    const r = await jmap([['x:Account/set', { update: { [id]: patch } }, 'u']]);
    if (!r.updated || !(id in r.updated)) throw Object.assign(new Error('account update refused'), { detail: r.notUpdated?.[id] });
  };
  // The account's creation time is part of the token: Stalwart may hand a deleted account's id to a new account, and
  // an old record left in DNS must never verify the newcomer's claim.
  const tokenOf = async (who, name) => {
    const at = (await jmap([['x:Account/get', { ids: [who.id], properties: ['createdAt'] }, 'c']])).list[0]?.createdAt ?? '';
    return tokenFor(secret, `${who.id}/${at}`, name);
  };
  const setMeta = (d, meta) => jmap([['x:Domain/set', { update: { [d.id]: { description: writeMeta(meta) } } }, 'm']]);
  /** Switch every address on the domain on or off (paused domains neither send nor receive). */
  const switchAll = (owner, domainId, enable) => serial(owner, async () => {
    const patch = Object.fromEntries(Object.entries(await aliasesOf(owner)).filter(([, a]) => a.domainId === domainId).map(([pos]) => [`aliases/${pos}/enable`, enable]));
    if (Object.keys(patch).length) await setAccount(owner, patch);
  });

  /**
   * Record what the verification TXT says now. Gone for GRACE_DAYS: pause the domain (addresses off) and tell the
   * owner; back again: switch them on. A DNS timeout (null) changes nothing.
   */
  async function refresh(d, found, now = Date.now()) {
    const m = { ...d.meta, checked: new Date(now).toISOString() };
    // Released for someone else: its account is gone, or the record has been missing well past the pause.
    const since = m.orphaned ?? (m.paused && m.missing ? new Date(Date.parse(m.missing) + GRACE_DAYS * 86400e3).toISOString() : null);
    if (since && now - Date.parse(since) > RELEASE_DAYS * 86400e3 && (m.orphaned || found === false)) {
      if (m.owner) await removeAddresses({ id: m.owner }, d, null);
      await destroyDomain(d);
      console.log(`domains: released ${d.name}`);
      return null;
    }
    if (found === null || m.orphaned) { if (!m.orphaned) return d.meta; await setMeta(d, m); return (d.meta = m); }
    if (found) {
      if (m.paused) await switchAll(m.owner, d.id, true);
      Object.assign(m, { missing: null, paused: false });
    } else {
      m.missing ??= m.checked;
      if (!m.paused && now - Date.parse(m.missing) > GRACE_DAYS * 86400e3) {
        await switchAll(m.owner, d.id, false);
        m.paused = true;
        await tell(m.owner, d.name).catch((e) => console.error('domains: couldn’t email the owner:', e.message));
      }
    }
    await setMeta(d, m);
    return (d.meta = m);
  }
  async function tell(owner, name) {
    if (!cfg.systemMail) return; // without system mail, Settings → Your domain shows it
    const to = (await jmap([['x:Account/get', { ids: [owner], properties: ['emailAddress'] }, 'g']])).list[0]?.emailAddress;
    if (to) await (cfg.mailer ?? sendMail)(cfg.systemMail, { from: cfg.systemMail.from, to, subject: `Addresses at ${name} are paused`,
      text: `We haven’t been able to find the openmail-verify record for ${name} for ${GRACE_DAYS} days, so mail to and from your addresses there is paused.\n\nPut the record back at your DNS host (Settings → Your domain shows it), then press “Check again”. Everything switches back on as soon as we see it.` });
  }
  /** Job (server.mjs, every 6 hours): re-check every claimed domain. */
  async function recheckAll(now = Date.now()) {
    for (const d of await customDomains(jmap)) {
      try { await refresh(d, await hasRecord(dns, { kind: 'verify', name: d.name, type: 'TXT', value: `openmail-verify=${d.meta.token}` }), now); }
      catch (e) { console.error(`domains: re-check of ${d.name} failed:`, e.message); }
    }
  }

  /** What Settings shows for one domain: its status, the records with live status, and its addresses. */
  async function view(d, who) {
    const recs = wantedRecords(d.name, { token: d.meta?.token ?? await tokenOf(who, d.name), mailHost: await host(), spfDomain: cfg.domain, zone: d.id ? await zoneOf(d.id) : '' });
    const records = await Promise.all(recs.map(async (r) => ({ ...r, ok: await hasRecord(dns, r) })));
    if (d.id) await refresh(d, records[0].ok);
    const addresses = d.id ? Object.values(await aliasesOf(who.id)).filter((a) => a.domainId === d.id)
      .map((a) => ({ name: a.name, email: `${a.name}@${d.name}`, enabled: a.enable !== false, main: a.name === who.name })) : [];
    return { name: d.name, status: !d.id ? 'pending' : d.meta.paused ? 'paused' : d.meta.missing ? 'missing' : 'active',
      missingSince: d.meta?.missing ?? null, pausesAt: d.meta?.missing && !d.meta.paused ? new Date(Date.parse(d.meta.missing) + GRACE_DAYS * 86400e3).toISOString() : null,
      dkimPending: !!d.id && !records.some((r) => r.kind === 'dkim'), records, addresses, maxAddresses };
  }

  async function addAddress(who, d, name) {
    const email = `${name}@${d.name}`;
    if ((cfg.extraReserved ?? []).includes(email)) return [409, 'retired', `${email} was used before and can’t be used again.`];
    return serial(who.id, async () => {
      const current = await aliasesOf(who.id);
      if (Object.values(current).some((a) => a.domainId === d.id && a.name === name)) return [409, 'exists', `You already have ${email}.`];
      if (Object.values(current).filter((a) => a.domainId === d.id).length >= maxAddresses) return [409, 'too_many', `You can have up to ${maxAddresses} addresses on ${d.name}.`];
      if (Object.keys(current).length >= (cfg.maxAliasesTotal ?? 1000)) return [409, 'too_many_total', 'This account has used all of its addresses. Contact support to raise the limit.'];
      await setAccount(who.id, { [`aliases/${Object.keys(current).length + 1000}`]: { name, domainId: d.id, enable: !d.meta.paused, description: `domain: ${d.name}` } });
      return null;
    });
  }

  /** Remove addresses (all of them when names is null). They're retired first, so nobody gets them later. */
  const removeAddresses = (who, d, names) => serial(who.id, async () => {
    const current = Object.values(await aliasesOf(who.id));
    const gone = current.filter((a) => a.domainId === d.id && (!names || names.includes(a.name)));
    if (!gone.length) return 0;
    retire(cfg, gone.map((a) => `${a.name}@${d.name}`));
    // The whole list is written back: positions shift when entries go, and this runs under the account's lock.
    await setAccount(who.id, { aliases: Object.fromEntries(current.filter((a) => !gone.includes(a)).map((a, i) => [String(i), a])) });
    return gone.length;
  });

  /** Its DKIM keys first (Stalwart refuses to destroy a domain they still point at), then the domain. */
  async function destroyDomain(d) {
    const keys = (await jmap([['x:DkimSignature/query', { filter: { domainId: d.id } }, 'q']])).ids;
    const own = keys.length ? (await jmap([['x:DkimSignature/get', { ids: keys, properties: ['domainId'] }, 'g']])).list.filter((k) => k.domainId === d.id).map((k) => k.id) : [];
    if (own.length) await jmap([['x:DkimSignature/set', { destroy: own }, 'k']]);
    const r = await jmap([['x:Domain/set', { destroy: [d.id] }, 'x']]);
    if (!r.destroyed?.includes(d.id)) throw Object.assign(new Error('domain destroy refused'), { detail: r.notDestroyed?.[d.id] });
  }

  const handlers = {
    'GET ': async (who) => {
      const mine = (await customDomains(jmap)).filter((d) => d.meta.owner === who.id);
      return { domains: await Promise.all(mine.map((d) => view(d, who))), maxDomains };
    },
    // Add a domain, or "Check again" while it waits for its TXT record. Claimed the moment the record is seen.
    'POST ': async (who, req) => {
      const body = await readJson(req).catch(() => ({}));
      const name = cleanDomain(body.domain);
      const bad = checkDomain(name, await ours());
      if (bad) return [400, bad.code, bad.message];
      const all = await customDomains(jmap);
      const mine = all.find((d) => d.name === name && d.meta.owner === who.id);
      if (mine) return { domain: await view(mine, who) };
      const existing = (await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.some((d) => d.name === name);
      if (existing) return [409, 'taken', 'That domain is already in use on this server.'];
      if (all.filter((d) => d.meta.owner === who.id).length >= maxDomains) return [409, 'too_many', `You can add up to ${maxDomains} domains.`];
      const pending = await view({ name }, who);
      if (!pending.records[0].ok) return { domain: pending };

      const wait = claims.take(who.id);
      if (wait) return [429, 'rate_limited', 'You’ve added a lot of domains recently. Try again tomorrow.', { retryAfter: wait }];
      const now = new Date().toISOString();
      const meta = { owner: who.id, token: await tokenOf(who, name), added: now, checked: now, missing: null, paused: false };
      const r = await jmap([['x:Domain/set', { create: { d: { name, description: writeMeta(meta) } } }, 'c']]);
      if (r.notCreated?.d?.type === 'primaryKeyViolation') return [409, 'taken', 'That domain is already in use on this server.'];
      if (!r.created?.d) throw Object.assign(new Error('domain create refused'), { detail: r.notCreated?.d });
      const d = { id: r.created.d.id, name, meta };
      console.log(`domains: ${who.name} claimed ${name}`);
      const no = await addAddress(who, d, who.name); // their own name, e.g. ann@ann.dev
      if (no && no[1] !== 'retired') throw Object.assign(new Error('main address refused'), { detail: no });
      return { domain: await view(d, who) };
    },
    'POST addresses': async (who, req, d) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().replace(/@.*$/, '') : '';
      const bad = checkLocal(name);
      if (bad) return [400, 'bad_name', bad];
      const wait = addrLimit.take(who.id);
      if (wait) return [429, 'rate_limited', 'You’ve made a lot of addresses recently. Try again in a little while.', { retryAfter: wait }];
      const no = await addAddress(who, d, name);
      return no ?? { domain: await view(d, who) };
    },
    'DELETE addresses': async (who, _req, d, name) => {
      if (name === who.name) return [400, 'main', 'This is your main address on the domain. Remove the whole domain instead.'];
      if (!(await removeAddresses(who, d, [name]))) return [404, 'not_found', 'That address no longer exists.'];
      return { domain: await view(d, who) };
    },
    'DELETE domain': async (who, _req, d) => {
      await removeAddresses(who, d, null);
      await destroyDomain(d);
      console.log(`domains: ${who.name} removed ${d.name}`);
      return {};
    },
  };

  const handle = async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/domains(?:\/([a-z0-9.-]{1,253})(?:\/addresses(?:\/([a-z0-9._-]{1,64}))?)?)?$/);
    if (!m) return false;
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);

    const sub = !m[1] ? '' : url.pathname.includes('/addresses') ? 'addresses' : 'domain';
    const key = `${req.method} ${sub}`;
    const fn = handlers[key];
    if (!fn || (sub === 'addresses' && (req.method === 'DELETE') !== !!m[2])) return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    if (!sub || key === 'POST ') {
      const wait = lookups.take(who.id);
      if (wait) return fail(res, 429, 'rate_limited', 'That’s a lot of checks. DNS changes take a while to show up anyway: try again in a few minutes.', { retryAfter: wait }), true;
    }
    let d;
    if (sub) {
      d = (await customDomains(jmap)).find((x) => x.name === m[1] && x.meta.owner === who.id);
      if (!d) return fail(res, 404, 'not_found', 'That domain isn’t on your account.'), true;
    }
    let out;
    try { out = await fn(who, req, d, m[2]); }
    catch (e) {
      console.error(`domains: ${key} by ${who.name} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : '');
      return fail(res, 502, 'stalwart_refused', 'The mail server refused that change. Try again in a few minutes.'), true;
    }
    if (Array.isArray(out)) return fail(res, out[0], out[1], out[2], out[3]), true;
    return send(res, 200, { ok: true, ...out }), true;
  };
  return Object.assign(handle, { recheckAll, refresh });
}
