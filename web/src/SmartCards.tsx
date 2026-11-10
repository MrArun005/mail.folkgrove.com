// What the reader shows from smarts.ts: package / flight / order / booking cards, "Add to calendar", the verified-sender
// mark, the brand logo (BIMI) and the "be careful" note. Kept out of Reader.tsx so it stays a few one-line hooks there.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { EventEditor } from './CalendarView';
import { localZone, toDuration, toLocal, type CalEvent } from './calendar';
import { Icon } from './icons';
import type { EmailFull, Jmap } from './jmap';
import { findCards, findWhen, trust, type CalendarDraft, type Card, type When, ownWords } from './smarts';
import { lang, locale, t } from './i18n';

const ICON = { parcel: 'archive', flight: 'sent', order: 'receipt', stay: 'calendar', event: 'calendar' } as const;
const KIND = { parcel: 'smarts.package', flight: 'smarts.flight', order: 'smarts.order', stay: 'smarts.stay', event: 'smarts.event' } as const;
const fmt = (w: When) => w.at.toLocaleString(locale(), w.time ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function toEvent(d: CalendarDraft, note: string): CalEvent {
  const minutes = d.end && +d.end > +d.start ? Math.round((+d.end - +d.start) / 60000) : d.allDay ? 1440 : 60;
  return { title: d.title, start: toLocal(d.start), timeZone: localZone(), allDay: d.allDay, location: d.location, description: note,
    duration: d.allDay ? `P${Math.max(1, Math.round(minutes / 1440))}D` : toDuration(minutes) };
}

/** Cards above the message, and "Add to calendar" for a card's or the text's date. `text`: what the reader can see. */
export function SmartCards({ client, m, html, text, hasInvite }: { client: Jmap; m: EmailFull; html: string | null; text: string; hasInvite: boolean }) {
  const cards = useMemo(() => findCards(html), [html]); // html: the decrypted one, for encrypted mail
  const mention = useMemo(() => {
    if (hasInvite || cards.length) return null; // an invitation or a card already says when
    const w = findWhen(`${m.subject ?? ''}\n${ownWords(html, text)}`, new Date(m.receivedAt), lang()); // not dates inside what it quotes
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return w && +w.start >= +today ? w : null;
  }, [m.id, text, cards, hasInvite]);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [added, setAdded] = useState(false);
  const note = `${m.subject ?? ''}\n${m.from?.[0]?.email ?? ''}`.trim();
  const add = (d: CalendarDraft) => setEditing(toEvent(d, note));
  if (!cards.length && !mention) return null;
  return (
    <>
      {cards.map((c, i) => <SmartCard key={i} c={c} onAdd={add} />)}
      {mention && (
        <p className="banner banner--info">
          <Icon name="calendar" size={16} />
          <span className="grow">{t('smarts.mentions', { when: fmt({ at: mention.start, time: !mention.allDay }) })}</span>
          <Button variant="link" onClick={() => add({ title: m.subject?.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, '') ?? '', start: mention.start, allDay: mention.allDay, location: '' })}>
            {t('smarts.addToCalendar')}
          </Button>
        </p>
      )}
      {added && <p className="fine smart-added" role="status">{t('smarts.added')}</p>}
      {/* Portal: the reader pane is its own containing block, so the sheet's overlay wouldn't cover the page. */}
      {editing && createPortal(<EventEditor event={editing} onClose={() => setEditing(null)} onDelete={() => setEditing(null)}
        onSave={async (e) => { await client.saveEvent(e); setEditing(null); setAdded(true); }} />, document.body)}
    </>
  );
}

function SmartCard({ c, onAdd }: { c: Card; onAdd: (d: CalendarDraft) => void }) {
  return (
    <div className="smart-card" role="group" aria-label={t(KIND[c.kind])}>
      <Icon name={ICON[c.kind]} size={18} />
      <div className="sc-body">
        <b className="sc-name">{c.kind === 'parcel' && c.name ? t('smarts.packageFrom', { carrier: c.name }) : c.name || t(KIND[c.kind])}</b>
        {c.facts.length > 0 && (
          <dl className="sc-facts">
            {c.facts.map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd className={k === 'smarts.tracking' || k === 'smarts.confirmation' || k === 'smarts.orderNumber' ? 'code' : ''}>{typeof v === 'string' ? v : fmt(v)}</dd></div>)}
          </dl>
        )}
      </div>
      {(c.link || c.event) && (
        <span className="sc-actions">
          {c.link && <a className="btn btn--link btn--sm" href={c.link.href} target="_blank" rel="noopener noreferrer">
            {t(c.kind === 'parcel' ? 'smarts.trackOn' : 'smarts.openOn', { host: c.link.host })}</a>}
          {c.event && <Button size="sm" icon="calendar" onClick={() => onAdd(c.event!)}>{t('smarts.addToCalendar')}</Button>}
        </span>
      )}
    </div>
  );
}

/** A small check after the sender's name when DMARC passed for their domain. */
export function VerifiedMark({ m, me }: { m: EmailFull; me: string }) {
  const tr = trust(m, me);
  if (!tr.verified) return null;
  const label = t('smarts.verifiedTitle', { domain: tr.domain });
  return <span className="verified" role="img" aria-label={label} title={label}><Icon name="check" size={14} /></span>;
}

/** "Be careful": the name says PayPal (or another big brand), the mail isn't verified. */
export function BrandWarning({ m, me }: { m: EmailFull; me: string }) {
  const { brand } = trust(m, me);
  if (!brand) return null;
  return (
    <p className="banner banner--danger" role="alert">
      <Icon name="shield" size={16} />
      <span className="grow"><b>{t('smarts.careful')}</b> {t('smarts.carefulBody', { brand, email: m.from?.[0]?.email ?? '' })}</span>
    </p>
  );
}

const noLogo = new Set<string>(); // domains without a logo (or no account service): ask once per session
/** The sender's brand logo (BIMI, served checked and cleaned by the account service), over the initial avatar.
 *  Only for verified mail; the account service also requires a DMARC quarantine/reject policy. */
export function BimiLogo({ m, me, inJunk }: { m: EmailFull; me: string; inJunk: boolean }) {
  const { verified, domain } = trust(m, me);
  const [ok, setOk] = useState(false);
  const [, failed] = useState(0);
  // ponytail: same-origin account service; a mail account on another server (rare) gets the initial avatar.
  if (!verified || inJunk || !domain || domain === me.split('@')[1]?.toLowerCase() || noLogo.has(domain)) return null;
  return <img className={`logo${ok ? ' on' : ''}`} src={`/api/bimi/${encodeURIComponent(domain)}`} alt="" referrerPolicy="no-referrer"
    onLoad={() => setOk(true)} onError={() => { noLogo.add(domain); failed((n) => n + 1); }} />;
}
