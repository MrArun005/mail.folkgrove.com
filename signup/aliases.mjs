// Masked aliases: random addresses (quiet.otter.4821@domain) that deliver to your inbox and can be switched off
// one by one. Adding an address to an account needs admin rights, so the web app asks this service, which checks
// the caller's own token against Stalwart first and only ever touches the caller's account.
import { randomInt } from 'node:crypto';

const WORDS_A = 'amber brave calm clever cosy crisp dusty eager early fancy gentle glad golden happy honest humble jolly keen kind lively lucky merry mild misty noble plain proud quick quiet rapid rosy shy silent silver smart snowy sunny swift tidy vivid warm wise witty young bold bright cool fair fresh green jade lunar mellow neat olive polar royal sandy solar sturdy tame velvet wild'.split(' ');
const WORDS_B = 'otter river maple falcon harbor meadow comet pebble willow badger cedar lantern heron canyon spruce marble orchid walrus thistle beacon breeze cobalt dune ember fjord glacier grove hazel island juniper kestrel lagoon lynx moss nectar oasis panda quartz raven sparrow tiger tulip valley wren yak zephyr acorn bison cliff dolphin fern koala lotus'.split(' ');
const MASKED = 'masked: ';

export const maskedName = () => `${WORDS_A[randomInt(WORDS_A.length)]}.${WORDS_B[randomInt(WORDS_B.length)]}.${randomInt(1000, 10000)}`;

/** One alias as the app sees it; its id is the address's local part (Stalwart keeps aliases as a list, so
 *  positions shift). Only aliases this service created (description "masked: …") may be renamed or deleted. */
export function toView(a, domainName) {
  const masked = typeof a.description === 'string' && a.description.startsWith(MASKED);
  return { id: a.name, email: `${a.name}@${domainName}`, label: masked ? a.description.slice(MASKED.length) : a.description ?? '', enabled: a.enable !== false, masked };
}

export const cleanLabel = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '');

export function aliasRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter }) {
  const createLimit = new RateLimiter(cfg.aliasesPerHour ?? 30, 3600e3);
  // ponytail: changes are "read the list, patch by position", so one account's changes run one at a time.
  // Ceiling: one service instance; with replicas, two could still race (rare: same user, same instant).
  const locks = new Map();
  const serial = (id, fn) => {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    locks.set(id, run.catch(() => {}));
    run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => {});
    return run;
  };

  /** Who is calling: their own session, verified by Stalwart. Returns the account id or null. */
  async function caller(req) {
    const authz = req.headers.authorization;
    if (!authz || !/^(Bearer|Basic) /.test(authz)) return null;
    const r = await fetch(`${cfg.stalwartUrl}/jmap/session`, { headers: { Authorization: authz }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const [local, domain] = String((await r.json()).username ?? '').toLowerCase().split('@');
    if (!local || domain !== cfg.domain) return null;
    const q = await jmap([['x:Account/query', { filter: { name: local, domainId: await getDomainId() } }, 'q']]);
    return q.ids[0] ?? null;
  }
  const aliasesOf = async (id) => (await jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']])).list[0]?.aliases ?? {};
  const list = async (id) => Object.values(await aliasesOf(id)).map((a) => toView(a, cfg.domain));
  const find = async (id, name) => Object.entries(await aliasesOf(id)).find(([, a]) => a.name === name) ?? [];
  const update = async (id, patch) => {
    const r = await jmap([['x:Account/set', { update: { [id]: patch } }, 'u']]);
    if (!r.updated || !(id in r.updated)) throw Object.assign(new Error('update refused'), { detail: r.notUpdated?.[id] });
  };

  return async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/aliases(?:\/([a-z0-9.-]{1,64}))?$/);
    if (!m) return false;
    const id = await caller(req);
    if (!id) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    const key = m[1];

    if (!key && req.method === 'GET') return send(res, 200, { ok: true, aliases: await list(id) }), true;

    if (!key && req.method === 'POST') {
      const wait = createLimit.take(id);
      if (wait) return fail(res, 429, 'rate_limited', 'You’ve made a lot of addresses recently. Try again in a little while.', { retryAfter: wait }), true;
      const body = await readJson(req).catch(() => ({})); // label is optional
      const current = await aliasesOf(id);
      if (Object.keys(current).length >= (cfg.maxAliases ?? 200)) return fail(res, 409, 'too_many', 'You’ve reached the limit for addresses. Delete ones you no longer use.'), true;
      // Writing any new key appends to Stalwart's list. A name clash is very rare and Stalwart refuses duplicates: retry.
      return serial(id, async () => {
        for (let attempt = 0; ; attempt++) {
          const name = maskedName();
          try {
            await update(id, { [`aliases/${Object.keys(current).length + 1000}`]: { name, domainId: await getDomainId(), enable: true, description: MASKED + (cleanLabel(body.label) || 'Untitled') } });
            return send(res, 201, { ok: true, alias: toView((await find(id, name))[1], cfg.domain) }), true;
          } catch (e) { if (attempt === 2) throw e; }
        }
      });
    }

    if (key && (req.method === 'PATCH' || req.method === 'DELETE')) return serial(id, async () => {
      const [pos, a] = await find(id, key);
      if (!a) return fail(res, 404, 'not_found', 'That address no longer exists.'), true;
      const view = toView(a, cfg.domain);
      if (req.method === 'DELETE') {
        if (!view.masked) return fail(res, 403, 'not_masked', 'This address was set up by your administrator.'), true;
        await update(id, { [`aliases/${pos}`]: null });
        return send(res, 200, { ok: true }), true;
      }
      const body = await readJson(req).catch(() => ({})); // label is optional
      const patch = {};
      if (typeof body.enabled === 'boolean') patch[`aliases/${pos}/enable`] = body.enabled;
      if (typeof body.label === 'string' && view.masked) patch[`aliases/${pos}/description`] = MASKED + (cleanLabel(body.label) || 'Untitled');
      if (Object.keys(patch).length) await update(id, patch);
      return send(res, 200, { ok: true, alias: toView((await find(id, key))[1], cfg.domain) }), true;
    });
    return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
  };
}
