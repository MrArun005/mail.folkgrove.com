// Ways into the app from outside it, and being an installed app:
//  - home-screen shortcut "Compose" (/?compose), email links (/?mailto=…, from the browser's or desktop app's mailto
//    handler) and "Share to OpenMail" (/?share&title&text&url, files kept by the service worker: sw.js);
//  - the install prompt (Settings → App), the app-icon badge, and the native shells (apps/).
import type { Address } from './jmap';
import { parseAddresses } from './mailutil';

export interface Launch { to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string; files: File[] }

/** mailto:ann@x.org,bob@y.org?subject=Hi&cc=…&body=… (RFC 6068). Unknown fields are ignored. */
export function parseMailto(href: string): Omit<Launch, 'files'> {
  const s = href.replace(/^mailto:/i, ''), at = s.indexOf('?');
  const fields: Record<string, string> = {};
  // RFC 6068 percent-encodes everything; a "+" is a plus sign, not a space (URLSearchParams would say space).
  for (const [k, v] of new URLSearchParams(at < 0 ? '' : s.slice(at + 1).replace(/\+/g, '%2B'))) {
    const key = k.toLowerCase();
    fields[key] = fields[key] && key !== 'subject' && key !== 'body' ? `${fields[key]},${v}` : v;
  }
  const dec = (x: string) => { try { return decodeURIComponent(x); } catch { return x; } };
  const list = (x?: string) => parseAddresses(x ?? '').list;
  return {
    to: list([dec(at < 0 ? s : s.slice(0, at)), fields.to].filter(Boolean).join(',')),
    cc: list(fields.cc), bcc: list(fields.bcc), subject: fields.subject ?? '', body: (fields.body ?? '').replace(/\r\n/g, '\n'),
  };
}

const empty = (): Launch => ({ to: [], cc: [], bcc: [], subject: '', body: '', files: [] });

/** What this page was opened to do, once: the address bar is cleaned so a reload doesn't do it again. */
export async function takeLaunch(): Promise<Launch | null> {
  const q = new URLSearchParams(location.search);
  let l: Launch | null = null;
  if (q.has('mailto')) l = { ...parseMailto(q.get('mailto') ?? ''), files: [] };
  else if (q.has('share')) {
    // Apps differ: some share the link as "url", some put it inside "text".
    const text = q.get('text') ?? '', url = q.get('url') ?? '';
    l = { ...empty(), subject: q.get('title') ?? '', body: [text, text.includes(url) ? '' : url].filter(Boolean).join('\n\n'), files: await sharedFiles() };
  } else if (q.has('compose')) l = empty();
  if (l) history.replaceState(history.state, '', location.pathname);
  return l;
}

async function sharedFiles(): Promise<File[]> {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open('om-share');
  const files = await Promise.all((await cache.keys()).map(async (k) => {
    const r = await cache.match(k);
    return r ? new File([await r.blob()], decodeURIComponent(r.headers.get('X-Name') ?? 'file'), { type: r.headers.get('Content-Type') ?? '' }) : null;
  }));
  await caches.delete('om-share');
  return files.filter((f): f is File => !!f);
}

/** Unread count on the app icon (installed app, desktop shell); nothing where it isn't supported. */
export function setBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}

// ── Installing ─────────────────────────────────────────
// Chrome and Edge offer an install prompt once per page load; keep it until the user asks for it in Settings.
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let installPrompt: InstallPrompt | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as InstallPrompt; });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
}

/** Inside our iOS / Android shell (apps/mobile) or desktop app (apps/desktop): they add this to the user agent. */
export const shell = (): 'mobile' | 'desktop' | null =>
  typeof navigator === 'undefined' ? null : /OpenMailDesktop/.test(navigator.userAgent) ? 'desktop' : /OpenMailApp/.test(navigator.userAgent) ? 'mobile' : null;
export const installed = () => !!shell() || matchMedia('(display-mode: standalone)').matches || !!(navigator as { standalone?: boolean }).standalone;
export const canInstall = () => !!installPrompt;
export async function install(): Promise<boolean> {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}

/** The mobile shell's server-address screen (apps/shell/index.html), served by the shell itself. */
export const changeServer = () => { location.href = `${/Android/.test(navigator.userAgent) ? 'https' : 'capacitor'}://localhost/?change`; };

/** Ask the browser to open mailto: links here (browsers allow this for mailto). */
export function handleMailto() {
  navigator.registerProtocolHandler?.('mailto', `${location.origin}/?mailto=%s`);
}
