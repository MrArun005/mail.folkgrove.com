// Quick time choices shared by Snooze and Schedule send, in the user's local time zone.
import { locale, t } from './i18n';

export interface When { label: string; at: Date }

const at = (base: Date, days: number, hour: number) => {
  const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d;
};

export function quickTimes(now = new Date()): When[] {
  const out: When[] = [];
  if (now.getHours() < 17) {
    const later = new Date(now); later.setHours(now.getHours() + 3, 0, 0, 0);
    out.push({ label: t('when.laterToday'), at: later });
  }
  out.push({ label: t('when.tomorrowMorning'), at: at(now, 1, 8) });
  const day = now.getDay(); // 0 Sun … 6 Sat
  if (day >= 1 && day <= 4) out.push({ label: t('when.thisWeekend'), at: at(now, 6 - day, 9) });
  out.push({ label: t('when.nextWeek'), at: at(now, ((8 - day) % 7) || 7, 8) }); // next Monday
  return out;
}

export const describe = (d: Date) =>
  d.toLocaleString(locale(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Value for <input type="datetime-local"> (local time, minutes precision). */
export const toLocalInput = (d: Date) => new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * When someone usually writes, as minutes after midnight on our clock (rounded to a quarter hour), from the times
 * of their recent mail; null when there's too little to go on. A circular mean, so 23:30 and 00:30 average to
 * midnight, not noon. It needs no time zone: if they write to us at 3pm our time, 3pm our time is when they're
 * at their mail. People who write at all hours (no real pattern) give null rather than a made-up time.
 */
export function usualTime(times: Date[]): number | null {
  if (times.length < 3) return null;
  let x = 0, y = 0;
  for (const d of times) { const a = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 2 * Math.PI; x += Math.cos(a); y += Math.sin(a); }
  if (Math.hypot(x, y) / times.length < 0.5) return null; // spread round the clock
  const minutes = ((Math.atan2(y, x) / (2 * Math.PI)) * 1440 + 1440) % 1440;
  return (Math.round(minutes / 15) * 15) % 1440;
}

/** The next time the clock shows `minutes` after midnight, at least half an hour from now. */
export function nextAt(minutes: number, now = new Date()): Date {
  const d = new Date(now); d.setHours(0, minutes, 0, 0);
  if (+d < +now + 30 * 60_000) d.setDate(d.getDate() + 1);
  return d;
}
