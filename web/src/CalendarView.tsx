import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import {
  addDays, allDayOn, durationMinutes, fromLocal, layoutDay, localZone, sameDay, span, timeLabel, toDuration, toLocal, weekStart, type CalEvent,
} from './calendar';
import type { Jmap } from './jmap';
import { locale, t } from './i18n';

const HOUR = 48; // px per hour in the grid
const DAYS = 7;

/** Week view. Click an empty slot to add an event there; click an event to edit it. */
export function CalendarView({ client, say }: { client: Jmap; say: (text: string) => void }) {
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  // Month view shows 6 whole weeks starting the Monday on or before the 1st.
  const month = new Date(addDays(anchor, 6).getFullYear(), addDays(anchor, 6).getMonth(), 1);
  const range = mode === 'week' ? { from: anchor, days: DAYS } : { from: weekStart(month), days: 42 };
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [now, setNow] = useState(new Date());
  const scroller = useRef<HTMLDivElement>(null);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(anchor, i)), [anchor]);

  const load = () => client.events(range.from, addDays(range.from, range.days)).then(setEvents, (e) => { setEvents([]); say(t('calendar.couldntLoad', { error: e.message })); });
  useEffect(() => { setEvents(null); load(); }, [anchor, mode]);
  useEffect(() => { scroller.current?.scrollTo({ top: 7.5 * HOUR }); }, []); // open on the working day
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);

  const title = mode === 'week' ? weekTitle(anchor, addDays(anchor, DAYS - 1)) : month.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  const step = (dir: 1 | -1) => setAnchor(mode === 'week' ? addDays(anchor, 7 * dir) : weekStart(new Date(month.getFullYear(), month.getMonth() + dir, 1)));

  const blank = (start: Date, allDay = false): CalEvent => ({
    title: '', start: toLocal(start), timeZone: localZone(), duration: allDay ? 'P1D' : 'PT1H', allDay, location: '', description: '',
  });

  async function save(e: CalEvent) {
    await client.saveEvent(e);
    setEditing(null); say(e.id ? t('calendar.updated') : t('calendar.added')); load();
  }
  async function remove(e: CalEvent) {
    if (!e.id || !(await confirmIt({ title: t('calendar.deleteTitle', { title: e.title || t('calendar.untitledEvent') }), confirm: t('calendar.delete'), danger: true }))) return;
    await client.deleteEvent(e.id);
    setEditing(null); say(t('calendar.deleted')); load();
  }

  return (
    <section className="calendar" aria-label={t('folder.calendar')}>
      <header className="cal-head">
        <h2 className="cal-title">{title}</h2>
        <div className="cal-nav">
          <div className="segmented" role="radiogroup" aria-label={t('calendar.view')}>
            {(['week', 'month'] as const).map((m) => (
              <label key={m} className={mode === m ? 'on' : ''}>
                <input type="radio" name="cal-view" checked={mode === m} onChange={() => setMode(m)} />{m === 'week' ? t('calendar.week') : t('calendar.month')}
              </label>
            ))}
          </div>
          <Button size="md" onClick={() => setAnchor(weekStart(new Date()))}>{t('calendar.today')}</Button>
          <Button variant="quiet" icon="back" label={mode === 'week' ? t('calendar.previousWeek') : t('calendar.previousMonth')} onClick={() => step(-1)} />
          <Button variant="quiet" icon="next" label={mode === 'week' ? t('calendar.nextWeek') : t('calendar.nextMonth')} onClick={() => step(1)} />
          <Button variant="primary" icon="compose" onClick={() => setEditing(blank(roundUp(new Date())))}>{t('calendar.new')}</Button>
        </div>
      </header>

      {mode === 'month' ? (
        <MonthGrid start={range.from} month={month.getMonth()} events={events ?? []} now={now}
          onDay={(d) => { setAnchor(weekStart(d)); setMode('week'); }} onEvent={setEditing} />
      ) : <div className="cal-scroll" ref={scroller} aria-busy={events === null}>
        {/* Inside the scroller (sticky), so day headers and columns always share the same width. */}
        <div className="cal-grid-head">
        <span />
        {days.map((d) => (
          <div key={+d} className={`cal-day-head${sameDay(d, now) ? ' today' : ''}`}>
            <span className="dow">{d.toLocaleDateString(locale(), { weekday: 'short' })}</span>
            <span className="dom">{d.getDate()}</span>
          </div>
        ))}
        <span className="cal-allday-label">{t('calendar.allDay')}</span>
        {days.map((d) => (
          <div key={+d} className="cal-allday" onDoubleClick={() => setEditing(blank(d, true))}>
            {allDayOn(events ?? [], d).map((e) => (
              <button key={e.id + String(+d)} className="cal-chip" onClick={() => setEditing(e)}>{e.title || t('calendar.untitled')}</button>
            ))}
          </div>
        ))}
      </div>

        <div className="cal-body" style={{ height: 24 * HOUR }}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? new Date(2026, 0, 1, h).toLocaleTimeString(locale(), { hour: 'numeric' }) : ''}</span>)}
          </div>
          {days.map((d) => (
            <div key={+d} className="cal-col" onClick={(ev) => {
              if (ev.target !== ev.currentTarget) return;
              const minutes = Math.floor((ev.nativeEvent.offsetY / HOUR) * 2) * 30; // snap to the half hour
              setEditing(blank(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes)));
            }}>
              {sameDay(d, now) && <span className="cal-now" style={{ top: (now.getHours() * 60 + now.getMinutes()) * HOUR / 60 }} />}
              {layoutDay(events ?? [], d).map((p) => {
                const { start, end } = span(p.event);
                return (
                  <button key={p.event.id} className={`cal-event${p.height < 45 ? ' short' : ''}`} onClick={() => setEditing(p.event)}
                    style={{ top: p.top * HOUR / 60, height: p.height * HOUR / 60 - 2, insetInlineStart: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)` }}>
                    <span className="t">{p.event.title || t('calendar.untitled')}</span>
                    <span className="w">{timeLabel(start)} – {timeLabel(end)}{p.event.location ? `, ${p.event.location}` : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>}

      {editing && <EventEditor event={editing} onSave={save} onDelete={remove} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** "November 2 – 8, 2026", "October 27 – November 2, 2026", "December 28, 2026 – January 3, 2027". */
export function weekTitle(a: Date, b: Date): string {
  // Intl puts thin spaces around the dash; plain spaces read the same and keep titles stable across browsers.
  return new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric', year: 'numeric' }).formatRange(a, b).replace(/\u2009/g, ' ');
}

/** Six weeks of days; each shows up to three events, then "+N more" (which opens that week). */
function MonthGrid({ start, month, events, now, onDay, onEvent }: {
  start: Date; month: number; events: CalEvent[]; now: Date; onDay: (d: Date) => void; onEvent: (e: CalEvent) => void;
}) {
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const on = (d: Date) => [...allDayOn(events, d), ...layoutDay(events, d).map((p) => p.event)]
    .filter((e, i, a) => a.indexOf(e) === i)
    .sort((a, b) => +span(a).start - +span(b).start);
  return (
    <div className="cal-month">
      {days.slice(0, 7).map((d) => <span key={+d} className="mdow">{d.toLocaleDateString(locale(), { weekday: 'short' })}</span>)}
      {days.map((d) => {
        const list = on(d);
        return (
          <div key={+d} className={`mday${d.getMonth() !== month ? ' other' : ''}${sameDay(d, now) ? ' today' : ''}`}>
            <button className="mnum" onClick={() => onDay(d)} aria-label={t('calendar.openWeek', { date: d.toLocaleDateString(locale()) })}>{d.getDate()}</button>
            {list.slice(0, 3).map((e) => (
              <button key={(e.id ?? e.title) + String(+d)} className={`mchip${e.allDay ? ' all' : ''}`} onClick={() => onEvent(e)}>
                {!e.allDay && <span className="mt">{timeLabel(span(e).start)}</span>}{e.title || t('calendar.untitled')}
              </button>
            ))}
            {list.length > 3 && <button className="mmore" onClick={() => onDay(d)}>{t('calendar.more', { count: list.length - 3 })}</button>}
          </div>
        );
      })}
    </div>
  );
}

const roundUp = (d: Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() < 30 ? 30 : 60, 0, 0); return x; };
const dateValue = (d: Date) => toLocal(d).slice(0, 10);
const timeValue = (d: Date) => toLocal(d).slice(11, 16);

export function EventEditor({ event, onSave, onDelete, onClose }: {
  event: CalEvent; onSave: (e: CalEvent) => Promise<void>; onDelete: (e: CalEvent) => void; onClose: () => void;
}) {
  const { start, end } = span(event);
  const [title, setTitle] = useState(event.title);
  const [allDay, setAllDay] = useState(event.allDay);
  const [date, setDate] = useState(dateValue(start));
  const [from, setFrom] = useState(timeValue(start));
  const [to, setTo] = useState(timeValue(end));
  const [endDate, setEndDate] = useState(dateValue(event.allDay ? addDays(end, -1) : end));
  const [location, setLocation] = useState(event.location);
  const [notes, setNotes] = useState(event.description);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const s = fromLocal(`${date}T${allDay ? '00:00' : from}:00`);
    const en = allDay ? addDays(fromLocal(`${endDate}T00:00:00`), 1) : fromLocal(`${date}T${to}:00`);
    const minutes = Math.round((+en - +s) / 60000);
    if (minutes <= 0) return setError(allDay ? t('calendar.lastBeforeFirst') : t('calendar.endAfterStart'));
    setBusy(true); setError('');
    try {
      await onSave({ ...event, title: title.trim(), allDay, start: toLocal(s), timeZone: event.timeZone || localZone(),
        duration: toDuration(minutes), location, description: notes });
    } catch (err) { setError(t('common.couldntSave', { error: (err as Error).message })); setBusy(false); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="sheet event-form" role="dialog" aria-label={event.id ? t('calendar.edit') : t('calendar.new')} onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2>{event.id ? t('calendar.edit') : t('calendar.new')}</h2>
        <label>{t('calendar.title')}<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('calendar.titlePlaceholder')} autoFocus /></label>
        <label className="inline"><input type="checkbox" className="check" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />{t('calendar.allDay')}</label>
        {allDay ? (
          <div className="row2">
            <label>{t('calendar.firstDay')}<input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value); }} /></label>
            <label>{t('calendar.lastDay')}<input className="input" type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} /></label>
          </div>
        ) : (
          <div className="row3">
            <label>{t('calendar.date')}<input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label>{t('calendar.starts')}<input className="input" type="time" value={from} step={300} onChange={(e) => {
              const shift = durationMinutes(toDuration(Math.max(15, (+fromLocal(`${date}T${to}:00`) - +fromLocal(`${date}T${from}:00`)) / 60000)));
              setFrom(e.target.value); setTo(timeValue(new Date(+fromLocal(`${date}T${e.target.value}:00`) + shift * 60000)));
            }} /></label>
            <label>{t('calendar.ends')}<input className="input" type="time" value={to} step={300} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <label>{t('calendar.location')}<input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('calendar.locationPlaceholder')} /></label>
        <label>{t('calendar.notes')}<textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <footer>
          {event.id && <Button variant="quiet" icon="trash" className="push-left" onClick={() => onDelete(event)}>{t('common.delete')}</Button>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? t('common.saving') : t('calendar.save')}</Button>
        </footer>
      </form>
    </div>
  );
}
