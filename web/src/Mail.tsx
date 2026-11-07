import { Fragment, Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmIt, promptIt } from './Dialog';
import { Button } from './Button';
import { Compose, type ComposeApi } from './Compose';
import { Icon, roleIcon } from './icons';
import { Jmap, UNDO_SECONDS, type Attachment, type Contact, type Subscription, type Address, type Draft, type EmailFull, type EmailSummary, type Filter, type Identity, type Mailbox, type Scheduled } from './jmap';
import { addSignature, chooseSignature, displayName, draftFor, draftFromEmail, formatAddresses, parseAddresses, textToHtml, unsubscribePlan, type ReplyMode, type Signature } from './mailutil';
import { Menu, TimeChoices } from './Menu';
import { Palette, type Command } from './Palette';
import { SubscriptionsList } from './Subscriptions';
import { ContactList, ContactPanel, fullName } from './Contacts';
import { CalendarView } from './CalendarView';
import { localZone } from './calendar';
import type { PartStat } from './ics';
import { Reader, shortDate, type Action, type MoreAction } from './Reader';
import { addRule, loadScript, saveScript } from './Filters';
import { SCREENER, UPDATES, type Rule, type ScriptData } from './rules';
import { notifyOn, showMail } from './notify';
import { buildSrcdoc } from './safeHtml';
import { parseSearch } from './search';
import { applyTheme, Settings } from './Settings';
import { cache } from './store';
import { describe } from './when';

const PAGE = 50;
const FALLBACK_POLL_MS = 5 * 60_000; // push does the real work; this only covers a silently dead stream
const EMPTY_DRAFT: Draft = { to: [], cc: [], subject: '', html: '', text: '', attachments: [] };
// Virtual folders: views that aren't mailboxes on the server.
const STARRED = 'starred', SCHEDULED = 'scheduled', SUBSCRIPTIONS = 'subscriptions', CONTACTS = 'contacts', CALENDAR = 'calendar';

type Toast = { text: string; undo?: () => void } | null;
type BulkAction = Action | 'read' | { snooze: Date } | { moveTo: string | null; label: boolean };

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev: { resetKey: unknown }) { if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p className="empty">This conversation couldn’t be displayed. Try another one, or reload the page.</p> : this.props.children; }
}

export function Mail({ client, onLogout }: { client: Jmap; onLogout: () => void }) {
  const key = (k: string) => `${client.username}:${k}`;
  const [boxes, setBoxes] = useState<Mailbox[]>(() => cache.get(key('boxes')) ?? []);
  const [view, setView] = useState<string | null>(null); // mailbox id or virtual folder; null = Inbox
  const [tab, setTab] = useState<'primary' | 'updates'>('primary'); // Inbox categories
  const [categories, setCategories] = useState(true);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [saved, setSaved] = useState<{ name: string; query: string }[]>([]);
  const [people, setPeople] = useState<Contact[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [editingPerson, setEditingPerson] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState<EmailSummary[] | null>(null);
  /** Priority Inbox: how many rows at the top are "Important and unread" (from people you write to). */
  const [important, setImportant] = useState(0);
  const correspondents = useRef<Set<string>>(new Set());
  const [scheduled, setScheduled] = useState<Scheduled[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<EmailFull[] | null>(null);
  const [readerError, setReaderError] = useState('');
  const [compose, setCompose] = useState<Draft | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [overlay, setOverlay] = useState<'help' | 'settings' | 'palette' | null>(null);
  const [threadVersion, setThreadVersion] = useState(0); // bump to reload the open conversation
  const [contacts, setContacts] = useState<Address[]>(() => cache.get(key('contacts')) ?? []);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [rulePrefill, setRulePrefill] = useState<Partial<Rule> | undefined>();
  const toastTimer = useRef<number>(0);
  const lastClicked = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const goPending = useRef(false);

  const inbox = boxes.find((b) => b.role === 'inbox')?.id ?? null;
  /** Cache key for a list: the Inbox has one per category tab. */
  const listKey = (box: string | null) => `list:${box}${box && box === inbox && categories ? `:${tab}` : ''}`;
  const current = query ? null : view ?? inbox;
  const currentBox = boxes.find((b) => b.id === current);
  const role = [STARRED, SCHEDULED, SUBSCRIPTIONS, CONTACTS, CALENDAR].includes(current ?? '') ? current : currentBox?.role ?? null;
  // Moves need a real source folder; from Starred or search results, act on the Inbox copy.
  const source = currentBox ? currentBox.id : inbox;
  const folders = useMemo(() => boxes.filter((b) => (!b.role || b.role === 'archive' || b.role === 'inbox') && b.id !== source), [boxes, source]);

  const say = useCallback((t: Toast, ms = 4000) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    if (t && ms) toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const fail = (e: unknown) => say({ text: `Couldn’t do that: ${(e as Error).message}` }, 6000);

  // ── Loading ────────────────────────────────────────────

  // Paging: the list shows `limit` conversations and grows as you scroll. A ref, so growing it doesn't count as
  // switching folders (which clears the selection).
  // ponytail: each refresh re-reads the first `limit` rows; fine into the low thousands. Upgrade: Email/queryChanges.
  const limit = useRef(PAGE);
  const [hasMore, setHasMore] = useState(false);
  const loadingMore = useRef(false);
  const refresh = useCallback(async () => {
    try {
      let b = await client.mailboxes();
      const woke = await client.wakeSnoozed(b);
      if (woke) { b = await client.mailboxes(); say({ text: woke === 1 ? 'A snoozed conversation is back in your Inbox' : `${woke} snoozed conversations are back in your Inbox` }); }
      const nudged = await client.sweep(b).catch(() => 0); // muted conversations, follow-up reminders
      if (nudged) say({ text: nudged === 1 ? 'No reply yet to a message you sent: it’s back in your Inbox' : `${nudged} sent messages got no reply: they’re back in your Inbox` });
      setBoxes(b); cache.set(key('boxes'), b);
      const box = query ? null : view ?? b.find((x) => x.role === 'inbox')?.id ?? null;
      if (box === SCHEDULED) { setScheduled(await client.scheduled()); return; }
      if (box === SUBSCRIPTIONS) { setSubs(await client.subscriptions()); return; }
      if (box === CONTACTS) { setPeople(await client.addressBook()); return; }
      if (box === CALENDAR) return; // the calendar loads its own week
      const isInbox = b.find((x) => x.id === box)?.role === 'inbox';
      const filter: Filter = query ? parseSearch(query, b) : box === STARRED ? { hasKeyword: '$flagged' }
        : isInbox && categories ? { operator: 'AND', conditions: [{ inMailbox: box }, tab === 'updates' ? { hasKeyword: UPDATES } : { notKeyword: UPDATES }] }
        : { inMailbox: box };
      const l = await client.threads(filter, limit.current + 1); // one extra tells us whether there's more
      setHasMore(l.length > limit.current);
      let page = l.slice(0, limit.current);
      // Priority Inbox (Primary only): unread mail from people you write to comes first, under its own label.
      let top = 0;
      if (isInbox && !query && (!categories || tab !== 'updates')) {
        const imp = (e: EmailSummary) => !e.keywords.$seen && !!e.from?.some((a) => correspondents.current.has(a.email.toLowerCase()));
        const first = page.filter(imp);
        top = first.length;
        if (top) page = [...first, ...page.filter((e) => !imp(e))];
      }
      setImportant(top);
      setList(page);
      if (!query) cache.set(key(listKey(box)), page.slice(0, PAGE));
    } catch (e) { say({ text: e instanceof Error ? e.message : String(e) }); }
  }, [client, view, query, tab, categories]);

  useEffect(() => {
    setList(query ? null : cache.get(key(listKey(view ?? inbox))));
    setSelected(new Set());
    limit.current = PAGE;
    const t = setTimeout(refresh, query ? 300 : 0); // debounce typing in search
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => { clearTimeout(t); clearInterval(poll); window.removeEventListener('focus', refresh); };
  }, [refresh]);

  // Live updates: the server pushes a note whenever anything changes; coalesce bursts.
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { client.correspondents().then((s) => { correspondents.current = s; refreshRef.current(); }, () => {}); }, [client]);
  async function loadMore() {
    if (loadingMore.current) return;
    loadingMore.current = true; limit.current += PAGE;
    try { await refresh(); } finally { loadingMore.current = false; }
  }
  const inboxRef = useRef(inbox); inboxRef.current = inbox;
  const openRef = useRef((_: string) => {});
  useEffect(() => {
    let t = 0, since = new Date().toISOString();
    return client.watch(() => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        refreshRef.current(); setThreadVersion((v) => v + 1);
        const box = inboxRef.current;
        if (!box || !notifyOn()) return;
        client.arrivedSince(box, since).then((l) => {
          if (l[0]) since = l[0].receivedAt;
          if (!document.hasFocus()) l.slice(0, 3).forEach((e) => showMail(e, () => openRef.current(e.threadId)));
        }, () => {});
      }, 400);
    });
  }, [client]);

  // Autocomplete: address book entries first (they have proper names), then people from recent mail.
  const loadContacts = useCallback(() => Promise.all([client.addressBook().catch(() => [] as Contact[]), client.contacts()]).then(([book, recent]) => {
    const seen = new Set<string>();
    const merged = [...book.flatMap((p) => p.emails.map((email) => ({ name: fullName(p) || null, email }))), ...recent]
      .filter((a) => !seen.has(a.email.toLowerCase()) && seen.add(a.email.toLowerCase()));
    setContacts(merged); cache.set(key('contacts'), merged);
  }, () => {}), [client]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const loadIdentity = useCallback(() => {
    client.getIdentityFresh().then(setIdentity, () => {});
    client.identities().then((l) => setIdentities(l.sort((a, b) => Number(b.email === client.username) - Number(a.email === client.username))), () => {});
  }, [client]);
  useEffect(() => { loadContacts(); loadIdentity(); }, [loadContacts, loadIdentity]);

  const [sigData, setSigData] = useState<Pick<ScriptData, 'signatures' | 'sigNew' | 'sigReply'>>({});
  // Accounts from before named signatures: the identity's one signature is the only one.
  const signatures: Signature[] = sigData.signatures ?? (identity?.textSignature?.trim() ? [{ name: 'Signature', text: identity.textSignature }] : []);
  const reloadCategories = () => loadScript(client).then(({ data }) => { setCategories(data.categories !== false); setSigData(data); }, () => {});

  // Inbox categories: install the server rule (and tag existing mail) the first time this account opens the app.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await loadScript(client);
        setCategories(data.categories !== false);
        setSaved(data.savedSearches ?? []);
        setSigData(data);
        if (data.categories !== undefined) return;
        const b = await client.mailboxes();
        await saveScript(client, b, (d) => ({ ...d, categories: d.categories ?? true }));
        const inboxId = b.find((x) => x.role === 'inbox')?.id;
        if (inboxId && await client.tagUpdates(inboxId)) refreshRef.current();
      } catch { /* categories are a nicety: the inbox still works without them */ }
    })();
  }, [client]);

  useEffect(() => {
    if (!threadId) { setMessages(null); return; }
    let live = true;
    setReaderError('');
    client.thread(threadId).then((m) => {
      if (!live) return;
      setMessages(m);
      if (m.some((x) => !x.keywords.$seen)) {
        // Optimistic: update the UI first, server second.
        setList((l) => l?.map((x) => (x.threadId === threadId ? { ...x, keywords: { ...x.keywords, $seen: true } } : x)) ?? l);
        client.setSeen(threadId, true).catch(() => refresh());
      }
    }, (e) => live && setReaderError(e.message));
    return () => { live = false; };
  }, [client, threadId, threadVersion]);
  useEffect(() => setMessages(null), [threadId]); // loading bar only when switching conversations

  function openFolder(id: string) { setView(id); setQuery(''); setThreadId(null); }

  // In Drafts, opening a conversation resumes the draft in the editor.
  openRef.current = (tid) => { setQuery(''); setView(null); openThread(tid); }; // from a notification: show it in the Inbox
  async function openThread(tid: string) {
    if (role !== 'drafts') return setThreadId(tid);
    try {
      const draft = (await client.thread(tid)).filter((m) => m.keywords.$draft).pop();
      if (draft) setCompose(draftFromEmail(draft)); else setThreadId(tid);
    } catch (e) { fail(e); }
  }

  // ── Actions (one conversation or a selection) ──────────

  const targets = () => (selected.size ? [...selected] : threadId ? [threadId] : []);

  async function act(a: BulkAction, tids = targets()) {
    if (!tids.length || !source) return;
    const n = tids.length, many = n > 1 ? `${n} conversations` : 'Conversation';
    if (a === 'trash' && role === 'trash' && !(await confirmIt({ title: `Delete ${n > 1 ? `${n} conversations` : 'this conversation'} forever?`, body: 'This can’t be undone.', confirm: 'Delete forever', danger: true }))) return;
    const inList = (id: string) => list?.find((x) => x.threadId === id);

    if (a === 'star') {
      const on = !tids.every((id) => (id === threadId ? messages?.some((m) => m.keywords.$flagged) : inList(id)?.keywords.$flagged));
      const flag = (k: Record<string, boolean>) => ({ ...k, $flagged: on });
      setList((l) => (role === STARRED && !on ? l?.filter((x) => !tids.includes(x.threadId)) : l?.map((x) => (tids.includes(x.threadId) ? { ...x, keywords: flag(x.keywords) } : x))) ?? l);
      if (threadId && tids.includes(threadId)) setMessages((ms) => ms?.map((m) => ({ ...m, keywords: flag(m.keywords) })) ?? ms);
      try { await Promise.all(tids.map((t) => client.setStarred(t, on))); } catch (e) { fail(e); refresh(); }
      return;
    }
    if (a === 'unread' || a === 'read') {
      const seen = a === 'read';
      setList((l) => l?.map((x) => (tids.includes(x.threadId) ? { ...x, keywords: { ...x.keywords, $seen: seen } } : x)) ?? l);
      if (!seen && threadId && tids.includes(threadId)) setThreadId(null);
      setSelected(new Set());
      try { await Promise.all(tids.map((t) => client.setSeen(t, seen))); say({ text: seen ? 'Marked as read' : 'Marked as unread' }); } catch (e) { fail(e); }
      return refresh();
    }

    let target: string | null = null, label = false;
    if (typeof a === 'object' && 'moveTo' in a) {
      label = a.label;
      target = a.moveTo;
      if (!target) {
        const name = await promptIt({ title: 'New folder', label: 'Folder name', placeholder: 'e.g. Receipts', confirm: 'Create folder' });
        if (!name) return;
        try { target = await client.createMailbox(name); } catch (e) { return fail(e); }
      }
    }

    // Everything else removes the conversations from this view (a label keeps them).
    if (!label) {
      const idx = list?.findIndex((x) => x.threadId === threadId) ?? -1;
      const rest = list?.filter((x) => !tids.includes(x.threadId)) ?? [];
      setList(rest);
      // Keep the reading flow going: open the next conversation, like Gmail's auto-advance.
      if (threadId && tids.includes(threadId)) setThreadId(rest[Math.min(idx, rest.length - 1)]?.threadId ?? null);
    }
    setSelected(new Set());

    try {
      const each = (f: (t: string) => Promise<unknown>) => Promise.all(tids.map(f));
      const box = (r: string) => boxes.find((b) => b.role === r)!.id;
      if (typeof a === 'object' && 'snooze' in a) { await each((t) => client.snooze(t, source, a.snooze, boxes)); say({ text: `${many} snoozed until ${describe(a.snooze)}` }); }
      else if (typeof a === 'object') {
        const name = boxes.find((b) => b.id === target)?.name ?? 'the new folder';
        await each((t) => (label ? client.addToMailbox(t, target!) : client.move(t, source, target!)));
        say({ text: label ? `Labelled ${name}` : `${many} moved to ${name}` });
      }
      else if (a === 'mute') { await each((t) => client.mute(t, source, boxes)); say({ text: `${many} muted. New replies will skip your Inbox.` }); }
      else if (a === 'archive') { const to = await client.mailboxFor('archive', 'Archive', boxes); await each((t) => client.move(t, source, to)); say({ text: `${many} archived` }); }
      else if (a === 'trash' && role === 'trash') { await each((t) => client.destroyThread(t, source)); say({ text: 'Deleted forever' }); }
      else if (a === 'trash') { await each((t) => client.move(t, source, box('trash'))); say({ text: 'Moved to Deleted Items' }); }
      else if (a === 'junk' && role === 'junk') { await each((t) => client.move(t, source, inbox!, { $junk: null, $notjunk: true })); say({ text: 'Moved to Inbox and marked not spam' }); }
      else if (a === 'junk') { await each((t) => client.move(t, source, box('junk'), { $junk: true, $notjunk: null })); say({ text: 'Reported as spam' }); }
    } catch (e) { fail(e); }
    refresh();
  }

  /** Shared by the reader's Unsubscribe link and the Subscriptions page. Returns true when it went through. */
  async function unsubscribe(m: Pick<EmailFull, 'unsubscribe'> & { from: Address[] | null }): Promise<boolean> {
    const who = displayName(m.from?.[0]);
    const plan = unsubscribePlan(m.unsubscribe);
    if (!plan) { say({ text: `This message doesn’t include a safe way to unsubscribe from ${who}.` }, 6000); return false; }
    const where = plan.kind === 'mail' ? `by sending an email to ${plan.to}` : plan.kind === 'post' ? `via ${plan.host}` : `on ${plan.host} (opens in a new tab)`;
    if (!(await confirmIt({ title: `Unsubscribe from ${who}?`, body: `This is done ${where}.`, confirm: 'Unsubscribe' }))) return false;
    try {
      if (plan.kind === 'post') {
        // RFC 8058 one-click: a plain form POST. no-cors because we never need to read the reply.
        await fetch(plan.url, { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
        say({ text: `Unsubscribed from ${who}` });
      } else if (plan.kind === 'mail') {
        await client.send({ to: [{ name: null, email: plan.to }], cc: [], subject: 'unsubscribe', html: '<p>unsubscribe</p>', text: 'unsubscribe', attachments: [] }, boxes);
        say({ text: `Sent an unsubscribe request to ${plan.to}` });
      } else {
        window.open(plan.url, '_blank', 'noopener,noreferrer');
        say({ text: `Opened ${plan.host} to finish unsubscribing` });
      }
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function deleteAllFrom(s: Subscription) {
    const who = displayName(s.from);
    if (!(await confirmIt({ title: `Delete everything from ${who}?`, body: `Every message from ${s.from.email} moves to Deleted Items. Sent mail and drafts are kept.`, confirm: 'Move to Deleted Items', danger: true }))) return;
    try { const n = await client.trashFrom(s.from.email, boxes); say({ text: `Moved ${n} messages from ${who} to Deleted Items` }); refresh(); }
    catch (e) { fail(e); }
  }

  async function saveSearch() {
    const name = await promptIt({ title: 'Save this search', body: 'It appears in the sidebar, one click away.', label: 'Name', value: query, confirm: 'Save search' });
    if (!name) return;
    try {
      let next: { name: string; query: string }[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, savedSearches: (next = [...(d.savedSearches ?? []).filter((x) => x.name !== name), { name, query }]) }));
      setSaved(next); say({ text: `Saved “${name}”` });
    } catch (e) { fail(e); }
  }

  async function removeSearch(name: string) {
    try {
      let next: { name: string; query: string }[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, savedSearches: (next = (d.savedSearches ?? []).filter((x) => x.name !== name)) }));
      setSaved(next);
    } catch (e) { fail(e); }
  }

  async function more(what: MoreAction, m: EmailFull) {
    const sender = m.from?.[0]?.email ?? '';
    try {
      if (what === 'original') {
        const url = URL.createObjectURL(new Blob([await client.original(m)], { type: 'text/plain;charset=utf-8' }));
        window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else if (what === 'print') {
        // Print from a hidden sandboxed frame: same isolation as reading (CSP, trackers removed). allow-same-origin
        // lets us call print(); without allow-scripts nothing in the message can run. allow-modals shows the dialog.
        const head = `<h1 style="font:600 20px system-ui">${escape(m.subject ?? '')}</h1><p style="font:13px system-ui;color:#555">From: ${escape(formatAddresses(m.from))}<br>To: ${escape(formatAddresses(m.to))}<br>${new Date(m.receivedAt).toLocaleString()}</p><hr>`;
        const frame = Object.assign(document.createElement('iframe'), { srcdoc: buildSrcdoc(head + (m.html ?? textToHtml(m.text ?? '')), false).srcdoc });
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
        frame.onload = () => { frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); };
        document.body.appendChild(frame);
      } else if (what === 'unmute') {
        await client.unmute(m.threadId); setThreadVersion((v) => v + 1); say({ text: 'Unmuted' });
      } else if (what === 'filter') {
        setRulePrefill({ from: sender }); setOverlay('settings');
      } else if (what === 'addContact') {
        const name = m.from?.[0]?.name?.trim() ?? '';
        const [given, ...rest] = name.split(/\s+/);
        await client.saveContact({ given: given ?? '', surname: rest.join(' '), emails: [sender], phones: [], org: '', note: '' });
        say({ text: `Added ${name || sender} to contacts` }); loadContacts();
      } else if (what === 'block') {
        if (!parseAddresses(sender).list.length) return say({ text: 'This sender’s address can’t be blocked safely. Use a filter instead.' });
        if (!(await confirmIt({ title: `Block ${sender}?`, body: 'Messages from exactly this address go straight to Junk. You can undo this in Settings → Filters.', confirm: 'Block', danger: true }))) return;
        await addRule(client, boxes, { id: crypto.randomUUID(), from: sender, fromExact: true, action: 'block' });
        await act('junk', [m.threadId]);
        say({ text: `Blocked ${sender}` });
      }
    } catch (e) { fail(e); }
  }
  async function rsvp(m: EmailFull, ics: Attachment, status: PartStat) {
    const was = (['accepted', 'tentative'] as const).some((p) => m.keywords[`$rsvp-${p}`]);
    try {
      const inv = await client.rsvp(m.id, ics, status, boxes);
      // Yes / Maybe also put it in the calendar, once (changing Maybe → Yes doesn't duplicate it).
      let added = false;
      if (status !== 'DECLINED' && !was && !(await client.hasEvent(inv.uid))) {
        const [ev] = await client.parseInvite(ics.blobId);
        if (ev) { await client.saveEvent({ ...ev, id: undefined, uid: inv.uid, timeZone: ev.timeZone || localZone() }); added = true; }
      }
      say({ text: `Replied “${{ ACCEPTED: 'Yes', TENTATIVE: 'Maybe', DECLINED: 'No' }[status]}” to ${inv.organizerEmail}${added ? ' and added it to your calendar' : ''}` });
      setThreadVersion((v) => v + 1);
    } catch (e) { fail(e); }
  }

  async function receipt(m: EmailFull, send: boolean) {
    try {
      if (send) { await client.sendReadReceipt(m, boxes); say({ text: `Read receipt sent to ${m.receiptTo?.[0]?.email}` }); }
      else { await client.declineReadReceipt(m.id); say({ text: 'No receipt sent' }); }
      setThreadVersion((v) => v + 1);
    } catch (e) { fail(e); }
  }

  const escape = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // ── Writing ────────────────────────────────────────────

  const withSignature = (d: Draft, kind: 'new' | 'reply' = 'new'): Draft =>
    ({ ...d, html: addSignature(d.html, chooseSignature(signatures, kind === 'new' ? sigData.sigNew : sigData.sigReply)) });
  const newMessage = () => setCompose(withSignature(EMPTY_DRAFT));
  function reply(mode: ReplyMode, e: EmailFull) { setCompose(withSignature(draftFor(mode, e, client.username, identities.map((i) => i.email)), 'reply')); }

  const composeApi: ComposeApi = {
    upload: (f) => client.upload(f),
    save: (d) => client.saveDraft(d, boxes),
    discard: (id) => client.deleteDraft(id),
    download: (a) => client.download(a),
    templates: () => client.templates(),
    saveTemplate: (d) => client.saveTemplate(d),
    deleteTemplate: (id) => client.deleteTemplate(id),
  };
  function closeCompose(outcome: 'saved' | 'discarded' | 'closed') {
    setCompose(null);
    if (outcome === 'saved') say({ text: 'Draft saved' });
    if (outcome === 'discarded') say({ text: 'Draft discarded' });
    refresh();
  }

  /** Screener: people you write to are people you want to hear from. */
  async function approveRecipients(d: Draft) {
    try {
      const { data } = await loadScript(client);
      const to = [...d.to, ...d.cc, ...(d.bcc ?? [])].map((a) => a.email.toLowerCase());
      if (!data.screener?.on || to.every((a) => data.screener!.allow.includes(a))) return; // nothing new: skip the write
      await saveScript(client, boxes, (s) => (s.screener?.on ? { ...s, screener: { on: true, allow: [...new Set([...s.screener.allow, ...to])] } } : s));
    } catch { /* the message went out; approving can happen from the Screener */ }
  }

  /** Screener decision for one sender: yes → Inbox from now on (and what's waiting moves there); no → blocked. */
  async function screen(sender: string, yes: boolean) {
    const s = sender.toLowerCase();
    try {
      const screenerBox = boxes.find((b) => !b.role && b.name === SCREENER)?.id;
      if (yes) {
        await saveScript(client, boxes, (d) => ({ ...d, screener: { on: d.screener?.on ?? true, allow: [...new Set([...(d.screener?.allow ?? []), s])] } }));
      } else await addRule(client, boxes, { id: crypto.randomUUID(), from: s, fromExact: true, action: 'block' });
      const waiting = (list ?? []).filter((e) => e.from?.some((a) => a.email.toLowerCase() === s));
      setList((l) => l?.filter((e) => !waiting.includes(e)) ?? l);
      if (screenerBox) await Promise.all(waiting.map((e) => client.move(e.threadId, screenerBox, yes ? inbox! : boxes.find((b) => b.role === 'junk')!.id, yes ? {} : { $junk: true })));
      say({ text: yes ? `${sender} can reach your Inbox` : `${sender} is blocked. Undo in Settings → Filters.` });
    } catch (e) { fail(e); }
    refresh();
  }

  async function send(d: Draft, sendAt?: Date) {
    setCompose(null);
    const pending = client.send(d, boxes, sendAt);
    let undone = false;
    const undo = async () => {
      undone = true;
      say({ text: sendAt ? 'Cancelling…' : 'Undoing…' }, 0);
      try {
        const { submissionId, emailId } = await pending;
        await client.undoSend(submissionId, emailId, boxes);
        say({ text: sendAt ? 'Schedule cancelled. Your message is back in the editor.' : 'Sending undone. Your message is back in the editor.' });
        setCompose({ ...d, id: emailId }); // it's a draft again
      } catch { say({ text: 'Too late to undo. The message was sent.' }); }
      refresh();
    };
    say({ text: sendAt ? `Scheduled for ${describe(sendAt)}` : 'Sending…', undo }, sendAt ? 8000 : UNDO_SECONDS * 1000);
    try { await pending; loadContacts(); approveRecipients(d); } catch (e) {
      say({ text: `Not sent: ${(e as Error).message}` }, 8000);
      setCompose(d); // never lose what someone wrote
      return;
    }
    if (sendAt) return refresh();
    // After the undo window, ask the server how delivery went: a refused recipient is reported, not hidden.
    setTimeout(async () => {
      if (undone) return;
      const { submissionId } = await pending;
      const problems = await client.deliveryProblems(submissionId).catch(() => []);
      say(problems.length
        ? { text: `Not delivered to ${problems.map((p) => p.email).join(', ')}: ${problems[0].reason}` }
        : { text: 'Message sent' }, problems.length ? 10000 : 4000);
      refresh(); setThreadVersion((v) => v + 1);
    }, UNDO_SECONDS * 1000 + 1500);
  }

  async function editScheduled(s: Scheduled) {
    if (!(await confirmIt({ title: 'Edit this scheduled message?', body: `“${s.email.subject || '(no subject)'}” won’t go out on ${describe(new Date(s.sendAt))} until you schedule or send it again.`, confirm: 'Edit message' }))) return;
    try {
      await client.undoSend(s.submissionId, s.email.id, boxes);
      const draft = (await client.thread(s.email.threadId)).find((m) => m.id === s.email.id);
      if (draft) setCompose(draftFromEmail(draft));
      refresh();
    } catch (e) { fail(e); }
  }

  // ── Selection ──────────────────────────────────────────

  function toggleSelect(tid: string, range: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      const ids = list?.map((x) => x.threadId) ?? [];
      if (range && lastClicked.current) {
        const [a, b] = [ids.indexOf(lastClicked.current), ids.indexOf(tid)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach((id) => next.add(id));
      } else if (next.has(tid)) next.delete(tid); else next.add(tid);
      return next;
    });
    lastClicked.current = tid;
  }
  const allSelected = !!list?.length && list.every((x) => selected.has(x.threadId));

  // ── Keyboard + command palette ─────────────────────────

  const last = messages?.[messages.length - 1];
  const navItems = [
    ...boxes.slice(0, 1),
    { id: STARRED, name: 'Starred', role: STARRED, unreadEmails: 0, sortOrder: 0 },
    ...boxes.slice(1).flatMap((b) => (b.role === 'drafts' ? [b, { id: SCHEDULED, name: 'Scheduled', role: SCHEDULED, unreadEmails: 0, sortOrder: 0 }] : [b])),
    { id: SUBSCRIPTIONS, name: 'Subscriptions', role: SUBSCRIPTIONS, unreadEmails: 0, sortOrder: 0 },
    { id: CONTACTS, name: 'Contacts', role: CONTACTS, unreadEmails: 0, sortOrder: 0 },
    { id: CALENDAR, name: 'Calendar', role: CALENDAR, unreadEmails: 0, sortOrder: 0 },
  ];

  const commands: Command[] = [
    { id: 'compose', label: 'Compose new message', icon: 'compose', hint: 'c', run: newMessage },
    { id: 'search', label: 'Search mail', icon: 'search', hint: '/', run: () => searchRef.current?.focus() },
    ...navItems.map((b) => ({ id: 'go-' + b.id, label: `Go to ${b.name}`, icon: roleIcon(b.role), run: () => openFolder(b.id) })),
    ...(last ? [
      { id: 'reply', label: 'Reply', icon: 'reply' as const, hint: 'r', run: () => reply('reply', last) },
      { id: 'replyall', label: 'Reply all', icon: 'replyAll' as const, hint: 'a', run: () => reply('replyAll', last) },
      { id: 'forward', label: 'Forward', icon: 'forward' as const, hint: 'f', run: () => reply('forward', last) },
      { id: 'archive', label: 'Archive conversation', icon: 'archive' as const, hint: 'e', run: () => act('archive') },
      { id: 'snooze', label: 'Snooze until tomorrow morning', icon: 'clock' as const, run: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); act({ snooze: d }); } },
    ] : []),
    { id: 'settings', label: 'Settings: name, signature, out-of-office', icon: 'settings', run: () => setOverlay('settings') },
    { id: 'theme-dark', label: 'Theme: dark', icon: 'settings', run: () => applyTheme('dark') },
    { id: 'theme-light', label: 'Theme: light', icon: 'settings', run: () => applyTheme('light') },
    { id: 'theme-system', label: 'Theme: match device', icon: 'settings', run: () => applyTheme('system') },
    { id: 'help', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: () => setOverlay('help') },
    { id: 'logout', label: 'Sign out', icon: 'back', run: onLogout },
  ];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !compose) { e.preventDefault(); setOverlay((o) => (o === 'palette' ? null : 'palette')); return; }
      const t = e.target as HTMLElement;
      if (compose || overlay || e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, [contenteditable], [role=menu]')) return;
      const ids = list?.map((x) => x.threadId) ?? [];
      const i = threadId ? ids.indexOf(threadId) : -1;
      // Gmail-style "g then a letter" to jump between places.
      if (goPending.current) {
        goPending.current = false;
        const role = { i: 'inbox', t: 'sent', d: 'drafts' }[e.key];
        const to = role ? boxes.find((b) => b.role === role)?.id : { s: STARRED, c: CONTACTS, k: CALENDAR }[e.key];
        if (to) { e.preventDefault(); openFolder(to); }
        return;
      }
      if (e.key === 'g') { goPending.current = true; setTimeout(() => { goPending.current = false; }, 1500); return; }
      const keys: Record<string, () => void> = {
        j: () => ids.length && openThread(ids[Math.min(i + 1, ids.length - 1)]),
        k: () => ids.length && openThread(ids[Math.max(i - 1, 0)]),
        x: () => threadId && toggleSelect(threadId, false),
        m: () => act('mute'), e: () => act('archive'), ']': () => act('archive'), z: () => toast?.undo?.(), '#': () => act('trash'), '!': () => act('junk'), u: () => act('unread'), s: () => act('star'),
        I: () => act('read'), U: () => act('unread'),
        r: () => last && reply('reply', last), a: () => last && reply('replyAll', last), f: () => last && reply('forward', last),
        c: newMessage, '/': () => searchRef.current?.focus(), '?': () => setOverlay('help'),
        Escape: () => { if (selected.size) setSelected(new Set()); else setThreadId(null); },
      };
      const run = keys[e.key];
      if (run) { e.preventDefault(); run(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── View ───────────────────────────────────────────────

  const heading = query ? `Results for “${query}”` : navItems.find((b) => b.id === current)?.name ?? 'Inbox';
  const inScreener = !role && currentBox?.name === SCREENER;
  /** Folders you made (labels): shown as chips on rows that are also filed there. */
  const userFolders = useMemo(() => new Map(boxes.filter((b) => !b.role && b.name !== SCREENER).map((b) => [b.id, b.name])), [boxes]);
  const emptyText = query ? `No messages match “${query}”. Try from:, subject: or has:attachment.`
    : role === 'inbox' ? 'You’re all caught up.'
    : role === STARRED ? 'Star a conversation to keep it here. Press s while reading.'
    : role === 'snoozed' ? 'Snoozed conversations wait here until their time comes.'
    : `Nothing in ${heading}.`;
  const selectionMenu = (kind: 'move' | 'label') => (
    <Menu label={kind === 'move' ? 'Move to' : 'Label as'} button={<Button variant="quiet" size="sm" icon={kind === 'move' ? 'folder' : 'tag'} label={kind === 'move' ? 'Move to folder' : 'Label as'} />}>
      {(close) => <>
        <p className="menu-title">{kind === 'move' ? 'Move to' : 'Label as'}</p>
        {folders.map((f) => <button key={f.id} className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: f.id, label: kind === 'label' }); }}><Icon name="folder" size={16} />{f.path ?? f.name}</button>)}
        <button className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: null, label: kind === 'label' }); }}><Icon name="compose" size={16} />New folder…</button>
      </>}
    </Menu>
  );

  return (
    <div className={`app${role === CALENDAR ? ' calendar-mode' : ''}${threadId || (role === CONTACTS && (personId || editingPerson)) ? ' reading' : ''}`}>
      <nav className="rail" aria-label="Folders">
        <p className="wordmark">OpenMail</p>
        <Button variant="primary" size="lg" icon="compose" className="compose-btn" onClick={newMessage} title="Compose (c)">Compose</Button>
        {/* Mail places first, then the folders you made, under their own label. */}
        {[navItems.filter((b) => b.role), navItems.filter((b) => !b.role)].map((group, gi) => group.length > 0 && (
          <div key={gi} className="rail-group">
            {gi === 1 && <p className="rail-label">Folders</p>}
            <ul>
              {group.map((b) => (
                <li key={b.id}>
                  <button className={`nav-item${b.id === current ? ' active' : ''}`} aria-current={b.id === current ? 'page' : undefined} onClick={() => openFolder(b.id)}
                    style={b.depth ? { paddingLeft: `calc(var(--s3) + ${b.depth} * var(--s4))` } : undefined}>
                    <Icon name={roleIcon(b.role)} /><span className="name">{b.name}</span>
                    {b.unreadEmails > 0 && !['trash', 'sent', 'drafts'].includes(b.role ?? '') && <span className="count">{b.unreadEmails}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {saved.length > 0 && (
          <div className="saved">
            <p className="rail-label">Saved searches</p>
            <ul>
              {saved.map((x) => (
                <li key={x.name} className="saved-item">
                  <button className={`nav-item${query === x.query ? ' active' : ''}`} onClick={() => { setQuery(x.query); setThreadId(null); }} title={x.query}>
                    <Icon name="search" /><span className="name">{x.name}</span>
                  </button>
                  <Button variant="quiet" size="sm" icon="close" label={`Remove saved search ${x.name}`} onClick={() => removeSearch(x.name)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="me">
          <span className="addr">{identity?.name && identity.name !== identity.email ? identity.name : client.username}</span>
          <span className="links">
            <Button variant="link" onClick={() => setOverlay('settings')}>Settings</Button>
            <Button variant="link" onClick={() => setOverlay('palette')} title="Find any action (⌘K)">Commands</Button>
            <Button variant="link" onClick={onLogout}>Sign out</Button>
          </span>
        </div>
      </nav>

      {role === CALENDAR ? <CalendarView client={client} say={(text) => say({ text })} /> : <>
      <section className="list" aria-label="Conversations" onScroll={(e) => {
        const el = e.currentTarget;
        if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 600) loadMore();
      }}>
        <div className="list-head">
        <div className="search">
          <Icon name="search" />
          <input ref={searchRef} type="search" placeholder="Search mail" value={query} aria-label="Search mail (try from: or has:attachment)"
            onChange={(e) => { setQuery(e.target.value); setThreadId(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
        </div>
        {query && <SearchChips query={query} contacts={contacts} onChange={(q) => { setQuery(q); setThreadId(null); }} />}

        {selected.size > 0 ? (
          <div className="bulkbar" role="toolbar" aria-label="Selected conversations">
            <input type="checkbox" className="check" checked={allSelected} aria-label="Select all"
              onChange={() => setSelected(allSelected ? new Set() : new Set(list?.map((x) => x.threadId)))} />
            <span className="count-label">{selected.size} selected</span>
            {role !== 'trash' && <Button variant="quiet" size="sm" icon="archive" label="Archive" shortcut="e" onClick={() => act('archive')} />}
            <Button variant="quiet" size="sm" icon="trash" label="Delete" shortcut="#" onClick={() => act('trash')} />
            <Button variant="quiet" size="sm" icon="check" label="Mark as read" shortcut="Shift+I" onClick={() => act('read')} />
            <Button variant="quiet" size="sm" icon="unread" label="Mark as unread" shortcut="Shift+U" onClick={() => act('unread')} />
            <Button variant="quiet" size="sm" icon="star" label="Star" shortcut="s" onClick={() => act('star')} />
            <Menu label="Snooze" button={<Button variant="quiet" size="sm" icon="clock" label="Snooze" />}>
              {(close) => <><p className="menu-title">Snooze until…</p><TimeChoices verb="Snooze" close={close} onPick={(d) => act({ snooze: d })} /></>}
            </Menu>
            {selectionMenu('move')}{selectionMenu('label')}
            <Button variant="link" className="push" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        ) : <div className="list-title-row"><h2 className="list-title">{heading}</h2>
              {query && !saved.some((x) => x.query === query) && <Button variant="link" onClick={saveSearch}>Save this search</Button>}</div>}
        {role === 'inbox' && categories && !selected.size && (
          <div className="tabs" role="tablist" aria-label="Inbox categories">
            {(['primary', 'updates'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' on' : ''}`}
                onClick={() => { setTab(t); setThreadId(null); }}>
                <Icon name={t === 'primary' ? 'inbox' : 'tag'} size={16} />{t === 'primary' ? 'Primary' : 'Updates'}
              </button>
            ))}
          </div>
        )}
        </div>

        {role === CONTACTS ? (
          <ContactList contacts={people} selected={personId}
            onSelect={(id) => { setPersonId(id); setEditingPerson(false); }} onNew={() => { setPersonId(null); setEditingPerson(true); }} />
        ) : role === SUBSCRIPTIONS ? (
          <SubscriptionsList subs={subs} onDeleteAll={deleteAllFrom}
            onUnsubscribe={(x) => unsubscribe({ from: [x.from], unsubscribe: x.unsubscribe })} />
        ) : role === SCHEDULED ? (
          <>
            {scheduled === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
            {scheduled?.length === 0 && <p className="empty">Nothing scheduled. Use the clock next to Send to send later.</p>}
            <ul className="rows">
              {scheduled?.map((s) => (
                <li key={s.submissionId} className="row">
                  <button className="open" onClick={() => editScheduled(s)} title="Cancel and edit">
                    <span className="from">To {s.email.to?.map((a) => displayName(a)).join(', ') || '(no recipients)'}</span>
                    <time className="sends">{describe(new Date(s.sendAt))}</time>
                    <span className="subject">{s.email.subject || '(no subject)'}</span>
                    <span className="preview">{s.email.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {list === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} />)}</div>}
            {inScreener && !!list?.length && <p className="list-note">First-time senders. Allow them into your Inbox, or block them for good.</p>}
            {list?.length === 0 && <p className="empty">{inScreener ? 'Nobody new is waiting. New senders show up here first.' : emptyText}</p>}
            <ul className={`rows${selected.size ? ' selecting' : ''}`}>
              {list?.map((e, i) => (<Fragment key={e.threadId}>
                {important > 0 && (i === 0 || i === important) && <li className="list-section" role="presentation">{i === 0 ? 'Important and unread' : 'Everything else'}</li>}
                <li className={`row${e.keywords.$seen ? '' : ' unread'}${e.threadId === threadId ? ' active' : ''}${selected.has(e.threadId) ? ' selected' : ''}`}>
                  <input type="checkbox" className="check" checked={selected.has(e.threadId)} aria-label={`Select ${e.subject || 'conversation'}`}
                    onChange={() => {}} onClick={(ev) => toggleSelect(e.threadId, ev.shiftKey)} />
                  <button className="open" onClick={(ev) => (ev.shiftKey || selected.size ? toggleSelect(e.threadId, ev.shiftKey) : openThread(e.threadId))}>
                    <span className="from">{role === 'sent' || role === 'drafts'
                      ? `To ${e.to?.map((a) => displayName(a)).join(', ') || '(no recipients)'}` : displayName(e.from?.[0], client.username)}</span>
                    <time dateTime={e.receivedAt}>{e.keywords.$flagged && <span className="starmark" aria-label="Starred"><Icon name="star" size={13} filled /></span>}{shortDate(e.receivedAt)}</time>
                    <span className="subject">{e.keywords.$nudge && role === 'inbox' && <span className="pill pill--warn">No reply yet</span>}
                      {Object.keys(e.mailboxIds ?? {}).filter((id) => id !== current && userFolders.has(id)).slice(0, 2).map((id) => <span key={id} className="pill">{userFolders.get(id)}</span>)}
                      {e.subject || '(no subject)'}{e.hasAttachment && <Icon name="clip" size={14} />}</span>
                    <span className="preview">{e.preview}</span>
                  </button>
                  {inScreener && !selected.size && e.from?.[0] && (
                    <span className="row-actions screen-actions">
                      <Button size="sm" variant="primary" onClick={() => screen(e.from![0].email, true)}>Allow</Button>
                      <Button size="sm" onClick={() => screen(e.from![0].email, false)}>Block</Button>
                    </span>
                  )}
                  {role !== 'trash' && !inScreener && !selected.size && (
                    <span className="row-actions">
                      <Button variant="quiet" size="sm" icon="star" iconFilled={!!e.keywords.$flagged} label={e.keywords.$flagged ? 'Unstar' : 'Star'} shortcut="s" onClick={() => act('star', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="archive" label="Archive" shortcut="e" onClick={() => act('archive', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="trash" label="Delete" shortcut="#" onClick={() => act('trash', [e.threadId])} />
                    </span>
                  )}
                </li>
              </Fragment>))}
            </ul>
            {hasMore && <div className="list-more"><Button variant="link" onClick={loadMore}>Show more</Button></div>}
          </>
        )}
      </section>

      <section className="reader" aria-label="Conversation">
        {role === CONTACTS
          ? <ContactPanel contact={people?.find((x) => x.id === personId) ?? null} editing={editingPerson}
              onEdit={() => setEditingPerson(true)} onCancel={() => setEditingPerson(false)}
              onSave={async (c) => { const id = await client.saveContact(c); setEditingPerson(false); setPersonId(id); say({ text: 'Contact saved' }); refresh(); loadContacts(); }}
              onDelete={async (c) => {
                if (!(await confirmIt({ title: `Delete ${fullName(c) || c.emails[0]}?`, body: 'They’re removed from your contacts. Their mail stays.', confirm: 'Delete contact', danger: true }))) return;
                try { await client.deleteContact(c.id!); setPersonId(null); say({ text: 'Contact deleted' }); refresh(); loadContacts(); } catch (e) { fail(e); }
              }}
              onEmail={(c) => setCompose(withSignature({ ...EMPTY_DRAFT, to: [{ name: fullName(c) || null, email: c.emails[0] }] }))} />
          : threadId
          ? <ErrorBoundary resetKey={threadId}>
              <Reader client={client} me={client.username} messages={messages} error={readerError} folders={folders}
                inTrash={role === 'trash'} inJunk={role === 'junk'}
                onAction={(a) => act(a, [threadId])} onReply={reply} onBack={() => setThreadId(null)}
                onSnooze={(d) => act({ snooze: d }, [threadId])} onMoveTo={(id, label) => act({ moveTo: id, label }, [threadId])}
                onUnsubscribe={unsubscribe} onMore={more} onRsvp={rsvp} onReceipt={receipt} />
            </ErrorBoundary>
          : <div className="reader-empty">
              <p>{selected.size ? `${selected.size} selected` : 'Select a conversation to read it.'}</p>
              <p className="fine">Press <kbd>?</kbd> for keyboard shortcuts, or <kbd>⌘K</kbd> to find any action.</p>
            </div>}
      </section>

      </>}

      {compose && <Compose key={compose.id ?? JSON.stringify(compose).length} initial={compose} contacts={contacts} api={composeApi} signatures={signatures} identities={identities} onSend={send} onClose={closeCompose} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <Button variant="link" onClick={toast.undo}>Undo</Button>}
        </div>
      )}

      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === 'settings' && <Settings client={client} boxes={boxes} prefillRule={rulePrefill}
        onClose={() => { setOverlay(null); setRulePrefill(undefined); reloadCategories(); }} onFoldersChanged={refresh} onIdentitiesChanged={loadIdentity}
        onSaved={(m) => { setOverlay(null); setRulePrefill(undefined); say({ text: m }); loadIdentity(); reloadCategories(); }} />}
      {overlay === 'help' && (
        <div className="overlay" onClick={() => setOverlay(null)} onKeyDown={(e) => e.key === 'Escape' && setOverlay(null)}>
          <section className="sheet help" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <dl>
              {[['c', 'Compose'], ['/', 'Search'], ['⌘K', 'Find any action'], ['j / k', 'Next / previous'], ['x', 'Select'], ['r', 'Reply'],
                ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Report spam'], ['s', 'Star'],
                ['u', 'Mark unread'], ['Shift+I', 'Mark read'], ['m', 'Mute'], [']', 'Archive, open next'], ['z', 'Undo'],
                ['g then i', 'Go to Inbox'], ['g then s', 'Go to Starred'], ['g then t', 'Go to Sent'], ['g then d', 'Go to Drafts'],
                ['g then c', 'Go to Contacts'], ['g then k', 'Go to Calendar'], ['⌘/Ctrl Enter', 'Send'], ['Esc', 'Close or clear']]
                .map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
            </dl>
            <p className="fine">Search tips: <code>from:priya</code> <code>has:attachment</code> <code>is:unread</code> <code>in:archive</code> <code>after:2026-10-01</code></p>
          </section>
        </div>
      )}
    </div>
  );
}

/** Gmail-style one-click filters under the search box, plus "From <person>" for a name being typed. */
function SearchChips({ query, contacts, onChange }: { query: string; contacts: Address[]; onChange: (q: string) => void }) {
  const week = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const chips: [string, string, RegExp][] = [
    ['Unread', 'is:unread', /(^|\s)is:unread\b/], ['Starred', 'is:starred', /(^|\s)is:starred\b/],
    ['Has attachment', 'has:attachment', /(^|\s)has:attach\w*/], ['Last 7 days', `after:${week}`, /(^|\s)after:\S+/],
    ['Sent', 'in:sent', /(^|\s)in:sent\b/],
  ];
  const toggle = (token: string, re: RegExp) => onChange(re.test(query) ? query.replace(re, ' ').replace(/\s+/g, ' ').trim() : `${query.trim()} ${token}`.trim());
  // The last word, if it's plain text, may be the start of a name: offer people who match.
  const last = /(?:^|\s)([^\s:"]{2,})$/.exec(query)?.[1]?.toLowerCase();
  const people = last ? contacts.filter((c) => c.email.toLowerCase().includes(last) || c.name?.toLowerCase().includes(last)).slice(0, 3) : [];
  return (
    <div className="search-chips" role="toolbar" aria-label="Search filters">
      {people.map((c) => (
        <button key={c.email} className="filter-chip person" onClick={() => onChange(query.replace(new RegExp(`${last!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), `from:${c.email}`))}>
          <Icon name="person" size={14} />From {c.name || c.email}
        </button>
      ))}
      {chips.map(([label, token, re]) => (
        <button key={label} className={`filter-chip${re.test(query) ? ' on' : ''}`} aria-pressed={re.test(query)} onClick={() => toggle(token, re)}>{label}</button>
      ))}
    </div>
  );
}
