import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import {
  addDays, allDayOn, durationMinutes, fromLocal, layoutDay, localZone, sameDay, span, timeLabel, toDuration, toLocal, weekStart, type CalEvent,
} from './calendar';
import type { Jmap } from './jmap';

const HOUR = 48; // px per hour in the grid
const DAYS = 7;

/** Week view. Click an empty slot to add an event there; click an event to edit it. */
export function CalendarView({ client, say }: { client: Jmap; say: (text: string) => void }) {
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [now, setNow] = useState(new Date());
  const scroller = useRef<HTMLDivElement>(null);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(anchor, i)), [anchor]);

  const load = () => client.events(anchor, addDays(anchor, DAYS)).then(setEvents, (e) => { setEvents([]); say(`Couldn’t load the calendar: ${e.message}`); });
  useEffect(() => { setEvents(null); load(); }, [anchor]);
  useEffect(() => { scroller.current?.scrollTo({ top: 7.5 * HOUR }); }, []); // open on the working day
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  const title = weekTitle(anchor, addDays(anchor, DAYS - 1));

  const blank = (start: Date, allDay = false): CalEvent => ({
    title: '', start: toLocal(start), timeZone: localZone(), duration: allDay ? 'P1D' : 'PT1H', allDay, location: '', description: '',
  });

  async function save(e: CalEvent) {
    await client.saveEvent(e);
    setEditing(null); say(e.id ? 'Event updated' : 'Event added'); load();
  }
  async function remove(e: CalEvent) {
    if (!e.id || !confirm(`Delete “${e.title || 'Untitled event'}”?`)) return;
    await client.deleteEvent(e.id);
    setEditing(null); say('Event deleted'); load();
  }

  return (
    <section className="calendar" aria-label="Calendar">
      <header className="cal-head">
        <h2 className="cal-title">{title}</h2>
        <div className="cal-nav">
          <Button size="md" onClick={() => setAnchor(weekStart(new Date()))}>Today</Button>
          <Button variant="quiet" icon="back" label="Previous week" onClick={() => setAnchor(addDays(anchor, -7))} />
          <Button variant="quiet" icon="next" label="Next week" onClick={() => setAnchor(addDays(anchor, 7))} />
          <Button variant="primary" icon="compose" onClick={() => setEditing(blank(roundUp(new Date())))}>New event</Button>
        </div>
      </header>

      <div className="cal-scroll" ref={scroller} aria-busy={events === null}>
        {/* Inside the scroller (sticky), so day headers and columns always share the same width. */}
        <div className="cal-grid-head">
        <span />
        {days.map((d) => (
          <div key={+d} className={`cal-day-head${sameDay(d, now) ? ' today' : ''}`}>
            <span className="dow">{d.toLocaleDateString([], { weekday: 'short' })}</span>
            <span className="dom">{d.getDate()}</span>
          </div>
        ))}
        <span className="cal-allday-label">All day</span>
        {days.map((d) => (
          <div key={+d} className="cal-allday" onDoubleClick={() => setEditing(blank(d, true))}>
            {allDayOn(events ?? [], d).map((e) => (
              <button key={e.id + String(+d)} className="cal-chip" onClick={() => setEditing(e)}>{e.title || 'Untitled'}</button>
            ))}
          </div>
        ))}
      </div>

        <div className="cal-body" style={{ height: 24 * HOUR }}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }) : ''}</span>)}
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
                    style={{ top: p.top * HOUR / 60, height: p.height * HOUR / 60 - 2, left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)` }}>
                    <span className="t">{p.event.title || 'Untitled'}</span>
                    <span className="w">{timeLabel(start)} – {timeLabel(end)}{p.event.location ? `, ${p.event.location}` : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {editing && <EventEditor event={editing} onSave={save} onDelete={remove} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** "November 2 – 8, 2026", "October 27 – November 2, 2026", "December 28, 2026 – January 3, 2027". */
export function weekTitle(a: Date, b: Date): string {
  const m = (d: Date) => d.toLocaleDateString([], { month: 'long' });
  if (a.getFullYear() !== b.getFullYear()) return `${m(a)} ${a.getDate()}, ${a.getFullYear()} – ${m(b)} ${b.getDate()}, ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${m(a)} ${a.getDate()} – ${m(b)} ${b.getDate()}, ${b.getFullYear()}`;
  return `${m(a)} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
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
    if (minutes <= 0) return setError(allDay ? 'The last day can’t be before the first day.' : 'The event has to end after it starts.');
    setBusy(true); setError('');
    try {
      await onSave({ ...event, title: title.trim(), allDay, start: toLocal(s), timeZone: event.timeZone || localZone(),
        duration: toDuration(minutes), location, description: notes });
    } catch (err) { setError(`Couldn’t save: ${(err as Error).message}`); setBusy(false); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="sheet event-form" role="dialog" aria-label={event.id ? 'Edit event' : 'New event'} onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2>{event.id ? 'Edit event' : 'New event'}</h2>
        <label>Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a title" autoFocus /></label>
        <label className="inline"><input type="checkbox" className="check" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />All day</label>
        {allDay ? (
          <div className="row2">
            <label>First day<input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value); }} /></label>
            <label>Last day<input className="input" type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} /></label>
          </div>
        ) : (
          <div className="row3">
            <label>Date<input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label>Starts<input className="input" type="time" value={from} step={300} onChange={(e) => {
              const shift = durationMinutes(toDuration(Math.max(15, (+fromLocal(`${date}T${to}:00`) - +fromLocal(`${date}T${from}:00`)) / 60000)));
              setFrom(e.target.value); setTo(timeValue(new Date(+fromLocal(`${date}T${e.target.value}:00`) + shift * 60000)));
            }} /></label>
            <label>Ends<input className="input" type="time" value={to} step={300} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <label>Location<input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, address or link" /></label>
        <label>Notes<textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <footer>
          {event.id && <Button variant="quiet" icon="trash" className="push-left" onClick={() => onDelete(event)}>Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</Button>
        </footer>
      </form>
    </div>
  );
}
