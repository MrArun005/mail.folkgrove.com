// Delete my account (erasure): DELETE /api/account. Destroying an account needs admin rights, so the web app asks
// this service. The caller proves it three ways: their own sign-in token, their current password (and two-factor
// code) typed again, and their full address typed as confirmation.
//
// No address recycling, ever: Stalwart frees a destroyed account's name and its aliases at once (it would let
// anyone sign up for them a second later and receive the old owner's password resets). So before destroying, every
// name the account used goes into a retired-names file that sign-up and masked-address generation both consult.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { callerOf } from './aliases.mjs';

export const readRetired = (file) =>
  file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];

/** Never give these out again: names on DOMAIN, or full addresses on other domains (domains.mjs). */
export function retire(cfg, names) {
  if (cfg.retiredFile) appendFileSync(cfg.retiredFile, names.join('\n') + '\n');
  (cfg.extraReserved ??= []).push(...names);
}

/** Reserve every name an account uses (username + aliases) for good, before it's destroyed. Shared with admin.mjs. */
export async function retireNames({ cfg, jmap }, id, name) {
  const [acct, doms] = await Promise.all([jmap([['x:Account/get', { ids: [id], properties: ['aliases'] }, 'g']]), jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])]);
  const domainName = new Map((doms.list ?? []).map((d) => [d.id, d.name]));
  // Aliases on the user's own domains are kept as full addresses (the domain itself stays claimed: domains.mjs).
  const full = (a) => { const d = domainName.get(a.domainId); return !d || d === cfg.domain ? String(a.name).toLowerCase() : `${a.name}@${d}`.toLowerCase(); };
  const names = [...new Set([String(name).toLowerCase(), ...Object.values(acct.list?.[0]?.aliases ?? {}).map(full)])];
  retire(cfg, names);
  return names;
}

export function accountRoutes({ cfg, jmap, getDomainId, send, fail, readJson, RateLimiter, ipOf, clientIp = () => '' }) {
  const caller = callerOf({ cfg, jmap, getDomainId });
  // ponytail: retired names join extraReserved, a list scanned on every username check. Fine to ~100k names;
  // past that, a Set of squashed names in lib.mjs.
  if (!cfg.retiredFile) console.warn('account: RETIRED_FILE is not set; names of deleted accounts are only kept until restart');
  cfg.extraReserved = [...(cfg.extraReserved ?? []), ...readRetired(cfg.retiredFile)];
  const badAuth = new RateLimiter(20, 15 * 60e3); // bad tokens per network (as in aliases.mjs)
  // Wrong passwords per account (Stalwart also counts them per client address).
  const badPass = new RateLimiter(5, 3600e3);
  // The sign-in API only answers for a registered redirect address: use the web app's own (install.sh registers it).
  let redirect = null;
  const redirectUri = async () => (redirect ??= Object.keys((await jmap([['x:OAuthClient/get', { ids: null, properties: ['clientId', 'redirectUris'] }, 'o']]))
    .list.find((c) => c.clientId === 'openmail-web')?.redirectUris ?? {})[0] ?? null);

  return async function handle(req, res, url) {
    if (url.pathname !== '/api/account') return false;
    if (req.method !== 'DELETE') return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);

    const body = await readJson(req).catch(() => ({}));
    const email = `${who.name}@${cfg.domain}`;
    if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== email)
      return fail(res, 400, 'confirm_mismatch', `Type your full address, ${email}, to confirm.`, { field: 'confirm' }), true;
    if (typeof body.password !== 'string' || !body.password) return fail(res, 400, 'password_required', 'Enter your current password.', { field: 'password' }), true;
    // Counted before asking Stalwart (and refunded when the password is right), so parallel guesses can't all slip
    // in while the first is still being checked.
    const wait = badPass.take(who.id), pwin = badPass.window(who.id);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many wrong passwords. Try again in an hour.', { retryAfter: wait }), true;

    // Stalwart checks the password through its own sign-in API (what its sign-in page and our web app call), not
    // Basic auth: Basic also accepts app passwords (one sitting in a phone's mail app must not delete the account)
    // and on Stalwart 1.0 can't carry a two-factor code. Nothing is issued: we stop at the consent step.
    const query = new URLSearchParams({ response_type: 'code', client_id: 'openmail-web', redirect_uri: await redirectUri(), scope: 'openid',
      code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', state: 'delete' }).toString();
    // The real client address, so Stalwart's ban on repeated wrong passwords hits the guesser, not this service
    // (production Stalwart reads X-Forwarded-For: install.sh sets clientIpSource).
    const r = await fetch(`${cfg.stalwartUrl}/api/auth`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(clientIp(req) && { 'X-Forwarded-For': clientIp(req) }) },
      body: JSON.stringify({ type: 'authCode', accountName: email, accountSecret: body.password, query,
        ...(typeof body.code === 'string' && body.code.trim() && { mfaToken: body.code.replace(/\s/g, '') }) }) });
    if (!r.ok) return badPass.refund(who.id, pwin), fail(res, 503, 'unavailable', 'The mail server isn’t answering. Try again in a few minutes.'), true;
    const a = await r.json().catch(() => ({}));
    if (a.type === 'invalid') { // e.g. the web app's OAuth client isn't registered
      badPass.refund(who.id, pwin);
      console.error('account: Stalwart sign-in API refused the check:', a.description);
      return fail(res, 503, 'unavailable', 'Your password couldn’t be checked right now. Nothing was removed. Try again later.'), true;
    }
    if (a.type === 'mfaRequired') return badPass.refund(who.id, pwin), fail(res, 400, 'code_required', 'Enter the code from your authenticator app too.', { field: 'code' }), true;
    if (!(a.type === 'consentRequired' || a.location))
      return fail(res, 403, 'wrong_password', 'That password (or code) isn’t right.', { field: 'password' }), true;
    badPass.refund(who.id, pwin);

    // Retire first: if the destroy then fails, the names are merely reserved, never free.
    const names = await retireNames({ cfg, jmap }, who.id, who.name);

    const d = await jmap([['x:Account/set', { destroy: [who.id] }, 'x']]);
    if (!d.destroyed?.includes(who.id)) {
      console.error('account: Stalwart refused destroy:', JSON.stringify(d.notDestroyed?.[who.id]));
      return fail(res, 503, 'unavailable', 'Your account couldn’t be deleted right now. Nothing was removed. Try again later.'), true;
    }
    console.log(`account: deleted ${email} (${names.length} names retired)`);
    return send(res, 200, { ok: true }), true;
  };
}
