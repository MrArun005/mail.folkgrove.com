// Minimal JMAP client (RFC 8620 core, 8621 mail + submission). Talks to Stalwart directly; we have no backend.
import { SCRIPT_NAME, UPDATES } from './rules';
import { isOffline, offlineStore } from './offline';
import type { CalEvent } from './calendar';
import { buildReply, parseInvite, replyWord, type Invite, type PartStat } from './ics';
import { buildMdn } from './mailutil';
import { autocryptHeader, myKey, peerKey, unlockedKey } from './keys';


const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse', 'urn:ietf:params:jmap:sieve'];
// Contacts are asked for only on contact calls: a session without contacts access (or a server without it)
// must still be able to do everything else.
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const STALWART = 'urn:stalwart:jmap';
const CALENDARS = ['urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:calendars:parse'];
export const UNDO_SECONDS = 10;

export interface Mailbox {
  id: string; name: string; role: string | null; unreadEmails: number; sortOrder: number;
  parentId?: string | null;
  /** Nesting depth (0 = top level) and the full "Parent/Child" path, which is what Sieve filters file into. */
  depth?: number; path?: string;
}
export interface Address { name: string | null; email: string }
export interface Attachment { blobId: string; name: string | null; type: string; size: number; cid?: string | null; disposition?: string | null }
export interface EmailSummary {
  id: string; threadId: string; subject: string | null; from: Address[] | null; to: Address[] | null;
  preview: string; receivedAt: string; keywords: Record<string, boolean>; hasAttachment: boolean;
  mailboxIds?: Record<string, boolean>;
}
export interface EmailFull extends EmailSummary {
  cc: Address[] | null; bcc: Address[] | null; replyTo: Address[] | null;
  blobId: string; messageId: string[] | null; inReplyTo: string[] | null; references: string[] | null; mailboxIds: Record<string, boolean>;
  attachments: Attachment[]; html: string | null; text: string | null;
  /** Disposition-Notification-To: the sender asked for a read receipt (we only ever send one if the user says so). */
  receiptTo: Address[] | null;
  /** RFC 2369/8058 List-Unsubscribe: where to unsubscribe, and whether a one-click POST is allowed. */
  unsubscribe: { urls: string[]; oneClick: boolean } | null;
  /** Autocrypt header: the sender's public key, offered for encrypted replies. */
  autocrypt?: string | null;
  /** Authentication-Results headers, topmost (added by our server on delivery) first. */
  authResults?: string[];
  /** The topmost Received line (our server's) and the DKIM-Signature headers, to check the two above. */
  received?: string | null;
  dkim?: string[];
}
export interface Identity { id: string; name: string; email: string; textSignature: string; htmlSignature: string }
export interface Vacation { isEnabled: boolean; fromDate: string | null; toDate: string | null; subject: string | null; textBody: string | null }
export interface Scheduled { submissionId: string; sendAt: string; email: EmailSummary }
export interface Draft {
  id?: string; // saved copy in Drafts, replaced on every autosave
  to: Address[]; cc: Address[]; subject: string;
  /** Blind copies: in the envelope only. The Sent copy keeps a Bcc header so you can see who got one. */
  bcc?: Address[];
  /** Send from this address (one of identities()); the account's main address when missing. */
  from?: string;
  html: string; text: string; attachments: Attachment[];
  inReplyTo?: string[]; references?: string[];
  /** Ask the recipient for a read receipt. */
  receipt?: boolean;
  /** Bring it back to the Inbox if nobody replies within this many days. */
  followUpDays?: number;
  /** Send end-to-end encrypted and signed (PGP/MIME). Every recipient needs a known key (keys.ts). */
  encrypt?: boolean;
}
/** An Email/query filter: { inMailbox }, { text }, { hasKeyword }, … */
export type Filter = Record<string, unknown>;

// Stalwart permission names, checked one by one against the server (unknown names are rejected).
const APP_PASSWORD_PERMISSIONS = ['authenticate', 'emailSend', 'emailReceive',
  ...'Append Authenticate Capability Copy Create Delete Enable Examine Expunge Fetch Idle List ListRights Lsub MetadataGet MetadataSet Move MyRights Namespace Rename Search Select Sort Status Store Subscribe Thread'.split(' ').map((x) => `imap${x}`),
  ...'Authenticate List Dele Retr Stat Uidl'.split(' ').map((x) => `pop3${x}`),
  ...'Authenticate CheckScript GetScript HaveSpace ListScripts PutScript SetActive DeleteScript RenameScript'.split(' ').map((x) => `sieve${x}`),
  ...['Cal', 'Card'].flatMap((k) => 'Copy Delete Move Acl Get Lock MkCol MultiGet PropFind PropPatch Put Query'.split(' ').map((x) => `dav${k}${x}`)), 'davCalFreeBusyQuery',
  ...'List Search Acl Match'.split(' ').map((x) => `davPrincipal${x}`), 'davSyncCollection', 'davExpandProperty'];

export class JmapError extends Error {}
/** Fired on window when the sign-in can't be renewed; the app returns to the sign-in screen. */
export const SESSION_EXPIRED = 'om:session-expired';

export const TEMPLATES = 'Templates';
export const TASKS = 'Tasks'; // app storage like Templates: hidden from the folder list
export const NOTES = 'Notes';
export interface Note { id: string; title: string; body: string; updatedAt: string; pinned: boolean }
export interface Task { id: string; title: string; done: boolean; due: string | null; threadId: string | null; createdAt: string }
export interface Subscription { from: Address; count: number; lastAt: string; unsubscribe: { urls: string[]; oneClick: boolean } }
/** A contact in the address book (a simplified JSContact card, RFC 9553). */
export interface Contact { id?: string; given: string; surname: string; emails: string[]; phones: string[]; org: string; note: string }
export interface AppPassword { id: string; description: string; createdAt?: string; expiresAt?: string | null }
export interface Template { id: string; subject: string; html: string; attachments: Attachment[] }

const clean = (a: Address) => (a.name ? { name: a.name, email: a.email } : { email: a.email });
const pathOnly = (url: string) => url.replace(/^https?:\/\/[^/]+/, ''); // keep {placeholders} intact

const SUMMARY = ['threadId', 'subject', 'from', 'to', 'preview', 'receivedAt', 'keywords', 'hasAttachment', 'mailboxIds'];
const FULL = [...SUMMARY, 'blobId', 'cc', 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references', 'mailboxIds', 'htmlBody', 'textBody', 'bodyValues', 'attachments',
  'header:List-Unsubscribe:asURLs', 'header:List-Unsubscribe-Post:asText', 'header:Disposition-Notification-To:asAddresses', 'header:Autocrypt:asText', 'header:Authentication-Results:asText:all', 'header:Received:asRaw:all', 'header:DKIM-Signature:asText:all'];

export interface MaskedAlias { id: string; email: string; label: string; enabled: boolean; masked: boolean }
async function aliasReply(r: Response) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw Object.assign(new JmapError(j.error?.message ?? `The server returned an error (${r.status})`), { code: j.error?.code as string | undefined });
  return j;
}

/**
 * System folders in a fixed order, then your folders as a tree (each parent followed by its children, depth-first),
 * with depth and full path filled in. Exported for tests.
 */
export function orderMailboxes(list: Mailbox[]): Mailbox[] {
  const order = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'junk', 'trash'];
  const rank = (b: Mailbox) => (b.role && order.includes(b.role) ? order.indexOf(b.role) : 99);
  const byName = (a: Mailbox, b: Mailbox) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const ids = new Set(list.map((b) => b.id));
  const kids = new Map<string | null, Mailbox[]>();
  for (const b of list) {
    const p = b.parentId && ids.has(b.parentId) ? b.parentId : null; // an orphan (parent hidden) shows at the top
    kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  const out: Mailbox[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    for (const b of (kids.get(parent) ?? []).sort(byName)) {
      const path = prefix ? `${prefix}/${b.name}` : b.name;
      out.push({ ...b, depth, path });
      walk(b.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return out;
}

export class Jmap {
  private identity?: Identity;

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
  static connect(session: { header(): Promise<string>; refresh(): Promise<void>; remembered?: boolean; username?: string }, base = ''): Promise<Jmap> {
    // Trusted device: keep the session details too, so the app can open with no connection.
    return Jmap.open(() => session.header(), () => session.refresh(), base, session.remembered ? session.username : undefined);
  }

  /** base '' = same origin (prod, and dev via the Vite proxy). */
  private static async open(authHeader: () => Promise<string>, onUnauthorized: (() => Promise<void>) | null, base: string, offlineUser?: string): Promise<Jmap> {
    const probe = new Jmap(authHeader, onUnauthorized, base, '', '', '', '', '', '');
    let s;
    try {
      const res = await probe.fetch(`${base}/jmap/session`);
      if (res.status === 401) throw new JmapError('Wrong email or password');
      if (!res.ok) throw new JmapError(`The mail server returned an error (${res.status})`);
      s = await res.json();
      if (offlineUser) offlineStore.set(`${offlineUser}:session`, s);
    } catch (e) {
      s = offlineUser && isOffline(e) ? await offlineStore.get<any>(`${offlineUser}:session`) : undefined;
      if (!s) throw e;
    }
    // A mail session has a mail account; a security-only session (step-up) has just the Stalwart one.
    const accountId = s.primaryAccounts?.['urn:ietf:params:jmap:mail'] ?? s.primaryAccounts?.['urn:stalwart:jmap'] ?? Object.keys(s.accounts ?? {})[0];
    if (!accountId) throw new JmapError('This account has no mailbox');
    // Session URLs may be absolute with the server's internal hostname (e.g. behind a proxy).
    // Keep only the path and use the origin we actually reached.
    const c = new Jmap(authHeader, onUnauthorized, base, accountId, s.username, pathOnly(s.apiUrl), pathOnly(s.downloadUrl), pathOnly(s.uploadUrl), pathOnly(s.eventSourceUrl));
    c.maxConcurrent = Math.max(1, Number(s.capabilities?.['urn:ietf:params:jmap:core']?.maxConcurrentRequests) || 4);
    c.vapidKey = s.capabilities?.['urn:ietf:params:jmap:webpush-vapid']?.applicationServerKey ?? null;
    c.offline = !!offlineUser;
    return c;
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

  // The server allows only a few API requests in flight per account (session maxConcurrentRequests; Stalwart: 4).
  // The app starts many at once on load, so extra ones wait their turn here instead of failing with 400.
  // One queue per account, shared by every client object for it (a reload or a second component may make another),
  // with one slot left for the live-update stream, which the server counts as a request too.
  private static gates = new Map<string, { inFlight: number; waiting: (() => void)[] }>();
  maxConcurrent = 4;
  /** Offline mode (trusted devices only): reads are saved locally and served from there when the network is gone. */
  offline = false;
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.offline) return load();
    const k = `${this.username}:${key}`;
    try { const v = await load(); if (this.offline) offlineStore.set(k, v); return v; } // not after sign-out turned it off
    catch (e) {
      const saved = isOffline(e) ? await offlineStore.get<T>(k) : undefined;
      if (saved === undefined) throw e;
      return saved;
    }
  }

  /** The server's Web Push (VAPID) public key, when it can push to closed tabs. */
  vapidKey: string | null = null;
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const key = `${this.base}|${this.username}`;
    const g = Jmap.gates.get(key) ?? Jmap.gates.set(key, { inFlight: 0, waiting: [] }).get(key)!;
    const limit = Math.max(1, this.maxConcurrent - 1);
    while (g.inFlight >= limit) await new Promise<void>((r) => g.waiting.push(r));
    g.inFlight++;
    try { return await fn(); } finally { g.inFlight--; g.waiting.shift()?.(); }
  }

  async call(methodCalls: [string, object, string][], extra: string[] = []): Promise<any[]> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.slot(() => this.callOnce(methodCalls, extra)); }
      catch (e) {
        // Another tab or device can still push us over the limit: back off briefly and try again.
        if (attempt >= 3 || !(e instanceof JmapError) || !/concurrent requests/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }

  private async callOnce(methodCalls: [string, object, string][], extra: string[]): Promise<any[]> {
    const res = await this.fetch(this.base + this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: [...USING, ...extra], methodCalls }),
    });
    if (!res.ok) {
      const detail = await res.json().then((j) => j?.detail as string | undefined, () => undefined);
      throw new JmapError(detail && /concurrent requests/i.test(detail) ? detail : `The mail server returned an error (${res.status})`);
    }
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
    return this.cached(`boxes:${includeHidden}`, () => this.mailboxesLive(includeHidden));
  }
  private async mailboxesLive(includeHidden: boolean): Promise<Mailbox[]> {
    const [r] = await this.call([['Mailbox/get', {
      accountId: this.accountId, properties: ['name', 'role', 'unreadEmails', 'sortOrder', 'parentId'],
    }, 'm']]);
    if (!includeHidden) r.list = (r.list as Mailbox[]).filter((b) => b.role || ![TEMPLATES, TASKS, NOTES].includes(b.name));
    return orderMailboxes(r.list);
  }

  /** Newest matching message of each conversation. */
  async threads(filter: Filter, limit = 50): Promise<EmailSummary[]> {
    return this.cached(`threads:${JSON.stringify(filter)}:${limit}`, () => this.threadsLive(filter, limit));
  }
  private async threadsLive(filter: Filter, limit: number): Promise<EmailSummary[]> {
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

  /** Unread Primary-inbox mail received after `since`, newest first (for desktop notifications). */
  async arrivedSince(inboxId: string, since: string): Promise<EmailSummary[]> {
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 5,
        filter: { operator: 'AND', conditions: [{ inMailbox: inboxId }, { after: since }, { notKeyword: '$seen' }, { notKeyword: UPDATES }] } }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY }, 'g'],
    ]);
    return r.list;
  }

  /** Everyone you've written to recently (recipients of your last 500 sent messages), lowercased. Priority Inbox. */
  async correspondents(): Promise<Set<string>> {
    const sent = (await this.mailboxes()).find((b) => b.role === 'sent');
    if (!sent) return new Set();
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: sent.id }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 500 }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['to', 'cc'] }, 'g'],
    ]);
    const mine = new Set((await this.identities()).map((i) => i.email.toLowerCase())); // notes to self aren't "important"
    return new Set((r.list as { to: Address[] | null; cc: Address[] | null }[]).flatMap((e) => [...(e.to ?? []), ...(e.cc ?? [])])
      .map((a) => a.email.toLowerCase()).filter((a) => !mine.has(a)));
  }

  // ── Web Push (RFC 8620 §7.2 PushSubscription + VAPID): new mail reaches this browser even with every tab closed ──

  /** Register this browser's push endpoint for new-mail deliveries only. Returns the subscription id. */
  async createPushSubscription(deviceClientId: string, url: string, keys: { p256dh: string; auth: string }): Promise<string> {
    // One per browser: replace any earlier one for this device.
    const [g] = await this.call([['PushSubscription/get', { ids: null }, 'g']]);
    const old = (g.list as { id: string; deviceClientId: string }[]).filter((x) => x.deviceClientId === deviceClientId).map((x) => x.id);
    const [r] = await this.call([['PushSubscription/set', {
      create: { p: { deviceClientId, url, keys, types: ['EmailDelivery'] } }, ...(old.length && { destroy: old }),
    }, 's']]);
    return r.created.p.id;
  }
  /** Finish registration with the code the server pushed to the browser. */
  async verifyPushSubscription(id: string, verificationCode: string) {
    await this.call([['PushSubscription/set', { update: { [id]: { verificationCode } } }, 'v']]);
  }
  async deletePushSubscriptions(deviceClientId: string) {
    const [g] = await this.call([['PushSubscription/get', { ids: null }, 'g']]);
    const ids = (g.list as { id: string; deviceClientId: string }[]).filter((x) => x.deviceClientId === deviceClientId).map((x) => x.id);
    if (ids.length) await this.call([['PushSubscription/set', { destroy: ids }, 'd']]);
  }

  /** Every message in a conversation, oldest first. */
  async thread(threadId: string): Promise<EmailFull[]> {
    return this.cached(`thread:${threadId}`, () => this.threadLive(threadId));
  }
  private async threadLive(threadId: string): Promise<EmailFull[]> {
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
      return { ...e, attachments: e.attachments ?? [], html: join(e.htmlBody, 'text/html'), text: join(e.textBody, 'text/plain'), unsubscribe,
        receiptTo: e['header:Disposition-Notification-To:asAddresses'] ?? null, autocrypt: e['header:Autocrypt:asText'] ?? null,
        authResults: e['header:Authentication-Results:asText:all'] ?? [],
        received: e['header:Received:asRaw:all']?.[0] ?? null, dkim: e['header:DKIM-Signature:asText:all'] ?? [] };
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

  async getRules(): Promise<{ id: string | null; script: string; state?: string }> {
    const [r] = await this.call([['SieveScript/get', { accountId: this.accountId }, 'g']]);
    const mine = (r.list as { id: string; name: string; blobId: string }[]).find((x) => x.name === SCRIPT_NAME);
    if (!mine) return { id: null, script: '', state: r.state };
    const blob = await this.download({ blobId: mine.blobId, name: 'rules.sieve', type: 'application/sieve', size: 0 });
    return { id: mine.id, script: await blob.text(), state: r.state };
  }

  /** ifInState: refuse (JmapError "stateMismatch…") if the script changed on the server since `state` was read. */
  async saveRules(script: string, existingId: string | null, ifInState?: string) {
    const { blobId } = await this.upload(Object.assign(new Blob([script], { type: 'application/sieve' }), { name: 'rules.sieve' }));
    await this.call([['SieveScript/set', {
      accountId: this.accountId, ...(ifInState && { ifInState }),
      ...(existingId ? { update: { [existingId]: { blobId } } } : { create: { s: { name: SCRIPT_NAME, blobId } } }),
      onSuccessActivateScript: existingId ?? '#s',
    }, 's']]);
  }

  async createMailbox(name: string, parentId?: string | null): Promise<string> {
    const [r] = await this.call([['Mailbox/set', { accountId: this.accountId, create: { m: { name, ...(parentId && { parentId }) } } }, 'c']]);
    return r.created.m.id;
  }

  /** Put a folder inside another (or back at the top level with null). */
  async moveMailbox(id: string, parentId: string | null) {
    await this.call([['Mailbox/set', { accountId: this.accountId, update: { [id]: { parentId } } }, 'p']]);
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

  // ── Mute and follow-up reminders: keywords, like snooze. No server changes, so any JMAP server works. ──

  /** Mute: archive the conversation and keep archiving anything new in it (see sweep()). */
  async mute(threadId: string, from: string, boxes: Mailbox[]) {
    await this.move(threadId, from, await this.mailboxFor('archive', 'Archive', boxes), { $muted: true, $seen: true });
  }
  unmute(threadId: string) { return this.patchThread(threadId, null, { 'keywords/$muted': null }); }

  /**
   * Housekeeping on each refresh. Muted: new Inbox messages in a muted conversation go straight to Archive.
   * Follow-up: a sent message whose reminder is due and that got no reply comes back to the top of the Inbox,
   * unread, with $nudge ("No reply yet"); one that got a reply just loses its reminder. Returns how many nudged.
   * ponytail: two small queries per refresh, each capped (500 muted messages, 200 reminders); a server-side
   * Sieve/cron job would be the upgrade if accounts ever carry thousands of either.
   */
  async sweep(boxes: Mailbox[]): Promise<number> {
    const inbox = boxes.find((b) => b.role === 'inbox')?.id, archive = boxes.find((b) => b.role === 'archive')?.id;
    if (!inbox) return 0;
    const ids = (name: string) => ({ resultOf: name, name: 'Email/query', path: '/ids' });
    const [, muted, , inInbox, , follow] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { hasKeyword: '$muted' }, limit: 500 }, 'mq'],
      ['Email/get', { accountId: this.accountId, '#ids': ids('mq'), properties: ['threadId'] }, 'mg'],
      ['Email/query', { accountId: this.accountId, filter: { operator: 'AND', conditions: [{ inMailbox: inbox }, { notKeyword: '$muted' }] }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 200 }, 'iq'],
      ['Email/get', { accountId: this.accountId, '#ids': ids('iq'), properties: ['threadId'] }, 'ig'],
      ['Email/query', { accountId: this.accountId, filter: { hasKeyword: '$followup' }, limit: 200 }, 'fq'],
      ['Email/get', { accountId: this.accountId, '#ids': ids('fq'), properties: ['threadId', 'keywords', 'receivedAt'] }, 'fg'],
    ]);
    const update: Record<string, Record<string, unknown>> = {};
    const mutedThreads = new Set((muted.list as { threadId: string }[]).map((e) => e.threadId));
    if (archive) for (const e of inInbox.list as { id: string; threadId: string }[])
      if (mutedThreads.has(e.threadId)) update[e.id] = { [`mailboxIds/${inbox}`]: null, [`mailboxIds/${archive}`]: true, 'keywords/$muted': true, 'keywords/$seen': true };

    const now = Date.now() / 1000;
    const due = (follow.list as { id: string; threadId: string; keywords: Record<string, boolean>; receivedAt: string }[])
      .map((e) => ({ ...e, at: +(Object.keys(e.keywords).find((k) => k.startsWith('$followup-'))?.slice(10) ?? 0) }))
      .filter((e) => e.at <= now);
    let nudged = 0;
    if (due.length) {
      const [, later] = await this.call([
        ['Thread/get', { accountId: this.accountId, ids: [...new Set(due.map((e) => e.threadId))] }, 't'],
        ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['threadId', 'from', 'receivedAt'] }, 'g'],
      ]);
      const mine = new Set((await this.identities()).map((i) => i.email.toLowerCase()));
      for (const e of due) {
        const replied = (later.list as { threadId: string; from: Address[] | null; receivedAt: string }[]).some((x) =>
          x.threadId === e.threadId && x.receivedAt > e.receivedAt && x.from?.some((a) => !mine.has(a.email.toLowerCase())));
        const clear = { 'keywords/$followup': null, [`keywords/$followup-${e.at}`]: null };
        update[e.id] = replied ? clear : { ...clear, [`mailboxIds/${inbox}`]: true, 'keywords/$nudge': true, 'keywords/$seen': null };
        if (!replied) nudged++;
      }
    }
    if (Object.keys(update).length) await this.call([['Email/set', { accountId: this.accountId, update }, 'u']]);
    return nudged;
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

  /** Store one raw message (RFC 5322 bytes) in the given folders, keeping its original date. Returns the email id. */
  async importMessage(raw: Uint8Array, mailboxIds: string[], keywords: Record<string, true>, receivedAt?: string): Promise<string> {
    const blob = await this.upload(new Blob([raw.slice().buffer as ArrayBuffer], { type: 'message/rfc822' }));
    const [r] = await this.call([['Email/import', { accountId: this.accountId, emails: { i: {
      blobId: blob.blobId, mailboxIds: Object.fromEntries(mailboxIds.map((id) => [id, true])), keywords,
      ...(receivedAt && { receivedAt }),
    } } }, 'i']]);
    return r.created.i.id;
  }

  /** The folder at this "A/B/C" path, creating any missing level. `known` caches path → id across calls. */
  async folderPath(path: string, known: Map<string, string>, boxes: Mailbox[]): Promise<string> {
    if (known.has(path)) return known.get(path)!;
    for (const b of boxes) if (b.path && !b.role) known.set(b.path, b.id);
    let parent: string | null = null, sofar = '';
    for (const part of path.split('/').map((x) => x.trim()).filter(Boolean)) {
      sofar = sofar ? `${sofar}/${part}` : part;
      if (!known.has(sofar)) known.set(sofar, await this.createMailbox(part, parent));
      parent = known.get(sofar)!;
    }
    return parent!;
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
      const list = await this.identities();
      // The account's own address first; Stalwart also adds one identity per alias.
      this.identity = list.find((i) => i.email.toLowerCase() === this.username.toLowerCase()) ?? list[0];
      if (!this.identity) throw new JmapError('This account has no sending identity');
    }
    return this.identity;
  }

  /** Every address this account may send from (its own, plus aliases). */
  async identities(): Promise<Identity[]> {
    const [r] = await this.call([['Identity/get', { accountId: this.accountId }, 'i']]);
    return r.list;
  }

  // ── Masked aliases (the account service, signup/aliases.mjs: adding addresses needs admin rights) ──

  /** null = this server doesn't run the account service. */
  async aliases(): Promise<MaskedAlias[] | null> {
    const r = await this.fetch(`${this.base}/api/aliases`);
    if (r.status === 404 || r.status === 502 || r.status === 503) return null;
    return (await aliasReply(r)).aliases;
  }
  async createAlias(label: string): Promise<MaskedAlias> {
    return (await aliasReply(await this.fetch(`${this.base}/api/aliases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }))).alias;
  }
  async updateAlias(id: string, patch: { enabled?: boolean; label?: string }): Promise<MaskedAlias> {
    return (await aliasReply(await this.fetch(`${this.base}/api/aliases/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }))).alias;
  }
  async deleteAlias(id: string): Promise<void> {
    await aliasReply(await this.fetch(`${this.base}/api/aliases/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  }

  /** Delete this account for good (the account service, signup/account.mjs). Errors carry the service's `code`. */
  async deleteAccount(body: { password: string; code?: string; confirm: string }): Promise<void> {
    const r = await this.fetch(`${this.base}/api/account`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404 || r.status === 502) throw new JmapError('This server can’t delete accounts from here. Ask its administrator.');
    await aliasReply(r);
  }

  // ── Export (Settings → Export your data) ──────────────

  /** One page of every message, oldest first (new mail lands after the pages already read). */
  async emailPage(position: number, limit = 500): Promise<{ total: number; list: { id: string; blobId: string; mailboxIds: Record<string, true>; keywords: Record<string, true>; receivedAt: string }[] }> {
    const [q, g] = await this.call([
      ['Email/query', { accountId: this.accountId, sort: [{ property: 'receivedAt', isAscending: true }], position, limit, calculateTotal: true }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['blobId', 'mailboxIds', 'keywords', 'receivedAt'] }, 'g'],
    ]);
    return { total: q.total, list: g.list };
  }

  /** A message exactly as stored (RFC 5322 bytes). */
  async rawMessage(blobId: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.download({ blobId, name: 'message.eml', type: 'message/rfc822', size: 0 })).arrayBuffer());
  }

  /**
   * Every calendar event (kind 'cal', iCalendar) or contact (kind 'card', vCard) exactly as stored, via CalDAV/CardDAV:
   * JMAP has no "give me the original" for these.
   */
  async davObjects(kind: 'cal' | 'card'): Promise<string[]> {
    const dav = async (path: string, method: string, body: string) => {
      const r = await this.fetch(this.base + path, { method, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body });
      if (r.status !== 207) throw new JmapError(`The server didn’t list your ${kind === 'cal' ? 'calendars' : 'contacts'} (${r.status})`);
      return new DOMParser().parseFromString(await r.text(), 'application/xml');
    };
    const ns = kind === 'cal' ? 'urn:ietf:params:xml:ns:caldav' : 'urn:ietf:params:xml:ns:carddav';
    const [type, data, query] = kind === 'cal' ? ['calendar', 'calendar-data', 'calendar-query'] : ['addressbook', 'address-data', 'addressbook-query'];
    const home = await dav(`/dav/${kind}/${encodeURIComponent(this.username)}/`, 'PROPFIND', '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>');
    // Matched by namespace and local name by hand (getElementsByTagNameNS isn't everywhere, e.g. test DOMs).
    const els = (n: Document | Element, uri: string, local: string) => [...n.getElementsByTagName('*')].filter((e) => e.namespaceURI === uri && e.localName === local);
    const collections = els(home, 'DAV:', 'response').filter((r) => els(r, ns, type).length)
      .map((r) => els(r, 'DAV:', 'href')[0]?.textContent ?? '').filter(Boolean);
    const out: string[] = []; 
    for (const href of collections) {
      const filter = kind === 'cal' ? '<C:filter><C:comp-filter name="VCALENDAR"/></C:filter>' : '';
      const doc = await dav(pathOnly(href), 'REPORT', `<?xml version="1.0"?><C:${query} xmlns:D="DAV:" xmlns:C="${ns}"><D:prop><C:${data}/></D:prop>${filter}</C:${query}>`);
      for (const el of els(doc, ns, data)) if (el.textContent?.trim()) out.push(el.textContent);
    }
    return out;
  }

  /** Admin console API (signup/admin.mjs); only accounts listed in the service's ADMINS get answers. */
  async admin<T = any>(path: string, method = 'GET', body?: object): Promise<T> {
    const r = await this.fetch(`${this.base}/api/admin/${path}`, { method, ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (r.status === 404 || r.status === 502) throw new JmapError('The admin console is off on this server. Set ADMINS for the account service to switch it on.');
    return aliasReply(r);
  }

  /** The identity a draft sends as: its chosen From address if the account still owns it, else the main one. */
  private async identityFor(d: Draft): Promise<Identity> {
    const main = await this.getIdentity();
    if (!d.from || d.from.toLowerCase() === main.email.toLowerCase()) return main;
    return (await this.identities()).find((i) => i.email.toLowerCase() === d.from!.toLowerCase()) ?? main;
  }

  /** Email/set create payload. Stalwart rejects explicit nulls on create, so optional fields are omitted when empty. */
  private async compose(d: Draft, mailboxId: string) {
    const me = await this.identityFor(d);
    return {
      mailboxIds: { [mailboxId]: true }, keywords: { $draft: true, $seen: true },
      from: [me.name && me.name !== me.email ? { name: me.name, email: me.email } : { email: me.email }],
      subject: d.subject,
      ...(d.to.length && { to: d.to.map(clean) }),
      ...(d.cc.length && { cc: d.cc.map(clean) }),
      ...(d.bcc?.length && { bcc: d.bcc.map(clean) }),
      ...(d.inReplyTo?.length && { inReplyTo: d.inReplyTo }),
      ...(d.references?.length && { references: d.references }),
      ...(d.receipt && { 'header:Disposition-Notification-To:asAddresses': [{ email: me.email }] }),
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

  // ── Tasks: each is a tiny message in a hidden "Tasks" folder (title = subject), so they sync everywhere ──
  // Keywords: $done when finished. Headers: X-OpenMail-Due (YYYY-MM-DD), X-OpenMail-Thread (the email it came from).

  async tasks(): Promise<Task[]> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === TASKS);
    if (!box) return [];
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: box.id }, sort: [{ property: 'receivedAt', isAscending: true }], limit: 1000 }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'keywords', 'receivedAt', 'header:X-OpenMail-Due:asText', 'header:X-OpenMail-Thread:asText'] }, 'g'],
    ]);
    return (r.list as any[]).map((e) => ({ id: e.id, title: e.subject ?? '', done: !!e.keywords?.$done, createdAt: e.receivedAt,
      due: e['header:X-OpenMail-Due:asText']?.trim() || null, threadId: e['header:X-OpenMail-Thread:asText']?.trim() || null }));
  }

  async addTask(title: string, opts: { due?: string | null; threadId?: string | null } = {}): Promise<string> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === TASKS)?.id ?? await this.createMailbox(TASKS);
    const [r] = await this.call([['Email/set', { accountId: this.accountId, create: { t: {
      mailboxIds: { [box]: true }, keywords: { $seen: true }, from: [{ email: this.username }], subject: title.trim().slice(0, 300),
      ...(opts.due && /^\d{4}-\d{2}-\d{2}$/.test(opts.due) && { 'header:X-OpenMail-Due:asText': opts.due }),
      ...(opts.threadId && /^[\w-]{1,64}$/.test(opts.threadId) && { 'header:X-OpenMail-Thread:asText': opts.threadId }),
      bodyValues: { t: { value: '' } }, textBody: [{ partId: 't', type: 'text/plain' }],
    } } }, 't']]);
    return r.created.t.id;
  }
  setTaskDone(id: string, done: boolean) { return this.call([['Email/set', { accountId: this.accountId, update: { [id]: { 'keywords/$done': done || null } } }, 'd']]); }
  deleteTask(id: string) { return this.call([['Email/set', { accountId: this.accountId, destroy: [id] }, 'x']]); }

  // ── Notes: like tasks, each a small message in a hidden "Notes" folder (title = subject, text = body) ──
  // Messages can't be edited in place, so saving replaces the old one in the same call. $pinned keeps a note on top.

  async notes(): Promise<Note[]> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === NOTES);
    if (!box) return [];
    const [, r] = await this.call([
      ['Email/query', { accountId: this.accountId, filter: { inMailbox: box.id }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 1000 }, 'q'],
      ['Email/get', { accountId: this.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'keywords', 'receivedAt', 'textBody', 'bodyValues'], fetchTextBodyValues: true }, 'g'],
    ]);
    return (r.list as any[]).map((e) => ({ id: e.id, title: e.subject ?? '', updatedAt: e.receivedAt, pinned: !!e.keywords?.$pinned,
      body: e.textBody?.[0] ? e.bodyValues?.[e.textBody[0].partId]?.value ?? '' : '' }));
  }

  /** Create or replace a note. Returns the new id (a replaced note gets a new id). */
  async saveNote(n: { id?: string; title: string; body: string; pinned?: boolean }): Promise<string> {
    const box = (await this.mailboxes(true)).find((b) => !b.role && b.name === NOTES)?.id ?? await this.createMailbox(NOTES);
    const [r] = await this.call([['Email/set', { accountId: this.accountId,
      create: { n: { mailboxIds: { [box]: true }, keywords: { $seen: true, ...(n.pinned && { $pinned: true }) }, from: [{ email: this.username }],
        subject: n.title.trim().slice(0, 300) || 'Untitled note', bodyValues: { t: { value: n.body } }, textBody: [{ partId: 't', type: 'text/plain' }] } },
      ...(n.id && { destroy: [n.id] }) }, 'n']]);
    return r.created.n.id;
  }
  deleteNote(id: string) { return this.call([['Email/set', { accountId: this.accountId, destroy: [id] }, 'x']]); }

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
    const me = await this.identityFor(d);
    const drafts = this.box(boxes, 'drafts'), sent = this.box(boxes, 'sent');
    // Your public key travels with every message (Autocrypt), so people can write back encrypted.
    const mine = await myKey(this.username).catch(() => undefined);
    const [created, sub] = await this.call([
      d.encrypt
        ? ['Email/import', { accountId: this.accountId, emails: { d: { blobId: (await this.upload(new Blob([await this.encrypted(d, me, mine?.keydata)], { type: 'message/rfc822' }))).blobId,
            mailboxIds: { [drafts]: true }, keywords: { $draft: true, $seen: true } } } }, 'e']
        : ['Email/set', { accountId: this.accountId, create: { d: { ...await this.compose(d, drafts),
            ...(mine && { 'header:Autocrypt:asText': autocryptHeader(me.email, mine.keydata) }) } }, destroy: d.id ? [d.id] : [] }, 'e'],
      ['EmailSubmission/set', {
        accountId: this.accountId,
        create: { s: { identityId: me.id, emailId: '#d', envelope: {
          mailFrom: { email: me.email, parameters: sendAt
            ? { HOLDUNTIL: sendAt.toISOString().replace(/\.\d+Z$/, 'Z') } : { HOLDFOR: String(UNDO_SECONDS) } },
          rcptTo: [...d.to, ...d.cc, ...(d.bcc ?? [])].map((a) => ({ email: a.email })),
        } } },
        onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null,
          ...(d.followUpDays && { 'keywords/$followup': true, [`keywords/$followup-${Math.floor((+(sendAt ?? new Date()) + d.followUpDays * 86400e3) / 1000)}`]: true }) } },
      }, 's'],
      ...(d.encrypt && d.id ? [['Email/set', { accountId: this.accountId, destroy: [d.id] }, 'x'] as [string, object, string]] : []), // the unencrypted autosaved draft
    ]);
    return { submissionId: sub.created.s.id, emailId: created.created.d.id };
  }

  /** The raw encrypted + signed message for a draft (pgp.ts loads only now). Encrypted to you too, so Sent stays readable. */
  private async encrypted(d: Draft, me: Identity, keydata?: string): Promise<string> {
    const privateKey = unlockedKey(this.username);
    if (!privateKey) throw new JmapError('Unlock your encryption key to send encrypted mail.');
    const people = [...d.to, ...d.cc, ...(d.bcc ?? [])];
    // A key under dispute (a different one turned up) isn't used until you choose one in Settings.
    const keys = await Promise.all(people.map(async (a) => { const k = await peerKey(a.email); return k?.conflict ? undefined : k?.publicKey; }));
    const missing = people.filter((_, i) => !keys[i]);
    if (missing.length) throw new JmapError(`There’s no encryption key for ${missing.map((a) => a.email).join(', ')}.`);
    const own = await myKey(this.username);
    const pgp = await import('./pgp');
    const files = await Promise.all(d.attachments.map(async (a) => ({ name: a.name ?? 'attachment', type: a.type, cid: a.cid ?? null, data: new Uint8Array(await (await this.download(a)).arrayBuffer()) })));
    return pgp.encryptedMessage({ from: { name: me.name && me.name !== me.email ? me.name : null, email: me.email }, to: d.to, cc: d.cc, subject: d.subject,
      html: d.html, text: d.text, files, inReplyTo: d.inReplyTo, references: d.references, autocrypt: keydata && autocryptHeader(me.email, keydata) },
      privateKey, [...(keys as string[]), ...(own ? [own.publicKey] : [])]);
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

  /** Send a read receipt the user chose to send. Not kept in Sent; the original is marked $MDNSent (RFC 3503). */
  async sendReadReceipt(m: EmailFull, boxes: Mailbox[]): Promise<void> {
    const to = m.receiptTo?.[0]?.email;
    if (!to) throw new JmapError('This message didn’t ask for a read receipt');
    const me = await this.getIdentity();
    const raw = buildMdn({ from: me.email, to, subject: m.subject ?? '', originalMessageId: m.messageId?.[0], readAt: new Date(),
      domain: me.email.split('@')[1], id: crypto.randomUUID() });
    const blob = await this.upload(Object.assign(new Blob([raw], { type: 'message/rfc822' }), { name: 'receipt.eml' }));
    const [imp] = await this.call([['Email/import', { accountId: this.accountId, emails: { r: {
      blobId: blob.blobId, mailboxIds: { [this.box(boxes, 'drafts')]: true }, keywords: { $seen: true } } } }, 'i']]);
    await this.call([
      ['EmailSubmission/set', { accountId: this.accountId,
        create: { s: { identityId: me.id, emailId: imp.created.r.id, envelope: { mailFrom: { email: me.email }, rcptTo: [{ email: to }] } } },
        onSuccessDestroyEmail: ['#s'] }, 's'],
      ['Email/set', { accountId: this.accountId, update: { [m.id]: { 'keywords/$mdnsent': true } } }, 'k'],
    ]);
  }

  /** Decline a receipt request: remember it so we don't ask again. */
  async declineReadReceipt(id: string) { await this.call([['Email/set', { accountId: this.accountId, update: { [id]: { 'keywords/$mdnsent': true } } }, 'k']]); }

  async undoSend(submissionId: string, emailId: string, boxes: Mailbox[]): Promise<void> {
    await this.call([
      ['EmailSubmission/set', { accountId: this.accountId, update: { [submissionId]: { undoStatus: 'canceled' } } }, 'u'],
      ['Email/set', { accountId: this.accountId, update: { [emailId]: {
        [`mailboxIds/${this.box(boxes, 'sent')}`]: null, [`mailboxIds/${this.box(boxes, 'drafts')}`]: true, 'keywords/$draft': true,
      } } }, 'm'],
    ]);
  }

  // ── Account security (needs a security-scoped client from a step-up sign-in) ──
  // Password and two-factor changes also require the current password (the server checks it).

  async security(): Promise<{ twoFactor: boolean; appPasswords: AppPassword[] }> {
    const [pw, apps] = await this.call([
      ['x:AccountPassword/get', { accountId: this.accountId, ids: ['singleton'] }, 'p'],
      ['x:AppPassword/get', { accountId: this.accountId, ids: null, properties: ['description', 'createdAt', 'expiresAt'] }, 'a'],
    ], [STALWART]);
    return {
      twoFactor: !!pw.list[0]?.otpAuth?.otpUrl,
      appPasswords: (apps.list as AppPassword[]).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    };
  }

  /** otpUrl null turns two-factor off. `code` is a current code from the authenticator app. */
  async setTwoFactor(currentPassword: string, otpUrl: string | null, code: string) {
    await this.call([['x:AccountPassword/set', { accountId: this.accountId, update: { singleton: {
      currentSecret: currentPassword, otpAuth: { otpUrl, otpCode: code } } } }, 's']], [STALWART]);
  }

  async changePassword(currentPassword: string, next: string) {
    await this.call([['x:AccountPassword/set', { accountId: this.accountId, update: { singleton: { currentSecret: currentPassword, secret: next } } }, 's']], [STALWART]);
  }

  /** Returns the new app password: shown once, never readable again. */
  /** App passwords get only what a mail, calendar or contacts app needs (IMAP, POP3, SMTP, ManageSieve, CalDAV,
   *  CardDAV), never admin or account-security rights, so a leaked one can't change the password or 2FA. */
  async createAppPassword(description: string): Promise<string> {
    const permissions = Object.fromEntries(APP_PASSWORD_PERMISSIONS.map((p) => [p, true]));
    const [r] = await this.call([['x:AppPassword/set', { accountId: this.accountId, create: { p: { description, permissions: { '@type': 'Replace', permissions } } } }, 'c']], [STALWART]);
    return r.created.p.secret;
  }

  // ── Encryption at rest and your public key (Stalwart x:PublicKey, x:AccountSettings; needs the step-up client
  //    with the settings scope, so a stolen everyday token can't swap the key your mail is encrypted to) ──

  async encryptionState(): Promise<{ keys: { id: string; kind: string | null; fingerprints: string[]; description: string }[]; atRest: string | null }> {
    const [k, s] = await this.call([
      ['x:PublicKey/get', { accountId: this.accountId, ids: null, properties: ['kind', 'fingerprints', 'description'] }, 'k'],
      ['x:AccountSettings/get', { accountId: this.accountId, ids: ['singleton'] }, 's'],
    ], [STALWART]);
    const ear = s.list[0]?.encryptionAtRest;
    return { keys: k.list, atRest: ear?.['@type'] === 'Enabled' ? ear.publicKey : null };
  }
  /** Upload a public key (OpenPGP, or an S/MIME certificate). Returns its id. */
  async addPublicKey(key: string, description: string): Promise<string> {
    const [r] = await this.call([['x:PublicKey/set', { accountId: this.accountId, create: { k: { key, description } } }, 'k']], [STALWART]);
    return r.created.k.id;
  }
  /** Turn encryption at rest on (to this key) or off (null). New mail only: what's stored stays as it is. */
  async setEncryptionAtRest(publicKeyId: string | null) {
    await this.call([['x:AccountSettings/set', { accountId: this.accountId, update: { singleton: {
      encryptionAtRest: publicKeyId ? { '@type': 'Enabled', publicKey: publicKeyId } : { '@type': 'Disabled' } } } }, 's']], [STALWART]);
  }

  async deleteAppPassword(id: string) { await this.call([['x:AppPassword/set', { accountId: this.accountId, destroy: [id] }, 'd']], [STALWART]); }

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
