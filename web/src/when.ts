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
