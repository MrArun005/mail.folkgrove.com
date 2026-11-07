import type { Filter, Mailbox } from './jmap';

/**
 * Gmail-style search box → JMAP Email/query filter (RFC 8621 §4.4.1).
 *   from:priya  to:"Carol Diaz"  subject:offsite  has:attachment  is:unread|read|starred
 *   in:archive  before:2026-11-01  after:2026-10-01  plus free text for everything else.
 * Unknown operators are searched as plain text, so nothing the user types is silently dropped.
 */
export function parseSearch(q: string, boxes: Mailbox[] = []): Filter {
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
      return null;
    }
    case 'in': {
      const k = v.toLowerCase();
      const box = boxes.find((b) => b.role === k || b.name.toLowerCase() === k || (k === 'spam' && b.role === 'junk') || (k === 'bin' && b.role === 'trash'));
      return box ? { inMailbox: box.id } : null;
    }
    case 'before': case 'after': {
      const d = parseDate(v);
      return d ? { [op]: d } : null;
    }
    default: return null;
  }
}

/** 2026-11-01, 2026/11/01 → UTC midnight in JMAP's UTCDate format. */
function parseDate(v: string): string | null {
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(+d) ? null : d.toISOString().replace(/\.\d+Z$/, 'Z');
}
