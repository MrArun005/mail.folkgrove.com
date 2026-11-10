// Email HTML is hostile. Defence in depth, using browser features instead of a sanitizer library:
//  1. It renders in <iframe sandbox> without allow-scripts (no JS). allow-same-origin only so the reader can size it and check links; with no scripts the message can't use that access.
//  2. A CSP <meta> blocks scripts, network requests and (by default) remote images, which defeats tracking pixels.
//  3. DOMParser strips the few things CSP and sandbox don't cover: meta refresh (iframe navigation) and <base>, and
//     the result is parsed once more as the frame will, in case serialising brought any of them back.
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
  // Mail in Arabic or Hebrew reads right to left, whatever the app's language, unless the sender said otherwise.
  if (!doc.documentElement.dir && !doc.body.dir) doc.body.dir = 'auto';
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
  // Every link: <a>, <area>, SVG <a xlink:href> (any element carrying an href, in any namespace).
  doc.querySelectorAll('*').forEach((el) => {
    const links = [...el.attributes].filter((at) => at.localName === 'href');
    if (!links.length) return;
    for (const at of links) {
      const href = at.value.trim();
      // Only web, mail and phone links: javascript:, data:, file: and the like never reach a click.
      if (/^(https?:|mailto:|tel:)/i.test(href)) at.value = cleanLink(href); else el.removeAttributeNode(at);
    }
    // Our <base target="_blank"> opens links in a new tab; a target of the sender's (or rel="opener") would give that
    // tab a window.opener pointing back at the message frame.
    el.removeAttribute('target');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  const blockedImages = allowRemoteImages
    ? 0
    : doc.querySelectorAll('img[src^="http" i], img[src^="//"], [background^="http" i]').length;

  const img = allowRemoteImages ? 'data: https:' : 'data:';
  const ours = (d: Document) => {
    const csp = d.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:`;
    const noPrefetch = d.createElement('meta');
    noPrefetch.httpEquiv = 'x-dns-prefetch-control';
    noPrefetch.content = 'off';
    const base = d.createElement('base');
    base.target = '_blank'; // links open in a new tab, never inside the frame
    const style = d.createElement('style');
    style.textContent = 'body{margin:16px;font:15px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}';
    d.head.prepend(csp, noPrefetch, base, style);
    return '<!doctype html>' + d.documentElement.outerHTML;
  };
  const srcdoc = ours(doc);

  // The frame parses this string again, and HTML doesn't always survive a round trip: nested <form>, <math> and
  // <style> can serialise into markup that re-parses as a live <link> or <meta refresh> (mutation XSS). Parse it as
  // the frame will; if anything beyond our own two <meta> and one <base> is there, show the words only.
  const again = new DOMParser().parseFromString(srcdoc, 'text/html');
  if (!again.querySelector('script, link') && again.querySelectorAll('meta').length === 2 && again.querySelectorAll('base').length === 1)
    return { srcdoc, blockedImages, trackers: [...trackers] };
  doc.body.querySelectorAll('style, title, template').forEach((el) => el.remove());
  const plain = document.implementation.createHTMLDocument('');
  plain.body.dir = 'auto';
  const pre = plain.body.appendChild(plain.createElement('pre'));
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = doc.body.textContent ?? ''; // serialised escaped: text only, nothing to re-parse
  return { srcdoc: ours(plain), blockedImages: 0, trackers: [...trackers] };
}
