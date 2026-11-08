import { Fragment, Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SendingBlocked } from './Sending';
import { confirmIt, promptIt } from './Dialog';
import { Button } from './Button';
import type { ComposeApi } from './Compose';
import { ComposeDock, useComposeWindows } from './ComposeDock';
import { reactionDraft } from './reactions';
import { Icon, roleIcon } from './icons';
import { Jmap, UNDO_SECONDS, type SharedAccount, type Attachment, type Contact, type Subscription, type Address, type Draft, type EmailFull, type EmailSummary, type Filter, type Identity, type Mailbox, type Scheduled } from './jmap';
import { addSignature, chooseSignature, displayName, draftFor, draftFromEmail, fileSize, formatAddresses, parseAddresses, textToHtml, unsubscribePlan, type ReplyMode, type Signature } from './mailutil';
import { Menu, TimeChoices } from './Menu';
import { Palette, type Command } from './Palette';
import { canAsk } from './ai';
import { SubscriptionsList } from './Subscriptions';
import { ContactList, ContactPanel, fullName, groupAddresses } from './Contacts';
import { CalendarView } from './CalendarView';
import { localZone } from './calendar';
import type { PartStat } from './ics';
import { Reader, shortDate, type Action, type MoreAction } from './Reader';
import { TaskList } from './Tasks';
import { NotesView } from './Notes';
import { addRule, loadScript, saveScript } from './Filters';
import { DEFAULT_TABS, SCREENER, TAB_LABEL, tabKeyword, TABS, type Rule, type ScriptData, type Tab } from './rules';
import { enablePush, notifyOn, showMail } from './notify';
import { setBadge, takeLaunch } from './launch';
import { offlineStore } from './offline';
import { buildSrcdoc } from './safeHtml';
import { parseSearch } from './search';
import { applyTheme, Settings } from './Settings';
import { cache } from './store';
import { describe } from './when';
import { SharedRail, TeamComments, useShared } from './Sharing';
import { boxName, locale, t } from './i18n';

const PAGE = 50;
const FALLBACK_POLL_MS = 5 * 60_000; // push does the real work; this only covers a silently dead stream
const EMPTY_DRAFT: Draft = { to: [], cc: [], subject: '', html: '', text: '', attachments: [] };
// Virtual folders: views that aren't mailboxes on the server.
/** Always in the rail (Gmail's set); everything else folds under More. */
const MAIN = ['inbox', 'starred', 'snoozed', 'sent', 'drafts'];
const STARRED = 'starred', SCHEDULED = 'scheduled', SUBSCRIPTIONS = 'subscriptions', CONTACTS = 'contacts', CALENDAR = 'calendar', TASKS = 'tasks', NOTES = 'notes';

// Read by list servers, not people: never translated (RFC 2369 / RFC 8058).
const UNSUB = 'unsubscribe', ONE_CLICK = 'List-Unsubscribe=One-Click';

type Toast = { text: string; undo?: () => void } | null;

/** A folder's name on screen: boxName, plus the Screener (a folder we make, found by its name). */
const shown = (b: { role?: string | null; name: string }) => (!b.role && b.name === SCREENER ? t('folder.screener') : boxName(b));
/** A message with {name} placeholders shown as keycaps: t() leaves unfilled placeholders as they are. */
const withKeys = (text: string, keys: Record<string, string>) =>
  text.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? <kbd key={i}>{keys[part] ?? part}</kbd> : part));
type BulkAction = Action | 'read' | { snooze: Date } | { moveTo: string | null; label: boolean };

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev: { resetKey: unknown }) { if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p className="empty">{t('mail.cantDisplay')}</p> : this.props.children; }
}

type MailProps = {
  client: Jmap; onLogout: () => void;
  /** Accounts signed in on this tab (Gmail-style switcher), active first. */
  accounts: string[]; onSwitch: (username: string) => void; onAddAccount: () => void;
};

/** Your mail, or another account you can open (shared folders, delegated or team mailbox) with the same screen. */
export function Mail(props: MailProps) {
  const [open, setOpen] = useState<{ acc: SharedAccount; box?: string } | null>(null);
  const client = useMemo(() => (open ? props.client.as(open.acc) : props.client), [props.client, open]);
  const shared = useShared(props.client);
  return <MailView key={open ? `${open.acc.id}/${open.box ?? ''}` : ''} {...props} client={client} own={props.client} sharing={shared}
    opened={open?.acc ?? null} startView={open?.box} onOpenShared={(acc, box) => setOpen(acc && { acc, box })} />;
}

function MailView({ client, own, sharing, opened, startView, onOpenShared, onLogout, accounts, onSwitch, onAddAccount }: MailProps & {
  /** Your own account (Settings, the shared list); `client` is the account on screen. */
  own: Jmap; sharing: ReturnType<typeof useShared>; opened: SharedAccount | null; startView?: string;
  onOpenShared: (acc: SharedAccount | null, box?: string) => void;
}) {
  const key = (k: string) => `${client.scope}:${k}`;
  const [boxes, setBoxes] = useState<Mailbox[]>(() => cache.get(key('boxes')) ?? []);
  const [view, setView] = useState<string | null>(startView ?? null); // mailbox id or virtual folder; null = Inbox
  const [tab, setTab] = useState<'primary' | Tab>('primary'); // Inbox categories
  const [categories, setCategories] = useState(true);
  const [tabs, setTabs] = useState<Tab[]>(() => cache.get(key('tabs')) ?? ['updates']); // which tabs show next to Primary (cached: no flash of two tabs)
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [saved, setSaved] = useState<{ name: string; query: string }[]>([]);
  const [people, setPeople] = useState<Contact[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [editingPerson, setEditingPerson] = useState<boolean | 'group'>(false);
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
  const [toast, setToast] = useState<Toast>(null);
  const [overlay, setOverlay] = useState<'help' | 'settings' | 'palette' | null>(null);
  const [threadVersion, setThreadVersion] = useState(0); // bump to reload the open conversation
  const [contacts, setContacts] = useState<Address[]>(() => cache.get(key('contacts')) ?? []);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [rulePrefill, setRulePrefill] = useState<Partial<Rule> | undefined>();
  // Settings are always your own, also while another mailbox is open.
  const [ownBoxes, setOwnBoxes] = useState<Mailbox[] | null>(null);
  useEffect(() => { if (opened && overlay === 'settings') own.mailboxes().then(setOwnBoxes, fail); }, [opened, overlay]);
  const toastTimer = useRef<number>(0);
  const lastClicked = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const goPending = useRef(false);
  // Offline: a banner, and an outbox that empties itself when the connection comes back.
  const [online, setOnline] = useState(() => navigator.onLine);
  const [outbox, setOutbox] = useState(0);
  useEffect(() => {
    if (!client.offline) return;
    const key = `${client.username}:outbox`;
    const flush = async () => {
      const box = (await offlineStore.get<{ d: Draft; sendAt?: string }[]>(key)) ?? [];
      setOutbox(box.length);
      if (!box.length || !navigator.onLine) return;
      let sent = 0;
      const b = await client.mailboxes().catch(() => boxes);
      for (const item of box) {
        try { await client.send(item.d, b, item.sendAt ? new Date(item.sendAt) : undefined); sent++; }
        catch { break; } // still failing: keep the rest for next time
      }
      const rest = box.slice(sent);
      await offlineStore.set(key, rest); setOutbox(rest.length);
      if (sent) { say({ text: t('mail.outboxSent', { count: sent }) }); refresh(); }
    };
    const on = () => { setOnline(true); flush(); }, off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    flush();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [client]);
  // Rail: the main places always show; the rest fold under "More" (remembered per device).
  const [railOpen, setRailOpen] = useState(() => { try { return localStorage.getItem('om:rail') === 'open'; } catch { return false; } });
  const toggleRail = (open: boolean) => { setRailOpen(open); try { localStorage.setItem('om:rail', open ? 'open' : 'closed'); } catch { /* fine */ } };

  const inbox = boxes.find((b) => b.role === 'inbox')?.id ?? null;
  /** Cache key for a list: the Inbox has one per category tab. */
  const listKey = (box: string | null) => `list:${box}${box && box === inbox && categories ? `:${tab}` : ''}`;
  const current = query ? null : view ?? inbox;
  const currentBox = boxes.find((b) => b.id === current);
  const role = [STARRED, SCHEDULED, SUBSCRIPTIONS, CONTACTS, CALENDAR, TASKS, NOTES].includes(current ?? '') ? current : currentBox?.role ?? null;
  // Moves need a real source folder; from Starred or search results, act on the Inbox copy.
  const source = currentBox ? currentBox.id : inbox;
  const folders = useMemo(() => boxes.filter((b) => (!b.role || b.role === 'archive' || b.role === 'inbox') && b.id !== source), [boxes, source]);

  const say = useCallback((t: Toast, ms = 4000) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    if (t && ms) toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const fail = (e: unknown) => say({ text: t('mail.couldntDoThat', { error: (e as Error).message }) }, 6000);

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
      if (woke) { b = await client.mailboxes(); say({ text: t('mail.snoozedBack', { count: woke }) }); }
      const nudged = await client.sweep(b).catch(() => 0); // muted conversations, follow-up reminders
      if (nudged) say({ text: t('mail.nudged', { count: nudged }) });
      setBoxes(b); cache.set(key('boxes'), b);
      const box = query ? null : view ?? b.find((x) => x.role === 'inbox')?.id ?? null;
      if (box === SCHEDULED) { setScheduled(await client.scheduled()); return; }
      if (box === SUBSCRIPTIONS) { setSubs(await client.subscriptions()); return; }
      if (box === CONTACTS) { setPeople(await client.addressBook()); return; }
      if (box === CALENDAR || box === TASKS || box === NOTES) return; // these load their own data
      const isInbox = b.find((x) => x.id === box)?.role === 'inbox';
      const filter: Filter = query ? parseSearch(query, b) : box === STARRED ? { hasKeyword: '$flagged' }
        : isInbox && categories ? { operator: 'AND', conditions: [{ inMailbox: box },
          ...(tab === 'primary' ? tabs.map((k) => ({ notKeyword: tabKeyword(k) })) : [{ hasKeyword: tabKeyword(tab) }])] }
        : { inMailbox: box };
      const l = await client.threads(filter, limit.current + 1); // one extra tells us whether there's more
      setHasMore(l.length > limit.current);
      let page = l.slice(0, limit.current);
      // Priority Inbox (Primary only): unread mail from people you write to comes first, under its own label.
      let top = 0;
      if (isInbox && !query && (!categories || tab === 'primary')) {
        const imp = (e: EmailSummary) => !e.keywords.$seen && !!e.from?.some((a) => correspondents.current.has(a.email.toLowerCase()));
        const first = page.filter(imp);
        top = first.length;
        if (top) page = [...first, ...page.filter((e) => !imp(e))];
      }
      setImportant(top);
      setList(page);
      if (!query) cache.set(key(listKey(box)), page.slice(0, PAGE));
    } catch (e) { say({ text: e instanceof Error ? e.message : String(e) }); }
  }, [client, view, query, tab, categories, tabs]);

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
  // Background push: a click on a notification opens that conversation; subscriptions expire, so renew every few days.
  useEffect(() => {
    const onMsg = (m: MessageEvent) => { if (m.data?.type === 'om-open-thread') openRef.current(m.data.threadId); };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    try {
      if (notifyOn() && Date.now() - Number(localStorage.getItem('om:push-at') ?? 0) > 3 * 86400e3)
        enablePush(client).then((ok) => { if (ok) localStorage.setItem('om:push-at', String(Date.now())); }, () => {});
    } catch { /* storage blocked: renew next time */ }
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [client]);
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
  const [groups, setGroups] = useState<{ name: string; members: Address[] }[]>([]);
  const loadContacts = useCallback(() => Promise.all([client.addressBook().catch(() => [] as Contact[]), client.contacts()]).then(([book, recent]) => {
    setGroups(book.filter((g) => g.kind === 'group').map((g) => ({ name: fullName(g), members: groupAddresses(g, book) })));
    const seen = new Set<string>();
    const merged = [...book.filter((p) => p.kind !== 'group').flatMap((p) => p.emails.map((email) => ({ name: fullName(p) || null, email }))), ...recent]
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
  const signatures: Signature[] = sigData.signatures ?? (identity?.textSignature?.trim() ? [{ name: t('mail.signature'), text: identity.textSignature }] : []);
  const showTabs = (data: ScriptData) => {
    const on = TABS.filter((k) => (data.tabs ?? ['updates']).includes(k));
    setCategories(data.categories !== false); setTabs(on); cache.set(key('tabs'), on); setTab((x) => (x === 'primary' || on.includes(x) ? x : 'primary'));
  };
  const reloadCategories = () => loadScript(client).then(({ data }) => { showTabs(data); setSigData(data); }, () => {});

  // Inbox categories: install the server rule (and tag existing mail) the first time this account opens the app.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await loadScript(client);
        showTabs(data);
        setSaved(data.savedSearches ?? []);
        setSigData(data);
        if (data.categories !== undefined) return;
        const b = await client.mailboxes();
        await saveScript(client, b, (d) => ({ ...d, categories: d.categories ?? true, tabs: d.tabs ?? DEFAULT_TABS }));
        showTabs({ ...data, categories: true, tabs: DEFAULT_TABS });
        const inboxId = b.find((x) => x.role === 'inbox')?.id;
        if (inboxId && await client.tagUpdates(inboxId, DEFAULT_TABS)) refreshRef.current();
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
    const n = tids.length;
    if (a === 'trash' && role === 'trash' && !(await confirmIt({ title: t('mail.deleteForeverTitle', { count: n }), body: t('mail.cantBeUndone'), confirm: t('mail.deleteForever'), danger: true }))) return;
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
      try { await Promise.all(tids.map((t) => client.setSeen(t, seen))); say({ text: t(seen ? 'mail.markedRead' : 'mail.markedUnread') }); } catch (e) { fail(e); }
      return refresh();
    }

    let target: string | null = null, label = false;
    if (typeof a === 'object' && 'moveTo' in a) {
      label = a.label;
      target = a.moveTo;
      if (!target) {
        const name = await promptIt({ title: t('mail.newFolder'), label: t('mail.folderName'), placeholder: t('mail.folderNameExample'), confirm: t('mail.createFolder') });
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
      const box = (r: string) => { const id = boxes.find((b) => b.role === r)?.id; if (!id) throw new Error(t('mail.noFolderForThat')); return id; };
      if (typeof a === 'object' && 'snooze' in a) { await each((t) => client.snooze(t, source, a.snooze, boxes)); say({ text: t('mail.snoozedUntil', { count: n, time: describe(a.snooze) }) }); }
      else if (typeof a === 'object') {
        const b = boxes.find((x) => x.id === target), name = b ? shown(b) : t('mail.theNewFolder');
        await each((t) => (label ? client.addToMailbox(t, target!) : client.move(t, source, target!)));
        say({ text: label ? t('mail.labelled', { name }) : t('mail.movedTo', { count: n, name }) });
      }
      else if (a === 'mute') { await each((t) => client.mute(t, source, boxes)); say({ text: t('mail.muted', { count: n }) }); }
      else if (a === 'archive') { const to = await client.mailboxFor('archive', 'Archive', boxes); await each((t) => client.move(t, source, to)); say({ text: t('mail.archived', { count: n }) }); }
      else if (a === 'trash' && role === 'trash') { await each((t) => client.destroyThread(t, source)); say({ text: t('mail.deletedForever') }); }
      else if (a === 'trash') { await each((t) => client.move(t, source, box('trash'))); say({ text: t('mail.movedToTrash') }); }
      else if (a === 'junk' && role === 'junk') { await each((t) => client.move(t, source, inbox!, { $junk: null, $notjunk: true })); say({ text: t('mail.notSpam') }); }
      else if (a === 'junk') { await each((t) => client.move(t, source, box('junk'), { $junk: true, $notjunk: null })); say({ text: t('mail.reportedSpam') }); }
    } catch (e) { fail(e); }
    refresh();
  }

  /** Shared by the reader's Unsubscribe link and the Subscriptions page. Returns true when it went through. */
  async function unsubscribe(m: Pick<EmailFull, 'unsubscribe'> & { from: Address[] | null }): Promise<boolean> {
    const who = displayName(m.from?.[0]);
    const plan = unsubscribePlan(m.unsubscribe);
    if (!plan) { say({ text: t('mail.noSafeUnsubscribe', { name: who }) }, 6000); return false; }
        if (!(await confirmIt({ title: t('mail.unsubscribeTitle', { name: who }), body: plan.kind === 'mail' ? t('mail.unsubscribeByMail', { address: plan.to }) : t(plan.kind === 'post' ? 'mail.unsubscribeByPost' : 'mail.unsubscribeByLink', { host: plan.host }), confirm: t('mail.unsubscribe') }))) return false;
    try {
      if (plan.kind === 'post') {
        // RFC 8058 one-click: a plain form POST. no-cors because we never need to read the reply.
        await fetch(plan.url, { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: ONE_CLICK });
        say({ text: t('mail.unsubscribed', { name: who }) });
      } else if (plan.kind === 'mail') {
        await client.send({ to: [{ name: null, email: plan.to }], cc: [], subject: UNSUB, html: `<p>${UNSUB}</p>`, text: UNSUB, attachments: [] }, boxes);
        say({ text: t('mail.unsubscribeSent', { address: plan.to }) });
      } else {
        window.open(plan.url, '_blank', 'noopener,noreferrer');
        say({ text: t('mail.unsubscribeOpened', { host: plan.host }) });
      }
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function deleteAllFrom(s: Subscription) {
    const who = displayName(s.from);
    if (!(await confirmIt({ title: t('mail.deleteAllTitle', { name: who }), body: t('mail.deleteAllBody', { address: s.from.email }), confirm: t('mail.moveToTrash'), danger: true }))) return;
    try { const n = await client.trashFrom(s.from.email, boxes); say({ text: t('mail.deletedAllFrom', { count: n, name: who }) }); refresh(); }
    catch (e) { fail(e); }
  }

  async function saveSearch() {
    const name = await promptIt({ title: t('mail.saveSearch'), body: t('mail.saveSearchBody'), label: t('mail.name'), value: query, confirm: t('mail.saveSearchConfirm') });
    if (!name) return;
    try {
      let next: { name: string; query: string }[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, savedSearches: (next = [...(d.savedSearches ?? []).filter((x) => x.name !== name), { name, query }]) }));
      setSaved(next); say({ text: t('mail.savedSearch', { name }) });
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
        const head = `<h1 style="font:600 20px system-ui">${escape(m.subject ?? '')}</h1><p style="font:13px system-ui;color:#555">${escape(t('mail.printFrom', { from: formatAddresses(m.from) }))}<br>${escape(t('mail.printTo', { to: formatAddresses(m.to) }))}<br>${new Date(m.receivedAt).toLocaleString(locale())}</p><hr>`;
        const frame = Object.assign(document.createElement('iframe'), { srcdoc: buildSrcdoc(head + (m.html ?? textToHtml(m.text ?? '')), false).srcdoc });
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
        frame.onload = () => { frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); };
        document.body.appendChild(frame);
      } else if (what === 'task') {
        await client.addTask(m.subject?.replace(/^((re|fwd?)\s*:\s*)+/i, '') || t('mail.followUp'), { threadId: m.threadId });
        say({ text: t('mail.addedToTasks') });
      } else if (what === 'unmute') {
        await client.unmute(m.threadId); setThreadVersion((v) => v + 1); say({ text: t('mail.unmuted') });
      } else if (what === 'filter') {
        setRulePrefill({ from: sender }); setOverlay('settings');
      } else if (what === 'addContact') {
        const name = m.from?.[0]?.name?.trim() ?? '';
        const [given, ...rest] = name.split(/\s+/);
        await client.saveContact({ given: given ?? '', surname: rest.join(' '), emails: [sender], phones: [], org: '', note: '' });
        say({ text: t('mail.addedContact', { name: name || sender }) }); loadContacts();
      } else if (what === 'block') {
        if (!parseAddresses(sender).list.length) return say({ text: t('mail.cantBlock') });
        if (!(await confirmIt({ title: t('mail.blockTitle', { address: sender }), body: t('mail.blockBody'), confirm: t('mail.block'), danger: true }))) return;
        await addRule(client, boxes, { id: crypto.randomUUID(), from: sender, fromExact: true, action: 'block' });
        await act('junk', [m.threadId]);
        say({ text: t('mail.blocked', { address: sender }) });
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
      say({ text: t(added ? 'mail.repliedAdded' : 'mail.replied', { answer: t(({ ACCEPTED: 'mail.rsvpYes', TENTATIVE: 'mail.rsvpMaybe', DECLINED: 'mail.rsvpNo' } as const)[status]), address: inv.organizerEmail }) });
      setThreadVersion((v) => v + 1);
    } catch (e) { fail(e); }
  }

  async function receipt(m: EmailFull, send: boolean) {
    try {
      if (send) { await client.sendReadReceipt(m, boxes); say({ text: t('mail.receiptSent', { address: m.receiptTo?.[0]?.email ?? '' }) }); }
      else { await client.declineReadReceipt(m.id); say({ text: t('mail.noReceipt') }); }
      setThreadVersion((v) => v + 1);
    } catch (e) { fail(e); }
  }

  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // ── Writing ────────────────────────────────────────────

  const withSignature = (d: Draft, kind: 'new' | 'reply' = 'new'): Draft =>
    ({ ...d, html: addSignature(d.html, chooseSignature(signatures, kind === 'new' ? sigData.sigNew : sigData.sigReply)) });
  const windows = useComposeWindows(client, { send: (d, at) => send(d, at), blocked: () => say({ text: t('mail.popupBlocked') }) });
  const setCompose = windows.open;
  const compose = windows.expanded;
  const newMessage = () => setCompose(withSignature(EMPTY_DRAFT));
  function reply(mode: ReplyMode, e: EmailFull, text?: string) {
    const d = draftFor(mode, e, client.username, identities.map((i) => i.email));
    // A picked suggestion goes on the first line; the user edits it like anything they typed.
    if (text) d.html = d.html.replace('<div><br></div>', `<div>${escape(text)}</div><div><br></div>`);
    setCompose(withSignature(d, 'reply'));
  }

  const composeApi: ComposeApi = {
    upload: (f) => client.upload(f),
    save: (d) => client.saveDraft(d, boxes),
    discard: (id) => client.deleteDraft(id),
    download: (a) => client.download(a),
    templates: () => client.templates(),
    saveTemplate: (d) => client.saveTemplate(d),
    deleteTemplate: (id) => client.deleteTemplate(id),
    share: (f, days) => client.shareFile(f, days),
    maxUpload: client.maxUpload,
    events: opened ? undefined : (from, to) => client.events(from, to),
  };
  // Opened from outside: the Compose shortcut, an email link or "Share to OpenMail" (launch.ts).
  useEffect(() => {
    takeLaunch().then(async (l) => {
      if (!l) return;
      // Shared files come from outside (any site can post to /share): attach them only when the person says so.
      // Names are the sender's text: control/direction characters stripped, shortened, shown after the warning.
      const label = (f: File) => `${f.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 60) || t('mail.untitledFile')} (${fileSize(f.size)})`;
      if (l.files.length && !(await confirmIt({ title: t('mail.attachSharedTitle', { count: l.files.length }), danger: true,
        body: t('mail.attachSharedBody', { files: `${l.files.slice(0, 5).map(label).join(' · ')}${l.files.length > 5 ? ' …' : ''}` }), confirm: t('mail.attach') }))) l.files = [];
      const attachments = await Promise.all(l.files.map((f) => client.upload(f))).catch((e) => { fail(e); return []; });
      setCompose(withSignature({ ...EMPTY_DRAFT, to: l.to, cc: l.cc, bcc: l.bcc, subject: l.subject, html: l.body ? textToHtml(l.body) : '', text: l.body, attachments }));
    });
  }, [client]);
  // Unread Inbox mail on the app icon.
  // ponytail: the active account's Inbox only; other signed-in accounts don't add to it.
  useEffect(() => setBadge(boxes.find((b) => b.role === 'inbox')?.unreadEmails ?? 0), [boxes]);
  useEffect(() => () => setBadge(0), []); // signed out
  function closeCompose(outcome: 'saved' | 'discarded' | 'closed') {
    if (outcome === 'saved') say({ text: t('mail.draftSaved') });
    if (outcome === 'discarded') say({ text: t('mail.draftDiscarded') });
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
      say({ text: t(yes ? 'mail.screenAllowed' : 'mail.screenBlocked', { address: sender }) });
    } catch (e) { fail(e); }
    refresh();
  }

  async function send(d: Draft, sendAt?: Date) {
    if (!navigator.onLine && client.offline) {
      // Offline: keep it in the outbox; it goes when the connection is back (see the 'online' effect).
      const box = (await offlineStore.get<{ d: Draft; sendAt?: string }[]>(`${client.username}:outbox`)) ?? [];
      await offlineStore.set(`${client.username}:outbox`, [...box, { d, sendAt: sendAt?.toISOString() }]);
      setOutbox(box.length + 1);
      return say({ text: t('mail.offlineQueued') }, 6000);
    }
    const pending = client.send(d, boxes, sendAt);
    let undone = false;
    const undo = async () => {
      undone = true;
      say({ text: t(sendAt ? 'mail.cancelling' : 'mail.undoing') }, 0);
      try {
        const { submissionId, emailId } = await pending;
        await client.undoSend(submissionId, emailId, boxes);
        say({ text: t(sendAt ? 'mail.scheduleCancelled' : 'mail.sendUndone') });
        setCompose({ ...d, id: emailId }); // it's a draft again
      } catch { say({ text: t('mail.tooLate') }); }
      refresh();
    };
    say({ text: sendAt ? t('mail.scheduledFor', { time: describe(sendAt) }) : t('mail.sending'), undo }, sendAt ? 8000 : UNDO_SECONDS * 1000);
    try { await pending; loadContacts(); approveRecipients(d); } catch (e) {
      say({ text: t('mail.notSent', { error: (e as Error).message }) }, 8000);
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
        ? { text: t('mail.notDelivered', { addresses: problems.map((p) => p.email).join(', '), reason: problems[0].reason }) }
        : { text: t('mail.sent') }, problems.length ? 10000 : 4000);
      refresh(); setThreadVersion((v) => v + 1);
    }, UNDO_SECONDS * 1000 + 1500);
  }

  async function editScheduled(s: Scheduled) {
    if (!(await confirmIt({ title: t('mail.editScheduledTitle'), body: t('mail.editScheduledBody', { subject: s.email.subject || t('mail.noSubject'), time: describe(new Date(s.sendAt)) }), confirm: t('mail.editMessage') }))) return;
    try {
      await client.undoSend(s.submissionId, s.email.id, boxes);
      const draft = (await client.thread(s.email.threadId)).find((m) => m.id === s.email.id);
      if (draft) setCompose(draftFromEmail(draft));
      refresh();
    } catch (e) { fail(e); }
  }

  /** RFC 9078 reaction: a tiny reply holding the emoji; it shows as a chip under the message. */
  async function react(m: EmailFull, emoji: string) {
    try {
      await client.send(reactionDraft(m, emoji, client.username, identities.map((i) => i.email)), boxes);
      say({ text: t('mail.reacted', { emoji }) }); setThreadVersion((v) => v + 1);
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
    { id: STARRED, name: STARRED, role: STARRED, unreadEmails: 0, sortOrder: 0 },
    ...boxes.slice(1).flatMap((b) => (b.role === 'drafts' && !opened ? [b, { id: SCHEDULED, name: SCHEDULED, role: SCHEDULED, unreadEmails: 0, sortOrder: 0 }] : [b])),
    // Someone else's mailbox shows its mail only; your contacts, calendar, tasks and notes stay in yours.
    ...(opened ? [] : [
      { id: SUBSCRIPTIONS, name: SUBSCRIPTIONS, role: SUBSCRIPTIONS, unreadEmails: 0, sortOrder: 0 },
      { id: CONTACTS, name: CONTACTS, role: CONTACTS, unreadEmails: 0, sortOrder: 0 },
      { id: CALENDAR, name: CALENDAR, role: CALENDAR, unreadEmails: 0, sortOrder: 0 },
      { id: TASKS, name: TASKS, role: TASKS, unreadEmails: 0, sortOrder: 0 },
      { id: NOTES, name: NOTES, role: NOTES, unreadEmails: 0, sortOrder: 0 },
    ]),
  ];

  const commands: Command[] = [
    { id: 'compose', label: t('mail.cmdCompose'), icon: 'compose', hint: 'c', run: newMessage },
    { id: 'search', label: t('mail.cmdSearch'), icon: 'search', hint: '/', run: () => searchRef.current?.focus() },
    ...navItems.map((b) => ({ id: 'go-' + b.id, label: t('mail.goTo', { folder: shown(b) }), icon: roleIcon(b.role), run: () => openFolder(b.id) })),
    ...(last ? [
      { id: 'reply', label: t('mail.cmdReply'), icon: 'reply' as const, hint: 'r', run: () => reply('reply', last) },
      { id: 'replyall', label: t('mail.cmdReplyAll'), icon: 'replyAll' as const, hint: 'a', run: () => reply('replyAll', last) },
      { id: 'forward', label: t('mail.cmdForward'), icon: 'forward' as const, hint: 'f', run: () => reply('forward', last) },
      { id: 'archive', label: t('mail.cmdArchive'), icon: 'archive' as const, hint: 'e', run: () => act('archive') },
      { id: 'snooze', label: t('mail.cmdSnooze'), icon: 'clock' as const, run: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); act({ snooze: d }); } },
    ] : []),
    { id: 'settings', label: t('mail.cmdSettings'), icon: 'settings', run: () => setOverlay('settings') },
    { id: 'theme-dark', label: t('mail.cmdThemeDark'), icon: 'settings', run: () => applyTheme('dark') },
    { id: 'theme-light', label: t('mail.cmdThemeLight'), icon: 'settings', run: () => applyTheme('light') },
    { id: 'theme-system', label: t('mail.cmdThemeSystem'), icon: 'settings', run: () => applyTheme('system') },
    { id: 'help', label: t('mail.shortcuts'), icon: 'keyboard', hint: '?', run: () => setOverlay('help') },
    { id: 'logout', label: t('mail.cmdSignOut'), icon: 'back', run: onLogout },
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

  const navCurrent = navItems.find((b) => b.id === current);
  const heading = query ? t('mail.resultsFor', { query }) : navCurrent ? shown(navCurrent) : t('folder.inbox');
  const inScreener = !role && currentBox?.name === SCREENER;
  /** Folders you made (labels): shown as chips on rows that are also filed there. */
  const userFolders = useMemo(() => new Map(boxes.filter((b) => !b.role && b.name !== SCREENER).map((b) => [b.id, b.name])), [boxes]);
  const emptyText = query ? t('mail.noMatches', { query })
    : role === 'inbox' ? t('mail.caughtUp')
    : role === STARRED ? t('mail.starredEmpty')
    : role === 'snoozed' ? t('mail.snoozedEmpty')
    : t('mail.emptyFolder', { folder: heading });
  const selectionMenu = (kind: 'move' | 'label') => (
    <Menu label={t(kind === 'move' ? 'mail.moveTo' : 'mail.labelAs')} button={<Button variant="quiet" size="sm" icon={kind === 'move' ? 'folder' : 'tag'} label={t(kind === 'move' ? 'mail.moveToFolder' : 'mail.labelAs')} />}>
      {(close) => <>
        <p className="menu-title">{t(kind === 'move' ? 'mail.moveTo' : 'mail.labelAs')}</p>
        {folders.map((f) => <button key={f.id} className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: f.id, label: kind === 'label' }); }}><Icon name="folder" size={16} />{f.role || f.name === SCREENER ? shown(f) : f.path ?? f.name}</button>)}
        <button className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: null, label: kind === 'label' }); }}><Icon name="compose" size={16} />{t('mail.newFolderItem')}</button>
      </>}
    </Menu>
  );

  return (
    <div className={`app${role === CALENDAR || role === NOTES ? ' calendar-mode' : ''}${threadId || (role === CONTACTS && (personId || editingPerson)) ? ' reading' : ''}`}>
      <nav className="rail" aria-label={t('mail.folders')}>
        <p className="wordmark">OpenMail</p>
        <Button variant="primary" size="lg" icon="compose" className="compose-btn" onClick={newMessage} title={t('mail.composeTitle')}>{t('mail.compose')}</Button>
        {opened && <p className="banner banner--info shared-banner" role="status"><Icon name={opened.team ? 'inbox' : 'person'} size={16} />
          <span className="grow" title={opened.name}>{t(opened.team ? 'mail.teamMailbox' : opened.whole ? 'mail.delegatedMailbox' : 'mail.sharedFolders')}: <b>{opened.name.replace(/@.*/, '')}</b>
            {!opened.team && opened.canSend && <><br />{t('mail.sendOnBehalf')}</>}</span>
          <Button variant="link" onClick={() => onOpenShared(null)}>{t('mail.backToMyMail')}</Button></p>}
        {/* The main places, then "More" (folded by default, like Gmail), then the folders you made. */}
        {[navItems.filter((b) => b.role && (MAIN.includes(b.role) || railOpen || b.id === current)), navItems.filter((b) => !b.role)].map((group, gi) => (
          <div key={gi} className="rail-group">
            {gi === 1 && group.length > 0 && <p className="rail-label">{t('mail.folders')}</p>}
            <ul>
              {group.map((b) => (
                <li key={b.id}>
                  <button className={`nav-item${b.id === current ? ' active' : ''}`} aria-current={b.id === current ? 'page' : undefined} onClick={() => openFolder(b.id)}
                    style={b.depth ? { paddingLeft: `calc(var(--s3) + ${b.depth} * var(--s4))` } : undefined}>
                    <Icon name={roleIcon(b.role)} /><span className="name">{shown(b)}</span>
                    {b.unreadEmails > 0 && !['trash', 'sent', 'drafts'].includes(b.role ?? '') && <span className="count">{b.unreadEmails}</span>}
                  </button>
                </li>
              ))}
              {gi === 0 && (
                <li>
                  <button className="nav-item nav-more" aria-expanded={railOpen} onClick={() => toggleRail(!railOpen)}>
                    <Icon name="chevron" className={railOpen ? 'flip' : ''} /><span className="name">{t(railOpen ? 'mail.less' : 'mail.more')}</span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        ))}
        <SharedRail accounts={sharing.accounts} hidden={sharing.hidden} current={{ account: opened?.id ?? null, box: current }}
          onOpen={(a, b) => onOpenShared(a, b)} onHide={(k) => sharing.hide(k).catch(fail)} onUnhide={() => sharing.unhideAll().catch(fail)} />
        {saved.length > 0 && (
          <div className="saved">
            <p className="rail-label">{t('mail.savedSearches')}</p>
            <ul>
              {saved.map((x) => (
                <li key={x.name} className="saved-item">
                  <button className={`nav-item${query === x.query ? ' active' : ''}`} onClick={() => { setQuery(x.query); setThreadId(null); }} title={x.query}>
                    <Icon name="search" /><span className="name">{x.name}</span>
                  </button>
                  <Button variant="quiet" size="sm" icon="close" label={t('mail.removeSavedSearch', { name: x.name })} onClick={() => removeSearch(x.name)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="me">
          <Menu label={t('mail.accounts')} up button={
            <button className="account-btn" title={t('mail.switchAccount')}>
              <span className="addr" dir="auto">{identity?.name && identity.name !== identity.email ? identity.name : client.username}</span>
              {accounts.length > 1 && <span className="count">{accounts.length}</span>}
            </button>}>
            {(close) => <>
              <p className="menu-title">{t('mail.signedInHere')}</p>
              {accounts.map((a) => (
                <button key={a} className="menu-item" role="menuitem" aria-current={a === client.username} onClick={() => { close(); if (a !== client.username) onSwitch(a); }}>
                  <Icon name={a === client.username ? 'check' : 'person'} size={16} /><span className="grow">{a}</span>
                </button>
              ))}
              {sharing.accounts.some((a) => a.whole) && <>
                <p className="menu-title menu-sep">{t('mail.mailboxesYouCanOpen')}</p>
                {opened && <button className="menu-item" role="menuitem" onClick={() => { close(); onOpenShared(null); }}><Icon name="person" size={16} /><span className="grow">{t('mail.myMailbox')}</span></button>}
                {sharing.accounts.filter((a) => a.whole).map((a) => (
                  <button key={a.id} className="menu-item" role="menuitem" aria-current={a.id === opened?.id} onClick={() => { close(); onOpenShared(a); }}>
                    <Icon name={a.id === opened?.id ? 'check' : a.team ? 'inbox' : 'person'} size={16} /><span className="grow">{a.name}</span>
                  </button>
                ))}
              </>}
              <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); onAddAccount(); }}><Icon name="compose" size={16} />{t('mail.addAccount')}</button>
            </>}
          </Menu>
          <span className="links">
            <Button variant="quiet" size="sm" icon="settings" label={t('mail.settings')} onClick={() => setOverlay('settings')} />
            <Button variant="quiet" size="sm" icon="command" label={t('mail.findAnyAction')} shortcut="⌘K" onClick={() => setOverlay('palette')} />
            <Button variant="quiet" size="sm" icon="logout" label={t('mail.signOutOf', { address: client.username })} onClick={onLogout} />
          </span>
        </div>
      </nav>

      {role === CALENDAR ? <CalendarView client={client} say={(text) => say({ text })} /> : role === NOTES ? <NotesView client={client} say={(text) => say({ text })} /> : <>
      <section className="list" aria-label={t('mail.conversations')} onScroll={(e) => {
        const el = e.currentTarget;
        if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 600) loadMore();
      }}>
        <div className="list-head">
        <SendingBlocked client={client} />
        {!online && <p className="banner banner--info offline-banner" role="status">{t(client.offline ? 'mail.offlineSaved' : 'mail.offlineUnsaved', { waiting: outbox ? t('mail.waitingToSend', { count: outbox }) : '' })}</p>}
        <div className="search">
          <Icon name="search" />
          <input ref={searchRef} type="search" placeholder={t('mail.searchMail')} value={query} aria-label={t('mail.searchMailHint')}
            onChange={(e) => { setQuery(e.target.value); setThreadId(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
        </div>
        {query && <SearchChips query={query} contacts={contacts} onChange={(q) => { setQuery(q); setThreadId(null); }} />}

        {selected.size > 0 ? (
          <div className="bulkbar" role="toolbar" aria-label={t('mail.selectedConversations')}>
            <input type="checkbox" className="check" checked={allSelected} aria-label={t('mail.selectAll')}
              onChange={() => setSelected(allSelected ? new Set() : new Set(list?.map((x) => x.threadId)))} />
            <span className="count-label">{t('mail.selected', { count: selected.size })}</span>
            {role !== 'trash' && <Button variant="quiet" size="sm" icon="archive" label={t('mail.archive')} shortcut="e" onClick={() => act('archive')} />}
            <Button variant="quiet" size="sm" icon="trash" label={t('common.delete')} shortcut="#" onClick={() => act('trash')} />
            <Button variant="quiet" size="sm" icon="check" label={t('mail.markRead')} shortcut="Shift+I" onClick={() => act('read')} />
            <Button variant="quiet" size="sm" icon="unread" label={t('mail.markUnread')} shortcut="Shift+U" onClick={() => act('unread')} />
            <Button variant="quiet" size="sm" icon="star" label={t('mail.star')} shortcut="s" onClick={() => act('star')} />
            <Menu label={t('mail.snooze')} button={<Button variant="quiet" size="sm" icon="clock" label={t('mail.snooze')} />}>
              {(close) => <><p className="menu-title">{t('mail.snoozeUntil')}</p><TimeChoices verb={t('mail.snooze')} close={close} onPick={(d) => act({ snooze: d })} /></>}
            </Menu>
            {selectionMenu('move')}{selectionMenu('label')}
            <Button variant="link" className="push" onClick={() => setSelected(new Set())}>{t('mail.clear')}</Button>
          </div>
        ) : <div className="list-title-row"><h2 className="list-title">{heading}</h2>
              {query && !saved.some((x) => x.query === query) && <Button variant="link" onClick={saveSearch}>{t('mail.saveSearch')}</Button>}</div>}
        {role === 'inbox' && categories && !selected.size && (
          <div className="tabs" role="tablist" aria-label={t('mail.inboxCategories')}>
            {(['primary', ...tabs] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`}
                onClick={() => { setTab(k); setThreadId(null); }}>
                <Icon name={TAB_ICON[k]} size={16} />{t(TAB_LABEL[k])}
              </button>
            ))}
          </div>
        )}
        </div>

        {role === CONTACTS ? (
          <ContactList contacts={people} selected={personId}
            onSelect={(id) => { setPersonId(id); setEditingPerson(false); }} onNew={() => { setPersonId(null); setEditingPerson(true); }}
            onNewGroup={() => { setPersonId(null); setEditingPerson('group'); }} />
        ) : role === SUBSCRIPTIONS ? (
          <SubscriptionsList subs={subs} onDeleteAll={deleteAllFrom}
            onUnsubscribe={(x) => unsubscribe({ from: [x.from], unsubscribe: x.unsubscribe })} />
        ) : role === TASKS ? (
          <TaskList client={client} say={(text) => say({ text })} onOpenThread={(tid) => { setView(null); setThreadId(tid); }} />
        ) : role === SCHEDULED ? (
          <>
            {scheduled === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
            {scheduled?.length === 0 && <p className="empty">{t('mail.nothingScheduled')}</p>}
            <ul className="rows">
              {scheduled?.map((s) => (
                <li key={s.submissionId} className="row">
                  <button className="open" onClick={() => editScheduled(s)} title={t('mail.cancelAndEdit')}>
                    <span className="from">{t('mail.toNames', { names: s.email.to?.map((a) => displayName(a)).join(', ') || t('mail.noRecipients') })}</span>
                    <time className="sends">{describe(new Date(s.sendAt))}</time>
                    <span className="subject">{s.email.subject || t('mail.noSubject')}</span>
                    <span className="preview">{s.email.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {list === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} />)}</div>}
            {opened && currentBox?.myRights && !currentBox.myRights.mayRemoveItems && <p className="list-note">{t('mail.readOnlyShared')}</p>}
            {inScreener && !!list?.length && <p className="list-note">{t('mail.screenerNote')}</p>}
            {list?.length === 0 && <p className="empty">{inScreener ? t('mail.screenerEmpty') : emptyText}</p>}
            <ul className={`rows${selected.size ? ' selecting' : ''}`}>
              {list?.map((e, i) => (<Fragment key={e.threadId}>
                {important > 0 && (i === 0 || i === important) && <li className="list-section" role="presentation">{t(i === 0 ? 'mail.importantUnread' : 'mail.everythingElse')}</li>}
                <li className={`row${e.keywords.$seen ? '' : ' unread'}${e.threadId === threadId ? ' active' : ''}${selected.has(e.threadId) ? ' selected' : ''}`}>
                  <input type="checkbox" className="check" checked={selected.has(e.threadId)} aria-label={e.subject ? t('mail.selectSubject', { subject: e.subject }) : t('mail.selectConversation')}
                    onChange={() => {}} onClick={(ev) => toggleSelect(e.threadId, ev.shiftKey)} />
                  <button className="open" onClick={(ev) => (ev.shiftKey || selected.size ? toggleSelect(e.threadId, ev.shiftKey) : openThread(e.threadId))}>
                    <span className="from">{role === 'sent' || role === 'drafts'
                      ? t('mail.toNames', { names: e.to?.map((a) => displayName(a)).join(', ') || t('mail.noRecipients') }) : displayName(e.from?.[0], client.username)}</span>
                    <time dateTime={e.receivedAt}>{e.keywords.$flagged && <span className="starmark" aria-label={t('folder.starred')}><Icon name="star" size={13} filled /></span>}{shortDate(e.receivedAt)}</time>
                    <span className="subject">{e.keywords.$nudge && role === 'inbox' && <span className="pill pill--warn">{t('mail.noReplyYet')}</span>}
                      {Object.keys(e.mailboxIds ?? {}).filter((id) => id !== current && userFolders.has(id)).slice(0, 2).map((id) => <span key={id} className="pill">{userFolders.get(id)}</span>)}
                      {e.subject || t('mail.noSubject')}{e.hasAttachment && <Icon name="clip" size={14} />}</span>
                    <span className="preview">{e.preview}</span>
                  </button>
                  {inScreener && !selected.size && e.from?.[0] && (
                    <span className="row-actions screen-actions">
                      <Button size="sm" variant="primary" onClick={() => screen(e.from![0].email, true)}>{t('mail.allow')}</Button>
                      <Button size="sm" onClick={() => screen(e.from![0].email, false)}>{t('mail.block')}</Button>
                    </span>
                  )}
                  {role !== 'trash' && !inScreener && !selected.size && (
                    <span className="row-actions">
                      <Button variant="quiet" size="sm" icon="star" iconFilled={!!e.keywords.$flagged} label={t(e.keywords.$flagged ? 'mail.unstar' : 'mail.star')} shortcut="s" onClick={() => act('star', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="archive" label={t('mail.archive')} shortcut="e" onClick={() => act('archive', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="trash" label={t('common.delete')} shortcut="#" onClick={() => act('trash', [e.threadId])} />
                    </span>
                  )}
                </li>
              </Fragment>))}
            </ul>
            {hasMore && <div className="list-more"><Button variant="link" onClick={loadMore}>{t('mail.showMore')}</Button></div>}
          </>
        )}
      </section>

      <section className="reader" aria-label={t('mail.conversation')}>
        {role === CONTACTS
          ? <ContactPanel contact={people?.find((x) => x.id === personId) ?? null} editing={editingPerson} all={people ?? []}
              onEmailAll={(to) => setCompose(withSignature({ ...EMPTY_DRAFT, to }))}
              onEdit={() => setEditingPerson(true)} onCancel={() => setEditingPerson(false)}
              onSave={async (c) => { const id = await client.saveContact(c); setEditingPerson(false); setPersonId(id); say({ text: t('mail.contactSaved') }); refresh(); loadContacts(); }}
              onDelete={async (c) => {
                if (!(await confirmIt({ title: t('mail.deleteContactTitle', { name: fullName(c) || c.emails[0] }), body: t('mail.deleteContactBody'), confirm: t('mail.deleteContact'), danger: true }))) return;
                try { await client.deleteContact(c.id!); setPersonId(null); say({ text: t('mail.contactDeleted') }); refresh(); loadContacts(); } catch (e) { fail(e); }
              }}
              onEmail={(c) => setCompose(withSignature({ ...EMPTY_DRAFT, to: [{ name: fullName(c) || null, email: c.emails[0] }] }))} />
          : threadId
          ? <ErrorBoundary resetKey={threadId}>
              <Reader client={client} me={client.username} messages={messages} error={readerError} folders={folders}
                inTrash={role === 'trash'} inJunk={role === 'junk'}
                onAction={(a) => act(a, [threadId])} onReply={reply} onBack={() => setThreadId(null)}
                onSnooze={(d) => act({ snooze: d }, [threadId])} onMoveTo={(id, label) => act({ moveTo: id, label }, [threadId])}
                onUnsubscribe={unsubscribe} onMore={more} onRsvp={rsvp} onReceipt={receipt} onReact={opened ? undefined : react}
                footer={opened?.whole && <TeamComments client={client} threadId={threadId} version={threadVersion} me={own.username} />} />
            </ErrorBoundary>
          : <div className="reader-empty">
              <p>{selected.size ? t('mail.selected', { count: selected.size }) : t('mail.selectToRead')}</p>
              <p className="fine">{withKeys(t('mail.pressKeys'), { help: '?', palette: '⌘K' })}</p>
            </div>}
      </section>

      </>}

      <ComposeDock windows={windows} contacts={contacts} groups={groups} api={composeApi} signatures={signatures} identities={identities} onSend={send} onClose={closeCompose} />

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <Button variant="link" onClick={toast.undo}>{t('common.undo')}</Button>}
        </div>
      )}

      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay(null)} ask={canAsk() ? { client, open: (tid) => openRef.current(tid) } : undefined} />}
      {overlay === 'settings' && (!opened || ownBoxes) && <Settings client={own} boxes={ownBoxes ?? boxes} prefillRule={rulePrefill}
        onClose={() => { setOverlay(null); setRulePrefill(undefined); reloadCategories(); }} onFoldersChanged={refresh} onIdentitiesChanged={loadIdentity} onAccountDeleted={onLogout}
        onSaved={(m) => { setOverlay(null); setRulePrefill(undefined); say({ text: m }); loadIdentity(); reloadCategories(); }} />}
      {overlay === 'help' && (
        <div className="overlay" onClick={() => setOverlay(null)} onKeyDown={(e) => e.key === 'Escape' && setOverlay(null)}>
          <section className="sheet help" role="dialog" aria-label={t('mail.shortcuts')} onClick={(e) => e.stopPropagation()}>
            <h2>{t('mail.shortcuts')}</h2>
            <dl>
              {[['c', t('mail.keyCompose')], ['/', t('mail.keySearch')], ['⌘K', t('mail.findAnyAction')], ['j / k', t('mail.keyNextPrev')], ['x', t('mail.keySelect')], ['r', t('mail.keyReply')],
                ['a', t('mail.keyReplyAll')], ['f', t('mail.keyForward')], ['e', t('mail.keyArchive')], ['#', t('mail.keyDelete')], ['!', t('mail.keySpam')], ['s', t('mail.keyStar')],
                ['u', t('mail.keyUnread')], ['Shift+I', t('mail.keyRead')], ['m', t('mail.keyMute')], [']', t('mail.keyArchiveNext')], ['z', t('mail.keyUndo')],
                ...(['inbox', 'starred', 'sent', 'drafts', 'contacts', 'calendar'] as const).map((f, i) => [t('mail.keyThen', { first: 'g', second: 'istdck'[i] }), t('mail.goTo', { folder: t(`folder.${f}`) })]),
                ['⌘/Ctrl Enter', t('mail.keySend')], ['Esc', t('mail.keyClose')]]
                .map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
            </dl>
            <p className="fine">{t('mail.searchTips')}{['from:priya', 'has:attachment', 'is:unread', 'in:archive', 'after:2026-10-01'].map((c) => <Fragment key={c}> <code>{c}</code></Fragment>)}</p>
          </section>
        </div>
      )}
    </div>
  );
}

const TAB_ICON = { primary: 'inbox', promotions: 'tag', social: 'person', updates: 'bell', forums: 'replyAll' } as const;

/** Gmail-style one-click filters under the search box, plus "From <person>" for a name being typed. */
function SearchChips({ query, contacts, onChange }: { query: string; contacts: Address[]; onChange: (q: string) => void }) {
  const week = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const chips: [string, string, RegExp][] = [
    [t('mail.chipUnread'), 'is:unread', /(^|\s)is:unread\b/], [t('folder.starred'), 'is:starred', /(^|\s)is:starred\b/],
    [t('mail.chipAttachment'), 'has:attachment', /(^|\s)has:attach\w*/], [t('mail.chipLastWeek'), `after:${week}`, /(^|\s)after:\S+/],
    [t('folder.sent'), 'in:sent', /(^|\s)in:sent\b/], [t('smarts.chipPurchases'), 'is:purchase', /(^|\s)is:purchases?\b/],
  ];
  const toggle = (token: string, re: RegExp) => onChange(re.test(query) ? query.replace(re, ' ').replace(/\s+/g, ' ').trim() : `${query.trim()} ${token}`.trim());
  // The last word, if it's plain text, may be the start of a name: offer people who match.
  const last = /(?:^|\s)([^\s:"]{2,})$/.exec(query)?.[1]?.toLowerCase();
  const people = last ? contacts.filter((c) => c.email.toLowerCase().includes(last) || c.name?.toLowerCase().includes(last)).slice(0, 3) : [];
  return (
    <div className="search-chips" role="toolbar" aria-label={t('mail.searchFilters')}>
      {people.map((c) => (
        <button key={c.email} className="filter-chip person" onClick={() => onChange(query.replace(new RegExp(`${last!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), `from:${c.email}`))}>
          <Icon name="person" size={14} />{t('mail.fromPerson', { name: c.name || c.email })}
        </button>
      ))}
      {chips.map(([label, token, re]) => (
        <button key={label} className={`filter-chip${re.test(query) ? ' on' : ''}`} aria-pressed={re.test(query)} onClick={() => toggle(token, re)}>{label}</button>
      ))}
    </div>
  );
}
