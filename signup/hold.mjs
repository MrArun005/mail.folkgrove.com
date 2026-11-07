// Outgoing spam held for review. Stalwart calls POST /internal/outbound-hook (an MTA hook, x:MtaHook, at the DATA
// stage) for every message a signed-in user sends, by SMTP or the web app. We score it with Stalwart's own spam
// filter (the ClassifySpam action). Likely spam is refused with "held for review" and kept here; an admin releases it
// (we send it on, as is) or deletes it in the console. Several held messages at once pause the sender's sending.
//
// Why not Stalwart's own verdict: its spam filter runs after MTA hooks, and its X-Spam-Status header never reaches a
// hook; a DATA-stage Sieve script didn't run on 1.0.3; queue routing can't tell one message from another (PLAN.md).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { sendRaw } from './mailer.mjs';
import { withPerms } from './admin.mjs';
import { SEND } from './abuse.mjs';

// The standard anti-spam test string (SpamAssassin, Rspamd): always held, so the hold can be tested end to end.
const GTUBE = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X';
// ClassifySpam scores a message as if it came in from outside: no SPF/DKIM/DMARC result, no Received header, an
// EHLO name, the client's network. Those tags say nothing about mail a signed-in user submits (and .test domains
// always trip FROM_INVALID), so only tags about the message itself count. Its tags' "reject" dispositions are
// ignored too: ClassifySpam reports them for unscored markers (X_HDR_*, SOURCE_ASN_*) that the real filter doesn't act on.
const CONTEXT_TAG = /^(AUTH_|DMARC_|SPF_|R_SPF|DKIM|ARC_|HELO_|RCVD_|MID_RHS_|SOURCE_|ENV_FROM_INVALID$|FROM_INVALID$|X_HDR_)/;
const ACCEPT = { action: 'accept' };
// The sender sees this (mail app error or bounce; web app error). Plain ASCII: it goes into an SMTP reply.
const HELD = 'This message looks like spam, so it is held for review. An administrator will send it or delete it. You do not need to send it again.';

/** The message as Stalwart hands it to a hook: headers ([name, " value\r\n"]) plus the body. */
export const rawOf = (m) => m.headers.map(([n, v]) => `${n}:${v}`).join('') + '\r\n' + m.contents;
const header = (m, name) => m.headers.find(([n]) => n.toLowerCase() === name)?.[1].trim() ?? '';
/** The address in a From/Sender value ("Ann <ann@x.org>" or "ann@x.org"); the first one if there are several. */
export const addressOf = (v) => (/<([^<>@\s]+@[^<>\s]+)>/.exec(v)?.[1] ?? /[^\s<>,;:"]+@[^\s<>,;:"]+/.exec(v)?.[0] ?? '').toLowerCase();

/** Score from ClassifySpam's tags, counting only tags about the content; reasons = the tags that added to it. */
export function outboundScore(tags = {}) {
  const own = Object.entries(tags).filter(([name, t]) => !CONTEXT_TAG.test(name) && t.score);
  const score = Math.round(own.reduce((s, [, t]) => s + t.score, 0) * 100) / 100;
  return { score, reasons: own.sort((a, b) => b[1].score - a[1].score).filter(([, t]) => t.score > 0).map(([n]) => n) };
}

/** Held messages: <id>.json (who, to whom, why) next to <id>.eml (the message). In memory when there's no dir. */
// ponytail: one pair of files per message, listed by reading every .json. Fine for hundreds; a table if it grows.
export function holdStore(dir) {
  const mem = new Map();
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    list: () => dir
      ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      : [...mem.values()].map(({ raw, ...meta }) => meta),
    put(meta, raw) {
      if (!dir) return mem.set(meta.id, { ...meta, raw });
      writeFileSync(join(dir, `${meta.id}.eml`), raw, { mode: 0o600 });
      writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(meta), { mode: 0o600 }); // last: listed only when complete
    },
    raw: (id) => dir ? readFileSync(join(dir, `${id}.eml`), 'utf8') : mem.get(id)?.raw,
    remove(id) {
      if (!dir) return mem.delete(id);
      const had = readdirSync(dir).includes(`${id}.json`);
      for (const ext of ['json', 'eml']) rmSync(join(dir, `${id}.${ext}`), { force: true });
      return had;
    },
  };
}

/**
 * The hook endpoint plus what the admin console needs (list, release, remove). Null when HOLD_HOOK_SECRET isn't set.
 * cfg.hold: { secret, dir, score, suspendAfter, smtp: { host, port, servername?, insecure? } }
 */
export function holdRoutes({ cfg, jmap, getDomainId, send, fail, readJson, abuse = null }) {
  const h = cfg.hold;
  if (!h?.secret) return null;
  const store = holdStore(h.dir);
  const digest = (s) => createHash('sha256').update(s).digest();
  const want = digest(`Bearer ${h.secret}`);
  const ids = /^[A-Za-z0-9_-]{1,64}$/;

  async function verdict(body, raw) {
    if (raw.includes(GTUBE)) return { score: 1000, reasons: ['GTUBE'] };
    const c = body.context ?? {};
    const r = await jmap([['x:Action/set', { create: { c: {
      '@type': 'ClassifySpam', message: raw, authenticatedAs: c.sasl.login, mailFrom: body.envelope.from.address,
      rcptTo: Object.fromEntries(body.envelope.to.map((t) => [t.address, true])), remoteIp: c.client?.ip || '127.0.0.1',
      ehloDomain: c.client?.helo || 'localhost', isTls: !!c.tls,
    } } }, 'a']]);
    if (!r.created?.c) throw Object.assign(new Error('ClassifySpam refused'), { detail: r.notCreated?.c });
    return outboundScore(r.created.c.tags);
  }

  // Pause sending for someone with several messages waiting for review (until an admin lets them send again).
  async function maybeSuspend(login) {
    const waiting = store.list().filter((m) => m.login === login).length;
    if (waiting < h.suspendAfter) return false;
    const [local, domain] = login.toLowerCase().split('@');
    if (domain && domain !== cfg.domain) return false;
    const { ids: [id] } = await jmap([['x:Account/query', { filter: { name: local, domainId: await getDomainId() } }, 'q']]);
    const a = id && (await jmap([['x:Account/get', { ids: [id], properties: ['name', 'emailAddress', 'roles', 'permissions'] }, 'g']])).list[0];
    if (!a || a.roles?.['@type'] !== 'User' || (cfg.admins ?? []).includes(local)) return false; // never admins
    // Through the sending block (abuse.mjs) so it's listed with its reason; "spam hold" as the one who did it means
    // the person can't lift it themselves, only an admin.
    if (abuse) return abuse.suspendAccount(a, `${waiting} messages were held as likely spam.`, 'spam hold');
    const r = await jmap([['x:Account/set', { update: { [id]: { permissions: withPerms(a.permissions, SEND, false) } } }, 'u']]);
    if (!r.updated || !(id in r.updated)) throw Object.assign(new Error('pausing sending refused'), { detail: r.notUpdated?.[id] });
    console.log(`hold: paused sending for ${login} (${waiting} messages held)`);
    return true;
  }

  // ── Who may appear in From ──
  let domainNames = null; // domain id → name (custom domains included); refreshed when an unknown id turns up
  const domainName = async (id) => {
    if (!domainNames?.has(id)) domainNames = new Map((await jmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.map((d) => [d.id, d.name]));
    return domainNames.get(id);
  };
  const addressesOf = async (a) => [a.emailAddress, ...await Promise.all(Object.values(a.aliases ?? {}).filter((x) => x.enable !== false)
    .map(async (x) => `${x.name}@${await domainName(x.domainId)}`))].map((x) => String(x).toLowerCase());
  const accountByAddress = async (addr) => {
    const [local, domain] = addr.split('@');
    const domId = domain === cfg.domain ? await getDomainId() : null;
    if (!domId) return null;
    const { ids } = await jmap([['x:Account/query', { filter: { name: local, domainId: domId } }, 'q']]);
    return ids.length === 1 ? (await jmap([['x:Account/get', { ids, properties: ['name', 'emailAddress', 'aliases', 'memberGroupIds'] }, 'g']])).list[0] : null;
  };
  async function mayUseFrom(login, from, sender) {
    if (!from) return false;
    const me = await accountByAddress(login.includes('@') ? login.toLowerCase() : `${login.toLowerCase()}@${cfg.domain}`);
    if (!me) return false;
    const mine = await addressesOf(me);
    if (mine.includes(from)) return true;
    const groups = Object.keys(me.memberGroupIds ?? {});
    if (groups.length) for (const g of (await jmap([['x:Account/get', { ids: groups, properties: ['emailAddress', 'aliases'] }, 'g']])).list)
      if ((await addressesOf(g)).includes(from)) return true;
    // Delegation: the owner shared their Inbox with you with maySubmit, and Sender: is one of your addresses.
    if (!mine.includes(sender)) return false;
    const owner = await accountByAddress(from);
    if (!owner) return false;
    const boxes = (await jmap([['Mailbox/get', { accountId: owner.id, properties: ['role', 'shareWith'] }, 'm']], ['urn:ietf:params:jmap:mail'])).list ?? [];
    return !!boxes.find((b) => b.role === 'inbox')?.shareWith?.[me.id]?.maySubmit;
  }

  async function hook(req, res) {
    const auth = String(req.headers.authorization ?? '');
    if (!timingSafeEqual(digest(auth), want)) return fail(res, 401, 'unauthorized', 'Wrong hook secret.');
    let body;
    try { body = await readJson(req, 50 * 1024 ** 2); } catch (status) {
      // Too big to scan (it would fill memory): refused, not sent unchecked. Big files go as links (files.mjs).
      if (status === 413) return send(res, 200, { action: 'reject', response: { status: 552, enhancedStatus: '5.3.4',
        message: '5.3.4 Messages over 50 MB can’t be sent. Share big files as a link instead (OpenMail offers this when you attach them).' } });
      return fail(res, 400, 'bad_json', 'Not a hook request.');
    }
    const login = body.context?.sasl?.login;
    // Only signed-in senders; the admin login is how released mail goes back out (install.sh lets it send as anyone).
    if (!login || !body.message || !body.envelope || login === cfg.admin.user) return send(res, 200, ACCEPT);
    // Stalwart checks only the envelope sender; the From line people see is checked here, or anyone could send as a
    // colleague. Allowed: your own addresses, a team mailbox you're in, or (delegation) an owner who let you send on
    // their behalf, with Sender: naming you.
    const fromAddr = addressOf(header(body.message, 'from'));
    if (!(await mayUseFrom(login, fromAddr, addressOf(header(body.message, 'sender'))).catch((e) => { console.error('hold: From check failed:', e.message); return false; })))
      return send(res, 200, { action: 'reject', response: { status: 550, enhancedStatus: '5.7.1',
        message: `5.7.1 You can't send as ${fromAddr || 'that address'}. Use one of your own addresses, or ask its owner to let you send on their behalf.` } });
    const raw = rawOf(body.message);
    let v;
    try { v = await verdict(body, raw); } catch (e) {
      // Fail closed: a broken spam check must not become a way to send unchecked. A temporary failure: SMTP clients
      // retry by themselves, the web app shows the error and the message stays in Drafts.
      console.error('hold: spam check failed, asked the sender to retry:', e.message, e.detail ? JSON.stringify(e.detail) : '');
      return send(res, 200, { action: 'reject', response: { status: 451, enhancedStatus: '4.7.1',
        message: '4.7.1 We couldn’t check this message just now. Try sending it again in a few minutes.' } });
    }
    if (v.score < h.score) return send(res, 200, ACCEPT);
    const messageId = header(body.message, 'message-id');
    // Sending the same message again (a retry, or the web app's Send pressed twice) doesn't hold it twice.
    if (!messageId || !store.list().some((m) => m.login === login && m.messageId === messageId)) {
      const id = randomBytes(9).toString('base64url');
      store.put({ id, at: new Date().toISOString(), login, from: body.envelope.from.address, to: body.envelope.to.map((t) => t.address),
        subject: header(body.message, 'subject').slice(0, 300), messageId, size: raw.length, score: v.score, reasons: v.reasons.slice(0, 12) }, raw);
      console.log(`hold: held ${id} from ${login} (score ${v.score}: ${v.reasons.slice(0, 5).join(', ')})`);
      await maybeSuspend(login).catch((e) => console.error('hold: pausing sending failed:', e.message, e.detail ? JSON.stringify(e.detail) : ''));
    }
    return send(res, 200, { action: 'reject', response: { status: 550, enhancedStatus: '5.7.1', message: `5.7.1 ${HELD}` } });
  }

  return {
    hook,
    list: () => store.list().sort((a, b) => b.at.localeCompare(a.at)),
    remove: (id) => ids.test(id) && store.remove(id),
    /** Send it on exactly as it was written, as the admin login (so this hook lets it pass), then forget it. */
    async release(id) {
      const meta = ids.test(id) && store.list().find((m) => m.id === id);
      if (!meta) return false;
      await sendRaw({ ...h.smtp, user: cfg.admin.user, pass: cfg.admin.pass }, { from: meta.from, to: meta.to, raw: store.raw(id) });
      store.remove(id);
      return true;
    },
  };
}
