// Minimal JMAP client (RFC 8620 core, 8621 mail + submission). Talks to Stalwart directly; we have no backend.
import { SCRIPT_NAME, UPDATES } from './rules';
import type { CalEvent } from './calendar';
import { buildReply, parseInvite, replyWord, type Invite, type PartStat } from './ics';


const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse', 'urn:ietf:params:jmap:sieve'];
// Contacts are asked for only on contact calls: a session without contacts access (or a server without it)
// must still be able to do everything else.
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const CALENDARS = ['urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:calendars:parse'];
export const UNDO_SECONDS = 10;

export interface Mailbox { id: string; name: string; role: string | null; unreadEmails: number; sortOrder: number }
export interface Address { name: string | null; email: string }
export interface Attachment { blobId: string; name: string | null; type: string; size: number; cid?: string | null; disposition?: string | null }
export interface EmailSummary {
  id: string; threadId: string; subject: string | null; from: Address[] | null; to: Address[] | null;
  preview: string; receivedAt: string; keywords: Record<string, boolean>; hasAttachment: boolean;
}
export interface EmailFull extends EmailSummary {
  cc: Address[] | null; replyTo: Address[] | null;
  blobId: string; messageId: string[] | null; inReplyTo: string[] | null; references: string[] | null; mailboxIds: Record<string, boolean>;
  attachments: Attachment[]; html: string | null; text: string | null;
  /** RFC 2369/8058 List-Unsubscribe: where to unsubscribe, and whether a one-click POST is allowed. */
  unsubscribe: { urls: string[]; oneClick: boolean } | null;
}
export interface Identity { id: string; name: string; email: string; textSignature: string; htmlSignature: string }
export interface Vacation { isEnabled: boolean; fromDate: string | null; toDate: string | null; subject: string | null; textBody: string | null }
export interface Scheduled { submissionId: string; sendAt: string; email: EmailSummary }
export interface Draft {
  id?: string; // saved copy in Drafts, replaced on every autosave
  to: Address[]; cc: Address[]; subject: string;
  html: string; text: string; attachments: Attachment[];
  inReplyTo?: string[]; references?: string[];
}
/** An Email/query filter: { inMailbox }, { text }, { hasKeyword }, … */
export type Filter = Record<string, unknown>;

export class JmapError extends Error {}
/** Fired on window when the sign-in can't be renewed; the app returns to the sign-in screen. */
export const SESSION_EXPIRED = 'om:session-expired';

export const TEMPLATES = 'Templates';
export interface Subscription { from: Address; count: number; lastAt: string; unsubscribe: { urls: string[]; oneClick: boolean } }
/** A contact in the address book (a simplified JSContact card, RFC 9553). */
export interface Contact { id?: string; given: string; surname: string; emails: string[]; phones: string[]; org: string; note: string }
export interface Template { id: string; subject: string; html: string; attachments: Attachment[] }

const clean = (a: Address) => (a.name ? { name: a.name, email: a.email } : { email: a.email });
const pathOnly = (url: string) => url.replace(/^https?:\/\/[^/]+/, ''); // keep {placeholders} intact

const SUMMARY = ['threadId', 'subject', 'from', 'to', 'preview', 'receivedAt', 'keywords', 'hasAttachment'];
const FULL = [...SUMMARY, 'blobId', 'cc', 'replyTo', 'messageId', 'inReplyTo', 'references', 'mailboxIds', 'htmlBody', 'textBody', 'bodyValues', 'attachments',
  'header:List-Unsubscribe:asURLs', 'header:List-Unsubscribe-Post:asText'];

export class Jmap {
  private identity?: { id: string; name: string; email: string };

  private constructor(
    private authHeader: () => Promise<string>, private onUnauthorized: (() => Promise<void>) | null, private base: string,
    readonly accountId: string, readonly username: string,
    private apiUrl: string, private downloadUrl: string, private uploadUrl: string, private eventSourceUrl: string,
  ) {}

  /** Password sign-in (HTTP Basic). Used by tests and local development; the app signs in with OAuth (connect). */
  static login(user: string, pass: string, base = ''): Promise<Jmap> {
    const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
    return Jmap.open(async () => auth, null, base);
  }

  /** OAuth sign-in: tokens come from the session and are refreshed on expiry or a 401. */
  static connect(session: { header(): Promise<string>; refresh(): Promise<void> }, base = ''): Promise<Jmap> {
    return Jmap.open(() => session.header(), () => session.refresh(), base);
  }

  /** base '' = same origin (prod, and dev via the Vite proxy). */
  private static async open(authHeader: () => Promise<string>, onUnauthorized: (() => Promise<void>) | null, base: string): Promise<Jmap> {
    const probe = new Jmap(authHeader, onUnauthorized, base, '', '', '', '', '', '');
    const res = await probe.fetch(`${base}/jmap/session`);
    if (res.status === 401) throw new JmapError('Wrong email or password');
    if (!res.ok) throw new JmapError(`The mail server returned an error (${res.status})`);
    const s = await res.json();
    const accountId = s.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId) throw new JmapError('This account has no mailbox');
    // Session URLs may be absolute with the server's internal hostname (e.g. behind a proxy).
    // Keep only the path and use the origin we actually reached.
    return new Jmap(authHeader, onUnauthorized, base, accountId, s.username, pathOnly(s.apiUrl), pathOnly(s.downloadUrl), pathOnly(s.uploadUrl), pathOnly(s.eventSourceUrl));
  }

  /** Authenticated fetch. On a 401 with OAuth, refresh the token once and retry. */
  private async fetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: await this.authHeader() } });
    if (res.status === 401 && retry && this.onUnauthorized) {
      try { await this.onUnauthorized(); }
      catch {
        // The refresh token no longer works (signed out elsewhere, revoked, or the server's settings changed).
        window.dispatchEvent(new Event(SESSION_EXPIRED));
        throw new JmapError('Your session has ended. Please sign in again.');
      }
      return this.fetch(url, init, false);
    }
    return res;
  }

  async call(methodCalls: [string, object, string][], extra: string[] = []): Promise<any[]> {
    const res = await this.fetch(this.base + this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: [...USING, ...extra], methodCalls }),
    });
    if (!res.ok) throw new JmapError(`The mail server returned an error (${res.status})`);
    const { methodResponses } = await res.json();
    for (const [name, args] of methodResponses) {
      if (name === 'error') throw new JmapError(`${args.type}: ${args.description ?? ''}`);
      for (const k of ['notCreated', 'notUpdated', 'notDestroyed']) {
        const failed = args[k] && Object.values(args[k])[0] as { description?: string; type: string } | undefined;
        if (failed) throw new JmapError(failed.description || failed.type);
      }
    }
    return methodResponses.map(([, args]: [string, unknown]) => args);
  }

  /** Folders, Inbox first. The Templates folder is app storage, so it's hidden unless asked for. */
  async mailboxes(includeHidden = false): Promise<Mailbox[]> {
    const [r] = await this.call([['Mailbox/get', {
      accountId: this.accountId, properties: ['name', 'role', 'unreadEmails', 'sortOrder'],
    }, 'm']]);
    if (!includeHidden) r.list = (r.list as Mailbox[]).filter((b) => b.role || b.name !== TEMPLATES);
    const order = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'junk', 'trash'];
    const rank = (b: Mailbox) => (b.role && order.includes(b.role) ? order.indexOf(b.role) : 99);
    return (r.list as Mailbox[]).sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  /** Newest matching message of each conversation. */
  async threads(filter: Filter, limit = 50): Promise<EmailSummary[]> {
    const [, r] = await this.call([
      ['Email/query', {
        accountId: this.accountId, filter, collapseThreads: true, limit,
        sort: [{ property: 'receivedAt', isAscending: false }],
      }, 'q'],
      ['Email/get', {
        accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY,
      }, 'g'],
    ]);
    return r.list;
  }

  /** Every message in a conversation, oldest first. */
  async thread(threadId: string): Promise<EmailFull[]> {
    const [, r] = await this.call([
      ['Thread/get', { accountId: this.accountId, ids: [threadId] }, 't'],
      ['Email/get', {
        accountId: this.accountId, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
        properties: FULL, fetchHTMLBodyValues: true, fetchTextBodyValues: true,
      }, 'g'],
    ]);
    return (r.list as any[]).map((e) => {
      const join = (parts: { partId: string; type: string }[], type: string) => {
        const p = parts.filter((x) => x.type === type);
        return p.length ? p.map((x) => e.bodyValues[x.partId]?.value ?? '').join('\n') : null;
      };
      const urls: string[] = e['header:List-Unsubscribe:asURLs'] ?? [];
      const unsubscribe = urls.length ? { urls, oneClick: /One-Click/i.test(e['header:List-Unsubscribe-Post:asText'] ?? '') } : null;
      return { ...e, attachments: e.attachments ?? [], html: join(e.htmlBody, 'text/html'), text: join(e.textBody, 'text/plain'), unsubscribe };
    }).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** Apply a patch to the messages of a conversation, optionally only those in one mailbox. */
  private async patchThread(threadId: string, inMailbox: string | null, patch: Record<string, unknown> | 'destroy') {
    const [, r] = await this.call([
      ['Thread/get', { accountId: this.accountId, ids: [threadId] }, 't'],
      ['Email/get', {
        accountId: this.accountId, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
        properties: ['mailboxIds'],
      }, 'g'],
    ]);
    const ids = (r.list as { id: string; mailboxIds: Record<string, boolean> }[])
      .filter((e) => !inMailbox || e.mailboxIds[inMailbox]).map((e) => e.id);
    if (!ids.length) return;
    await this.call([['Email/set', patch === 'destroy'
      ? { accountId: this.accountId, destroy: ids }
      : { accountId: this.accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) }, 's']]);
  }

  /** Move a conversation's messages out of `from` into `to` (Gmail-style: Sent copies stay put). */
  move(threadId: string, from: string, to: string, keywords: Record<string, true | null> = {}) {
    const kw = Object.fromEntries(Object.entries(keywords).map(([k, v]) => [`keywords/${k}`, v]));
    return this.patchThread(threadId, from, { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true, ...kw });
  }

  destroyThread(threadId: string, inMailbox: string) { return this.patchThread(threadId, inMailbox, 'destroy'); }
  setSeen(threadId: string, seen: boolean) { return this.patchThread(threadId, null, { 'keywords/$seen': seen || null }); }
  setStarred(threadId: string, starred: boolean) { return this.patchThread(threadId, null, { 'keywords/$flagged': starred || null }); }
  /** Gmail-style label: the conversation also appears in that folder. */
  addToMailbox(threadId: string, mailboxId: string) { return this.patchThread(threadId, null, { [`mailboxIds/${mailboxId}`]: true }); }

  async renameMailbox(id: string, name: string) {
    await this.call([['Mailbox/set', { accountId: this.accountId, update: { [id]: { name } } }, 'r']]);
  }

  /** Deleting a folder keeps messages that are also elsewhere; ones only in this folder are deleted. */
  async deleteMailbox(id: string) {
    await this.call([['Mailbox/set', { accountId: this.accountId, destroy: [id], onDestroyRemoveEmails: true }, 'd']]);
  }

  /** The raw message (headers + MIME) for "Show original". */
  async original(e: { blobId: string }): Promise<string> {
    return (await this.download({ blobId: e.blobId, name: 'message.eml', type: 'message/rfc822', size: 0 })).text();
  }

  // ── Filters: one Sieve script owned by this app (rules.ts compiles it) ──

  async getRules(): Promise<{ id: string | null; script: string }> {
    const [r] = await this.call([['SieveScript/get', { accountId: this.accountId }, 'g']]);
    const mine = (r.list as { id: string; name: string; blobId: string }[]).find((x) => x.name === SCRIPT_NAME);
    if (!mine) return { id: null, script: '' };
    const blob = await this.download({ blobId: mine.blobId, name: 'rules.sieve', type: 'application/sieve', size: 0 });
    return { id: mine.id, script: await blob.text() };
  }

  async saveRules(script: string, existingId: string | null) {
    const { blobId } = await this.upload(Object.assign(new Blob([script], { type: 'application/sieve' }), { name: 'rules.sieve' }));
    await this.call([['SieveScript/set', {
      accountId: this.accountId,
      ...(existingId ? { update: { [existingId]: { blobId } } } : { create: { s: { name: SCRIPT_NAME, blobId } } }),
      onSuccessActivateScript: existingId ?? '#s',
    }, 's']]);
  }

  async createMailbox(name: string): Promise<string> {
    const [r] = await this.call([['Mailbox/set', { accountId: this.accountId, create: { m: { name } } }, 'c']]);
    return r.created.m.id;
  }

  /**
   * Snooze: park the conversation in a Snoozed folder with a keyword holding the wake-up time.
   * ponytail: JMAP has no server-side snooze, so wakeSnoozed() runs on every client refresh; mail only
   * wakes while some client is open. Upgrade path: run the same function from a small server-side cron.
   */
  async snooze(threadId: string, from: string, until: Date, boxes: Mailbox[]) {
    const snoozed = await this.mailboxFor('snoozed', 'Snoozed', boxes);
    await this.move(threadId, from, snoozed, { [`$snoozed-${Math.floor(+until / 1000)}`]: true });
  }

  /** Move snoozed conversations whose time has come back to the Inbox, unread. Returns how many woke. */
  async wakeSnoozed(boxes: Mailbox[]): Promise<number> {
    const snoozed = boxes.find((b) => b.role === 'snoozed'), inbox = boxes.find((b) => b.role === 'inbox');
    if (!snoozed || !inbox) return 0;
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: snoozed.id } }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['keywords'] }, 'g'],
    ]);
    const now = Date.now() / 1000;
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of r.list as { id: string; keywords: Record<string, boolean> }[]) {
      const k = Object.keys(e.keywords).find((x) => x.startsWith('$snoozed-'));
      if (!k || +k.slice(9) > now) continue;
      update[e.id] = { [`mailboxIds/${snoozed.id}`]: null, [`mailboxIds/${inbox.id}`]: true, [`keywords/${k}`]: null, 'keywords/$seen': null };
    }
    if (Object.keys(update).length) await this.call([['Email/set', { accountId: this.accountId, update }, 'w']]);
    return Object.keys(update).length;
  }

  /** Mailbox with a role, created if missing (Stalwart doesn't make an Archive by default). */
  async mailboxFor(role: string, name: string, known: Mailbox[]): Promise<string> {
    const found = known.find((b) => b.role === role);
    if (found) return found.id;
    const [r] = await this.call([['Mailbox/set', { accountId: this.accountId, create: { m: { name, role } } }, 'c']]);
    return r.created.m.id;
  }

  // ── Files ──────────────────────────────────────────────

  async upload(file: Blob & { name?: string }): Promise<Attachment> {
    const res = await this.fetch(this.base + this.uploadUrl.replace('{accountId}', this.accountId), {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw new JmapError(res.status === 413 ? 'That file is too large to attach' : `Upload failed (${res.status})`);
    const r = await res.json();
    return { blobId: r.blobId, type: r.type, size: r.size, name: file.name ?? 'attachment' };
  }

  async download(a: Attachment): Promise<Blob> {
    const url = this.downloadUrl.replace('{accountId}', this.accountId).replace('{blobId}', a.blobId)
      .replace('{name}', encodeURIComponent(a.name ?? 'file')).replace('{type}', encodeURIComponent(a.type));
    const res = await this.fetch(this.base + url);
    if (!res.ok) throw new JmapError(`Download failed (${res.status})`);
    return res.blob();
  }

  // ── Writing ────────────────────────────────────────────

  async getIdentityFresh(): Promise<Identity> { this.identity = undefined; return this.getIdentity() as Promise<Identity>; }

  async setIdentity(patch: Partial<Pick<Identity, 'name' | 'textSignature' | 'htmlSignature'>>) {
    const me = await this.getIdentity();
    await this.call([['Identity/set', { accountId: this.accountId, update: { [me.id]: patch } }, 'i']]);
    this.identity = undefined;
  }

  async vacation(): Promise<Vacation> {
    const [r] = await this.call([['VacationResponse/get', { accountId: this.accountId, ids: ['singleton'] }, 'v']]);
    return r.list[0];
  }

  async setVacation(v: Partial<Vacation>) {
    await this.call([['VacationResponse/set', { accountId: this.accountId, update: { singleton: v } }, 'v']]);
  }

  private async getIdentity() {
    if (!this.identity) {
      const [r] = await this.call([['Identity/get', { accountId: this.accountId }, 'i']]);
      this.identity = r.list[0];
      if (!this.identity) throw new JmapError('This account has no sending identity');
    }
    return this.identity;
  }

  /** Email/set create payload. Stalwart rejects explicit nulls on create, so optional fields are omitted when empty. */
  private async compose(d: Draft, mailboxId: string) {
    const me = await this.getIdentity();
    return {
      mailboxIds: { [mailboxId]: true }, keywords: { $draft: true, $seen: true },
      from: [me.name && me.name !== me.email ? { name: me.name, email: me.email } : { email: me.email }],
      subject: d.subject,
      ...(d.to.length && { to: d.to.map(clean) }),
      ...(d.cc.length && { cc: d.cc.map(clean) }),
      ...(d.inReplyTo?.length && { inReplyTo: d.inReplyTo }),
      ...(d.references?.length && { references: d.references }),
      bodyValues: { t: { value: d.text }, h: { value: d.html } },
      textBody: [{ partId: 't', type: 'text/plain' }],
      htmlBody: [{ partId: 'h', type: 'text/html' }],
      ...(d.attachments.length && {
        attachments: d.attachments.map((a) => (a.cid
          ? { blobId: a.blobId, type: a.type, name: a.name, disposition: 'inline', cid: a.cid }
          : { blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
      }),
    };
  }

  private box(boxes: Mailbox[], role: string) {
    const id = boxes.find((b) => b.role === role)?.id;
    if (!id) throw new JmapError(`The ${role} folder is missing`);
    return id;
  }

  /** Save (or replace) a draft. Emails are immutable in JMAP, so a save is create-new + destroy-old. */
  async saveDraft(d: Draft, boxes: Mailbox[]): Promise<string> {
    const [r] = await this.call([['Email/set', {
      accountId: this.accountId, create: { d: await this.compose(d, this.box(boxes, 'drafts')) }, destroy: d.id ? [d.id] : [],
    }, 's']]);
    return r.created.d.id;
  }

  async deleteDraft(id: string) { await this.call([['Email/set', { accountId: this.accountId, destroy: [id] }, 'x']]); }

  // ── Templates: saved messages in a "Templates" folder (hidden from the folder list), so they sync everywhere ──

  async templates(): Promise<Template[]> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === TEMPLATES);
    if (!box) return [];
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: box.id }, sort: [{ property: 'subject', isAscending: true }] }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'htmlBody', 'textBody', 'bodyValues', 'attachments'], fetchHTMLBodyValues: true, fetchTextBodyValues: true }, 'g'],
    ]);
    return (r.list as any[]).map((e) => {
      const part = e.htmlBody?.find((p: { type: string }) => p.type === 'text/html') ?? e.textBody?.[0];
      return { id: e.id, subject: e.subject ?? '', html: part ? e.bodyValues[part.partId]?.value ?? '' : '', attachments: e.attachments ?? [] };
    });
  }

  async saveTemplate(d: Draft): Promise<void> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === TEMPLATES)?.id ?? await this.createMailbox(TEMPLATES);
    const email = await this.compose({ ...d, to: [], cc: [], inReplyTo: undefined, references: undefined }, box);
    await this.call([['Email/set', { accountId: this.accountId, create: { t: { ...email, keywords: { $seen: true } } } }, 't']]);
  }

  async deleteTemplate(id: string) { await this.call([['Email/set', { accountId: this.accountId, destroy: [id] }, 'x']]); }

  /** Newsletters you receive (anything with List-Unsubscribe in recent mail), grouped by sender, busiest first. */
  async subscriptions(limit = 500): Promise<Subscription[]> {
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['from', 'receivedAt', 'header:List-Unsubscribe:asURLs', 'header:List-Unsubscribe-Post:asText'] }, 'g'],
    ]);
    const by = new Map<string, Subscription>();
    for (const e of r.list as any[]) {
      const urls: string[] | null = e['header:List-Unsubscribe:asURLs'];
      const from: Address | undefined = e.from?.[0];
      if (!urls?.length || !from) continue;
      const k = from.email.toLowerCase(), cur = by.get(k);
      if (cur) { cur.count++; continue; } // newest first: the first one seen carries the latest unsubscribe link
      by.set(k, { from, count: 1, lastAt: e.receivedAt,
        unsubscribe: { urls, oneClick: /One-Click/i.test(e['header:List-Unsubscribe-Post:asText'] ?? '') } });
    }
    return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  }

  /**
   * Move every message from exactly this sender to Deleted Items. Returns how many.
   * JMAP's `from` filter is a text match (it would also catch "bob@x.com.evil" or a display name containing the
   * address), so each hit is re-checked against the exact address. Sent and Drafts are never touched.
   */
  async trashFrom(email: string, boxes: Mailbox[]): Promise<number> {
    const target = email.trim().toLowerCase();
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(target)) throw new JmapError('That isn’t a valid sender address');
    const trash = boxes.find((b) => b.role === 'trash')?.id;
    if (!trash) throw new JmapError('The trash folder is missing');
    const keep = new Set(boxes.filter((b) => b.role === 'sent' || b.role === 'drafts').map((b) => b.id));
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { from: target }, limit: 1000 }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['from', 'mailboxIds'] }, 'g'],
    ]);
    const ids = (r.list as { id: string; from: Address[] | null; mailboxIds: Record<string, boolean> }[])
      .filter((e) => e.from?.some((a) => a.email.toLowerCase() === target))
      .filter((e) => !Object.keys(e.mailboxIds).some((id) => keep.has(id)))
      .map((e) => e.id);
    if (ids.length) await this.call([['Email/set', { accountId: this.accountId,
      update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [trash]: true } }])) }, 's']]);
    return ids.length;
  }

  /**
   * One-time backfill for Inbox categories: tag recent newsletters/notifications already in the Inbox with $updates
   * (new mail is tagged on delivery by the Sieve rule). Same test as the rule. Returns how many were tagged.
   */
  async tagUpdates(inboxId: string, limit = 500): Promise<number> {
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: inboxId, notKeyword: UPDATES }, sort: [{ property: 'receivedAt', isAscending: false }], limit }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['from', 'header:List-Unsubscribe', 'header:List-Id'] }, 'g'], // raw form: works for any header
    ]);
    const automated = /^(noreply|no-reply|donotreply|notifications|mailer-daemon)/i;
    const ids = (r.list as any[]).filter((e) => e['header:List-Unsubscribe'] || e['header:List-Id']
      || e.from?.some((a: Address) => automated.test(a.email.split('@')[0]))).map((e) => e.id);
    if (ids.length) await this.call([['Email/set', { accountId: this.accountId, update: Object.fromEntries(ids.map((id) => [id, { [`keywords/${UPDATES}`]: true }])) }, 't']]);
    return ids.length;
  }

  /**
   * Send with a server-side hold (SMTP FUTURERELEASE), so Undo works even if the tab closes.
   * The message goes to Sent immediately; undoSend() pulls it back to Drafts. A saved draft is removed.
   */
  /** sendAt: schedule for later (SMTP FUTURERELEASE HOLDUNTIL, up to 30 days on Stalwart). */
  async send(d: Draft, boxes: Mailbox[], sendAt?: Date): Promise<{ submissionId: string; emailId: string }> {
    const me = await this.getIdentity();
    const drafts = this.box(boxes, 'drafts'), sent = this.box(boxes, 'sent');
    const [created, sub] = await this.call([
      ['Email/set', { accountId: this.accountId, create: { d: await this.compose(d, drafts) }, destroy: d.id ? [d.id] : [] }, 'e'],
      ['EmailSubmission/set', {
        accountId: this.accountId,
        create: { s: { identityId: me.id, emailId: '#d', envelope: {
          mailFrom: { email: me.email, parameters: sendAt
            ? { HOLDUNTIL: sendAt.toISOString().replace(/\.\d+Z$/, 'Z') } : { HOLDFOR: String(UNDO_SECONDS) } },
          rcptTo: [...d.to, ...d.cc].map((a) => ({ email: a.email })),
        } } },
        onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
      }, 's'],
    ]);
    return { submissionId: sub.created.s.id, emailId: created.created.d.id };
  }

  /** Messages waiting to go out later (excludes the few seconds of the normal undo window). */
  async scheduled(): Promise<Scheduled[]> {
    const [, subs] = await this.call([
      ['EmailSubmission/query', { accountId: this.accountId, filter: { undoStatus: 'pending' } }, 'q'],
      ['EmailSubmission/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' } }, 'g'],
    ]);
    const later = (subs.list as { id: string; emailId: string; sendAt: string }[])
      .filter((s) => +new Date(s.sendAt) - Date.now() > UNDO_SECONDS * 1000);
    if (!later.length) return [];
    const [emails] = await this.call([['Email/get', { accountId: this.accountId, ids: later.map((s) => s.emailId), properties: SUMMARY }, 'e']]);
    const byId = new Map((emails.list as EmailSummary[]).map((e) => [e.id, e]));
    return later.filter((s) => byId.has(s.emailId)).sort((a, b) => a.sendAt.localeCompare(b.sendAt))
      .map((s) => ({ submissionId: s.id, sendAt: s.sendAt, email: byId.get(s.emailId)! }));
  }

  /**
   * Live updates: JMAP push over an EventSource stream. We read it with fetch() because the browser's
   * EventSource can't send an Authorization header. Calls onChange when anything in the account changes;
   * reconnects with backoff. Returns a stop function.
   */
  watch(onChange: () => void): () => void {
    const url = this.base + this.eventSourceUrl.replace('{types}', '*').replace('{closeafter}', 'no').replace('{ping}', '60');
    let stopped = false, ctrl: AbortController, delay = 1000;
    const run = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await this.fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          delay = 1000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            const events = buf.split(/\r?\n\r?\n/); buf = events.pop()!;
            if (events.some((ev) => /^event:\s*state/m.test(ev))) onChange();
          }
        } catch { /* network drop or abort: retry below */ }
        if (!stopped) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 60_000); }
      }
    };
    run();
    return () => { stopped = true; ctrl?.abort(); };
  }

  /** Recipients the server refused for this submission, with its reason in plain words (empty = all fine so far). */
  async deliveryProblems(submissionId: string): Promise<{ email: string; reason: string }[]> {
    const [r] = await this.call([['EmailSubmission/get', { accountId: this.accountId, ids: [submissionId], properties: ['deliveryStatus', 'undoStatus'] }, 'g']]);
    const st = r.list[0]?.deliveryStatus ?? {};
    return Object.entries(st as Record<string, { delivered: string; smtpReply: string }>)
      .filter(([, v]) => v.delivered === 'no')
      .map(([email, v]) => ({ email, reason: v.smtpReply.replace(/^\d{3}\s+(\d\.\d\.\d+\s+)?/, '').replace(/\.$/, '') || 'the server refused it' }));
  }

  async undoSend(submissionId: string, emailId: string, boxes: Mailbox[]): Promise<void> {
    await this.call([
      ['EmailSubmission/set', { accountId: this.accountId, update: { [submissionId]: { undoStatus: 'canceled' } } }, 'u'],
      ['Email/set', { accountId: this.accountId, update: { [emailId]: {
        [`mailboxIds/${this.box(boxes, 'sent')}`]: null, [`mailboxIds/${this.box(boxes, 'drafts')}`]: true, 'keywords/$draft': true,
      } } }, 'm'],
    ]);
  }

  // ── Calendar (JMAP Calendars) ──────────────────────────

  async events(from: Date, to: Date): Promise<CalEvent[]> {
    const [, r] = await this.call([
      ['CalendarEvent/query', { accountId: this.accountId, filter: { after: from.toISOString().replace(/\.\d+Z$/, 'Z'), before: to.toISOString().replace(/\.\d+Z$/, 'Z') }, expandRecurrences: true }, 'q'],
      ['CalendarEvent/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
        properties: ['title', 'start', 'timeZone', 'duration', 'showWithoutTime', 'locations', 'description', 'utcStart', 'utcEnd'] }, 'g'],
    ], CALENDARS);
    return (r.list as any[]).map(toCalEvent);
  }

  async saveEvent(e: CalEvent): Promise<string> {
    const body = {
      '@type': 'Event', ...(e.uid && !e.id ? { uid: e.uid } : {}), title: e.title.trim() || 'Untitled event', start: e.start, timeZone: e.allDay ? null : e.timeZone,
      duration: e.duration, showWithoutTime: e.allDay, description: e.description,
      locations: e.location.trim() ? { l1: { '@type': 'Location', name: e.location.trim() } } : null,
    };
    if (e.id) {
      await this.call([['CalendarEvent/set', { accountId: this.accountId, update: { [e.id]: body } }, 's']], CALENDARS);
      return e.id;
    }
    const [cals] = await this.call([['Calendar/get', { accountId: this.accountId, properties: ['isDefault'] }, 'c']], CALENDARS);
    const cal = (cals.list as { id: string; isDefault: boolean }[]).find((c) => c.isDefault) ?? cals.list[0];
    if (!cal) throw new JmapError('This account has no calendar');
    const [r] = await this.call([['CalendarEvent/set', { accountId: this.accountId, create: { e: { ...body, calendarIds: { [cal.id]: true } } } }, 's']], CALENDARS);
    return r.created.e.id;
  }

  /**
   * Answer an invitation: email the organizer an iTIP REPLY (what Gmail/Outlook/Zoho process automatically) and
   * remember the answer on the message itself ($rsvp-accepted / -tentative / -declined), so every device shows it.
   */
  async rsvp(emailId: string, invite: Attachment, status: PartStat, boxes: Mailbox[]): Promise<Invite> {
    const inv = parseInvite(await (await this.download(invite)).text());
    if (!inv) throw new JmapError('This invitation can’t be read');
    const me = await this.getIdentity();
    const reply = buildReply(inv, { email: me.email, name: me.name !== me.email ? me.name : null }, status);
    const file = await this.upload(Object.assign(new Blob([reply], { type: 'text/calendar; method=REPLY; charset=utf-8' }), { name: 'reply.ics' }));
    const who = me.name && me.name !== me.email ? me.name : me.email;
    const verb = { ACCEPTED: 'accepted', TENTATIVE: 'tentatively accepted', DECLINED: 'declined' }[status];
    await this.send({ to: [{ name: null, email: inv.organizerEmail }], cc: [], subject: `${replyWord[status]}: ${inv.summary}`,
      html: `<p>${who} has ${verb} this invitation.</p>`, text: `${who} has ${verb} this invitation.`,
      attachments: [{ ...file, type: 'text/calendar; method=REPLY; charset=utf-8' }] }, boxes);
    const kw = (s: PartStat) => `keywords/$rsvp-${s.toLowerCase()}`;
    await this.call([['Email/set', { accountId: this.accountId, update: { [emailId]: {
      [kw('ACCEPTED')]: status === 'ACCEPTED' || null, [kw('TENTATIVE')]: status === 'TENTATIVE' || null, [kw('DECLINED')]: status === 'DECLINED' || null,
    } } }, 'k']]);
    return inv;
  }

  /** Is this meeting (by iCalendar UID) already in the calendar? */
  async hasEvent(uid: string): Promise<boolean> {
    const [q] = await this.call([['CalendarEvent/query', { accountId: this.accountId, filter: { uid } }, 'q']], CALENDARS);
    return q.ids.length > 0;
  }

  async deleteEvent(id: string) { await this.call([['CalendarEvent/set', { accountId: this.accountId, destroy: [id] }, 'd']], CALENDARS); }

  /** Read the events inside an invitation attachment (text/calendar), without adding them anywhere. */
  async parseInvite(blobId: string): Promise<CalEvent[]> {
    const [r] = await this.call([['CalendarEvent/parse', { accountId: this.accountId, blobIds: [blobId] }, 'p']], CALENDARS);
    return ((r.parsed?.[blobId] ?? []) as any[]).map(toCalEvent);
  }

  // ── Address book (JMAP Contacts, RFC 9610) ─────────────

  async addressBook(): Promise<Contact[]> {
    const [, r] = await this.call([
      ['ContactCard/query', { accountId: this.accountId }, 'q'],
      ['ContactCard/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
    ], [CONTACTS]);
    const part = (c: any, kind: string) => c.name?.components?.find((x: { kind: string }) => x.kind === kind)?.value ?? '';
    return (r.list as any[]).map((c) => ({
      id: c.id,
      given: part(c, 'given') || (c.name?.full ?? ''), surname: part(c, 'surname'),
      emails: Object.values(c.emails ?? {}).map((e: any) => e.address).filter(Boolean),
      phones: Object.values(c.phones ?? {}).map((p: any) => p.number).filter(Boolean),
      org: (Object.values(c.organizations ?? {})[0] as any)?.name ?? '',
      note: (Object.values(c.notes ?? {})[0] as any)?.note ?? '',
    })).sort((a, b) => `${a.given} ${a.surname}`.localeCompare(`${b.given} ${b.surname}`));
  }

  async saveContact(c: Contact): Promise<string> {
    const card = {
      '@type': 'Card', version: '1.0',
      name: { components: [{ kind: 'given', value: c.given.trim() }, ...(c.surname.trim() ? [{ kind: 'surname', value: c.surname.trim() }] : [])], isOrdered: true },
      emails: Object.fromEntries(c.emails.filter(Boolean).map((e, i) => [`e${i}`, { address: e.trim() }])),
      phones: Object.fromEntries(c.phones.filter(Boolean).map((p, i) => [`p${i}`, { number: p.trim() }])),
      organizations: c.org.trim() ? { o0: { name: c.org.trim() } } : {},
      notes: c.note.trim() ? { n0: { note: c.note.trim() } } : {},
    };
    if (c.id) {
      await this.call([['ContactCard/set', { accountId: this.accountId, update: { [c.id]: card } }, 's']], [CONTACTS]);
      return c.id;
    }
    const [books] = await this.call([['AddressBook/get', { accountId: this.accountId, properties: ['isDefault'] }, 'b']], [CONTACTS]);
    const book = (books.list as { id: string; isDefault: boolean }[]).find((b) => b.isDefault) ?? books.list[0];
    if (!book) throw new JmapError('This account has no address book');
    const [r] = await this.call([['ContactCard/set', { accountId: this.accountId, create: { c: { ...card, addressBookIds: { [book.id]: true } } } }, 's']], [CONTACTS]);
    return r.created.c.id;
  }

  async deleteContact(id: string) { await this.call([['ContactCard/set', { accountId: this.accountId, destroy: [id] }, 'd']], [CONTACTS]); }

  /**
   * People you correspond with, most frequent first, for recipient autocomplete.
   * ponytail: derived from the last 300 messages; switch to JMAP ContactCard once there's an address book.
   */
  async contacts(): Promise<Address[]> {
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 300 }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['from', 'to', 'cc', 'keywords', 'header:List-Unsubscribe', 'header:List-Id'] }, 'g'],
    ]);
    const me = this.username.toLowerCase();
    const seen = new Map<string, { a: Address; n: number }>();
    const add = (a: Address, weight: number) => {
      const k = a.email.toLowerCase();
      if (k === me || /no-?reply|mailer-daemon|postmaster/.test(k)) return;
      const cur = seen.get(k);
      seen.set(k, { a: cur?.a.name ? cur.a : a, n: (cur?.n ?? 0) + weight });
    };
    for (const e of r.list as any[]) {
      const mine = e.from?.some((a: Address) => a.email.toLowerCase() === me);
      // People you write to matter more than people who write to you.
      if (mine) [...(e.to ?? []), ...(e.cc ?? [])].forEach((a: Address) => add(a, 3));
      // Newsletters and automated mail aren't people you'd write to: never suggest their senders.
      else if (!e['header:List-Unsubscribe'] && !e['header:List-Id'] && !e.keywords?.[UPDATES]) (e.from ?? []).forEach((a: Address) => add(a, 1));
    }
    return [...seen.values()].sort((x, y) => y.n - x.n).map((x) => x.a);
  }
}

function toCalEvent(e: any): CalEvent {
  return {
    id: e.id, uid: e.uid, title: e.title ?? '', start: e.start, timeZone: e.timeZone ?? '', duration: e.duration ?? 'PT1H',
    allDay: !!e.showWithoutTime, location: (Object.values(e.locations ?? {})[0] as any)?.name ?? '', description: e.description ?? '',
    utcStart: e.utcStart, utcEnd: e.utcEnd,
  };
}
