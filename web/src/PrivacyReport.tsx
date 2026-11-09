// Privacy report (the shield in the rail, or ⌘K): who tried to track you, counted on this device as you read.
import { useState } from 'react';
import { Button } from './Button';
import { hue } from './Contacts';
import { confirmIt } from './Dialog';
import { Icon } from './icons';
import { clearTally, ranked, readTally, week } from './privacy';
import { locale, t } from './i18n';

export function PrivacyReport({ user, onClose, onSearch }: { user: string; onClose: () => void; onSearch: (query: string) => void }) {
  const [tally, setTally] = useState(() => readTally(user));
  const { senders, hosts } = ranked(tally);
  const most = Math.max(1, ...senders.map((s) => s.n));
  const w = week(tally), peak = Math.max(1, ...w.days.map((d) => d.n));
  const since = new Date(tally.since).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="overlay" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <section className="sheet privacy" role="dialog" aria-modal="true" aria-label={t('privacy.title')} onClick={(e) => e.stopPropagation()}>
        <header className="privacy-head">
          <span className="privacy-mark"><Icon name="shield" size={22} /></span>
          <h2>{t('privacy.title')}</h2>
          <Button variant="quiet" icon="close" label={t('common.close')} onClick={onClose} autoFocus />
        </header>
        {tally.messages === 0 ? <p className="privacy-empty">{t('privacy.empty')}</p> : <>
          <div className="privacy-stats">
            <p><b>{tally.trackers.toLocaleString(locale())}</b>{t('privacy.statTrackers', { count: tally.trackers })}</p>
            <p><b>{tally.messages.toLocaleString(locale())}</b>{t('privacy.statMessages', { count: tally.messages })}</p>
            <p><b>{senders.length.toLocaleString(locale())}</b>{t('privacy.statSenders', { count: senders.length })}</p>
          </div>
          <h3>{t('privacy.thisWeek')}</h3>
          <div className="privacy-week">
            <ol aria-hidden="true">
              {w.days.map((d) => (
                <li key={+d.date} title={`${d.date.toLocaleDateString(locale(), { weekday: 'long' })}: ${d.n}`}>
                  <span className="col" style={{ '--w': `${Math.round((d.n / peak) * 100)}%` } as React.CSSProperties} />
                  <span className="day">{d.date.toLocaleDateString(locale(), { weekday: 'narrow' })}</span>
                </li>
              ))}
            </ol>
            <p>{t('privacy.weekTotal', { count: w.total })}{' '}
              <span className="fine">{w.previous > 0 || w.total > 0 ? t('privacy.weekBefore', { count: w.previous }) : ''}</span></p>
          </div>
          <h3>{t('privacy.whoTracks')}</h3>
          <ul className="privacy-list">
            {senders.slice(0, 8).map((s) => (
              <li key={s.email}>
                <span className="avatar" aria-hidden="true" style={{ '--h': hue(s.email) } as React.CSSProperties}>{s.name.slice(0, 1).toUpperCase()}</span>
                <span className="who"><b dir="auto">{s.name}</b><span className="bar" aria-hidden="true" style={{ '--w': `${Math.round((s.n / most) * 100)}%` } as React.CSSProperties} /></span>
                <span className="n">{t('privacy.messages', { count: s.n })}</span>
                <Button variant="link" onClick={() => onSearch(`from:${s.email}`)}>{t('privacy.show')}</Button>
              </li>
            ))}
          </ul>
          {hosts.length > 0 && <>
            <h3>{t('privacy.companies')}</h3>
            <p className="privacy-hosts">{hosts.slice(0, 12).map((h) => <span key={h.host} className="pill"><span dir="ltr">{h.host}</span> · {h.n}</span>)}</p>
          </>}
        </>}
        <p className="fine">{t('privacy.note', { date: since })}</p>
        {tally.messages > 0 && <Button variant="link" className="start" onClick={async () => {
          if (!(await confirmIt({ title: t('privacy.resetTitle'), body: t('privacy.resetBody'), confirm: t('privacy.reset') }))) return;
          clearTally(user); setTally(readTally(user));
        }}>{t('privacy.reset')}</Button>}
      </section>
    </div>
  );
}
