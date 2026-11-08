// Just enough iCalendar (RFC 5545) to answer an invitation (iTIP REPLY, RFC 5546) the way Gmail, Outlook and
// Zoho expect: same UID and SEQUENCE, the organizer, and one ATTENDEE line carrying our answer.

import { t } from './i18n';

export type PartStat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

export interface Invite {
  method: string;
  uid: string;
  sequence: string;
  summary: string;
  organizer: string; // full property line value incl. params, e.g. "CN=Priya:mailto:priya@example.org"
  organizerEmail: string;
  /** The original DTSTART/DTEND/RECURRENCE-ID lines, copied verbatim into the reply. */
  timing: string[];
}

/** Undo RFC 5545 line folding (continuation lines start with a space or tab). */
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

export function parseInvite(text: string): Invite | null {
  const lines = unfold(text);
  const method = lines.find((l) => /^METHOD:/i.test(l))?.slice(7).trim().toUpperCase() ?? '';
  const start = lines.findIndex((l) => /^BEGIN:VEVENT$/i.test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^END:VEVENT$/i.test(l.trim()));
  const ev = lines.slice(start + 1, end < 0 ? undefined : end);
  const prop = (name: string) => ev.find((l) => new RegExp(`^${name}[;:]`, 'i').test(l));
  const value = (line?: string) => line?.slice(line.indexOf(':') + 1).trim() ?? '';
  const uid = value(prop('UID'));
  const orgLine = prop('ORGANIZER');
  if (!uid || !orgLine) return null;
  return {
    method, uid, sequence: value(prop('SEQUENCE')) || '0', summary: value(prop('SUMMARY')).replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' '),
    organizer: orgLine.slice(orgLine.search(/[;:]/) + 1),
    organizerEmail: value(orgLine).replace(/^mailto:/i, ''),
    timing: ev.filter((l) => /^(DTSTART|DTEND|DURATION|RECURRENCE-ID)[;:]/i.test(l)),
  };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold long lines at 75 octets as RFC 5545 requires (simplified to characters; our lines are ASCII-ish). */
const fold = (line: string) => line.length <= 75 ? line : line.match(/.{1,74}/g)!.join('\r\n ');

export function buildReply(inv: Invite, me: { email: string; name?: string | null }, status: PartStat, now = new Date()): string {
  const cn = me.name ? `;CN="${me.name.replace(/"/g, '')}"` : '';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenMail//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
    `UID:${inv.uid}`, `SEQUENCE:${inv.sequence}`, `DTSTAMP:${stamp(now)}`,
    // "ORGANIZER:mailto:…" when there are no parameters, "ORGANIZER;CN=…:mailto:…" when there are.
    `ORGANIZER${/^mailto:/i.test(inv.organizer) ? ':' : ';'}${inv.organizer}`,
    ...inv.timing,
    `ATTENDEE;PARTSTAT=${status}${cn}:mailto:${me.email}`,
    `SUMMARY:${inv.summary.replace(/([,;\\])/g, '\\$1')}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].map(fold).join('\r\n');
}

/** The answer's word for the reply's subject ("Accepted: Team lunch"). */
export const replyWord = (s: PartStat) => t(({ ACCEPTED: 'ics.accepted', TENTATIVE: 'ics.tentative', DECLINED: 'ics.declined' } as const)[s]);
