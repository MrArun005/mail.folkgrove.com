// The mailbox screen's keyboard shortcuts (Gmail's set; the sheet that lists them is Rail.tsx's ShortcutsHelp) and the
// ⌘K command palette's list. Mail.tsx hands both its current state every render.
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { EmailFull, EmailSummary, Mailbox } from './jmap';
import type { ReplyMode } from './mailutil';
import type { Command } from './Palette';
import { CALENDAR, CONTACTS, shown, STARRED, type RailItem } from './Rail';
import { applyTheme } from './Settings';
import { roleIcon } from './icons';
import type { BulkAction } from './useListActions';
import { t } from './i18n';

type Overlay = 'help' | 'settings' | 'palette' | 'privacy' | null;

export interface ShortcutContext {
  /** What's open over the list: the keys stay out of the editor's and the overlays' way. */
  compose: unknown; overlay: Overlay; setOverlay: Dispatch<SetStateAction<Overlay>>;
  list: EmailSummary[] | null; boxes: Mailbox[]; threadId: string | null; setThreadId: (id: string | null) => void;
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  /** The newest message of the open conversation (reply, forward). */
  last: EmailFull | undefined; toast: { undo?: () => void } | null;
  openFolder: (id: string) => void; openThread: (tid: string) => void; toggleSelect: (tid: string, range: boolean) => void;
  act: (a: BulkAction) => void; reply: (mode: ReplyMode, e: EmailFull) => void; newMessage: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/** Keys on the mailbox screen; re-registered every render, so each key sees the screen as it is now. */
export function useShortcuts({ compose, overlay, setOverlay, list, boxes, threadId, setThreadId, selected, setSelected, last, toast, openFolder, openThread, toggleSelect, act, reply, newMessage, searchRef }: ShortcutContext) {
  const goPending = useRef(false);
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
}

/** The ⌘K palette's commands. */
export function paletteCommands({ navItems, last, openFolder, act, reply, newMessage, searchRef, setOverlay, onLogout }:
  Pick<ShortcutContext, 'last' | 'openFolder' | 'act' | 'reply' | 'newMessage' | 'searchRef' | 'setOverlay'> & { navItems: RailItem[]; onLogout: () => void }): Command[] {
  return [
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
}
