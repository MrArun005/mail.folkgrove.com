// Installable-app service worker. Caches only the app shell (HTML, JS, CSS, fonts) so the app opens instantly
// and offline. Mail traffic (/jmap, /api, /.well-known) is never cached: it is private and must be fresh.
const SHELL = 'openmail-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/icon.svg']))); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
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
