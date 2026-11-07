// Email HTML is hostile. Defence in depth, using browser features instead of a sanitizer library:
//  1. It renders in <iframe sandbox> without allow-scripts (no JS). allow-same-origin only so the reader can size it and check links; with no scripts the message can't use that access.
//  2. A CSP <meta> blocks scripts, network requests and (by default) remote images, which defeats tracking pixels.
//  3. DOMParser strips the few things CSP and sandbox don't cover: meta refresh (iframe navigation) and <base>.
// Inline (cid:) images arrive as data: URLs, so the CSP never has to allow a network fetch.
//
// Privacy beyond the defaults: tracking pixels are removed outright, even after "Load images",
// and tracking parameters (utm_*, fbclid, …) are stripped from links.

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_eid|mc_cid|_hsenc|_hsmi|mkt_tok|oly_\w+|vero_\w+|__s|ck_subscriber_id)$/i;

export function cleanLink(href: string): string {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return href;
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return href; }
}

/** A remote image that can't be meant to be seen: 1–3px, or hidden. */
function isTracker(img: Element): boolean {
  const tiny = (a: string | null) => a !== null && /^\s*[0-3](px)?\s*$/.test(a);
  const style = (img.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase();
  return tiny(img.getAttribute('width')) || tiny(img.getAttribute('height'))
    || /display:none|visibility:hidden|(^|;)(width|height):[0-3]px/.test(style);
}

export interface Rendered { srcdoc: string; blockedImages: number; trackers: string[] }

/** `inline` maps Content-ID → data: URL for images embedded in the message (cid: references). */
export function buildSrcdoc(html: string, allowRemoteImages: boolean, inline: Record<string, string> = {}): Rendered {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // <link> (prefetch/preconnect) and <meta> can reach the network outside CSP's reach; <a ping> beacons on click.
  doc.querySelectorAll('script, base, meta, link').forEach((el) => el.remove());
  doc.querySelectorAll('[ping]').forEach((el) => el.removeAttribute('ping'));
  doc.querySelectorAll('img[src^="cid:" i]').forEach((img) => {
    const data = inline[img.getAttribute('src')!.slice(4).replace(/^<|>$/g, '')];
    if (data) img.setAttribute('src', data); else img.removeAttribute('src');
  });

  const trackers = new Set<string>();
  doc.querySelectorAll('img[src^="http" i], img[src^="//"]').forEach((img) => {
    if (!isTracker(img)) return;
    try { trackers.add(new URL(img.getAttribute('src')!, 'https://x').hostname); } catch { /* malformed src: still removed */ }
    img.remove();
  });
  doc.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', cleanLink(a.getAttribute('href')!)));

  const blockedImages = allowRemoteImages
    ? 0
    : doc.querySelectorAll('img[src^="http" i], img[src^="//"], [background^="http" i]').length;

  const img = allowRemoteImages ? 'data: https:' : 'data:';
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:`;
  const noPrefetch = doc.createElement('meta');
  noPrefetch.httpEquiv = 'x-dns-prefetch-control';
  noPrefetch.content = 'off';
  const base = doc.createElement('base');
  base.target = '_blank'; // links open in a new tab, never inside the frame
  const style = doc.createElement('style');
  style.textContent = 'body{margin:16px;font:15px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}';
  doc.head.prepend(csp, noPrefetch, base, style);

  return { srcdoc: '<!doctype html>' + doc.documentElement.outerHTML, blockedImages, trackers: [...trackers] };
}
