// Sharing a folder or delegating needs the other person's principal id (JMAP Mailbox.shareWith is keyed by it), and
// Stalwart's directory search is off for users because it would list everyone on the server. This answers for one
// exact address at a time, to signed-in users only: no more than SMTP already tells anyone about an address.
import { callerOf } from './aliases.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sharingRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter }) {
  const caller = callerOf({ cfg, jmap, getDomainId });
  const lookups = new RateLimiter(60, 3600e3); // per account per hour: enough to share, too few to crawl
  // Who each account has looked up (caller id → principal ids), kept next to RETIRED_FILE so names survive restarts.
  // ponytail: one small JSON file, rewritten on change; fine for thousands of accounts sharing now and then.
  const file = cfg.retiredFile ? join(dirname(cfg.retiredFile), 'share-lookups.json') : null;
  const found = new Map(Object.entries((() => { try { return file ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } })()).map(([k, v]) => [k, new Set(v)]));
  const remember = (caller, id) => {
    const set = found.get(caller) ?? new Set();
    if (set.has(id)) return;
    found.set(caller, set.add(id));
    if (file) try { writeFileSync(file, JSON.stringify(Object.fromEntries([...found].map(([k, v]) => [k, [...v].slice(-500)])))); } catch (e) { console.error('sharing: couldn’t save lookups:', e.message); }
  };
  return async function handle(req, res, url) {
    if (url.pathname !== '/api/principal') return false;
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    const who = await caller(req);
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    const wait = lookups.take(who.id);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many lookups. Try again later.', { retryAfter: wait }), true;
    if (url.searchParams.has('shared')) {
      // Names of the people the caller's own folders are shared with (users can't look up principals they share
      // with on Stalwart 1.0.3). Only people the caller found by exact address before: otherwise sharing a folder
      // with made-up ids would list every account on the server.
      const known = found.get(who.id) ?? new Set();
      const boxes = (await jmap([['Mailbox/get', { accountId: who.id, properties: ['shareWith'] }, 'm']], ['urn:ietf:params:jmap:mail'])).list ?? [];
      const ids = [...new Set(boxes.flatMap((b) => Object.keys(b.shareWith ?? {})))].filter((id) => known.has(id)).slice(0, 200);
      const domainId = await getDomainId();
      const list = (ids.length ? (await jmap([['x:Account/get', { ids, properties: ['emailAddress', 'description', '@type', 'domainId'] }, 'g']])).list ?? [] : [])
        .filter((a) => a['@type'] === 'User' && a.domainId === domainId);
      return send(res, 200, { ok: true, people: list.map((a) => ({ id: a.id, name: a.description || a.emailAddress, email: a.emailAddress })) }), true;
    }
    const [local, domain, extra] = String(url.searchParams.get('email') ?? '').trim().toLowerCase().split('@');
    const missing = () => fail(res, 404, 'not_found', `No one on this server has that address. Check it, or share with someone @${cfg.domain}.`);
    // ponytail: main addresses only (not aliases), users only (not groups).
    if (!local || domain !== cfg.domain || extra !== undefined || local.length > 64) return missing(), true;
    const { ids } = await jmap([['x:Account/query', { filter: { '@type': 'User', name: local, domainId: await getDomainId() } }, 'q']]);
    const a = ids.length === 1 ? (await jmap([['x:Account/get', { ids, properties: ['name', 'emailAddress', 'description'] }, 'g']])).list?.[0] : null;
    if (!a || a.name !== local) return missing(), true;
    remember(who.id, a.id);
    return send(res, 200, { ok: true, principal: { id: a.id, name: a.description || a.emailAddress, email: a.emailAddress } }), true;
  };
}
