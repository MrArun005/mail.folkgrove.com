// Inbox smarts that read one message on this device: package / flight / order / booking cards (schema.org data the
// sender put in the HTML), a date worth adding to the calendar, and whether the sender is who they say they are.
// Pure functions; the cards and banners are in SmartCards.tsx.
import type { EmailFull } from './jmap';
import { senderAuthenticated } from './keys';
import { locale, type Key } from './i18n';

// ── Cards from schema.org (JSON-LD and microdata) ──────────────────────

type Thing = Record<string, any>;
export interface When { at: Date; time: boolean }
export type Fact = [label: Key, value: string | When];
export interface CalendarDraft { title: string; start: Date; end?: Date; allDay: boolean; location: string }
export interface Card {
  kind: 'parcel' | 'flight' | 'order' | 'stay' | 'event';
  /** The sender's own name for it (carrier, shop, hotel, event), or a flight's "UA 123 SFO → JFK". */
  name: string;
  facts: Fact[];
  /** Only https links, shown by their real host. */
  link?: { href: string; host: string };
  event?: CalendarDraft;
}

/** Every card the message's HTML describes (most mail: none). DOMParser never runs scripts or loads anything. */
export function findCards(html: string | null): Card[] {
  if (!html || !/schema\.org/i.test(html)) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const things: Thing[] = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { things.push(JSON.parse(s.textContent ?? '')); } catch { /* a sender's broken JSON: no card */ }
  }
  for (const el of doc.querySelectorAll('[itemscope][itemtype]')) if (!el.parentElement?.closest('[itemscope]')) things.push(micro(el));
  const flat = (x: any): Thing[] => Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' ? (x['@graph'] ? flat(x['@graph']) : [x]) : [];
  return flat(things).map(card).filter((c): c is Card => !!c).slice(0, 4);
}

/** Microdata → the same shape as JSON-LD: { '@type', prop: value or nested thing }. First value of a prop wins. */
function micro(root: Element): Thing {
  const o: Thing = { '@type': root.getAttribute('itemtype') ?? '' };
  const walk = (el: Element) => {
    for (const c of el.children) {
      const prop = c.getAttribute('itemprop');
      if (prop) o[prop] ??= c.hasAttribute('itemscope') ? micro(c)
        : c.getAttribute('content') ?? c.getAttribute('href') ?? c.getAttribute('datetime') ?? c.textContent?.trim() ?? '';
      if (!c.hasAttribute('itemscope')) walk(c);
    }
  };
  walk(root);
  return o;
}

const type = (x: Thing) => [x?.['@type']].flat().map((s) => String(s ?? '').replace(/^https?:\/\/schema\.org\//i, ''));
const text = (v: any): string => typeof v === 'string' ? v.trim().slice(0, 200) : typeof v === 'number' ? String(v)
  : Array.isArray(v) ? text(v[0]) : v && typeof v === 'object' ? text(v.name ?? v.iataCode ?? v.streetAddress ?? '') : '';
export function safeLink(v: any): Card['link'] {
  try { const u = new URL(text(v)); return u.protocol === 'https:' ? { href: u.href, host: u.host } : undefined; } catch { return undefined; }
}
function when(v: any): When | undefined {
  const s = text(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return { at: new Date(y, m - 1, d), time: false }; }
  const at = new Date(s);
  return s && !isNaN(+at) ? { at, time: true } : undefined;
}
function money(price: any, currency: any): string {
  const n = Number(text(price).replace(/[^\d.-]/g, '')), c = text(currency);
  if (!text(price) || isNaN(n)) return '';
  try { return c ? new Intl.NumberFormat(locale(), { style: 'currency', currency: c }).format(n) : String(n); } catch { return `${n} ${c}`; }
}
const place = (p: any) => [text(p?.name), text(p?.address?.streetAddress ?? p?.address), text(p?.address?.addressLocality)]
  .filter((s, i, a) => s && a.indexOf(s) === i).join(', ');
const facts = (...f: [Key, string | When | undefined][]) => f.filter((x): x is Fact => !!x[1]);

function card(x: Thing): Card | null {
  const t = type(x);
  const r = x.reservationFor ?? {}, code = text(x.reservationNumber ?? x.reservationId);
  if (t.includes('ParcelDelivery')) {
    const arrives = when(x.expectedArrivalUntil ?? x.expectedArrivalFrom);
    return { kind: 'parcel', name: text(x.carrier ?? x.provider), link: safeLink(x.trackingUrl),
      facts: facts(['smarts.item', text(x.itemShipped)], ['smarts.tracking', text(x.trackingNumber)], ['smarts.arrives', arrives]) };
  }
  if (t.includes('Order')) {
    const total = money(x.totalPaymentDue?.price ?? x.totalPaymentDue?.value ?? x.price, x.totalPaymentDue?.priceCurrency ?? x.priceCurrency);
    return { kind: 'order', name: text(x.merchant ?? x.seller), link: safeLink(x.url),
      facts: facts(['smarts.orderNumber', text(x.orderNumber)], ['smarts.total', total]) };
  }
  if (t.includes('FlightReservation')) {
    const dep = when(r.departureTime), arr = when(r.arrivalTime), from = text(r.departureAirport?.iataCode ?? r.departureAirport), to = text(r.arrivalAirport?.iataCode ?? r.arrivalAirport);
    const name = [`${text(r.airline?.iataCode ?? r.airline)} ${text(r.flightNumber)}`.trim(), from && to ? `${from} → ${to}` : ''].filter(Boolean).join(' · ');
    return { kind: 'flight', name, link: safeLink(x.url ?? x.checkinUrl),
      facts: facts(['smarts.departs', dep], ['smarts.arrives', arr], ['smarts.confirmation', code]),
      event: dep && { title: name.replace(' · ', ' '), start: dep.at, end: arr?.at, allDay: false, location: text(r.departureAirport?.name) || from } };
  }
  if (t.includes('LodgingReservation')) {
    const inn = when(x.checkinTime ?? x.checkinDate), out = when(x.checkoutTime ?? x.checkoutDate), name = text(r.name);
    const day = (w?: When) => w && new Date(w.at.getFullYear(), w.at.getMonth(), w.at.getDate());
    return { kind: 'stay', name, link: safeLink(x.url ?? r.url),
      facts: facts(['smarts.checkIn', inn], ['smarts.checkOut', out], ['smarts.where', place(r)], ['smarts.confirmation', code]),
      event: inn && { title: name, start: day(inn)!, end: day(out), allDay: true, location: place(r) } };
  }
  if (t.includes('EventReservation')) {
    const start = when(r.startDate), end = when(r.endDate), name = text(r.name);
    return { kind: 'event', name, link: safeLink(x.url ?? r.url),
      facts: facts(['smarts.starts', start], ['smarts.where', place(r.location)], ['smarts.confirmation', code]),
      event: start && { title: name, start: start.at, end: end?.at, allDay: !start.time, location: place(r.location) } };
  }
  return null;
}

// ── A date and time in plain text ("Friday 14 Dec at 3pm") ──────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (langs: string[], opt: Intl.DateTimeFormatOptions, n: number, at: (i: number) => Date) => {
  const out = new Map<string, number>();
  for (const l of langs) for (const style of ['long', 'short'] as const) for (let i = 0; i < n; i++) {
    try { out.set(new Intl.DateTimeFormat(l, { [Object.keys(opt)[0]]: style }).format(at(i)).toLowerCase().replace(/\.$/, ''), i); } catch { /* unknown locale */ }
  }
  if (langs.includes('en')) out.set('sept', 8);
  return out;
};

/**
 * The first date (with a time, if one is given) that the text mentions, read in English and with the month and
 * weekday names of `lang` (from Intl). Without a year: the next such date after `ref`, or this year's if it was
 * under two months ago (a past date the caller won't offer).
 * ponytail: English only for the rest ("at", "tomorrow", am/pm, day-month order); other languages' own phrasing
 * (e.g. "14 décembre à 15 h") gets the month right but not the time. A grammar per language is the upgrade.
 */
export function findWhen(text: string, ref: Date, lang = 'en'): { start: Date; allDay: boolean } | null {
  const langs = [...new Set(['en', lang])];
  const months = names(langs, { month: 'long' }, 12, (i) => new Date(2026, i, 15));
  const days = names(langs, { weekday: 'long' }, 7, (i) => new Date(2026, 0, 4 + i)); // 4 Jan 2026 is a Sunday
  const alt = (m: Map<string, number>) => [...m.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
  const M = `(${alt(months)})\\.?`, D = '(\\d{1,2})(?:st|nd|rd|th)?', Y = '(?:,?\\s+(\\d{4}))?';
  const T = '(?:,?\\s+(?:at|@|from)?\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*([ap]\\.?m\\.?)?)?';
  const edge = '(?<![\\p{L}\\d])', end = '(?![\\p{L}\\d])';
  const res = [
    { re: new RegExp(`${edge}${D}\\s+(?:of\\s+)?${M}${Y}${T}${end}`, 'iu'), order: 'dm' },
    { re: new RegExp(`${edge}${M}\\s+${D}${Y}${T}${end}`, 'iu'), order: 'md' },
    { re: new RegExp(`${edge}(today|tonight|tomorrow|${alt(days)})\\s+(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*([ap]\\.?m\\.?)${end}`, 'iu'), order: 'rel' },
  ];
  const found = res.map(({ re, order }) => ({ m: re.exec(text.slice(0, 20_000)), order })).filter((x) => x.m)
    .sort((a, b) => a.m!.index - b.m!.index);
  for (const { m, order } of found) {
    const g = m!;
    const time = (h?: string, mi?: string, ap?: string) => {
      if (!h || (!mi && !ap)) return null; // "14 Dec 2026 3 people" is not a time
      let hour = +h; const pm = /^p/i.test(ap ?? ''), am = /^a/i.test(ap ?? '');
      if (ap && (hour < 1 || hour > 12)) return null;
      if (pm && hour < 12) hour += 12; if (am && hour === 12) hour = 0;
      return hour < 24 && +(mi ?? 0) < 60 ? [hour, +(mi ?? 0)] : null;
    };
    let date: Date, hm: number[] | null;
    if (order === 'rel') {
      const w = g[1].toLowerCase();
      date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      if (w === 'tomorrow') date.setDate(date.getDate() + 1);
      else if (days.has(w)) date.setDate(date.getDate() + ((days.get(w)! - date.getDay() + 7) % 7));
      hm = time(g[2], g[3], g[4]);
      if (!hm) continue;
    } else {
      const [day, mon] = order === 'dm' ? [+g[1], months.get(g[2].toLowerCase().replace(/\.$/, ''))!] : [+g[2], months.get(g[1].toLowerCase().replace(/\.$/, ''))!];
      const year = g[3] ? +g[3] : ref.getFullYear();
      date = new Date(year, mon, day);
      if (date.getMonth() !== mon || day < 1) continue; // 31 Feb
      if (!g[3] && +date < +ref - 60 * 86400e3) date.setFullYear(year + 1);
      hm = time(g[4], g[5], g[6]);
    }
    if (hm) date.setHours(hm[0], hm[1]);
    return { start: date, allDay: !hm };
  }
  return null;
}

// ── Who sent it ───────────────────────────────────────────────────────

// ponytail: names phishers borrow most. A display name with one of them on mail that fails DMARC gets a warning;
// lookalike domains that pass DMARC (paypal-support.example) are not caught by this.
const BRANDS = ['PayPal', 'Apple', 'iCloud', 'Amazon', 'Google', 'Gmail', 'Microsoft', 'Outlook', 'Office 365', 'Netflix', 'Facebook',
  'Meta', 'Instagram', 'WhatsApp', 'LinkedIn', 'DHL', 'FedEx', 'UPS', 'USPS', 'Royal Mail', 'DocuSign', 'Dropbox', 'Coinbase',
  'Binance', 'eBay', 'Spotify', 'Bank of America', 'Chase', 'Wells Fargo', 'Citibank', 'HSBC', 'Barclays', 'Visa', 'Mastercard',
  'American Express', 'IRS', 'HMRC', 'Steam', 'Adobe', 'OpenMail'];

export interface Trust {
  domain: string;
  /** DMARC passed for the From domain (on our server's own Authentication-Results), or mail between accounts here. */
  verified: boolean;
  /** A well-known brand the display name claims, on mail that isn't verified. */
  brand: string | null;
}
export function trust(m: Pick<EmailFull, 'from' | 'authResults' | 'received'>, me: string): Trust {
  const from = m.from?.[0];
  if (!from?.email) return { domain: '', verified: false, brand: null };
  const domain = from.email.slice(from.email.lastIndexOf('@') + 1).toLowerCase();
  const verified = senderAuthenticated(from.email, m.authResults?.[0], me.split('@')[1] ?? '', { received: m.received ?? null, dmarcOnly: true });
  const brand = verified ? null : BRANDS.find((b) => new RegExp(`(?<![\\p{L}\\d])${esc(b)}(?![\\p{L}\\d])`, 'iu').test(from.name ?? '')) ?? null;
  return { domain, verified, brand };
}
