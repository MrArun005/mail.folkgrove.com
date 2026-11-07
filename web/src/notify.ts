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
export async function showMail(e: EmailSummary, open: () => void) {
  const title = displayName(e.from?.[0]), body = `${e.subject || '(no subject)'}\n${e.preview}`.slice(0, 200);
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg) {
    // Through the service worker, with the same tag as its generic "New mail": this replaces it instead of adding one.
    return reg.showNotification(title, { body, tag: 'om-new-mail', icon: '/icon.svg', data: { threadId: e.threadId } });
  }
  const n = new Notification(title, { body, tag: e.threadId, icon: '/icon.svg' });
  n.onclick = () => { window.focus(); open(); n.close(); };
}

// ── Web Push: notifications with every tab closed ─────
const DEVICE_KEY = 'om:device';
/** A random id for this browser, so re-subscribing replaces its old push subscription instead of piling up. */
const deviceId = () => {
  try { let d = localStorage.getItem(DEVICE_KEY); if (!d) { d = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, d); } return d; } catch { return 'this-browser'; }
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

/**
 * Subscribe this browser for "new mail" pushes from the mail server. Returns false when the server or browser can't
 * do it (notifications then work only while a tab is open). The server checks the subscription by pushing a code to
 * the browser; the service worker hands it back here to finish.
 */
export async function enablePush(client: { vapidKey: string | null; createPushSubscription: (d: string, u: string, k: { p256dh: string; auth: string }) => Promise<string>; verifyPushSubscription: (id: string, code: string) => Promise<void> }): Promise<boolean> {
  if (!pushSupported() || !client.vapidKey) return false;
  // Dev: push-only worker (no caching); production registers the full worker in main.tsx.
  const reg = await navigator.serviceWorker.register(import.meta.env.DEV ? '/sw.js?push-only' : '/sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(client.vapidKey) });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const verified = new Promise<void>((resolve) => {
    const onMsg = (m: MessageEvent) => {
      if (m.data?.type !== 'om-push-verify') return;
      navigator.serviceWorker.removeEventListener('message', onMsg);
      client.verifyPushSubscription(m.data.id, m.data.code).then(resolve, resolve);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    setTimeout(() => { navigator.serviceWorker.removeEventListener('message', onMsg); resolve(); }, 30_000);
  });
  await client.createPushSubscription(deviceId(), j.endpoint, j.keys);
  await verified;
  return true;
}

export async function disablePush(client: { deletePushSubscriptions: (d: string) => Promise<void> }) {
  await client.deletePushSubscriptions(deviceId()).catch(() => {});
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
}
