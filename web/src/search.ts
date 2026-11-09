import type { Filter, Mailbox } from './jmap';

/**
 * Gmail-style search box → JMAP Email/query filter (RFC 8621 §4.4.1).
 *   from:priya  to:"Carol Diaz"  subject:offsite  has:attachment  is:unread|read|starred
 *   in:archive (or label:)  before:2026-11-01  after:2026-10-01  older_than:7d  newer_than:2w
 *   larger:5M  smaller:200k  list:announce.example.org  and  a OR b  between any two terms;
 *   plus free text for everything else.
 * Unknown operators are searched as plain text, so nothing the user types is silently dropped.
 */
export function parseSearch(q: string, boxes: Mailbox[] = []): Filter {
  // "a OR b" (capitals, like Gmail): each side is its own search; a message matching either is found.
  const sides = q.split(/\s+OR\s+/).map((part) => parseAll(part, boxes)).filter((f) => Object.keys(f).length);
  if (!sides.length) return {};
  return sides.length === 1 ? sides[0] : { operator: 'OR', conditions: sides };
}

function parseAll(q: string, boxes: Mailbox[]): Filter {
  const conds: Filter[] = [];
  const text: string[] = [];
  const re = /(-)?(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
  for (const m of q.matchAll(re)) {
    const [, neg, op, raw, quoted, phrase, word] = m;
    if (!op) { text.push(phrase ?? word); continue; }
    const v = quoted ?? raw;
    const c = condition(op.toLowerCase(), v, boxes);
    if (!c) { text.push(m[0]); continue; }
    conds.push(neg ? { operator: 'NOT', conditions: [c] } : c);
  }
  if (text.length) conds.push({ text: text.join(' ') });
  if (!conds.length) return {};
  return conds.length === 1 ? conds[0] : { operator: 'AND', conditions: conds };
}

function condition(op: string, v: string, boxes: Mailbox[]): Filter | null {
  switch (op) {
    case 'from': case 'to': case 'cc': case 'subject': case 'body': return { [op]: v };
    case 'has': return /^attach/i.test(v) ? { hasAttachment: true } : null;
    case 'is': {
      const k = v.toLowerCase();
      if (k === 'unread') return { notKeyword: '$seen' };
      if (k === 'read') return { hasKeyword: '$seen' };
      if (k === 'starred') return { hasKeyword: '$flagged' };
      if (k === 'purchase' || k === 'purchases') return { hasKeyword: '$purchase' }; // set on delivery (rules.ts PURCHASE)
      return null;
    }
    case 'in': case 'label': {
      const k = v.toLowerCase();
      const box = boxes.find((b) => b.role === k || b.name.toLowerCase() === k || (k === 'spam' && b.role === 'junk') || (k === 'bin' && b.role === 'trash'));
      return box ? { inMailbox: box.id } : null;
    }
    case 'before': case 'after': {
      const d = parseDate(v);
      return d ? { [op]: d } : null;
    }
    // Relative dates: 7d, 2w, 3m, 1y ago. "older than" is before that moment, "newer than" after it.
    case 'older_than': case 'newer_than': {
      const d = ago(v);
      return d ? { [op === 'older_than' ? 'before' : 'after']: d } : null;
    }
    case 'larger': case 'smaller': {
      const n = bytes(v);
      return n === null ? null : { [op === 'larger' ? 'minSize' : 'maxSize']: n };
    }
    case 'list': return v ? { header: ['List-Id', v] } : null; // a mailing list, by any part of its id
    default: return null;
  }
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

/** 7d / 2w / 3m / 1y before now. */
function ago(v: string, now = new Date()): string | null {
  const m = v.match(/^(\d{1,4})([dwmy])$/i);
  if (!m) return null;
  const n = +m[1], d = new Date(now);
  const unit = m[2].toLowerCase();
  if (unit === 'd') d.setUTCDate(d.getUTCDate() - n);
  else if (unit === 'w') d.setUTCDate(d.getUTCDate() - 7 * n);
  else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return isNaN(+d) ? null : iso(d);
}

/** 500, 200k, 5M, 1G (also "5mb") → bytes. */
function bytes(v: string): number | null {
  const m = v.match(/^(\d+(?:\.\d+)?)([kmg])?b?$/i);
  if (!m) return null;
  return Math.round(+m[1] * 1024 ** ' kmg'.indexOf((m[2] ?? ' ').toLowerCase()));
}

/** 2026-11-01, 2026/11/01 → UTC midnight in JMAP's UTCDate format. */
function parseDate(v: string): string | null {
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(+d) ? null : d.toISOString().replace(/\.\d+Z$/, 'Z');
}
