// Installable-app service worker. Caches only the app shell (HTML, JS, CSS, fonts) so the app opens instantly
// and offline. Mail traffic (/jmap, /api, /.well-known) is never cached: it is private and must be fresh.
// Also receives Web Push from the mail server (JMAP PushSubscription): "new mail" while no OpenMail tab is open.
// In development it is registered with ?push-only, so it never caches anything (the dev server must stay live).
const PUSH_ONLY = new URL(self.location.href).searchParams.has('push-only');
const SHELL = 'openmail-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/icon.svg', '/icons/icon-192.png']))); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // "Share to OpenMail" (manifest share_target): keep the shared files for the page, then open Compose with them.
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname === '/share') {
    // Only the system share sheet ("none") or our own pages: another website must not post files into a draft.
    const site = e.request.headers.get('Sec-Fetch-Site');
    if (site === 'cross-site' || site === 'same-site') { e.respondWith(Response.redirect('/', 303)); return; }
    e.respondWith(share(e.request)); return;
  }
  if (PUSH_ONLY) return;
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(jmap|api|\.well-known)/.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    // Network first for the page, so updates arrive; cached shell when offline.
    e.respondWith(fetch(e.request).then((r) => { caches.open(SHELL).then((c) => c.put('/', r.clone())); return r; }).catch(() => caches.match('/')));
    return;
  }
  // Hashed assets never change: cache first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && url.pathname.startsWith('/assets/')) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return r;
  })));
});

async function share(request) {
  const form = await request.formData();
  const cache = await caches.open('om-share');
  await Promise.all((await cache.keys()).map((k) => cache.delete(k))); // only the newest share
  await Promise.all(form.getAll('files').filter((f) => typeof f !== 'string').map((f, i) =>
    cache.put(`/share/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name) } }))));
  const q = new URLSearchParams({ share: '' });
  for (const k of ['title', 'text', 'url']) if (form.get(k)) q.set(k, form.get(k));
  return Response.redirect(`/?${q}`, 303);
}

// ── Push ──────────────────────────────────────────────
// The server's pushes carry no message content (only "something was delivered"), so the notification can't leak
// anything on a lock screen. With an OpenMail tab open, that tab shows its own, richer notification instead.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* not JSON: treat as a plain wake-up */ }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    if (data['@type'] === 'PushVerification') {
      // Finishing registration needs the app's sign-in, so hand the code to it.
      tabs.forEach((t) => t.postMessage({ type: 'om-push-verify', id: data.pushSubscriptionId, code: data.verificationCode }));
      return;
    }
    // A tab you're looking at handles it. Otherwise always show one (browsers require it for every push); a hidden
    // open tab then replaces this generic one with sender and subject (same tag), so there's never two.
    if (tabs.some((t) => t.visibilityState === 'visible')) return;
    self.navigator.setAppBadge?.().catch(() => {}); // a dot on the app icon: the count comes when the app opens
    return self.registration.showNotification('New mail', {
      body: 'Open OpenMail to read it.', tag: 'om-new-mail', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
    });
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const threadId = e.notification.data && e.notification.data.threadId;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    if (!tabs[0]) return self.clients.openWindow('/');
    if (threadId) tabs[0].postMessage({ type: 'om-open-thread', threadId });
    return tabs[0].focus();
  }));
});
