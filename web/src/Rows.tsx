// The conversation list's rows: sender initial (or checkbox), who, when, subject, preview, label chips, and the
// things you can do to a row (hover buttons with a mouse, swipe on a touch screen, drag onto a folder).
// No state of its own: Mail.tsx owns the list and the selection.
import { Fragment, memo, type ReactNode } from 'react';
import { Button } from './Button';
import { hue } from './Contacts';
import { Icon } from './icons';
import type { EmailSummary } from './jmap';
import { displayName } from './mailutil';
import { shortDate } from './Reader';
import { useSwipe } from './Swipe';
import { t } from './i18n';

/** What a row itself can ask for; anything else (move, snooze, spam…) is on the toolbar. */
export type RowAction = 'star' | 'archive' | 'trash' | 'read' | 'unread';

export interface RowHandlers {
  onOpen: (threadId: string) => void; onSelect: (threadId: string, range: boolean) => void;
  onAct: (a: RowAction, threadId: string) => void; onScreen: (sender: string, allow: boolean) => void;
  /** A drag began on this row; Mail.tsx decides what travels (the row, or the whole selection if it is in it). */
  onDragStart: (threadId: string) => void; onDragEnd: () => void;
}

/**
 * The rows. Both the list and each row are memoised, and Mail.tsx hands them the same handler functions on every
 * render: so opening a menu, typing in the search box or a toast appearing redraws nothing here, and a new page
 * of fifty conversations draws fifty rows, not the thousand already on screen. (Measured on a 50,000-message
 * mailbox with 1,000 rows loaded: every small action took about 0.4 s before this.)
 */
export const ConversationRows = memo(function ConversationRows({ list, important, role, current, threadId, selected, me, inScreener, canDrag, labels, colors, on }: {
  list: EmailSummary[];
  /** Priority Inbox: how many rows at the top are "Important and unread" (0: no sections). */
  important: number;
  /** The folder on screen: its role (or virtual folder name) and id. */
  role: string | null; current: string | null;
  threadId: string | null; selected: Set<string>; me: string;
  inScreener: boolean; canDrag: boolean;
  /** Folders you made (id → name), shown as chips on rows also filed there; `colors` are the hues you chose. */
  labels: Map<string, string>; colors?: Record<string, number>;
  /** Must be the same object on every render (see above). */
  on: RowHandlers;
}) {
  const selecting = selected.size > 0;
  return (
    <ul className={`rows${selecting ? ' selecting' : ''}`}>
      {list.map((e, i) => (<Fragment key={e.threadId}>
        {important > 0 && (i === 0 || i === important) && <li className="list-section">{t(i === 0 ? 'mail.importantUnread' : 'mail.everythingElse')}</li>}
        <Row e={e} active={e.threadId === threadId} selected={selected.has(e.threadId)} selecting={selecting} role={role} current={current} me={me}
          inScreener={inScreener} canDrag={canDrag} labels={labels} colors={colors} on={on} />
      </Fragment>))}
    </ul>
  );
});

const Row = memo(function Row({ e, active, selected, selecting, role, current, me, inScreener, canDrag, labels, colors, on }: {
  e: EmailSummary; active: boolean; selected: boolean; selecting: boolean; role: string | null; current: string | null; me: string;
  inScreener: boolean; canDrag: boolean; labels: Map<string, string>; colors?: Record<string, number>; on: RowHandlers;
}) {
  /** Whose face the row shows: the sender, or in Sent and Drafts the person it's going to. */
  const who = role === 'sent' || role === 'drafts' ? e.to?.[0] : e.from?.[0];
  return (
    <SwipeRow className={`row${e.keywords.$seen ? '' : ' unread'}${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      off={selecting || inScreener || role === 'trash'}
      onDragStart={canDrag && !inScreener ? (ev) => {
        ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.subject ?? '');
        on.onDragStart(e.threadId);
      } : undefined} onDragEnd={on.onDragEnd}
      left={role === 'archive' ? t('common.delete') : t('mail.archive')} onLeft={() => on.onAct(role === 'archive' ? 'trash' : 'archive', e.threadId)}
      right={t(e.keywords.$seen ? 'mail.markUnread' : 'mail.markRead')} onRight={() => on.onAct(e.keywords.$seen ? 'unread' : 'read', e.threadId)}>
      {/* The sender's initial; it turns into the checkbox under the pointer, while selecting, and when tapped. */}
      <span className="lead">
        <span className="avatar" aria-hidden="true" style={{ '--h': hue(who?.email ?? '') } as React.CSSProperties}>{(displayName(who) || '?').slice(0, 1).toUpperCase()}</span>
        <input type="checkbox" className="check" checked={selected} aria-label={e.subject ? t('mail.selectSubject', { subject: e.subject }) : t('mail.selectConversation')}
          onChange={() => {}} onClick={(ev) => on.onSelect(e.threadId, ev.shiftKey)} />
      </span>
      <button className="open" onClick={(ev) => (ev.shiftKey || selecting ? on.onSelect(e.threadId, ev.shiftKey) : on.onOpen(e.threadId))}>
        <span className="from">{role === 'sent' || role === 'drafts'
          ? t('mail.toNames', { names: e.to?.map((a) => displayName(a)).join(', ') || t('mail.noRecipients') }) : displayName(e.from?.[0], me)}</span>
        <time dateTime={e.receivedAt}>{e.keywords.$flagged && <span className="starmark" aria-label={t('folder.starred')}><Icon name="star" size={13} filled /></span>}{shortDate(e.receivedAt)}</time>
        <span className="subject">{e.keywords.$nudge && role === 'inbox' && <span className="pill pill--warn">{t('mail.noReplyYet')}</span>}
          {Object.keys(e.mailboxIds ?? {}).filter((id) => id !== current && labels.has(id)).slice(0, 2).map((id) => <span key={id} className="pill pill--label" style={{ '--h': colors?.[id] ?? hue(labels.get(id)!) } as React.CSSProperties}>{labels.get(id)}</span>)}
          {e.subject || t('mail.noSubject')}{e.hasAttachment && <Icon name="clip" size={14} />}</span>
        <span className="preview">{e.preview}</span>
      </button>
      {inScreener && !selecting && e.from?.[0] && (
        <span className="row-actions screen-actions">
          <Button size="sm" variant="primary" onClick={() => on.onScreen(e.from![0].email, true)}>{t('mail.allow')}</Button>
          <Button size="sm" onClick={() => on.onScreen(e.from![0].email, false)}>{t('mail.block')}</Button>
        </span>
      )}
      {role !== 'trash' && !inScreener && !selecting && (
        <span className="row-actions">
          <Button variant="quiet" size="sm" icon="star" iconFilled={!!e.keywords.$flagged} label={t(e.keywords.$flagged ? 'mail.unstar' : 'mail.star')} shortcut="s" onClick={() => on.onAct('star', e.threadId)} />
          <Button variant="quiet" size="sm" icon="archive" label={t('mail.archive')} shortcut="e" onClick={() => on.onAct('archive', e.threadId)} />
          <Button variant="quiet" size="sm" icon="trash" label={t('common.delete')} shortcut="#" onClick={() => on.onAct('trash', e.threadId)} />
        </span>
      )}
    </SwipeRow>
  );
});

/** Nothing left in the Inbox: say so like it's good news, and show what was kept away meanwhile. */
export function InboxZero({ blocked, onCompose }: { blocked: number; onCompose: () => void }) {
  return (
    <div className="inbox-zero">
      <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <circle cx="60" cy="60" r="52" className="iz-ring" />
        <path d="M38 62l15 15 30-34" className="iz-tick" />
      </svg>
      <h3>{t('mail.zeroTitle')}</h3>
      <p>{blocked > 0 ? t('mail.zeroBlocked', { count: blocked }) : t('mail.zeroBody')}</p>
      <Button onClick={onCompose} icon="compose">{t('mail.compose')}</Button>
    </div>
  );
}

/** A conversation row you can swipe on a touch screen: left and right each do one thing, named as you drag. */
function SwipeRow({ className, off, left, right, onLeft, onRight, onDragStart, onDragEnd, children }: {
  className: string; off: boolean; left: string; right: string; onLeft: () => void; onRight: () => void;
  /** With a mouse: drag the row onto a folder in the rail. */
  onDragStart?: (e: React.DragEvent<HTMLLIElement>) => void; onDragEnd?: () => void; children: ReactNode;
}) {
  const swipe = useSwipe<HTMLLIElement>({ off, onLeft, onRight });
  return <li ref={swipe} className={className} data-swipe-left={left} data-swipe-right={right}
    draggable={!!onDragStart} onDragStart={onDragStart} onDragEnd={onDragEnd}>{children}</li>;
}
