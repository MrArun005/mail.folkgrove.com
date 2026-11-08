// Spam complaints. Mailbox providers' feedback loops (Yahoo CFL, Microsoft JMRP, ...) send an ARF report (RFC 5965:
// multipart/report; report-type=feedback-report) to abuse@ when one of their users marks our mail as spam.
// install.sh makes abuse@ (and postmaster@) a team mailbox; every few minutes this service reads the new messages in
// it as admin (JMAP), and each genuine report counts against the account that sent the reported message
// (abuse.complaint). Every message it has looked at gets a keyword, so nothing is counted twice.
//
// A report counts only when both hold, so forged reports can't get someone suspended:
// 1. we can trust who sent it: Stalwart's own Authentication-Results on delivery says DMARC passed for the report's
//    From domain, or a DKIM signature aligned with it did (as web/src/keys.ts checks). With ARF_REPORTERS set, that
//    domain must also be on the list; an IP on the list counts by itself (feedback loops that don't sign).
// 2. the reported message really left this server: it carries our DKIM signature or a Message-ID in our domain.
import { addressOf } from './hold.mjs';

const KEYWORD = '$openmail-arf-seen';
const MAX_SIZE = 5 << 20; // bigger messages aren't reports; skipped (and marked)

/** Header fields of a message (or of a feedback-report part), unfolded, top to bottom: [[lowercase name, value]]. */
export function headersOf(text) {
  const head = String(text).split(/\r?\n\r?\n/)[0];
  return head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] : null;
  }).filter(Boolean);
}
const field = (h, name) => h.find(([n]) => n === name)?.[1] ?? '';
const bodyOf = (text) => { const m = /\r?\n\r?\n/.exec(text); return m ? text.slice(m.index + m[0].length) : ''; };
const param = (v, name) => { const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v); return m ? m[1] ?? m[2] : ''; };
const tag = (sig, t) => new RegExp(`(?:^|;)\\s*${t}\\s*=\\s*([^;\\s]*)`, 'i').exec(sig)?.[1]?.toLowerCase() ?? '';
const under = (d, domain) => !!d && (d === domain || d.endsWith('.' + domain));

/** { type, mailFrom, original } of an ARF report, or null when the message isn't one. */
export function parseArf(raw) {
  const ct = field(headersOf(raw), 'content-type');
  if (!/^multipart\/report\b/i.test(ct) || param(ct, 'report-type').toLowerCase() !== 'feedback-report') return null;
  const b = param(ct, 'boundary');
  if (!b) return null;
  let report = null, original = null;
  // ponytail: one level of MIME, base64 or plain parts (what feedback loops send); quoted-printable isn't decoded.
  for (const part of bodyOf(raw).split(`--${b}`).slice(1)) {
    if (part.startsWith('--')) break; // the closing delimiter
    const p = part.replace(/^[ \t]*\r?\n/, ''), h = headersOf(p);
    let body = bodyOf(p);
    if (/base64/i.test(field(h, 'content-transfer-encoding'))) body = Buffer.from(body, 'base64').toString('utf8');
    const type = field(h, 'content-type').split(';')[0].trim().toLowerCase();
    if (type === 'message/feedback-report') report = headersOf(body.trim());
    else if (type === 'message/rfc822' || type === 'text/rfc822-headers') original = body;
  }
  if (!report || original === null) return null;
  return { type: field(report, 'feedback-type').toLowerCase(), mailFrom: addressOf(field(report, 'original-mail-from')), original };
}

/**
 * Did the report come from someone we trust? h = the report's own headers. Returns { ok, why, domain, ip }.
 * Only Stalwart's own lines count: the topmost Received (added on delivery from outside) and the first
 * Authentication-Results below it, naming the same host. Mail a user of this server submitted gets no Received
 * line but is signed with our DKIM key before local delivery, so our signature above that Received means it's theirs.
 */
export function reporterTrusted(h, { domain, reporters = [] }) {
  const iRcv = h.findIndex(([n]) => n === 'received');
  if (iRcv < 0) return { ok: false, why: 'not received from outside' };
  const rcv = h[iRcv][1], by = /\bby\s+([^\s(;]+)/i.exec(rcv)?.[1]?.toLowerCase();
  // ponytail: the client IP is the last [address] before "by" (Stalwart: "from helo (rdns [ip])"); an HELO name with
  // brackets comes earlier and so doesn't count.
  const ip = [...rcv.split(/\sby\s/i)[0].matchAll(/\[([0-9a-fA-F:.]+)\]/g)].at(-1)?.[1] ?? '';
  const no = (why) => ({ ok: false, why, ip });
  if (h.slice(0, iRcv).some(([n, v]) => n === 'dkim-signature' && under(tag(v, 'd'), domain))) return no('sent from this server');
  const list = reporters.map((r) => r.toLowerCase());
  if (ip && list.includes(ip.toLowerCase())) return { ok: true, why: 'listed IP', ip };
  const ar = h.slice(iRcv + 1).find(([n]) => n === 'authentication-results')?.[1] ?? '';
  if (!by || ar.split(';')[0].trim().toLowerCase() !== by) return no(`no Authentication-Results from ${by || 'our server'}`);
  const from = addressOf(field(h, 'from')).split('@')[1] ?? '';
  if (!from || under(from, domain)) return no('report From is missing or ours');
  const aligned = (d) => !!d && (d = d.toLowerCase().replace(/.*@/, ''), under(from, d) || under(d, from));
  const pass = ar.split(';').slice(1).some((r) => {
    const v = r.replace(/\([^)]*\)/g, ' ');
    const prop = (k) => new RegExp(`(?:^|\\s)${k.replace('.', '\\.')}=("?)([^\\s";]+)\\1`, 'i').exec(v)?.[2];
    return (/^\s*dmarc=pass\b/i.test(v) && aligned(prop('header.from'))) || (/^\s*dkim=pass\b/i.test(v) && aligned(prop('header.d') ?? prop('header.i')));
  });
  if (!pass) return no(`${from} not authenticated (DKIM/DMARC)`);
  if (list.length && !list.some((r) => under(from, r))) return no(`${from} not in ARF_REPORTERS`);
  return { ok: true, why: 'authenticated', domain: from, ip };
}

/** Did the reported message leave this server? Our DKIM signature or a Message-ID in our domain. */
export function fromOurServer(original, domain) {
  const h = headersOf(original);
  return h.some(([n, v]) => n === 'dkim-signature' && under(tag(v, 'd'), domain))
    || under(/@([^>\s]+)>?\s*$/.exec(field(h, 'message-id'))?.[1]?.toLowerCase(), domain);
}

/** What one message in abuse@ means: { counted?, why, sender? }. complaint(address, messageId) as in abuse.mjs. */
export async function handleReport(raw, cfg, complaint) {
  const arf = parseArf(raw);
  if (!arf) return { why: 'not an ARF report' };
  const trust = reporterTrusted(headersOf(raw), { domain: cfg.domain, reporters: cfg.arf?.reporters });
  if (!trust.ok) return { why: `untrusted reporter: ${trust.why}`, ip: trust.ip };
  if (!fromOurServer(arf.original, cfg.domain)) return { why: 'reported message is not from this server', ip: trust.ip };
  const oh = headersOf(arf.original);
  const sender = arf.mailFrom || addressOf(field(oh, 'return-path')) || addressOf(field(oh, 'from'));
  if (!sender.endsWith(`@${cfg.domain}`)) return { why: `sender ${sender || '(none)'} is not ours`, ip: trust.ip };
  const result = await complaint(sender, field(oh, 'message-id') || null);
  return { counted: result === 'counted' || result === 'suspended', why: result, sender, ip: trust.ip };
}

/**
 * Reads new messages in the abuse@ team mailbox (cfg.arf.mailbox, a Stalwart group) and counts genuine reports.
 * Also keeps the ADMINS members of that group, so they read it in the web app. Returns what it did, per message.
 */
export function arfJob({ cfg, jmap, getDomainId, complaint }) {
  const mail = (calls) => jmap(calls, ['urn:ietf:params:jmap:mail']);
  const auth = 'Basic ' + Buffer.from(`${cfg.admin.user}:${cfg.admin.pass}`).toString('base64');
  return async function scan() {
    const domainId = await getDomainId();
    const { ids: [gid] } = await jmap([['x:Account/query', { filter: { '@type': 'Group', name: cfg.arf.mailbox, domainId } }, 'q']]);
    if (!gid) return null; // no abuse@ team mailbox on this server (install.sh creates it)
    for (const name of cfg.admins ?? []) {
      const { ids: [uid] } = await jmap([['x:Account/query', { filter: { '@type': 'User', name, domainId } }, 'q']]);
      const u = uid && (await jmap([['x:Account/get', { ids: [uid], properties: ['memberGroupIds'] }, 'g']])).list[0];
      if (u && !u.memberGroupIds?.[gid]) await jmap([['x:Account/set', { update: { [uid]: { [`memberGroupIds/${gid}`]: true } } }, 's']]);
    }
    // ponytail: 50 messages a run, oldest first; a flood catches up over the next runs.
    const { ids } = await mail([['Email/query', { accountId: gid, filter: { notKeyword: KEYWORD }, sort: [{ property: 'receivedAt' }], limit: 50 }, 'q']]);
    if (!ids.length) return [];
    const { list } = await mail([['Email/get', { accountId: gid, ids, properties: ['blobId', 'size', 'subject'] }, 'g']]);
    const out = [];
    for (const e of list) {
      let r = { why: 'too big for a report' };
      if (e.size <= MAX_SIZE) {
        const res = await fetch(`${cfg.stalwartUrl}/jmap/download/${gid}/${e.blobId}/m.eml`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`downloading a message from ${cfg.arf.mailbox}@ failed: HTTP ${res.status}`); // retried next run
        r = await handleReport(await res.text(), cfg, complaint);
      }
      await mail([['Email/set', { accountId: gid, update: { [e.id]: { [`keywords/${KEYWORD}`]: true } } }, 's']]);
      if (r.why !== 'not an ARF report') console.log(`arf: ${r.counted ? 'complaint about ' + r.sender : 'ignored report'} (${r.why}): ${String(e.subject ?? '').slice(0, 80)}`);
      out.push({ id: e.id, ...r });
    }
    return out;
  };
}
