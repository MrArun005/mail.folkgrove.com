// The left rail: Compose, the folders, mailboxes shared with you, saved searches and the account footer.
// On phones it is the drawer (styles.css). It owns no state: Mail.tsx tells it what to show and hears what was picked.
import { Fragment } from 'react';
import { Button } from './Button';
import { hue } from './Contacts';
import { Icon, roleIcon } from './icons';
import { Menu } from './Menu';
import { SCREENER } from './rules';
import { SharedRail, type useShared } from './Sharing';
import type { SharedAccount } from './jmap';
import { boxName, t } from './i18n';

/** Always in the rail (Gmail's set); everything else folds under More. */
const MAIN = ['inbox', 'starred', 'snoozed', 'sent', 'drafts'];

/** A folder's name on screen: boxName, plus the Screener (a folder we make, found by its name). */
export const shown = (b: { role?: string | null; name: string }) => (!b.role && b.name === SCREENER ? t('folder.screener') : boxName(b));

export type RailItem = { id: string; name: string; role: string | null; unreadEmails: number; depth?: number };

export function Rail({ items, current, colors, query, open, onToggle, onFolder, onCompose, opened, sharing, onOpenShared, onError, saved, onSavedSearch, onRemoveSearch,
  name, username, accounts, onSwitch, onAddAccount, onLogout, onSettings, onPalette, onPrivacy, blockedThisWeek = 0, takesDrop, dropOn, onDropOver, onDrop }: {
  /** Colours chosen for folders (mailbox id → hue); the rest take one from their name. */
  colors?: Record<string, number>;
  /** Folders and places, in order; `current` is the one on screen (null while searching). */
  items: RailItem[]; current: string | null; query: string;
  /** "More" unfolded. */
  open: boolean; onToggle: (open: boolean) => void;
  onFolder: (id: string) => void; onCompose: () => void;
  /** Someone else's mailbox on screen, and the ones you can open. */
  opened: SharedAccount | null; sharing: ReturnType<typeof useShared>; onOpenShared: (acc: SharedAccount | null, box?: string) => void; onError: (e: unknown) => void;
  saved: { name: string; query: string }[]; onSavedSearch: (query: string) => void; onRemoveSearch: (name: string) => void;
  /** The account footer: display name, sign-in name, every account signed in on this tab. */
  name: string; username: string; accounts: string[]; onSwitch: (username: string) => void; onAddAccount: () => void; onLogout: () => void;
  onSettings: () => void; onPalette: () => void; onPrivacy: () => void;
  /** Trackers removed in the last seven days: a small count on the shield. */
  blockedThisWeek?: number;
  /** Dragging conversations onto a folder: which folders take the drop, and the one under the pointer. */
  takesDrop: (b: RailItem) => boolean; dropOn: string | null; onDropOver: (id: string | null) => void; onDrop: (b: RailItem) => void;
}) {
  return (
    <nav className="rail" aria-label={t('mail.folders')}>
      <p className="wordmark">OpenMail</p>
      <Button variant="primary" size="lg" icon="compose" className="compose-btn" onClick={onCompose} title={t('mail.composeTitle')}>{t('mail.compose')}</Button>
      {opened && <p className="banner banner--info shared-banner" role="status"><Icon name={opened.team ? 'inbox' : 'person'} size={16} />
        <span className="grow" title={opened.name}>{t(opened.team ? 'mail.teamMailbox' : opened.whole ? 'mail.delegatedMailbox' : 'mail.sharedFolders')}: <b>{opened.name.replace(/@.*/, '')}</b>
          {!opened.team && opened.canSend && <><br />{t('mail.sendOnBehalf')}</>}</span>
        <Button variant="link" onClick={() => onOpenShared(null)}>{t('mail.backToMyMail')}</Button></p>}
      {/* The main places, then "More" (folded by default, like Gmail), then the folders you made. */}
      {[items.filter((b) => b.role && (MAIN.includes(b.role) || open || b.id === current)), items.filter((b) => !b.role)].map((group, gi) => (
        <div key={gi} className="rail-group">
          {gi === 1 && group.length > 0 && <p className="rail-label">{t('mail.folders')}</p>}
          <ul>
            {group.map((b) => (
              <li key={b.id}>
                <button className={`nav-item${b.id === current ? ' active' : ''}${!b.role && b.name !== SCREENER ? ' labelled' : ''}${takesDrop(b) ? ' drop-ok' : ''}${dropOn === b.id ? ' drop-over' : ''}`}
                  aria-current={b.id === current ? 'page' : undefined} onClick={() => onFolder(b.id)}
                  onDragOver={takesDrop(b) ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropOn !== b.id) onDropOver(b.id); } : undefined}
                  onDragLeave={() => { if (dropOn === b.id) onDropOver(null); }} onDrop={takesDrop(b) ? (e) => { e.preventDefault(); onDrop(b); } : undefined}
                  style={{ ...(b.depth ? { paddingInlineStart: `calc(var(--s3) + ${b.depth} * var(--s4))` } : {}), ...(!b.role ? { '--h': colors?.[b.id] ?? hue(b.name) } : {}) } as React.CSSProperties}>
                  <Icon name={roleIcon(b.role)} /><span className="name">{shown(b)}</span>
                  {b.unreadEmails > 0 && !['trash', 'sent', 'drafts'].includes(b.role ?? '') && <span className="count">{b.unreadEmails}</span>}
                </button>
              </li>
            ))}
            {gi === 0 && (
              <li>
                <button className="nav-item nav-more" aria-expanded={open} onClick={() => onToggle(!open)}>
                  <Icon name="chevron" className={open ? 'flip' : ''} /><span className="name">{t(open ? 'mail.less' : 'mail.more')}</span>
                </button>
              </li>
            )}
          </ul>
        </div>
      ))}
      <SharedRail accounts={sharing.accounts} hidden={sharing.hidden} current={{ account: opened?.id ?? null, box: current }}
        onOpen={(a, b) => onOpenShared(a, b)} onHide={(k) => sharing.hide(k).catch(onError)} onUnhide={() => sharing.unhideAll().catch(onError)} />
      {saved.length > 0 && (
        <div className="saved">
          <p className="rail-label">{t('mail.savedSearches')}</p>
          <ul>
            {saved.map((x) => (
              <li key={x.name} className="saved-item">
                <button className={`nav-item${query === x.query ? ' active' : ''}`} onClick={() => onSavedSearch(x.query)} title={x.query}>
                  <Icon name="search" /><span className="name">{x.name}</span>
                </button>
                <Button variant="quiet" size="sm" icon="close" label={t('mail.removeSavedSearch', { name: x.name })} onClick={() => onRemoveSearch(x.name)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="me">
        <Menu label={t('mail.accounts')} up button={
          <button className="account-btn" title={t('mail.switchAccount')}>
            <span className="addr" dir="auto">{name}</span>
            {accounts.length > 1 && <span className="count">{accounts.length}</span>}
          </button>}>
          {(close) => <>
            <p className="menu-title">{t('mail.signedInHere')}</p>
            {accounts.map((a) => (
              <button key={a} className="menu-item" role="menuitem" aria-current={a === username} onClick={() => { close(); if (a !== username) onSwitch(a); }}>
                <Icon name={a === username ? 'check' : 'person'} size={16} /><span className="grow">{a}</span>
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
          <span className="badged"><Button variant="quiet" size="sm" icon="shield" label={blockedThisWeek ? `${t('privacy.title')}: ${t('privacy.weekBadge', { count: blockedThisWeek })}` : t('privacy.title')} onClick={onPrivacy} />
        {blockedThisWeek > 0 && <span className="badge" aria-hidden="true">{blockedThisWeek > 99 ? '99+' : blockedThisWeek}</span>}</span>
      <Button variant="quiet" size="sm" icon="settings" label={t('mail.settings')} onClick={onSettings} />
          <Button variant="quiet" size="sm" icon="command" label={t('mail.findAnyAction')} shortcut="⌘K" onClick={onPalette} />
          <Button variant="quiet" size="sm" icon="logout" label={t('mail.signOutOf', { address: username })} onClick={onLogout} />
        </span>
      </div>
    </nav>
  );
}

/** The keyboard shortcuts sheet (press ?). */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
      <div className="overlay" onClick={() => onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
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
  );
}
