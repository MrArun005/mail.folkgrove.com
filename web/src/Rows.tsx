// The conversation list's rows: sender initial (or checkbox), who, when, subject, preview, label chips, and the
// things you can do to a row (hover buttons with a mouse, swipe on a touch screen, drag onto a folder).
// No state of its own: Mail.tsx owns the list and the selection.
import { Fragment, type ReactNode } from 'react';
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

export function ConversationRows({ list, important, role, current, threadId, selected, me, inScreener, canDrag, labels, colors,
  onOpen, onSelect, onAct, onScreen, onDragStart, onDragEnd }: {
  list: EmailSummary[];
  /** Priority Inbox: how many rows at the top are "Important and unread" (0: no sections). */
  important: number;
  /** The folder on screen: its role (or virtual folder name) and id. */
  role: string | null; current: string | null;
  threadId: string | null; selected: Set<string>; me: string;
  inScreener: boolean; canDrag: boolean;
  /** Folders you made (id → name), shown as chips on rows also filed there; `colors` are the hues you chose. */
  labels: Map<string, string>; colors?: Record<string, number>;
  onOpen: (threadId: string) => void; onSelect: (threadId: string, range: boolean) => void;
  onAct: (a: RowAction, threadId: string) => void; onScreen: (sender: string, allow: boolean) => void;
  onDragStart: (threadIds: string[]) => void; onDragEnd: () => void;
}) {
  /** Whose face a row shows: the sender, or in Sent and Drafts the person it's going to. */
  const who = (e: EmailSummary) => (role === 'sent' || role === 'drafts' ? e.to?.[0] : e.from?.[0]);
  return (
    <ul className={`rows${selected.size ? ' selecting' : ''}`}>
      {list.map((e, i) => (<Fragment key={e.threadId}>
        {important > 0 && (i === 0 || i === important) && <li className="list-section" role="presentation">{t(i === 0 ? 'mail.importantUnread' : 'mail.everythingElse')}</li>}
        <SwipeRow className={`row${e.keywords.$seen ? '' : ' unread'}${e.threadId === threadId ? ' active' : ''}${selected.has(e.threadId) ? ' selected' : ''}`}
          off={!!selected.size || inScreener || role === 'trash'}
          onDragStart={canDrag && !inScreener ? (ev) => {
            const ids = selected.has(e.threadId) ? [...selected] : [e.threadId];
            ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.subject ?? '');
            onDragStart(ids);
          } : undefined} onDragEnd={onDragEnd}
          left={role === 'archive' ? t('common.delete') : t('mail.archive')} onLeft={() => onAct(role === 'archive' ? 'trash' : 'archive', e.threadId)}
          right={t(e.keywords.$seen ? 'mail.markUnread' : 'mail.markRead')} onRight={() => onAct(e.keywords.$seen ? 'unread' : 'read', e.threadId)}>
          {/* The sender's initial; it turns into the checkbox under the pointer, while selecting, and when tapped. */}
          <span className="lead">
            <span className="avatar" aria-hidden="true" style={{ '--h': hue(who(e)?.email ?? '') } as React.CSSProperties}>{(displayName(who(e)) || '?').slice(0, 1).toUpperCase()}</span>
            <input type="checkbox" className="check" checked={selected.has(e.threadId)} aria-label={e.subject ? t('mail.selectSubject', { subject: e.subject }) : t('mail.selectConversation')}
              onChange={() => {}} onClick={(ev) => onSelect(e.threadId, ev.shiftKey)} />
          </span>
          <button className="open" onClick={(ev) => (ev.shiftKey || selected.size ? onSelect(e.threadId, ev.shiftKey) : onOpen(e.threadId))}>
            <span className="from">{role === 'sent' || role === 'drafts'
              ? t('mail.toNames', { names: e.to?.map((a) => displayName(a)).join(', ') || t('mail.noRecipients') }) : displayName(e.from?.[0], me)}</span>
            <time dateTime={e.receivedAt}>{e.keywords.$flagged && <span className="starmark" aria-label={t('folder.starred')}><Icon name="star" size={13} filled /></span>}{shortDate(e.receivedAt)}</time>
            <span className="subject">{e.keywords.$nudge && role === 'inbox' && <span className="pill pill--warn">{t('mail.noReplyYet')}</span>}
              {Object.keys(e.mailboxIds ?? {}).filter((id) => id !== current && labels.has(id)).slice(0, 2).map((id) => <span key={id} className="pill pill--label" style={{ '--h': colors?.[id] ?? hue(labels.get(id)!) } as React.CSSProperties}>{labels.get(id)}</span>)}
              {e.subject || t('mail.noSubject')}{e.hasAttachment && <Icon name="clip" size={14} />}</span>
            <span className="preview">{e.preview}</span>
          </button>
          {inScreener && !selected.size && e.from?.[0] && (
            <span className="row-actions screen-actions">
              <Button size="sm" variant="primary" onClick={() => onScreen(e.from![0].email, true)}>{t('mail.allow')}</Button>
              <Button size="sm" onClick={() => onScreen(e.from![0].email, false)}>{t('mail.block')}</Button>
            </span>
          )}
          {role !== 'trash' && !inScreener && !selected.size && (
            <span className="row-actions">
              <Button variant="quiet" size="sm" icon="star" iconFilled={!!e.keywords.$flagged} label={t(e.keywords.$flagged ? 'mail.unstar' : 'mail.star')} shortcut="s" onClick={() => onAct('star', e.threadId)} />
              <Button variant="quiet" size="sm" icon="archive" label={t('mail.archive')} shortcut="e" onClick={() => onAct('archive', e.threadId)} />
              <Button variant="quiet" size="sm" icon="trash" label={t('common.delete')} shortcut="#" onClick={() => onAct('trash', e.threadId)} />
            </span>
          )}
        </SwipeRow>
      </Fragment>))}
    </ul>
  );
}

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
