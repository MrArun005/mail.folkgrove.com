// Calendar date math and layout. Pure functions, no DOM, all in the browser's local time zone.

export interface CalEvent {
  id?: string;
  title: string;
  /** Local wall-clock start, "YYYY-MM-DDTHH:MM:SS", in `timeZone`. */
  start: string;
  timeZone: string;
  /** ISO 8601 duration, e.g. "PT1H30M" or "P1D". */
  duration: string;
  allDay: boolean;
  location: string;
  description: string;
  /** Server-computed UTC times (read-only). */
  utcStart?: string;
  utcEnd?: string;
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Monday 00:00 of the week containing d. */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

const pad = (n: number) => String(n).padStart(2, '0');
/** Date → local "YYYY-MM-DDTHH:MM:SS" (what JMAP calls a LocalDateTime). */
export const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
export const fromLocal = (s: string) => {
  const [date, time = '00:00:00'] = s.split('T');
  const [y, m, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
};

/** Minutes ↔ ISO 8601 duration (days + hours + minutes; that's all a calendar needs). */
export function toDuration(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `P${minutes / 1440}D`;
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  return `P${d ? `${d}D` : ''}T${h ? `${h}H` : ''}${m || (!d && !h) ? `${m}M` : ''}`.replace(/T$/, '');
}
export function durationMinutes(iso: string): number {
  const m = iso.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 60;
  const [, w, d, h, mi] = m.map((x) => Number(x ?? 0));
  return w * 10080 + d * 1440 + h * 60 + mi;
}

/**
 * A wall-clock time in a named time zone → the real instant. (Invitations arrive as "09:30 in Etc/UTC" or
 * "09:30 in America/New_York"; only events already on the server come with UTC times precomputed.)
 * Two passes so times next to a daylight-saving change land right. Unknown zones fall back to local time.
 */
export function zonedToDate(local: string, tz: string): Date {
  const [d, t = '00:00:00'] = local.split('T');
  const [y, m, day] = d.split('-').map(Number), [h, mi, se = 0] = t.split(':').map(Number);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const offset = (ms: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
    };
    const wall = Date.UTC(y, m - 1, day, h, mi, se);
    return new Date(wall - offset(wall - offset(wall)));
  } catch { return fromLocal(local); }
}

/** Start and end as local Dates (uses the server's UTC times when present, so other time zones display right). */
export function span(e: CalEvent): { start: Date; end: Date } {
  // All-day events are "floating": the same calendar dates everywhere, so the server's UTC times don't apply.
  if (e.allDay) { const start = fromLocal(e.start); return { start, end: new Date(+start + durationMinutes(e.duration) * 60000) }; }
  const start = e.utcStart ? new Date(e.utcStart) : e.timeZone ? zonedToDate(e.start, e.timeZone) : fromLocal(e.start);
  const end = e.utcEnd ? new Date(e.utcEnd) : new Date(+start + durationMinutes(e.duration) * 60000);
  return { start, end };
}

export interface Placed { event: CalEvent; top: number; height: number; col: number; cols: number }

/**
 * Lay out one day's timed events: minutes from midnight → top/height, and overlapping events side by side.
 * Events that overlap form a cluster; each gets the first free column, and the whole cluster shares the width.
 */
export function layoutDay(events: CalEvent[], day: Date): Placed[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = addDays(dayStart, 1);
  const items = events.filter((e) => !e.allDay).map((event) => {
    const { start, end } = span(event);
    const s = Math.max(+start, +dayStart), en = Math.min(+end, +dayEnd);
    return { event, s, en };
  }).filter((x) => x.en > x.s).sort((a, b) => a.s - b.s || b.en - a.en);

  const out: Placed[] = [];
  let cluster: { placed: Placed; en: number }[] = [], clusterEnd = -Infinity;
  const flush = () => { const cols = Math.max(...cluster.map((c) => c.placed.col)) + 1; cluster.forEach((c) => { c.placed.cols = cols; }); cluster = []; };
  for (const x of items) {
    if (x.s >= clusterEnd && cluster.length) flush();
    const taken = new Set(cluster.filter((c) => c.en > x.s).map((c) => c.placed.col));
    let col = 0; while (taken.has(col)) col++;
    const placed: Placed = {
      event: x.event, col, cols: 1,
      top: (x.s - +dayStart) / 60000,
      height: Math.max((x.en - x.s) / 60000, 20), // never shorter than a readable sliver
    };
    out.push(placed); cluster.push({ placed, en: x.en }); clusterEnd = Math.max(clusterEnd, x.en);
  }
  if (cluster.length) flush();
  return out;
}

/** All-day events touching this day. */
export function allDayOn(events: CalEvent[], day: Date): CalEvent[] {
  const d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate()), d1 = addDays(d0, 1);
  return events.filter((e) => e.allDay).filter((e) => { const { start, end } = span(e); return +start < +d1 && +end > +d0; });
}

export const timeLabel = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
