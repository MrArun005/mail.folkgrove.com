// Brand logos (BIMI) for the web client's sender avatars: GET /api/bimi/<domain> → the domain's logo as a cleaned SVG.
// The browser never talks to the brand's servers (no tracking, no mixed content); this service looks up the
// `default._bimi.<domain>` TXT record, checks the domain's DMARC policy is quarantine or reject (BIMI's rule; the
// client separately checks that DMARC passed for the message), fetches the https SVG (32 KB at most, public
// addresses only), keeps only SVG Tiny PS shapes (no scripts, no external references) and caches the answer for a day.
// ponytail: the organizational domain is "the last two labels" (no public-suffix list), so example.co.uk falls
// back to co.uk, which has no records: those domains simply get no logo. VMC certificates (Gmail's blue check) are
// not checked: the logo is the domain's own claim, shown only on mail that passed DMARC.
import { resolveTxt, lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

const MAX_SVG = 32 * 1024;
const DAY = 86400e3;

/** Private, loopback, link-local and other non-public addresses: never fetched (the TXT record is the sender's). */
export function privateAddress(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || /^64:ff9b:/.test(x) || /^2001:db8:/.test(x);
}

/** The SVG, through an allow-list: shapes, gradients, title/desc and same-document references only. Null if it isn't one. */
export function sanitizeSvg(text) {
  const ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'defs',
    'lineargradient', 'radialgradient', 'stop', 'use', 'text', 'tspan', 'solidcolor']);
  const TEXT = new Set(['title', 'desc', 'text', 'tspan']);
  const NS = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };
  const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (all, d, h, n) => n
    ? { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n.toLowerCase()] : String.fromCodePoint(Math.min(Number(d ? d : `0x${h}`), 0x10ffff)));
  const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attrsOf = (raw) => {
    const out = [];
    for (const [, name, dq, sq, bare] of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const n = name.toLowerCase(), v = decode(dq ?? sq ?? bare ?? '');
      if (n.startsWith('on') || !/^[a-z][a-z0-9:-]*$/i.test(name)) continue; // event handlers, odd names
      if (n === 'href' || n === 'xlink:href') { if (/^#[\w-]+$/.test(v)) out.push([name, v]); continue; } // same document only
      if (n.includes(':') && !(n in NS && v === NS[n]) && n !== 'xml:space') continue; // other namespaces
      if (n === 'xmlns' && v !== NS.xmlns) continue;
      if (/url\s*\(\s*['"]?\s*(?!#)/i.test(v) || (n === 'style' && /@|\\|expression|javascript|url\s*\(/i.test(v))) continue; // external refs
      out.push([name, v]);
    }
    return out;
  };
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>"'<]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)|</g;
  let out = '', root = false, skip = 0;
  const open = [];
  for (const [, close, name, rawAttrs, selfClose, chars] of text.matchAll(re)) {
    if (skip) { // inside a removed element (script, style, foreignObject, image...): drop everything to its end
      if (name && !selfClose) skip++;
      else if (close) skip--;
      continue;
    }
    if (name) {
      const n = name.toLowerCase();
      if (!ELEMENTS.has(n) || (!root && n !== 'svg')) { if (!selfClose) skip = 1; continue; }
      const attrs = attrsOf(rawAttrs ?? '');
      if (n === 'svg' && !root && !attrs.some(([a]) => a === 'xmlns')) attrs.unshift(['xmlns', NS.xmlns]);
      root = true;
      out += `<${name}${attrs.map(([a, v]) => ` ${a}="${enc(v)}"`).join('')}${selfClose ? '/>' : '>'}`;
      if (!selfClose) open.push(name);
    } else if (close) {
      const i = open.map((x) => x.toLowerCase()).lastIndexOf(close.toLowerCase());
      if (i >= 0) while (open.length > i) out += `</${open.pop()}>`;
    } else if (chars && open.length && TEXT.has(open[open.length - 1].toLowerCase())) out += enc(decode(chars));
  }
  while (open.length) out += `</${open.pop()}>`;
  return root ? out : null;
}

const tag = (record, name) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*)`, 'i').exec(record)?.[1]?.trim();

async function defaultFetch(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('not an https host name');
  return new Promise((ok, fail) => {
    // The address check runs in the connection's own lookup, so a second DNS answer can't swap in a private address.
    const req = request(u, { method: 'GET', timeout: 5000, headers: { Accept: 'image/svg+xml' }, lookup: (host, opts, cb) => {
      lookup(host, { all: true }).then((list) => {
        const bad = list.find((a) => privateAddress(a.address));
        if (bad || !list.length) return cb(new Error('private address'));
        opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
      }, cb);
    } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)); } // no redirects either
      let size = 0; const parts = [];
      res.on('data', (c) => { size += c.length; if (size > MAX_SVG) { req.destroy(); fail(new Error('too big')); } else parts.push(c); });
      res.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); // 5 s of silence
    // And 8 s in all, however slowly the bytes keep coming.
    const deadline = setTimeout(() => req.destroy(new Error('took too long')), 8000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', fail);
    req.end();
  });
}

export function bimiRoutes({ RateLimiter, ipOf, txt = resolveTxt, fetchSvg = defaultFetch, now = Date.now, enabled = true }) {
  // ponytail: no VMC check (the trademark certificate Gmail and Apple require), so any domain with a strict DMARC policy
  // could show any brand's logo, and a fresh lookup tells the sender's DNS that someone opened the mail. Off unless
  // BIMI_LOGOS=on (server.mjs); the verified mark and the brand warning don't need it.
  const lookups = new RateLimiter(30, 60e3); // fresh lookups (not cached answers) per network a minute
  const cache = new Map(); // domain → { svg: string | null, until }
  const record = async (name) => (await txt(name).catch(() => [])).map((chunks) => chunks.join(''));
  async function logo(domain) {
    const org = domain.split('.').slice(-2).join('.');
    const find = async (prefix, v) => {
      for (const d of domain === org ? [domain] : [domain, org]) {
        const r = (await record(`${prefix}.${d}`)).find((x) => new RegExp(`^\\s*v\\s*=\\s*${v}\\s*(;|$)`, 'i').test(x));
        if (r) return { r, sub: d !== domain };
      }
      return null;
    };
    const dmarc = await find('_dmarc', 'DMARC1');
    const policy = dmarc && ((dmarc.sub && tag(dmarc.r, 'sp')) || tag(dmarc.r, 'p'))?.toLowerCase();
    const pct = dmarc ? Number(tag(dmarc.r, 'pct') ?? 100) : 0;
    if (!['quarantine', 'reject'].includes(policy) || pct !== 100) return null;
    const bimi = await find('default._bimi', 'BIMI1');
    const l = bimi && tag(bimi.r, 'l');
    if (!l || !/^https:\/\//i.test(l)) return null; // empty l= means "no logo, on purpose"
    return sanitizeSvg(await fetchSvg(l));
  }
  const reply = (res, status, body = '', type = 'text/plain; charset=utf-8', maxAge = 3600) => {
    res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      // Opened on its own (not as an <img>), the logo still can't run or load anything.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': status === 200 || status === 404 ? `public, max-age=${maxAge}` : 'no-store' });
    res.end(body);
  };
  return async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/bimi\/([^/]{1,253})$/);
    if (!m) return false;
    if (!enabled) return reply(res, 404, '', undefined, 86400), true;
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405), true;
    const domain = decodeURIComponent(m[1]).toLowerCase().replace(/\.$/, '');
    if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain)) return reply(res, 400), true;
    let hit = cache.get(domain);
    if (!hit || hit.until < now()) {
      const wait = lookups.take(ipOf(req));
      if (wait) { res.setHeader?.('Retry-After', String(wait)); return reply(res, 429), true; }
      const svg = await logo(domain).catch(() => null);
      hit = { svg, until: now() + (svg ? DAY : DAY / 24) };
      cache.delete(domain); cache.set(domain, hit);
      if (cache.size > 5000) cache.delete(cache.keys().next().value); // oldest first
    }
    return (hit.svg ? reply(res, 200, hit.svg, 'image/svg+xml; charset=utf-8', 86400) : reply(res, 404)), true;
  };
}
