import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SendingBlocked } from './Sending';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import { ComposeDock, useComposeWindows } from './ComposeDock';
import { messageActions } from './messageActions';
import { SearchChips } from './SearchChips';
import { Icon } from './icons';
import type { Jmap, SharedAccount, Contact, Subscription, Address, EmailFull, EmailSummary, Filter, Identity, Mailbox, Scheduled } from './jmap';
import { displayName, draftFromEmail, type Signature } from './mailutil';
import { Menu, TimeChoices } from './Menu';
import { Palette } from './Palette';
import { canAsk } from './ai';
import { SubscriptionsList } from './Subscriptions';
import { ContactList, ContactPanel, fullName, groupAddresses } from './Contacts';
import { CalendarView } from './CalendarView';
import { FeedView } from './FeedView';
import { Reader } from './Reader';
import { TaskList } from './Tasks';
import { NotesView } from './Notes';
import { loadScript, saveScript } from './Filters';
import { DEFAULT_TABS, SCREENER, TAB_LABEL, tabKeyword, TABS, type Rule, type ScriptData, type Tab } from './rules';
import { enablePush, notifyOn, showMail } from './notify';
import { setBadge } from './launch';
import { parseSearch } from './search';
import { Settings } from './Settings';
import { cache } from './store';
import { describe } from './when';
import { TeamComments, useShared } from './Sharing';
import { t } from './i18n';
import { clearRoute, readRoute, writeRoute, type Route } from './route';
import { ConversationRows, InboxZero, type RowHandlers } from './Rows';
import { CALENDAR, CONTACTS, FEED, NOTES, Rail, railItems, SCHEDULED, ShortcutsHelp, shown, STARRED, SUBSCRIPTIONS, TASKS, VIRTUAL } from './Rail';
import { PrivacyReport } from './PrivacyReport';
import { readTally, week } from './privacy';
import { useListActions } from './useListActions';
import { EMPTY_DRAFT, useSending } from './useSending';
import { paletteCommands, useShortcuts } from './shortcuts';

const PAGE = 50;
const EMPTY_LIST: EmailSummary[] = []; // one array, so an empty list is the same list on every render
const FALLBACK_POLL_MS = 5 * 60_000; // push does the real work; this only covers a silently dead stream

type Toast = { text: string; undo?: () => void } | null;

/** A message with {name} placeholders shown as keycaps: t() leaves unfilled placeholders as they are. */
const withKeys = (text: string, keys: Record<string, string>) =>
  text.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? <kbd key={i}>{keys[part] ?? part}</kbd> : part));

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
  const searchRef = useRef<HTMLInputElement>(null);
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
  const housekept = useRef(0);
  /** The query behind the list on screen, for loading its next page. */
  const shownFilter = useRef<Filter | null>(null);
  const refresh = useCallback(async () => {
    try {
      let b = await client.mailboxes();
      // Housekeeping (waking snoozed mail, muted conversations, follow-up reminders) costs several queries, and a
      // refresh runs on every push, focus and folder change: at most once every ten seconds is plenty for it.
      if (Date.now() - housekept.current > 10_000) {
        housekept.current = Date.now();
        const woke = await client.wakeSnoozed(b);
        if (woke) { b = await client.mailboxes(); say({ text: t('mail.snoozedBack', { count: woke }) }); }
        const nudged = await client.sweep(b).catch(() => 0); // muted conversations, follow-up reminders
        if (nudged) say({ text: t('mail.nudged', { count: nudged }) });
      }
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
      shownFilter.current = filter;
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
  /** Scrolling down: fetch just the next page and add it to the end (later refreshes cover the longer list). */
  async function loadMore() {
    const filter = shownFilter.current;
    if (loadingMore.current || !filter) return;
    loadingMore.current = true;
    try {
      const next = await client.threadsFrom(filter, limit.current, PAGE + 1); // one extra tells us whether there's more
      if (shownFilter.current !== filter) return; // another folder or search meanwhile: not ours to add to
      limit.current += PAGE;
      setHasMore(next.length > PAGE);
      // Mail arriving meanwhile shifts the list down by one, so a page can begin with a row we already have.
      setList((l) => { const have = new Set(l?.map((x) => x.threadId)); return [...(l ?? []), ...next.slice(0, PAGE).filter((e) => !have.has(e.threadId))]; });
    } catch (e) { fail(e); } finally { loadingMore.current = false; }
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

  // ── Actions (one conversation or a selection; drag to a folder; the Screener): useListActions.ts ──
  const { toggleSelect, allSelected, act, screen, setDragging, dropOn, setDropOn, canDrag, takesDrop, drop } = useListActions({
    client, boxes, list, setList, selected, setSelected, threadId, setThreadId, messages, setMessages, current, role, source, inbox, say, fail, refresh,
  });

  // What you can do with one message or sender (unsubscribe, block, print, RSVP, receipts, reactions…): messageActions.ts.
  const { unsubscribe, deleteAllFrom, saveSearch, removeSearch, more, rsvp, receipt, react } = messageActions({
    client, boxes, query, identities: identities.map((i) => i.email), say, fail, refresh, act: (a, tids) => act(a, tids), setSaved,
    reloadThread: () => setThreadVersion((v) => v + 1), loadContacts,
    search: (q) => { setQuery(q); setThreadId(null); }, filterLike: (from) => { setRulePrefill({ from }); setOverlay('settings'); },
  });

  // ── Writing and sending: useSending.ts ────────────────

  const windows = useComposeWindows(client, { send: (d, at) => send(d, at), blocked: () => say({ text: t('mail.popupBlocked') }) });
  const setCompose = windows.open;
  const compose = windows.expanded;
  const { online, outbox, withSignature, reply, quickReply, composeApi, closeCompose, send, editScheduled } = useSending({
    client, boxes, opened, identities: identities.map((i) => i.email), signatures, sigData, setCompose, say, fail, refresh, loadContacts, setThreadVersion,
  });
  const newMessage = () => setCompose(withSignature(EMPTY_DRAFT));

  // Unread Inbox mail on the app icon.
  // ponytail: the active account's Inbox only; other signed-in accounts don't add to it.
  useEffect(() => setBadge(boxes.find((b) => b.role === 'inbox')?.unreadEmails ?? 0), [boxes]);
  useEffect(() => () => setBadge(0), []); // signed out

  // ── Keyboard + command palette ─────────────────────────

  const last = messages?.[messages.length - 1];
  const navItems = railItems(boxes, !!opened);

  const commands = paletteCommands({ navItems, last, openFolder, act, reply, newMessage, searchRef, setOverlay, onLogout });
  useShortcuts({ compose, overlay, setOverlay, list, boxes, threadId, setThreadId, selected, setSelected, last, toast, openFolder, openThread, toggleSelect, act, reply, newMessage, searchRef });

  // The rows are memoised (Rows.tsx), so they get one handler object for the life of the screen. Each handler reads
  // the newest functions through this ref, which is refreshed on every render: never a stale list or selection.
  const rowLive = useRef({ openThread, toggleSelect, act, screen, selected });
  rowLive.current = { openThread, toggleSelect, act, screen, selected };
  const rowHandlers = useMemo<RowHandlers>(() => ({
    onOpen: (tid) => rowLive.current.openThread(tid),
    onSelect: (tid, range) => rowLive.current.toggleSelect(tid, range),
    onAct: (a, tid) => rowLive.current.act(a, [tid]),
    onScreen: (sender, allow) => rowLive.current.screen(sender, allow),
    onDragStart: (tid) => setDragging(rowLive.current.selected.has(tid) ? [...rowLive.current.selected] : [tid]),
    onDragEnd: () => { setDragging(null); setDropOn(null); },
  }), []);

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
            <ConversationRows list={list ?? EMPTY_LIST} important={important} role={role} current={current} threadId={threadId} selected={selected}
              me={client.username} inScreener={inScreener} canDrag={canDrag} labels={userFolders} colors={sigData.colors} on={rowHandlers} />
            {hasMore && <div className="list-more"><Button variant="link" onClick={loadMore}>{t('mail.showMore')}</Button></div>}
          </>
        )}
      </section>

      <section className="reader" aria-label={t('mail.conversation')} inert={navOpen}>
        {role === CONTACTS
          ? <ContactPanel contact={people?.find((x) => x.id === personId) ?? null} editing={editingPerson} all={people ?? []}
              onEmailAll={(to) => setCompose(withSignature({ ...EMPTY_DRAFT, to }))}
              onEdit={() => setEditingPerson(true)} onCancel={() => setEditingPerson(false)} onBack={() => { setPersonId(null); setEditingPerson(false); }}
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
