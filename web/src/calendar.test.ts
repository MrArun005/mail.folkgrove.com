import { expect, it } from 'vitest';
import { allDayOn, durationMinutes, fromLocal, layoutDay, toDuration, toLocal, weekStart, type CalEvent } from './calendar';

const ev = (title: string, start: string, minutes: number, allDay = false): CalEvent =>
  ({ title, start, timeZone: 'local', duration: toDuration(minutes), allDay, location: '', description: '' });

it('weeks start on Monday', () => {
  expect(toLocal(weekStart(new Date(2026, 10, 12, 15)))).toBe('2026-11-09T00:00:00'); // Thu → Mon
  expect(toLocal(weekStart(new Date(2026, 10, 15, 9)))).toBe('2026-11-09T00:00:00'); // Sun → previous Mon
  expect(toLocal(weekStart(new Date(2026, 10, 9)))).toBe('2026-11-09T00:00:00');
});

it('durations round-trip', () => {
  for (const [m, iso] of [[60, 'PT1H'], [90, 'PT1H30M'], [15, 'PT15M'], [1440, 'P1D'], [2880, 'P2D'], [1500, 'P1DT1H']] as const) {
    expect(toDuration(m)).toBe(iso);
    expect(durationMinutes(iso)).toBe(m);
  }
  expect(durationMinutes('PT0S')).toBe(0);
  expect(durationMinutes('P1W')).toBe(10080);
  expect(toLocal(fromLocal('2026-11-12T10:30:00'))).toBe('2026-11-12T10:30:00');
});

it('places overlapping events side by side and lone events full width', () => {
  const day = new Date(2026, 10, 12);
  const placed = layoutDay([
    ev('A', '2026-11-12T09:00:00', 60),
    ev('B', '2026-11-12T09:30:00', 60),   // overlaps A
    ev('C', '2026-11-12T10:15:00', 30),   // overlaps B only → reuses A's column
    ev('D', '2026-11-12T14:00:00', 45),   // alone
    ev('E', '2026-11-11T23:00:00', 120),  // started yesterday: clipped to midnight
  ], day);
  const by = Object.fromEntries(placed.map((p) => [p.event.title, p]));
  expect(by.A).toMatchObject({ top: 540, height: 60, col: 0, cols: 2 });
  expect(by.B).toMatchObject({ top: 570, col: 1, cols: 2 });
  expect(by.C).toMatchObject({ col: 0, cols: 2 });
  expect(by.D).toMatchObject({ top: 840, col: 0, cols: 1 });
  expect(by.E).toMatchObject({ top: 0, height: 60 });
});

it('very short events stay readable; all-day events are separate', () => {
  const day = new Date(2026, 10, 12);
  expect(layoutDay([ev('quick', '2026-11-12T08:00:00', 5)], day)[0].height).toBe(20);
  const holiday = ev('Holiday', '2026-11-12T00:00:00', 2880, true);
  expect(layoutDay([holiday], day)).toEqual([]);
  expect(allDayOn([holiday], day)).toHaveLength(1);
  expect(allDayOn([holiday], new Date(2026, 10, 13))).toHaveLength(1);
  expect(allDayOn([holiday], new Date(2026, 10, 14))).toHaveLength(0);
});

it('week titles read naturally across months and years', async () => {
  const { weekTitle } = await import('./CalendarView');
  expect(weekTitle(new Date(2026, 10, 2), new Date(2026, 10, 8))).toBe('November 2 – 8, 2026');
  expect(weekTitle(new Date(2026, 9, 26), new Date(2026, 10, 1))).toBe('October 26 – November 1, 2026');
  expect(weekTitle(new Date(2026, 11, 28), new Date(2027, 0, 3))).toBe('December 28, 2026 – January 3, 2027');
});

it('all-day events keep their own dates whatever UTC times the server reports', () => {
  const offsite: CalEvent = { title: 'Offsite', start: '2026-11-07T00:00:00', timeZone: '', duration: 'P1D', allDay: true, location: '', description: '',
    utcStart: '2026-11-06T18:30:00Z', utcEnd: '2026-11-07T18:30:00Z' }; // what a UTC+5:30 conversion looks like
  expect(allDayOn([offsite], new Date(2026, 10, 7))).toHaveLength(1);
  expect(allDayOn([offsite], new Date(2026, 10, 6))).toHaveLength(0);
  expect(allDayOn([offsite], new Date(2026, 10, 8))).toHaveLength(0);
});

it('invitation times convert from their own time zone', async () => {
  const { zonedToDate, span } = await import('./calendar');
  expect(zonedToDate('2026-11-10T09:30:00', 'Etc/UTC').toISOString()).toBe('2026-11-10T09:30:00.000Z');
  expect(zonedToDate('2026-11-10T09:30:00', 'America/New_York').toISOString()).toBe('2026-11-10T14:30:00.000Z'); // EST
  expect(zonedToDate('2026-07-01T09:30:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:30:00.000Z'); // EDT
  expect(zonedToDate('2026-11-10T09:30:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-10T04:00:00.000Z');
  const invite: CalEvent = { title: 'Review', start: '2026-11-10T09:30:00', timeZone: 'Etc/UTC', duration: 'PT1H', allDay: false, location: '', description: '' };
  expect(span(invite).start.toISOString()).toBe('2026-11-10T09:30:00.000Z');
  expect(span(invite).end.toISOString()).toBe('2026-11-10T10:30:00.000Z');
});
