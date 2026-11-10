import type { Address, Attachment, Draft, EmailFull } from './jmap';
import { locale, t } from './i18n';

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "Ann <ann@x.org>, bob@y.org" → addresses + anything that didn't parse. */
export function parseAddresses(input: string): { list: Address[]; invalid: string[] } {
  const list: Address[] = [], invalid: string[] = [];
  for (const raw of input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
    const email = (m ? m[2] : raw).trim();
    const name = m ? m[1].replace(/^"|"$/g, '').trim() || null : null;
    if (EMAIL.test(email)) list.push({ name, email }); else invalid.push(raw);
  }
  return { list, invalid };
}

export const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
export const formatAddresses = (as: Address[] | null) => (as ?? []).map(formatAddress).join(', ');
/** Typed recipients plus contact groups picked as one chip: the groups' members appended, each address once. What
 *  gets sent or saved in a draft is always plain addresses, so other mail apps read it. */
export function withGroups(typed: string, groups: { members: Address[] }[]): string {
  const seen = new Set(parseAddresses(typed).list.map((a) => a.email.toLowerCase()));
  const add = groups.flatMap((g) => g.members).filter((m) => !seen.has(m.email.toLowerCase()) && !!seen.add(m.email.toLowerCase()));
  return [typed.trim().replace(/[,;]$/, ''), ...add.map(formatAddress)].filter(Boolean).join(', ');
}
export const displayName = (a: Address | undefined, me?: string) =>
  a && me && a.email.toLowerCase() === me.toLowerCase() ? t('mailutil.me') : a?.name || a?.email || t('mailutil.unknownSender');

/** Units stay B/KB/MB in every language; the number follows it (1,5 MB in German). */
export function fileSize(n: number) {
  const num = (x: number, d = 0) => x.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
  return n < 1024 ? `${num(n)} B` : n < 1048576 ? `${num(Math.round(n / 1024))} KB` : `${num(n / 1048576, 1)} MB`;
}

// ── Large-file links (signup/files.mjs) ──────────────────
// A link looks like https://host/f/<id>#n=<name>&s=<bytes>. The part after # never reaches any server; it lets the
// recipient's reader show the file like an attachment without fetching anything.

export const fileLinkHtml = (f: { url: string; name: string; size: number; expires: number | null }) =>
  `<div><a href="${escapeHtml(`${f.url}#n=${encodeURIComponent(f.name)}&s=${f.size}`)}">${escapeHtml(f.name)}</a> (${fileSize(f.size)}, ${
    f.expires ? t('mailutil.downloadLinkUntil', { date: new Date(f.expires).toLocaleDateString(locale(), { dateStyle: 'medium' }) }) : t('mailutil.downloadLink')})</div>`;

/**
 * Large-file links in a message body (HTML or text), once each. Only links to this server (`origin`) count: anyone
 * can write a link that looks like one, and a chip would vouch for it. Other servers' links stay plain links, with
 * the reader's usual lookalike-link warning. ponytail: so files shared from another OpenMail server show no chip.
 */
export function fileLinks(body: string, origin: string): { url: string; name: string; size: number }[] {
  const out = new Map<string, { url: string; name: string; size: number }>();
  for (const [, url, name, size] of body.replace(/&amp;|&#38;/g, '&').matchAll(/(https?:\/\/[a-z0-9.-]+(?::\d+)?\/f\/[A-Za-z0-9_-]{24})#n=([^&\s"'<>]+)&s=(\d+)/gi)) {
    try {
      if (new URL(url).origin === new URL(origin).origin && !out.has(url)) out.set(url, { url, name: decodeURIComponent(name), size: Number(size) });
    } catch { /* bad %-escape or address: not ours */ }
  }
  return [...out.values()];
}

// ── HTML ↔ text ──────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const textToHtml = (s: string) => `<div>${escapeHtml(s).replace(/\r?\n/g, '<br>')}</div>`;

const KEEP = new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'PRE', 'CODE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
// The editor's own formatting (text colour, highlight, size, table borders, image size) is inline style. Only these
// properties survive, each with a value that can't load anything or hide text: plain colours, lengths and keywords.
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*(1|0?\.\d*[1-9]\d*|0*[1-9]\d*%)\s*)?\))$/i;
const LEN = /^\d{1,3}(\.\d+)?(px|em|%)$/;
const STYLE: Record<string, Record<string, (v: string) => boolean>> = {
  SPAN: { color: (v) => COLOR.test(v), 'background-color': (v) => COLOR.test(v), 'font-size': (v) => /^(x-small|small|medium|large|x-large|xx-large)$/.test(v) || /^(1[0-9]|2[0-9]|3[0-2])px$/.test(v) },
  IMG: { width: (v) => LEN.test(v), 'max-width': (v) => v === '100%' },
  TABLE: { 'border-collapse': (v) => v === 'collapse' },
  TD: { border: (v) => /^1px solid (#[0-9a-f]{3,8}|rgb\([\d,\s]+\))$/i.test(v), padding: (v) => /^(\d{1,2}px ?){1,2}$/.test(v) },
};
STYLE.TH = STYLE.TD;
function safeStyle(tag: string, style: string): string {
  const ok = STYLE[tag];
  if (!ok) return '';
  return style.split(';').map((d) => d.split(':')).filter((p) => p.length === 2)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]).filter(([k, v]) => ok[k]?.(v)).map(([k, v]) => `${k}: ${v}`).join('; ');
}
const FONT_SIZE = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xx-large'];
const DROP = 'script, style, head, title, meta, link, iframe, object, embed, form, input, button, select, textarea, svg, math, template, noscript';

/**
 * Allowlist sanitizer for HTML we put into the editor or send: pasted content and quoted replies.
 * Unknown tags are unwrapped (text kept); all attributes are stripped except safe link targets.
 * (Received mail is never sanitized this way. It renders in the sandboxed iframe; see safeHtml.ts.)
 */
export function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll(DROP).forEach((el) => el.remove());
  const walk = (node: Element) => {
    for (const el of [...node.children]) {
      walk(el);
      if (el.tagName === 'IMG') {
        // Only images that are part of the message itself (cid:), never remote ones. data-cid marks an embedded
        // image the editor is showing from a temporary blob: URL; it's turned back into cid: on send.
        const src = el.getAttribute('src') ?? '', cid = el.getAttribute('data-cid'), alt = el.getAttribute('alt');
        const keep = /^cid:/i.test(src) ? src : cid && /^blob:/.test(src) ? src : null;
        if (!keep) { el.remove(); continue; }
        const style = safeStyle('IMG', el.getAttribute('style') ?? '');
        for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
        el.setAttribute('src', keep);
        if (cid) el.setAttribute('data-cid', cid);
        if (alt) el.setAttribute('alt', alt);
        if (style) el.setAttribute('style', style);
        continue;
      }
      if (el.tagName === 'FONT') {
        // Some browsers' editing commands still write <font color size>: keep what it means as a styled span.
        const span = doc.createElement('span'), size = Number(el.getAttribute('size'));
        span.setAttribute('style', [el.getAttribute('color') && `color: ${el.getAttribute('color')}`, size >= 1 && size <= 7 && `font-size: ${FONT_SIZE[size - 1]}`, el.getAttribute('style')].filter(Boolean).join('; '));
        span.append(...el.childNodes); el.replaceWith(span);
        const style = safeStyle('SPAN', span.getAttribute('style')!);
        if (style) span.setAttribute('style', style); else span.replaceWith(...span.childNodes);
        continue;
      }
      if (!KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      const href = el.tagName === 'A' ? el.getAttribute('href') ?? '' : '';
      const sig = el.tagName === 'DIV' && el.hasAttribute('data-sig'); // inert marker so Compose can swap signatures
      const style = safeStyle(el.tagName, el.getAttribute('style') ?? '');
      for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      if (sig) el.setAttribute('data-sig', '');
      if (style) el.setAttribute('style', style);
      if (/^(https?:|mailto:)/i.test(href.trim())) { el.setAttribute('href', href.trim()); el.setAttribute('rel', 'noopener noreferrer'); }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** Plain-text alternative for an HTML body (every sent message carries both). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (n: Node, quote: string) => {
    if (n.nodeType === 3) { out.push(n.textContent ?? ''); return; }
    if (n.nodeType !== 1) return;
    const el = n as Element, tag = el.tagName;
    if (tag === 'BR') { out.push('\n' + quote); return; }
    const block = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|PRE|UL|OL)$/.test(tag);
    const q = tag === 'BLOCKQUOTE' ? quote + '> ' : quote;
    if (block) out.push('\n' + q);
    if (tag === 'LI') out.push('- ');
    el.childNodes.forEach((c) => walk(c, q));
    if (tag === 'A' && el.getAttribute('href') && el.getAttribute('href') !== el.textContent) out.push(` <${el.getAttribute('href')}>`);
    if (block) out.push('\n' + quote);
  };
  doc.body.childNodes.forEach((c) => walk(c, ''));
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n(>?\s*\n){2,}/g, '\n\n')
    .replace(/(\n>[ \t]*)+\s*$/, '').trim(); // no dangling empty quote line at the end
}

export function bodyText(e: Pick<EmailFull, 'text' | 'html'>): string {
  return e.text ?? (e.html ? htmlToText(e.html) : '');
}

// ── Replies, forwards, drafts ────────────────────────────

const withPrefix = (prefix: string, subject: string | null) => {
  const s = subject ?? '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
};

/** Inline images the message body actually shows (cid: references). */
const embedded = (e: EmailFull) => e.attachments.filter((a) => a.cid && e.html?.includes(`cid:${a.cid}`));

const originalHtml = (e: EmailFull) => (e.html ? cleanHtml(e.html) : textToHtml(e.text ?? ''));

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

/** mine: all addresses of this account (aliases too). Replies come from the one the message was sent to. */
export function draftFor(mode: ReplyMode, e: EmailFull, me: string, mine: string[] = []): Draft {
  const when = new Date(e.receivedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  if (mode === 'forward') {
    const header = [t('mailutil.fwdFrom', { value: formatAddresses(e.from) }), t('mailutil.fwdDate', { value: when }),
      t('mailutil.fwdSubject', { value: e.subject ?? '' }), t('mailutil.fwdTo', { value: formatAddresses(e.to) })]
      .map(escapeHtml).join('<br>');
    return {
      to: [], cc: [], subject: withPrefix('Fwd', e.subject), text: '',
      html: `<div><br></div><div>${escapeHtml(t('mailutil.forwarded'))}<br>${header}</div><br>${originalHtml(e)}`,
      attachments: [...e.attachments.filter((a) => a.disposition !== 'inline'), ...embedded(e)], // forwards keep files + inline images
    };
  }
  const own = new Set([me, ...mine].map((x) => x.toLowerCase()));
  const notMe = (a: Address) => !own.has(a.email.toLowerCase());
  const from = [...(e.to ?? []), ...(e.cc ?? [])].find((a) => own.has(a.email.toLowerCase()))?.email;
  const seen = new Set<string>();
  const uniq = (as: Address[]) => as.filter((a) => notMe(a) && !seen.has(a.email.toLowerCase()) && seen.add(a.email.toLowerCase()));
  const primary = e.replyTo?.length ? e.replyTo : e.from ?? [];
  // Replying to your own sent message goes back to its recipients.
  const to = uniq(primary.every((a) => !notMe(a)) ? e.to ?? [] : primary);
  if (!to.length) to.push({ name: null, email: me }); // a note to self: reply to self
  const extra = mode === 'replyAll' ? uniq([...(e.to ?? []), ...(e.cc ?? [])]) : [];
  return {
    to, cc: extra, subject: withPrefix('Re', e.subject), text: '', ...(from && from.toLowerCase() !== me.toLowerCase() && { from }), attachments: embedded(e), // quoted images keep working
    html: `<div><br></div><div>${escapeHtml(t('mailutil.replyLead', { when, name: displayName(e.from?.[0]) }))}</div><blockquote>${originalHtml(e)}</blockquote>`,
    inReplyTo: e.messageId ?? undefined,
    references: [...(e.references ?? []), ...(e.messageId ?? [])],
  };
}

/** Whether a line of text is the "On …, … wrote:" line above a quoted reply (in the current language). */
export function isReplyLead(text: string | null | undefined) {
  const [head, , tail] = t('mailutil.replyLead', { when: '\0', name: '\0' }).split('\0').map((x) => x.trim());
  const s = text?.trim() ?? '';
  return !!(head || tail) && s.startsWith(head) && s.endsWith(tail);
}

/** Reopen a saved draft in the editor. */
export function draftFromEmail(e: EmailFull): Draft {
  return {
    id: e.id, to: e.to ?? [], cc: e.cc ?? [], bcc: e.bcc ?? [], subject: e.subject ?? '',
    from: e.from?.[0]?.email,
    html: e.html ? cleanHtml(e.html) : textToHtml(e.text ?? ''), text: e.text ?? '',
    attachments: e.attachments.filter((a: Attachment) => a.disposition !== 'inline' || embedded(e).includes(a)), // pictures in the text stay
    inReplyTo: e.inReplyTo ?? undefined, references: e.references ?? undefined, // a resumed reply stays in its thread
  };
}

// ── Unsubscribe (RFC 2369 / 8058) ────────────────────────
// The List-Unsubscribe header is written by the sender, so treat it as hostile: only public https endpoints
// get a one-click POST, the mailto subject is fixed, and the user always sees the real destination first.

export type UnsubscribePlan =
  | { kind: 'post'; url: string; host: string }
  | { kind: 'mail'; to: string }
  | { kind: 'open'; url: string; host: string }
  | null;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|\[.*\]|(\d{1,3}\.){3}\d{1,3})$/i;

export function unsubscribePlan(u: { urls: string[]; oneClick: boolean } | null): UnsubscribePlan {
  if (!u) return null;
  const https = u.urls.map((x) => { try { return new URL(x); } catch { return null; } })
    .find((x): x is URL => !!x && x.protocol === 'https:' && !PRIVATE_HOST.test(x.hostname) && x.hostname.includes('.'));
  if (https && u.oneClick) return { kind: 'post', url: https.href, host: https.hostname };
  const mailto = u.urls.find((x) => /^mailto:/i.test(x));
  if (mailto) {
    const addr = decodeURIComponent(mailto.slice(7).split('?')[0]).trim();
    if (EMAIL.test(addr)) return { kind: 'mail', to: addr };
  }
  if (https) return { kind: 'open', url: https.href, host: https.hostname };
  return null;
}

// ── Read receipts (MDN, RFC 8098) ────────────────────────
// Always the user's choice: we ask, never send automatically, and the request's target address is shown.

/** RFC 2047 encoded-word for header text that isn't plain ASCII. */
export const encodeHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

/** Untrusted header-derived text going into a raw message: no CR/LF or other control characters. */
const oneLine = (v: string) => v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();

export function buildMdn(o: { from: string; to: string; subject: string; originalMessageId?: string; readAt: Date; domain: string; id: string }): string {
  // Subject, recipient and Message-ID come from the received message, i.e. from a stranger: sanitize every one.
  const subject = oneLine(o.subject);
  const to = oneLine(o.to), from = oneLine(o.from);
  if (!EMAIL.test(to) || !EMAIL.test(from)) throw new Error(t('mailutil.badReceiptAddress'));
  const msgId = o.originalMessageId && /^[^\s<>]+@[^\s<>]+$/.test(o.originalMessageId) ? o.originalMessageId : null;
  const boundary = `mdn-${crypto.randomUUID()}`; // random per message, so no content can contain it
  const when = o.readAt.toUTCString();
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(t('mailutil.receiptSubject', { subject }))}`, `Date: ${when}`,
    `Message-ID: <${oneLine(o.id)}@${oneLine(o.domain)}>`, 'MIME-Version: 1.0', 'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
    t('mailutil.receiptBody', { subject, when }), '',
    `--${boundary}`, 'Content-Type: message/disposition-notification', '',
    'Reporting-UA: OpenMail', `Final-Recipient: rfc822;${from}`,
    ...(msgId ? [`Original-Message-ID: <${msgId}>`] : []),
    'Disposition: manual-action/MDN-sent-manually; displayed', '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

// ── Signatures ────────────────────────────────────────────

export interface Signature { name: string; text: string }

/** "-- " is the delimiter other mail apps recognise; data-sig lets Compose find the block to swap it. */
export const signatureHtml = (text: string) => `<div data-sig=""><div>-- </div>${textToHtml(text)}</div>`;

/** Which signature to use: undefined = the first one, '' = none, otherwise by name (none if it was deleted). */
export const chooseSignature = (list: Signature[], name: string | undefined): Signature | null =>
  name === undefined ? list[0] ?? null : list.find((s) => s.name === name) ?? null;

/** New messages and replies get the signature on its own line at the top, above any quoted text. */
export function addSignature(html: string, sig: Signature | null): string {
  if (!sig?.text.trim()) return html;
  const block = signatureHtml(sig.text);
  return html.startsWith('<div><br></div>') ? html.replace('<div><br></div>', `<div><br></div>${block}`) : `<div><br></div>${block}${html}`;
}
