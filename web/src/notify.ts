// Desktop notifications for new mail: off until the user turns them on (per device), Primary inbox only,
// and only while the app isn't the window you're looking at.
import type { EmailSummary } from './jmap';
import { displayName } from './mailutil';

const KEY = 'openmail.notify';
export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export function notifyOn(): boolean {
  try { return notifySupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1'; } catch { return false; }
}
/** Returns whether notifications are now on (the browser may refuse permission). */
export async function setNotify(on: boolean): Promise<boolean> {
  if (on && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return false;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode: lasts this session only */ }
  return on;
}
export function showMail(e: EmailSummary, open: () => void) {
  const n = new Notification(displayName(e.from?.[0]), {
    body: `${e.subject || '(no subject)'}\n${e.preview}`.slice(0, 200), tag: e.threadId, icon: '/icon.svg',
  });
  n.onclick = () => { window.focus(); open(); n.close(); };
}
