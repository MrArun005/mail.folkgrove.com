import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SendingBlocked } from './Sending';
import { confirmIt, promptIt } from './Dialog';
import { Button } from './Button';
import type { ComposeApi } from './Compose';
import { ComposeDock, useComposeWindows } from './ComposeDock';
import { messageActions } from './messageActions';
import { SearchChips } from './SearchChips';
import { Icon, roleIcon } from './icons';
import { Jmap, UNDO_SECONDS, type SharedAccount, type Contact, type Subscription, type Address, type Draft, type EmailFull, type EmailSummary, type Filter, type Identity, type Mailbox, type Scheduled } from './jmap';
import { addSignature, chooseSignature, displayName, draftFor, draftFromEmail, fileSize, htmlToText, textToHtml, type ReplyMode, type Signature } from './mailutil';
import { Menu, TimeChoices } from './Menu';
import { Palette, type Command } from './Palette';
import { canAsk } from './ai';
import { SubscriptionsList } from './Subscriptions';
import { ContactList, ContactPanel, fullName, groupAddresses } from './Contacts';
import { CalendarView } from './CalendarView';
import { FeedView } from './FeedView';
import { Reader, type Action } from './Reader';
import { TaskList } from './Tasks';
import { NotesView } from './Notes';
import { addRule, loadScript, saveScript } from './Filters';
import { DEFAULT_TABS, SCREENER, TAB_LABEL, tabKeyword, TABS, type Rule, type ScriptData, type Tab } from './rules';
import { enablePush, notifyOn, showMail } from './notify';
import { setBadge, takeLaunch } from './launch';
import { offlineStore } from './offline';
import { parseSearch } from './search';
import { applyTheme, Settings } from './Settings';
import { cache } from './store';
import { describe } from './when';
import { TeamComments, useShared } from './Sharing';
import { t } from './i18n';
import { clearRoute, readRoute, writeRoute, type Route } from './route';
import { ConversationRows, InboxZero } from './Rows';
import { Rail, ShortcutsHelp, shown } from './Rail';
import { PrivacyReport } from './PrivacyReport';
import { readTally, week } from './privacy';

const PAGE = 50;
const UNDO_MS = 7000; // how long "Archived · Undo" stays
const FALLBACK_POLL_MS = 5 * 60_000; // push does the real work; this only covers a silently dead stream
const EMPTY_DRAFT: Draft = { to: [], cc: [], subject: '', html: '', text: '', attachments: [] };
// Virtual folders: views that aren't mailboxes on the server.
const STARRED = 'starred', SCHEDULED = 'scheduled', SUBSCRIPTIONS = 'subscriptions', CONTACTS = 'contacts', CALENDAR = 'calendar', TASKS = 'tasks', NOTES = 'notes', FEED = 'feed';
const VIRTUAL = [STARRED, SCHEDULED, SUBSCRIPTIONS, CONTACTS, CALENDAR, TASKS, NOTES, FEED];


type Toast = { text: string; undo?: () => void } | null;

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
    opened={open?.acc ?? null} startView={open?.box} onOpenShared={(acc, box) => { clearRoute(); setOpen(acc && { acc, box }); }} />;
}

function MailView({ client, own, sharing, opened, startView, onOpenShared, onLogout, accounts, onSwitch, onAddAccount }: MailProps & {
  /** Your own account (Settings, the shared list); `client` is the account on screen. */
  own: Jmap; sharing: ReturnType<typeof useShared>; opened: SharedAccount | null; startView?: string;
  onOpenShared: (acc: SharedAccount | null, box?: string) => void;
}) {
  const key = (k: string) => `${client.scope}:${k}`;
  const [boxes, setBoxes] = useState<Mailbox[]>(() => cache.get(key('boxes')) ?? []);
  // Where the address bar says we are (route.ts); another person's mailbox starts from the folder that was opened.
  const start = useRef<Route>(opened ? { view: startView ?? null, query: '', thread: null } : readRoute()).current;
  const [view, setView] = useState<string | null>(start.view); // mailbox id or virtual folder; null = Inbox
  const [tab, setTab] = useState<'primary' | Tab>('primary'); // Inbox categories
  const [categories, setCategories] = useState(true);
  const [tabs, setTabs] = useState<Tab[]>(() => cache.get(key('tabs')) ?? ['updates']); // which tabs show next to Primary (cached: no flash of two tabs)
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [saved, setSaved] = useState<{ name: string; query: string }[]>([]);
  const [people, setPeople] = useState<Contact[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [editingPerson, setEditingPerson] = useState<boolean | 'group'>(false);
  const [query, setQuery] = useState(start.query);
  const [list, setList] = useState<EmailSummary[] | null>(null);
  /** Priority Inbox: how many rows at the top are "Important and unread" (from people you write to). */
  const [important, setImportant] = useState(0);
  const correspondents = useRef<Set<string>>(new Set());
  const [scheduled, setScheduled] = useState<Scheduled[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [threadId, setThreadId] = useState<string | null>(start.thread);
  const [messages, setMessages] = useState<EmailFull[] | null>(null);
  const [readerError, setReaderError] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [overlay, setOverlay] = useState<'help' | 'settings' | 'palette' | 'privacy' | null>(null);
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

  // Phones: the rail is a drawer, opened from the top bar.
  const [navOpen, setNavOpen] = useState(false);
  // Keyboard and screen readers: opening the drawer moves focus into it (the folder you're in), closing it hands
  // focus back to the button that opened it, and the page behind can't be reached while it is open.
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (navOpen) document.querySelector<HTMLElement>('.rail .nav-item.active, .rail .nav-item')?.focus();
    else if (wasOpen.current && document.activeElement?.closest('.rail, body') && !document.activeElement.closest('.list, .reader, .overlay, .compose')) menuButton.current?.focus();
    wasOpen.current = navOpen;
  }, [navOpen]);
  // Drag conversations onto a folder in the rail (pointer devices): what is being dragged, and the folder under it.
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const inbox = boxes.find((b) => b.role === 'inbox')?.id ?? null;
  // The address bar follows the screen, and Back / Forward (or an edited link) move the screen.
  const place = useRef(start);
  useEffect(() => {
    const next = { view: view === inbox ? null : view, query, thread: threadId };
    writeRoute(place.current, next); place.current = next;
  }, [view, query, threadId, inbox]);
  useEffect(() => {
    const onPop = () => { const r = readRoute(); place.current = r; setView(r.view); setQuery(r.query); setThreadId(r.thread); setNavOpen(false); setOverlay(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Settings, the shortcuts sheet and the palette are a step of their own: Back closes them, not the page under them.
  const layered = !!overlay;
  useEffect(() => {
    if (layered) { if (!history.state?.omLayer) history.pushState({ ...history.state, omLayer: true }, ''); }
    else if (history.state?.omLayer) history.back();
  }, [layered]);
  // A link to a folder that no longer exists (or another account's) shows the Inbox.
  useEffect(() => {
    if (view && boxes.length && !VIRTUAL.includes(view) && !boxes.some((b) => b.id === view)) setView(null);
  }, [boxes, view]);
  /** Cache key for a list: the Inbox has one per category tab. */
  const listKey = (box: string | null) => `list:${box}${box && box === inbox && categories ? `:${tab}` : ''}`;
  const current = query ? null : view ?? inbox;
  const currentBox = boxes.find((b) => b.id === current);
  const role = VIRTUAL.includes(current ?? '') ? current : currentBox?.role ?? null;
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
      if (box === CALENDAR || box === TASKS || box === NOTES || box === FEED) return; // these load their own data
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

  const [sigData, setSigData] = useState<Pick<ScriptData, 'signatures' | 'sigNew' | 'sigReply' | 'colors'>>({});
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

  function openFolder(id: string) { setView(id); setQuery(''); setThreadId(null); setNavOpen(false); }

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
      // Undo (the toast's link, or z): put them back where they were.
      // ponytail: moves the whole conversation's copies in `to` back, including a message that was already there.
      const back = (to: string, kw: Record<string, true | null> = {}) => async () => {
        say({ text: t('mail.undoing') }, 0);
        try { await each((t) => client.move(t, to, source, kw)); say({ text: t('mail.undone') }); } catch (e) { fail(e); }
        refresh();
      };
      if (typeof a === 'object' && 'snooze' in a) { await each((t) => client.snooze(t, source, a.snooze, boxes)); say({ text: t('mail.snoozedUntil', { count: n, time: describe(a.snooze) }) }); }
      else if (typeof a === 'object') {
        const b = boxes.find((x) => x.id === target), name = b ? shown(b) : t('mail.theNewFolder');
        await each((t) => (label ? client.addToMailbox(t, target!) : client.move(t, source, target!)));
        say(label ? { text: t('mail.labelled', { name }) } : { text: t('mail.movedTo', { count: n, name }), undo: back(target!) }, UNDO_MS);
      }
      else if (a === 'mute') { await each((t) => client.mute(t, source, boxes)); say({ text: t('mail.muted', { count: n }) }); }
      else if (a === 'archive') { const to = await client.mailboxFor('archive', 'Archive', boxes); await each((t) => client.move(t, source, to)); say({ text: t('mail.archived', { count: n }), undo: back(to) }, UNDO_MS); }
      else if (a === 'trash' && role === 'trash') { await each((t) => client.destroyThread(t, source)); say({ text: t('mail.deletedForever') }); }
      else if (a === 'trash') { const to = box('trash'); await each((t) => client.move(t, source, to)); say({ text: t('mail.movedToTrash'), undo: back(to) }, UNDO_MS); }
      else if (a === 'junk' && role === 'junk') { await each((t) => client.move(t, source, inbox!, { $junk: null, $notjunk: true })); say({ text: t('mail.notSpam') }); }
      else if (a === 'junk') { const to = box('junk'); await each((t) => client.move(t, source, to, { $junk: true, $notjunk: null })); say({ text: t('mail.reportedSpam'), undo: back(to, { $junk: null }) }, UNDO_MS); }
    } catch (e) { fail(e); }
    refresh();
  }

  // What you can do with one message or sender (unsubscribe, block, print, RSVP, receipts, reactions…): messageActions.ts.
  const { unsubscribe, deleteAllFrom, saveSearch, removeSearch, more, rsvp, receipt, react } = messageActions({
    client, boxes, query, identities: identities.map((i) => i.email), say, fail, refresh, act: (a, tids) => act(a, tids), setSaved,
    reloadThread: () => setThreadVersion((v) => v + 1), loadContacts,
    search: (q) => { setQuery(q); setThreadId(null); }, filterLike: (from) => { setRulePrefill({ from }); setOverlay('settings'); },
  });

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
    // The signature is added before the words, so it lands under them rather than above (it goes after the first
    // blank line, and the words then take that line).
    const signed = withSignature(d, 'reply');
    if (text) signed.html = signed.html.replace('<div><br></div>', `${text.trim().split('\n').map((l) => `<div>${escape(l) || '<br>'}</div>`).join('')}<div><br></div>`);
    setCompose(signed);
  }

  /** A short reply typed under the conversation: built like any reply (quote, signature) and sent at once, with Undo. */
  function quickReply(e: EmailFull, text: string, all: boolean) {
    const d = draftFor(all ? 'replyAll' : 'reply', e, client.username, identities.map((i) => i.email));
    const lines = text.trim().split('\n').map((l) => `<div>${escape(l) || '<br>'}</div>`).join('');
    // Signature first (it goes under the blank first line), then the words onto that line: text, signature, quote.
    const signed = withSignature(d, 'reply');
    const html = signed.html.replace('<div><br></div>', `${lines}<div><br></div>`);
    send({ ...signed, html, text: htmlToText(html) });
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
    activity: (email) => client.threads({ from: email }, 30).then((l) => l.map((e) => e.receivedAt)),
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
      { id: FEED, name: FEED, role: FEED, unreadEmails: 0, sortOrder: 0 },
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
    { id: 'privacy', label: t('privacy.title'), icon: 'shield', run: () => setOverlay('privacy') },
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

  // ── Drag to a folder ───────────────────────────────────

  const canDrag = !['drafts', 'trash', SCHEDULED].includes(role ?? '');
  /** Folders that take a drop: yours, plus Inbox, Archive, Deleted Items and Junk; never the one you're in. */
  const takesDrop = (b: { id: string; role?: string | null }) =>
    !!dragging && b.id !== current && !VIRTUAL.includes(b.id) && (!b.role || ['inbox', 'archive', 'trash', 'junk'].includes(b.role));
  function drop(b: { id: string; role?: string | null }) {
    const ids = dragging ?? [];
    setDragging(null); setDropOn(null);
    if (!ids.length) return;
    // Deleted Items and Junk mean more than a move (confirmations, spam training), so they go the usual way.
    if (b.role === 'trash') act('trash', ids);
    else if (b.role === 'junk' || (role === 'junk' && b.role === 'inbox')) act('junk', ids);
    else if (b.role === 'archive') act('archive', ids);
    else act({ moveTo: b.id, label: false }, ids);
  }

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
    <div className={`app${role === CALENDAR || role === NOTES || role === FEED ? ' calendar-mode' : ''}${threadId || (role === CONTACTS && (personId || editingPerson)) ? ' reading' : ''}${navOpen ? ' nav-open' : ''}`}
      onKeyDown={(e) => { if (e.key === 'Escape' && navOpen) { e.stopPropagation(); setNavOpen(false); } }}>
      {/* Phones only: the way to the folders, the account and Settings (the rail is a drawer there). */}
      <header className="topbar">
        <Button ref={menuButton} variant="quiet" icon="menu" label={t('mail.openMenu')} aria-expanded={navOpen} onClick={() => setNavOpen(true)} />
        <h1 className="topbar-title">{heading}</h1>
        <Button variant="quiet" icon="settings" label={t('mail.settings')} onClick={() => setOverlay('settings')} />
      </header>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <Rail items={navItems} current={current} query={query} open={railOpen} onToggle={toggleRail} onFolder={openFolder} onCompose={newMessage}
        opened={opened} sharing={sharing} onOpenShared={onOpenShared} onError={fail} colors={opened ? undefined : sigData.colors}
        saved={saved} onSavedSearch={(q) => { setQuery(q); setThreadId(null); setNavOpen(false); }} onRemoveSearch={removeSearch}
        name={identity?.name && identity.name !== identity.email ? identity.name : client.username} username={client.username}
        accounts={accounts} onSwitch={onSwitch} onAddAccount={onAddAccount} onLogout={onLogout}
        onSettings={() => { setNavOpen(false); setOverlay('settings'); }} onPalette={() => { setNavOpen(false); setOverlay('palette'); }} onPrivacy={() => { setNavOpen(false); setOverlay('privacy'); }} blockedThisWeek={week(readTally(own.username)).total}
        takesDrop={takesDrop} dropOn={dropOn} onDropOver={setDropOn} onDrop={drop} />

      {role === CALENDAR ? <CalendarView client={client} say={(text) => say({ text })} /> : role === FEED ? <FeedView client={client} say={(text) => say({ text })} onOpen={(tid) => openRef.current(tid)} onUnsubscribe={unsubscribe} /> : role === NOTES ? <NotesView client={client} say={(text) => say({ text })} /> : <>
      <section className="list" aria-label={t('mail.conversations')} inert={navOpen} onScroll={(e) => {
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
            {list?.length === 0 && (role === 'inbox' && !query && (!categories || tab === 'primary')
              ? <InboxZero blocked={readTally(own.username).trackers} onCompose={newMessage} />
              : <p className="empty">{inScreener ? t('mail.screenerEmpty') : emptyText}</p>)}
            <ConversationRows list={list ?? []} important={important} role={role} current={current} threadId={threadId} selected={selected}
              me={client.username} inScreener={inScreener} canDrag={canDrag} labels={userFolders} colors={sigData.colors}
              onOpen={openThread} onSelect={toggleSelect} onAct={(a, tid) => act(a, [tid])} onScreen={screen}
              onDragStart={setDragging} onDragEnd={() => { setDragging(null); setDropOn(null); }} />
            {hasMore && <div className="list-more"><Button variant="link" onClick={loadMore}>{t('mail.showMore')}</Button></div>}
          </>
        )}
      </section>

      <section className="reader" aria-label={t('mail.conversation')} inert={navOpen}>
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
                onQuickReply={role === 'trash' || role === 'junk' || role === 'drafts' || (opened && !opened.canSend) ? undefined : quickReply}
                footer={opened ? opened.whole && <TeamComments client={client} threadId={threadId} version={threadVersion} me={own.username} />
                  : <TeamComments mine client={client} threadId={threadId} version={threadVersion} me={own.username} />} />
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
      {overlay === 'help' && <ShortcutsHelp onClose={() => setOverlay(null)} />}
      {overlay === 'privacy' && <PrivacyReport user={own.username} onClose={() => setOverlay(null)} onSearch={(q) => { setOverlay(null); setQuery(q); setThreadId(null); }} />}
    </div>
  );
}

const TAB_ICON = { primary: 'inbox', promotions: 'tag', social: 'person', updates: 'bell', forums: 'replyAll' } as const;
