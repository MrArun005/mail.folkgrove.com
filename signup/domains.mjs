// Your own domain ("use ann.dev with OpenMail"): /api/domains. The user proves they control the domain with a TXT
// record (openmail-verify=<token>); only then is the domain created in Stalwart (which makes its DKIM keys) and
// their address on it added as an alias of their account. Stalwart turns every alias into a sending identity, so the
// new addresses show up in Compose's From menu by themselves.
//
// State lives in Stalwart, not here: a claimed domain is an x:Domain whose description is TAG + JSON
// { owner, token, added, checked, missing, paused, members }. A domain still waiting for its TXT record is only in
// PENDING_DOMAINS_FILE ({ <account id>: { <domain>: token } }), so it is still listed after a restart; its token is an
// HMAC of (account, domain), so the same person always sees the same record to add.
//
// Shared (organisation) domains: the owner can give addresses on the domain to other accounts on this server
// ("members"). Such an address is an alias of the member's account, so its mail lands in their mailbox and it shows
// up in their From menu like any other alias. The claim keeps the list: members = { <account id>: [local parts] }.
// It lives in the claim, next to the owner, because that is the one record every path that ends a domain already
// reads (removal, pause, release, the owner's account being deleted), so none of them can forget the members.
// The aliases on the members' accounts are what actually exists; the list says where to look and what was given
// out. A listed address that is no longer on its account (the account was deleted behind our back, in Stalwart's
// own admin) is retired the next time the list is written, so it still can't be handed to someone else.
// What a member can do: use the address, see who gave it to them, and give it up. Nothing else: the domain, its
// records and its other addresses are the owner's.
// ponytail: one owner per domain, and no invitation step: the owner adds an address to an account and it is there
// (the member can remove it). Co-owners and "accept first" would be more fields in the claim.
import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const sameAddress = (a, b) => a.id === b.id && a.name === b.name;

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
  const ids = [...new Set(doms.flatMap((d) => [d.meta.owner, ...Object.keys(d.meta.members ?? {})]).filter(Boolean))];
  const accts = ids.length ? (await jmap([['x:Account/get', { ids, properties: ['emailAddress', 'aliases'] }, 'g']])).list : [];
  const byId = new Map(accts.map((a) => [a.id, a]));
  const on = (accountId, domainId) => Object.values(byId.get(accountId)?.aliases ?? {}).filter((x) => x.domainId === domainId).length;
  return doms.map(({ id, name, meta }) => {
    // addresses: the owner's and the members' together; members: other accounts that have one.
    const members = Object.keys(meta.members ?? {}).filter((m) => on(m, id) > 0);
    return { name, owner: byId.get(meta.owner)?.emailAddress ?? null, status: meta.paused ? 'paused' : meta.missing ? 'missing' : 'active',
      added: meta.added, checked: meta.checked ?? null, missingSince: meta.missing ?? null,
      addresses: on(meta.owner, id) + members.reduce((n, m) => n + on(m, id), 0), members: members.length };
  });
}

const aliasesOf = async (jmap, id) => (await jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']])).list[0]?.aliases ?? {};
const setAccount = async (jmap, id, patch) => {
  const r = await jmap([['x:Account/set', { update: { [id]: patch } }, 'u']]);
  if (!r.updated || !(id in r.updated)) throw Object.assign(new Error('account update refused'), { detail: r.notUpdated?.[id] });
};
// The claim is one string, rewritten whole. Whoever changes it holds the domain's lock and starts from what
// Stalwart has now, so a status re-check and a member change can't overwrite each other.
// Lock order: the domain first, then an account (aliases.mjs `serial`). Never call these while holding the lock.
const lockDomain = (d, fn) => serial(`domain:${d.id}`, fn);
const claimOf = async (jmap, d) => readMeta((await jmap([['x:Domain/get', { ids: [d.id], properties: ['description'] }, 'm']])).list[0]?.description) ?? d.meta;
const putClaim = (jmap, d, meta) => jmap([['x:Domain/set', { update: { [d.id]: { description: writeMeta(meta) } } }, 'm']]).then(() => (d.meta = meta));
/** Change a domain's claim: `change` is the fields to set, or a function of the claim as it is now. */
export const updateClaim = (jmap, d, change) => lockDomain(d, async () => {
  const cur = await claimOf(jmap, d);
  return putClaim(jmap, d, typeof change === 'function' ? change(cur) : { ...cur, ...change });
});

/** Members' addresses that really exist: [{ id, account, name, enabled }] (id: the member's account). */
export async function memberAddresses(jmap, d, meta = d.meta) {
  const listed = meta.members ?? {}, ids = Object.keys(listed);
  if (!ids.length) return [];
  const accts = (await jmap([['x:Account/get', { ids, properties: ['emailAddress', 'aliases'] }, 'g']])).list;
  return accts.flatMap((a) => Object.values(a.aliases ?? {}).filter((x) => x.domainId === d.id && listed[a.id].includes(x.name))
    .map((x) => ({ id: a.id, account: a.emailAddress, name: x.name, enabled: x.enable !== false })));
}
const asList = (addresses) => addresses.reduce((m, x) => ({ ...m, [x.id]: [...(m[x.id] ?? []), x.name] }), {});
const retireNew = (cfg, names) => { const fresh = names.filter((n) => !cfg.extraReserved?.includes(n)); if (fresh.length) retire(cfg, fresh); };

/** Take addresses on this domain off one account (all of them when names is null). Retired first, so nobody gets them later. */
export const removeAddresses = ({ cfg, jmap }, accountId, d, names) => serial(accountId, async () => {
  const current = Object.values(await aliasesOf(jmap, accountId));
  const gone = current.filter((a) => a.domainId === d.id && (!names || names.includes(a.name)));
  if (!gone.length) return 0;
  retireNew(cfg, gone.map((a) => `${a.name}@${d.name}`));
  // The whole list is written back: positions shift when entries go, and this runs under the account's lock.
  await setAccount(jmap, accountId, { aliases: Object.fromEntries(current.filter((a) => !gone.includes(a)).map((a, i) => [String(i), a])) });
  return gone.length;
});

/**
 * Under the domain's lock, before the member list is rewritten: the claim as it is now and the members' addresses
 * that really exist. Listed ones that are no longer on their account are retired here (see the top of this file).
 */
async function membersNow({ cfg, jmap }, d) {
  const meta = await claimOf(jmap, d);
  const real = await memberAddresses(jmap, d, meta);
  retireNew(cfg, Object.entries(meta.members ?? {}).flatMap(([id, names]) => names.filter((name) => !real.some((x) => sameAddress(x, { id, name }))).map((name) => `${name}@${d.name}`)));
  return { meta, real };
}

/**
 * Take members' addresses off their accounts and out of the claim: those `pick` chooses, or all of them. Retired
 * like every removed address, never recycled. The aliases go first and the claim second: stopping halfway leaves a
 * listed address that no longer exists (retired again next time), never an address nobody knows about.
 * Used when the owner or the member removes one, when the domain is removed or released, and by account.mjs when
 * the owner's or a member's account is deleted. Resolves to how many went.
 */
export const removeMembers = ({ cfg, jmap }, d, pick = null) => lockDomain(d, async () => {
  const { meta, real } = await membersNow({ cfg, jmap }, d);
  const gone = pick ? real.filter(pick) : real;
  for (const id of new Set(gone.map((x) => x.id))) await removeAddresses({ cfg, jmap }, id, d, gone.filter((x) => x.id === id).map((x) => x.name));
  await putClaim(jmap, d, { ...meta, members: asList(real.filter((x) => !gone.includes(x))) });
  return gone.length;
});

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
  const ctx = { cfg, jmap };
  // The account's creation time is part of the token: Stalwart may hand a deleted account's id to a new account, and
  // an old record left in DNS must never verify the newcomer's claim.
  const tokenOf = async (who, name) => {
    const at = (await jmap([['x:Account/get', { ids: [who.id], properties: ['createdAt'] }, 'c']])).list[0]?.createdAt ?? '';
    return tokenFor(secret, `${who.id}/${at}`, name);
  };
  // Domains added but not verified yet. An entry whose token no longer matches (the account id was reused) is ignored.
  // ponytail: whole file rewritten on every change; at most maxDomains entries per account.
  const pendingFile = cfg.pendingDomainsFile;
  if (!pendingFile) console.warn('domains: PENDING_DOMAINS_FILE is not set; domains waiting for verification are only kept until restart');
  const pending = pendingFile && existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : {};
  const setPending = (who, name, token) => {
    const p = { ...pending[who.id] };
    if (token) p[name] = token; else delete p[name];
    if (Object.keys(p).length) pending[who.id] = p; else delete pending[who.id];
    if (pendingFile) { writeFileSync(pendingFile + '.tmp', JSON.stringify(pending)); renameSync(pendingFile + '.tmp', pendingFile); }
  };
  const pendingOf = async (who) => {
    const out = [];
    for (const [name, token] of Object.entries(pending[who.id] ?? {})) if (token === await tokenOf(who, name)) out.push(name);
    return out;
  };
  /** Switch every address on the domain on or off, the members' too (paused domains neither send nor receive). */
  const switchAll = async (d, enable) => {
    const members = await memberAddresses(jmap, d, await claimOf(jmap, d));
    for (const id of new Set([d.meta.owner, ...members.map((x) => x.id)])) await serial(id, async () => {
      const mine = (a) => a.domainId === d.id && (id === d.meta.owner || members.some((x) => sameAddress(x, { id, name: a.name })));
      const patch = Object.fromEntries(Object.entries(await aliasesOf(jmap, id)).filter(([, a]) => mine(a)).map(([pos]) => [`aliases/${pos}/enable`, enable]));
      if (Object.keys(patch).length) await setAccount(jmap, id, patch);
    });
  };

  /**
   * Record what the verification TXT says now. Gone for GRACE_DAYS: pause the domain (addresses off) and tell the
   * owner; back again: switch them on. A DNS timeout (null) changes nothing.
   */
  async function refresh(d, found, now = Date.now()) {
    const m = { ...d.meta, checked: new Date(now).toISOString() };
    // Released for someone else: its account is gone, or the record has been missing well past the pause.
    const since = m.orphaned ?? (m.paused && m.missing ? new Date(Date.parse(m.missing) + GRACE_DAYS * 86400e3).toISOString() : null);
    if (since && now - Date.parse(since) > RELEASE_DAYS * 86400e3 && (m.orphaned || found === false)) {
      await removeMembers(ctx, d); // members' addresses first: retired with the owner's, nothing left pointing at the domain
      if (m.owner) await removeAddresses(ctx, m.owner, d, null);
      await destroyDomain(d);
      console.log(`domains: released ${d.name}`);
      return null;
    }
    // Only the fields this check owns are written, over the claim as it is now (updateClaim): the member list in
    // `m` may be a moment old.
    if (found === null || m.orphaned) return m.orphaned ? updateClaim(jmap, d, { checked: m.checked }) : d.meta;
    if (found) {
      if (m.paused) await switchAll(d, true);
      Object.assign(m, { missing: null, paused: false });
    } else {
      m.missing ??= m.checked;
      if (!m.paused && now - Date.parse(m.missing) > GRACE_DAYS * 86400e3) {
        await switchAll(d, false);
        m.paused = true;
        await tell(m.owner, d.name).catch((e) => console.error('domains: couldn’t email the owner:', e.message));
      }
    }
    return updateClaim(jmap, d, { checked: m.checked, missing: m.missing, paused: m.paused });
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

  /** What Settings shows the owner for one domain: its status, the records with live status, and its addresses. */
  async function view(d, who) {
    const recs = wantedRecords(d.name, { token: d.meta?.token ?? await tokenOf(who, d.name), mailHost: await host(), spfDomain: cfg.domain, zone: d.id ? await zoneOf(d.id) : '' });
    const records = await Promise.all(recs.map(async (r) => ({ ...r, ok: await hasRecord(dns, r) })));
    if (d.id) await refresh(d, records[0].ok);
    const addresses = d.id ? Object.values(await aliasesOf(jmap, who.id)).filter((a) => a.domainId === d.id)
      .map((a) => ({ name: a.name, email: `${a.name}@${d.name}`, enabled: a.enable !== false, main: a.name === who.name })) : [];
    // Addresses given to other accounts. maxAddresses is for the domain: the owner's and the members' together.
    const members = d.id ? (await memberAddresses(jmap, d)).map((x) => ({ account: x.account, name: x.name, email: `${x.name}@${d.name}`, enabled: x.enabled })) : [];
    return { name: d.name, status: !d.id ? 'pending' : d.meta.paused ? 'paused' : d.meta.missing ? 'missing' : 'active',
      missingSince: d.meta?.missing ?? null, pausesAt: d.meta?.missing && !d.meta.paused ? new Date(Date.parse(d.meta.missing) + GRACE_DAYS * 86400e3).toISOString() : null,
      dkimPending: !!d.id && !records.some((r) => r.kind === 'dkim'), records, addresses, members, maxAddresses };
  }

  /**
   * Add name@domain as an alias of `to`: the owner's own account, or a member's (then the claim lists it first, so
   * an address can never exist that the claim doesn't know about). One cap for the whole domain, and no name twice.
   */
  const addAddress = (who, d, name, to = who.id) => {
    const email = `${name}@${d.name}`;
    return lockDomain(d, async () => {
      const { meta, real: members } = await membersNow(ctx, d);
      if ((cfg.extraReserved ?? []).includes(email)) return [409, 'retired', `${email} was used before and can’t be used again.`];
      const own = Object.values(await aliasesOf(jmap, who.id)).filter((a) => a.domainId === d.id);
      if (own.some((a) => a.name === name)) return [409, 'exists', `You already have ${email}.`];
      if (members.some((x) => x.name === name)) return [409, 'exists', `${email} already belongs to ${members.find((x) => x.name === name).account}.`];
      if (own.length + members.length >= maxAddresses) return [409, 'too_many', `You can have up to ${maxAddresses} addresses on ${d.name}.`];
      const listed = asList(members);
      if (to !== who.id) await putClaim(jmap, d, { ...meta, members: asList([...members, { id: to, name }]) });
      let no;
      try {
        no = await serial(to, async () => {
          const current = await aliasesOf(jmap, to);
          if (Object.keys(current).length >= (cfg.maxAliasesTotal ?? 1000)) return [409, 'too_many_total', `${to === who.id ? 'This' : 'That'} account has used all of its addresses. Contact support to raise the limit.`];
          await setAccount(jmap, to, { [`aliases/${Object.keys(current).length + 1000}`]: { name, domainId: d.id, enable: !meta.paused, description: `domain: ${d.name}` } });
          return null;
        });
      } catch (e) { no = e; }
      if (no && to !== who.id) await putClaim(jmap, d, { ...meta, members: listed }).catch(() => {}); // not given after all
      if (no instanceof Error) throw no;
      return no;
    });
  };

  /** The account on our own domain with exactly this address, for the owner to give an address to. */
  async function memberAccount(address) {
    const [local, domain, extra] = address.split('@');
    if (!local || domain !== cfg.domain || extra !== undefined || local.length > 64) return [400, 'bad_account', `Enter their full address here, like sam@${cfg.domain}.`];
    const { ids } = await jmap([['x:Account/query', { filter: { '@type': 'User', name: local, domainId: await getDomainId() } }, 'q']]);
    const [a] = ids.length === 1 ? (await jmap([['x:Account/get', { ids, properties: ['name', 'roles'] }, 'g']])).list : [];
    if (!a || String(a.name).toLowerCase() !== local) return [404, 'no_such_account', `There’s no account ${address} on this server.`];
    // Server administrators (a Stalwart role other than User) are managed in Stalwart's own admin, as in admin.mjs.
    if (a.roles?.['@type'] !== 'User') return [403, 'protected', 'That account can’t be given addresses here.'];
    return a.id;
  }

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
      const all = await customDomains(jmap);
      const mine = all.filter((d) => d.meta.owner === who.id);
      // Addresses the caller was given on other people's domains: what it is, who gave it, nothing about the domain.
      const given = all.filter((d) => d.meta.members?.[who.id]);
      const theirs = given.length ? await aliasesOf(jmap, who.id) : {};
      const owners = new Map(given.length ? (await jmap([['x:Account/get', { ids: [...new Set(given.map((d) => d.meta.owner).filter(Boolean))], properties: ['emailAddress'] }, 'o']])).list.map((a) => [a.id, a.emailAddress]) : []);
      const memberOf = given.flatMap((d) => Object.values(theirs).filter((a) => a.domainId === d.id && d.meta.members[who.id].includes(a.name))
        .map((a) => ({ domain: d.name, name: a.name, email: `${a.name}@${d.name}`, enabled: a.enable !== false, owner: owners.get(d.meta.owner) ?? null })));
      const waiting = (await pendingOf(who)).filter((name) => !mine.some((d) => d.name === name));
      return { domains: await Promise.all([...mine.map((d) => view(d, who)), ...waiting.map((name) => view({ name }, who))]), maxDomains, memberOf };
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
      const waiting = (await pendingOf(who)).filter((n) => n !== name);
      if (all.filter((d) => d.meta.owner === who.id).length + waiting.length >= maxDomains) return [409, 'too_many', `You can add up to ${maxDomains} domains.`];
      const token = await tokenOf(who, name);
      const unverified = await view({ name, meta: { token } }, who);
      if (!unverified.records[0].ok) {
        if (pending[who.id]?.[name] !== token) setPending(who, name, token);
        return { domain: unverified };
      }

      const wait = claims.take(who.id);
      if (wait) return [429, 'rate_limited', 'You’ve added a lot of domains recently. Try again tomorrow.', { retryAfter: wait }];
      const now = new Date().toISOString();
      const meta = { owner: who.id, token, added: now, checked: now, missing: null, paused: false };
      const r = await jmap([['x:Domain/set', { create: { d: { name, description: writeMeta(meta) } } }, 'c']]);
      if (r.notCreated?.d?.type === 'primaryKeyViolation') return [409, 'taken', 'That domain is already in use on this server.'];
      if (!r.created?.d) throw Object.assign(new Error('domain create refused'), { detail: r.notCreated?.d });
      const d = { id: r.created.d.id, name, meta };
      if (pending[who.id]?.[name]) setPending(who, name, null);
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
      if (!(await removeAddresses(ctx, who.id, d, [name]))) return [404, 'not_found', 'That address no longer exists.'];
      return { domain: await view(d, who) };
    },
    // Give an address on the domain to another account on this server: { account: "sam@DOMAIN", name: "sam" }.
    'POST members': async (who, req, d) => {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().replace(/@.*$/, '') : '';
      const bad = checkLocal(name);
      if (bad) return [400, 'bad_name', bad];
      // The same budget as the owner's own addresses; it also keeps this from being a fast way to test which accounts exist.
      const wait = addrLimit.take(who.id);
      if (wait) return [429, 'rate_limited', 'You’ve made a lot of addresses recently. Try again in a little while.', { retryAfter: wait }];
      const to = await memberAccount(typeof body.account === 'string' ? body.account.trim().toLowerCase() : '');
      if (Array.isArray(to)) return to;
      if (to === who.id) return [400, 'self', 'That’s your own account. Add the address for yourself instead.'];
      const no = await addAddress(who, d, name, to);
      if (!no) console.log(`domains: ${who.name} gave ${name}@${d.name} to account ${to}`);
      return no ?? { domain: await view(d, who) };
    },
    // The owner takes a member's address back, or a member gives up their own. Retired either way.
    'DELETE members': async (who, _req, d, name) => {
      const owner = d.meta.owner === who.id;
      if (!(await removeMembers(ctx, d, (x) => x.name === name && (owner || x.id === who.id)))) return [404, 'not_found', 'That address no longer exists.'];
      return owner ? { domain: await view(d, who) } : {};
    },
    'DELETE domain': async (who, _req, d) => {
      await removeMembers(ctx, d); // members' addresses are retired with the owner's
      await removeAddresses(ctx, who.id, d, null);
      await destroyDomain(d);
      console.log(`domains: ${who.name} removed ${d.name}`);
      return {};
    },
  };

  const handle = async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/domains(?:\/([a-z0-9.-]{1,253})(?:\/(addresses|members)(?:\/([a-z0-9._-]{1,64}))?)?)?$/);
    if (!m) return false;
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);

    const sub = !m[1] ? '' : m[2] ?? 'domain';
    const key = `${req.method} ${sub}`;
    const fn = handlers[key];
    if (!fn || (m[2] && (req.method === 'DELETE') !== !!m[3])) return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    if (!sub || key === 'POST ') {
      const wait = lookups.take(who.id);
      if (wait) return fail(res, 429, 'rate_limited', 'That’s a lot of checks. DNS changes take a while to show up anyway: try again in a few minutes.', { retryAfter: wait }), true;
    }
    let d;
    if (sub) {
      // The owner manages the domain. A member gets one thing: giving up their own address (DELETE members).
      d = (await customDomains(jmap)).find((x) => x.name === m[1] && (x.meta.owner === who.id || (key === 'DELETE members' && x.meta.members?.[who.id])));
      if (!d && key === 'DELETE domain' && pending[who.id]?.[m[1]]) return setPending(who, m[1], null), send(res, 200, { ok: true }), true;
      if (!d) return fail(res, 404, 'not_found', 'That domain isn’t on your account.'), true;
    }
    let out;
    try { out = await fn(who, req, d, m[3]); }
    catch (e) {
      console.error(`domains: ${key} by ${who.name} failed:`, e.message, e.detail ? JSON.stringify(e.detail) : '');
      return fail(res, 502, 'stalwart_refused', 'The mail server refused that change. Try again in a few minutes.'), true;
    }
    if (Array.isArray(out)) return fail(res, out[0], out[1], out[2], out[3]), true;
    return send(res, 200, { ok: true, ...out }), true;
  };
  return Object.assign(handle, { recheckAll, refresh });
}

/**
 * An account is about to be deleted (account.mjs retireNames, before the destroy): nothing of its domains may be
 * left dangling. Its own domains lose their owner (paused, released after RELEASE_DAYS) and every member's address
 * on them is retired and taken off the member's account now: nobody is left to manage them. Where it was a member,
 * its addresses are retired and it leaves the claim: account ids can come back, and a later account with the same
 * id must never be taken for a member.
 */
export async function domainsOfDeleted({ cfg, jmap }, id, now = new Date().toISOString()) {
  for (const d of await customDomains(jmap)) {
    if (d.meta.owner === id) {
      await removeMembers({ cfg, jmap }, d);
      await updateClaim(jmap, d, (m) => ({ ...m, owner: null, orphaned: now, paused: true, members: {} }));
    } else if (d.meta.members?.[id]) await removeMembers({ cfg, jmap }, d, (x) => x.id === id);
  }
}
