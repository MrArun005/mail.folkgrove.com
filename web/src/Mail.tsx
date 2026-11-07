import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Compose, type ComposeApi } from './Compose';
import { Icon, roleIcon } from './icons';
import { Jmap, UNDO_SECONDS, type Address, type Draft, type EmailFull, type EmailSummary, type Filter, type Identity, type Mailbox, type Scheduled } from './jmap';
import { displayName, draftFor, draftFromEmail, formatAddresses, parseAddresses, textToHtml, unsubscribePlan, type ReplyMode } from './mailutil';
import { Menu, TimeChoices } from './Menu';
import { Palette, type Command } from './Palette';
import { Reader, shortDate, type Action, type MoreAction } from './Reader';
import { addRule } from './Filters';
import type { Rule } from './rules';
import { buildSrcdoc } from './safeHtml';
import { parseSearch } from './search';
import { applyTheme, Settings } from './Settings';
import { cache } from './store';
import { describe } from './when';

const FALLBACK_POLL_MS = 5 * 60_000; // push does the real work; this only covers a silently dead stream
const EMPTY_DRAFT: Draft = { to: [], cc: [], subject: '', html: '', text: '', attachments: [] };
// Virtual folders: views that aren't mailboxes on the server.
const STARRED = 'starred', SCHEDULED = 'scheduled';

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
  const [query, setQuery] = useState('');
  const [list, setList] = useState<EmailSummary[] | null>(null);
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

  const inbox = boxes.find((b) => b.role === 'inbox')?.id ?? null;
  const current = query ? null : view ?? inbox;
  const currentBox = boxes.find((b) => b.id === current);
  const role = current === STARRED ? STARRED : current === SCHEDULED ? SCHEDULED : currentBox?.role ?? null;
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

  const refresh = useCallback(async () => {
    try {
      let b = await client.mailboxes();
      const woke = await client.wakeSnoozed(b);
      if (woke) { b = await client.mailboxes(); say({ text: woke === 1 ? 'A snoozed conversation is back in your Inbox' : `${woke} snoozed conversations are back in your Inbox` }); }
      setBoxes(b); cache.set(key('boxes'), b);
      const box = query ? null : view ?? b.find((x) => x.role === 'inbox')?.id ?? null;
      if (box === SCHEDULED) { setScheduled(await client.scheduled()); return; }
      const filter: Filter = query ? parseSearch(query, b) : box === STARRED ? { hasKeyword: '$flagged' } : { inMailbox: box };
      const l = await client.threads(filter);
      setList(l);
      if (!query) cache.set(key('list:' + box), l);
    } catch (e) { say({ text: e instanceof Error ? e.message : String(e) }); }
  }, [client, view, query]);

  useEffect(() => {
    setList(query ? null : cache.get(key('list:' + (view ?? inbox))));
    setSelected(new Set());
    const t = setTimeout(refresh, query ? 300 : 0); // debounce typing in search
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => { clearTimeout(t); clearInterval(poll); window.removeEventListener('focus', refresh); };
  }, [refresh]);

  // Live updates: the server pushes a note whenever anything changes; coalesce bursts.
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    let t = 0;
    return client.watch(() => {
      clearTimeout(t);
      t = window.setTimeout(() => { refreshRef.current(); setThreadVersion((v) => v + 1); }, 400);
    });
  }, [client]);

  const loadContacts = useCallback(() => client.contacts().then((c) => { setContacts(c); cache.set(key('contacts'), c); }, () => {}), [client]);
  const loadIdentity = useCallback(() => client.getIdentityFresh().then(setIdentity, () => {}), [client]);
  useEffect(() => { loadContacts(); loadIdentity(); }, [loadContacts, loadIdentity]);

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
    if (a === 'trash' && role === 'trash' && !confirm(`Delete ${n > 1 ? `${n} conversations` : 'this conversation'} forever? This can’t be undone.`)) return;
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
        const name = prompt('Name for the new folder')?.trim();
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
      else if (a === 'archive') { const to = await client.mailboxFor('archive', 'Archive', boxes); await each((t) => client.move(t, source, to)); say({ text: `${many} archived` }); }
      else if (a === 'trash' && role === 'trash') { await each((t) => client.destroyThread(t, source)); say({ text: 'Deleted forever' }); }
      else if (a === 'trash') { await each((t) => client.move(t, source, box('trash'))); say({ text: 'Moved to Deleted Items' }); }
      else if (a === 'junk' && role === 'junk') { await each((t) => client.move(t, source, inbox!, { $junk: null, $notjunk: true })); say({ text: 'Moved to Inbox and marked not spam' }); }
      else if (a === 'junk') { await each((t) => client.move(t, source, box('junk'), { $junk: true, $notjunk: null })); say({ text: 'Reported as spam' }); }
    } catch (e) { fail(e); }
    refresh();
  }

  async function unsubscribe(m: EmailFull) {
    const who = displayName(m.from?.[0]);
    const plan = unsubscribePlan(m.unsubscribe);
    if (!plan) return say({ text: `This message doesn’t include a safe way to unsubscribe from ${who}.` }, 6000);
    const where = plan.kind === 'mail' ? `by sending an email to ${plan.to}` : plan.kind === 'post' ? `via ${plan.host}` : `on ${plan.host} (opens in a new tab)`;
    if (!confirm(`Unsubscribe from ${who} ${where}?`)) return;
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
      } else if (what === 'filter') {
        setRulePrefill({ from: sender }); setOverlay('settings');
      } else if (what === 'block') {
        if (!parseAddresses(sender).list.length) return say({ text: 'This sender’s address can’t be blocked safely. Use a filter instead.' });
        if (!confirm(`Block ${sender}? Messages from exactly this address will go straight to Junk. You can undo this in Settings → Filters.`)) return;
        await addRule(client, boxes, { id: crypto.randomUUID(), from: sender, fromExact: true, action: 'block' });
        await act('junk', [m.threadId]);
        say({ text: `Blocked ${sender}` });
      }
    } catch (e) { fail(e); }
  }
  const escape = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // ── Writing ────────────────────────────────────────────

  /** New messages and replies get the signature above any quoted text. */
  const withSignature = (d: Draft): Draft => {
    const sig = identity?.htmlSignature?.trim();
    if (!sig) return d;
    const block = `<div><br></div><div>-- </div>${sig}`;
    return { ...d, html: d.html.startsWith('<div><br></div>') ? d.html.replace('<div><br></div>', `<div><br></div>${block}`) : `<div><br></div>${block}${d.html}` };
  };
  const newMessage = () => setCompose(withSignature(EMPTY_DRAFT));
  function reply(mode: ReplyMode, e: EmailFull) { setCompose(withSignature(draftFor(mode, e, client.username))); }

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
    try { await pending; loadContacts(); } catch (e) {
      say({ text: `Not sent: ${(e as Error).message}` }, 8000);
      setCompose(d); // never lose what someone wrote
      return;
    }
    if (sendAt) return refresh();
    setTimeout(() => { if (!undone) { say({ text: 'Message sent' }); refresh(); setThreadVersion((v) => v + 1); } }, UNDO_SECONDS * 1000);
  }

  async function editScheduled(s: Scheduled) {
    if (!confirm(`Cancel sending “${s.email.subject || '(no subject)'}” on ${describe(new Date(s.sendAt))} and edit it?`)) return;
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
      const keys: Record<string, () => void> = {
        j: () => ids.length && openThread(ids[Math.min(i + 1, ids.length - 1)]),
        k: () => ids.length && openThread(ids[Math.max(i - 1, 0)]),
        x: () => threadId && toggleSelect(threadId, false),
        e: () => act('archive'), '#': () => act('trash'), '!': () => act('junk'), u: () => act('unread'), s: () => act('star'),
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
  const emptyText = query ? `No messages match “${query}”. Try from:, subject: or has:attachment.`
    : role === 'inbox' ? 'You’re all caught up.'
    : role === STARRED ? 'Star a conversation to keep it here. Press s while reading.'
    : role === 'snoozed' ? 'Snoozed conversations wait here until their time comes.'
    : `Nothing in ${heading}.`;
  const selectionMenu = (kind: 'move' | 'label') => (
    <Menu label={kind === 'move' ? 'Move to' : 'Label as'} button={<Button variant="quiet" size="sm" icon={kind === 'move' ? 'folder' : 'tag'} label={kind === 'move' ? 'Move to folder' : 'Label as'} />}>
      {(close) => <>
        <p className="menu-title">{kind === 'move' ? 'Move to' : 'Label as'}</p>
        {folders.map((f) => <button key={f.id} className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: f.id, label: kind === 'label' }); }}><Icon name="folder" size={16} />{f.name}</button>)}
        <button className="menu-item" role="menuitem" onClick={() => { close(); act({ moveTo: null, label: kind === 'label' }); }}><Icon name="compose" size={16} />New folder…</button>
      </>}
    </Menu>
  );

  return (
    <div className={`app${threadId ? ' reading' : ''}`}>
      <nav className="rail" aria-label="Folders">
        <p className="wordmark">OpenMail</p>
        <Button variant="primary" size="lg" icon="compose" className="compose-btn" onClick={newMessage} title="Compose (c)">Compose</Button>
        <ul>
          {navItems.map((b) => (
            <li key={b.id}>
              <button className={`nav-item${b.id === current ? ' active' : ''}`} aria-current={b.id === current ? 'page' : undefined} onClick={() => openFolder(b.id)}>
                <Icon name={roleIcon(b.role)} /><span className="name">{b.name}</span>
                {b.unreadEmails > 0 && !['trash', 'sent', 'drafts'].includes(b.role ?? '') && <span className="count">{b.unreadEmails}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="me">
          <span className="addr">{identity?.name && identity.name !== identity.email ? identity.name : client.username}</span>
          <span className="links">
            <Button variant="link" onClick={() => setOverlay('settings')}>Settings</Button>
            <Button variant="link" onClick={() => setOverlay('palette')} title="Find any action (⌘K)">Commands</Button>
            <Button variant="link" onClick={onLogout}>Sign out</Button>
          </span>
        </div>
      </nav>

      <section className="list" aria-label="Conversations">
        <div className="list-head">
        <div className="search">
          <Icon name="search" />
          <input ref={searchRef} type="search" placeholder="Search mail" value={query} aria-label="Search mail (try from: or has:attachment)"
            onChange={(e) => { setQuery(e.target.value); setThreadId(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
        </div>

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
        ) : <h2 className="list-title">{heading}</h2>}
        </div>

        {role === SCHEDULED ? (
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
            {list?.length === 0 && <p className="empty">{emptyText}</p>}
            <ul className={`rows${selected.size ? ' selecting' : ''}`}>
              {list?.map((e) => (
                <li key={e.threadId} className={`row${e.keywords.$seen ? '' : ' unread'}${e.threadId === threadId ? ' active' : ''}${selected.has(e.threadId) ? ' selected' : ''}`}>
                  <input type="checkbox" className="check" checked={selected.has(e.threadId)} aria-label={`Select ${e.subject || 'conversation'}`}
                    onChange={() => {}} onClick={(ev) => toggleSelect(e.threadId, ev.shiftKey)} />
                  <button className="open" onClick={(ev) => (ev.shiftKey || selected.size ? toggleSelect(e.threadId, ev.shiftKey) : openThread(e.threadId))}>
                    <span className="from">{role === 'sent' || role === 'drafts'
                      ? `To ${e.to?.map((a) => displayName(a)).join(', ') || '(no recipients)'}` : displayName(e.from?.[0], client.username)}</span>
                    <time dateTime={e.receivedAt}>{e.keywords.$flagged && <span className="starmark" aria-label="Starred"><Icon name="star" size={13} filled /></span>}{shortDate(e.receivedAt)}</time>
                    <span className="subject">{e.subject || '(no subject)'}{e.hasAttachment && <Icon name="clip" size={14} />}</span>
                    <span className="preview">{e.preview}</span>
                  </button>
                  {role !== 'trash' && !selected.size && (
                    <span className="row-actions">
                      <Button variant="quiet" size="sm" icon="star" iconFilled={!!e.keywords.$flagged} label={e.keywords.$flagged ? 'Unstar' : 'Star'} shortcut="s" onClick={() => act('star', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="archive" label="Archive" shortcut="e" onClick={() => act('archive', [e.threadId])} />
                      <Button variant="quiet" size="sm" icon="trash" label="Delete" shortcut="#" onClick={() => act('trash', [e.threadId])} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="reader" aria-label="Conversation">
        {threadId
          ? <ErrorBoundary resetKey={threadId}>
              <Reader client={client} me={client.username} messages={messages} error={readerError} folders={folders}
                inTrash={role === 'trash'} inJunk={role === 'junk'}
                onAction={(a) => act(a, [threadId])} onReply={reply} onBack={() => setThreadId(null)}
                onSnooze={(d) => act({ snooze: d }, [threadId])} onMoveTo={(id, label) => act({ moveTo: id, label }, [threadId])}
                onUnsubscribe={unsubscribe} onMore={more} />
            </ErrorBoundary>
          : <div className="reader-empty">
              <p>{selected.size ? `${selected.size} selected` : 'Select a conversation to read it.'}</p>
              <p className="fine">Press <kbd>?</kbd> for keyboard shortcuts, or <kbd>⌘K</kbd> to find any action.</p>
            </div>}
      </section>

      {compose && <Compose key={compose.id ?? JSON.stringify(compose).length} initial={compose} contacts={contacts} api={composeApi} onSend={send} onClose={closeCompose} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <Button variant="link" onClick={toast.undo}>Undo</Button>}
        </div>
      )}

      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === 'settings' && <Settings client={client} boxes={boxes} prefillRule={rulePrefill}
        onClose={() => { setOverlay(null); setRulePrefill(undefined); }} onFoldersChanged={refresh}
        onSaved={(m) => { setOverlay(null); setRulePrefill(undefined); say({ text: m }); loadIdentity(); }} />}
      {overlay === 'help' && (
        <div className="overlay" onClick={() => setOverlay(null)} onKeyDown={(e) => e.key === 'Escape' && setOverlay(null)}>
          <section className="sheet help" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <dl>
              {[['c', 'Compose'], ['/', 'Search'], ['⌘K', 'Find any action'], ['j / k', 'Next / previous'], ['x', 'Select'], ['r', 'Reply'],
                ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Report spam'], ['s', 'Star'],
                ['u', 'Mark unread'], ['Shift+I', 'Mark read'], ['⌘/Ctrl Enter', 'Send'], ['Esc', 'Close or clear']]
                .map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
            </dl>
            <p className="fine">Search tips: <code>from:priya</code> <code>has:attachment</code> <code>is:unread</code> <code>in:archive</code> <code>after:2026-10-01</code></p>
          </section>
        </div>
      )}
    </div>
  );
}
