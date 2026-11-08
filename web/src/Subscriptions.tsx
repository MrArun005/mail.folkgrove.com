import { useState } from 'react';
import { Button } from './Button';
import type { Subscription } from './jmap';
import { displayName } from './mailutil';
import { shortDate } from './Reader';
import { t } from './i18n';

/** Every newsletter in one place: unsubscribe, or clear out everything a sender has sent. */
export function SubscriptionsList({ subs, onUnsubscribe, onDeleteAll }: {
  subs: Subscription[] | null;
  onUnsubscribe: (s: Subscription) => Promise<boolean>;
  onDeleteAll: (s: Subscription) => Promise<void>;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  if (subs === null) return <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>;
  if (!subs.length) return <p className="empty">{t('subs.empty')}</p>;
  return (
    <>
      <p className="list-note">{t('subs.note')}</p>
      <ul className="subs">
        {subs.map((s) => {
          const k = s.from.email.toLowerCase();
          return (
            <li key={k} className="sub">
              <span className="avatar" aria-hidden="true" style={{ '--h': hue(k) } as React.CSSProperties}>{displayName(s.from).slice(0, 1).toUpperCase()}</span>
              <span className="who">
                <span className="name">{displayName(s.from)}</span>
                <span className="meta">{t('subs.meta', { count: s.count, date: shortDate(s.lastAt) })}</span>
              </span>
              <span className="actions">
                {done.has(k)
                  ? <span className="done">{t('subs.unsubscribed')}</span>
                  : <Button size="sm" onClick={async () => { if (await onUnsubscribe(s)) setDone((d) => new Set(d).add(k)); }}>{t('subs.unsubscribe')}</Button>}
                <Button variant="quiet" size="sm" icon="trash" label={t('subs.deleteAll', { name: displayName(s.from) })} onClick={() => onDeleteAll(s)} />
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function hue(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
