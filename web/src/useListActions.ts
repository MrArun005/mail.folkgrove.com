// What you do to conversations in the list: select, star, read/unread, archive, delete, spam, move, label, snooze, mute (one
// conversation or a selection), the Screener's yes/no, and dragging rows onto a folder.
// Mail.tsx calls this every render with the screen's current state, so each function sees the newest list, selection
// and open conversation (the rows reach them through Mail.tsx's `rowLive` ref).
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { confirmIt, promptIt } from './Dialog';
import { addRule, saveScript } from './Filters';
import type { EmailFull, EmailSummary, Jmap, Mailbox } from './jmap';
import type { Action } from './Reader';
import { SCHEDULED, shown, STARRED, VIRTUAL } from './Rail';
import { SCREENER } from './rules';
import { describe } from './when';
import { t } from './i18n';

const UNDO_MS = 7000; // how long "Archived · Undo" stays

export type BulkAction = Action | 'read' | { snooze: Date } | { moveTo: string | null; label: boolean };

export interface ListContext {
  client: Jmap; boxes: Mailbox[];
  list: EmailSummary[] | null; setList: Dispatch<SetStateAction<EmailSummary[] | null>>;
  selected: Set<string>; setSelected: Dispatch<SetStateAction<Set<string>>>;
  threadId: string | null; setThreadId: (id: string | null) => void;
  messages: EmailFull[] | null; setMessages: Dispatch<SetStateAction<EmailFull[] | null>>;
  /** The folder on screen, its role (or virtual folder), the real folder moves come from, and the Inbox. */
  current: string | null; role: string | null; source: string | null; inbox: string | null;
  say: (toast: { text: string; undo?: () => void }, ms?: number) => void; fail: (e: unknown) => void; refresh: () => void;
}

export function useListActions({ client, boxes, list, setList, selected, setSelected, threadId, setThreadId, messages, setMessages, current, role, source, inbox, say, fail, refresh }: ListContext) {
  // Drag conversations onto a folder in the rail (pointer devices): what is being dragged, and the folder under it.
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const lastClicked = useRef<string | null>(null);

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

  return { toggleSelect, allSelected, act, screen, setDragging, dropOn, setDropOn, canDrag, takesDrop, drop };
}
