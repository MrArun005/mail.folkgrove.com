// Export your data: the mirror of importer.ts. Messages go out as raw bytes (never decoded), in an mbox our own
// importer (and Thunderbird, Apple Mail, Gmail-reading tools) reads back. Folders, stars and unread travel in a
// Gmail-style X-Gmail-Labels header, the one header importer.ts already turns back into folders and flags.

const enc = new TextEncoder();
const NL = 0x0a, CR = 0x0d;

/** The mbox "From " line date (asctime, UTC): "Mon Nov  3 10:00:00 2026". */
function asctime(d: Date): string {
  const [wd, mon, day, time, year] = [d.toUTCString().slice(0, 3), d.toUTCString().slice(8, 11), d.getUTCDate(), d.toISOString().slice(11, 19), d.getUTCFullYear()];
  return `${wd} ${mon} ${String(day).padStart(2, ' ')} ${time} ${year}`;
}

/** Labels as Gmail writes them: comma-separated, a label with a comma or quote is quoted. */
export function labelsHeader(labels: string[]): string {
  return labels.map((l) => (/[,"]/.test(l) ? `"${l.replace(/"/g, "'")}"` : l)).join(','); // ponytail: a " inside a folder name becomes '
}

/**
 * One message as an mbox entry (mboxrd): separator line, our labels header, the raw message with every line that
 * starts with ">*From " given one more ">", then one line break. splitMbox undoes each step, so the bytes that
 * come back (after dropLabels) are exactly the bytes that went in.
 */
export function mboxEntry(raw: Uint8Array, labels: string[], received = new Date(0)): Uint8Array {
  const crlf = raw.indexOf(NL) > 0 && raw[raw.indexOf(NL) - 1] === CR;
  const head = enc.encode(`From MAILER-DAEMON ${asctime(received)}\n${labels.length ? `X-Gmail-Labels: ${labelsHeader(labels)}${crlf ? '\r\n' : '\n'}` : ''}`);
  // Count the ">" to add first, so the output is allocated once.
  const escapeAt: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i !== 0 && raw[i - 1] !== NL) continue;
    let j = i; while (raw[j] === 0x3e) j++;
    if (raw[j] === 0x46 && raw[j + 1] === 0x72 && raw[j + 2] === 0x6f && raw[j + 3] === 0x6d && raw[j + 4] === 0x20) escapeAt.push(i); // "From "
  }
  // splitMbox drops one final "\r\n" or "\n": add "\r\n" when the message itself ends in a bare "\r".
  const tail = raw[raw.length - 1] === CR ? [CR, NL] : [NL];
  const out = new Uint8Array(head.length + raw.length + escapeAt.length + tail.length);
  out.set(head);
  let o = head.length, from = 0;
  for (const at of escapeAt) { out.set(raw.subarray(from, at), o); o += at - from; out[o++] = 0x3e; from = at; }
  out.set(raw.subarray(from), o); o += raw.length - from;
  out.set(tail, o);
  return out;
}

/** Labels for one message: its folders as paths, plus Gmail's words for the special folders, stars and unread. */
export function labelsFor(mailboxIds: Record<string, true>, keywords: Record<string, true>, boxes: { id: string; role: string | null; path?: string; name: string }[]): string[] {
  const special: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', junk: 'Spam', trash: 'Trash', drafts: 'Drafts' };
  const out: string[] = [];
  for (const b of boxes) {
    if (!mailboxIds[b.id]) continue;
    if (b.role && special[b.role]) out.push(special[b.role]);
    else if (b.role !== 'archive') out.push(b.path ?? b.name); // ponytail: other roles (Snoozed) come back as plain folders
  }
  if (keywords.$flagged) out.push('Starred');
  if (!keywords.$seen) out.push('Unread');
  // Only in Archive: Gmail's way of saying "no Inbox" is a header with no folder; importer.ts files it in Archive.
  if (!out.some((l) => !['Starred', 'Unread'].includes(l))) out.push('Archived');
  return out;
}

/** Many iCalendar objects (one per event, as CalDAV stores them) as one calendar file, time zones once each. */
export function mergeCalendars(objects: string[]): string {
  const zones = new Map<string, string>(), items: string[] = [];
  for (const o of objects) {
    const inner = o.replace(/\r?\n/g, '\r\n').replace(/^[\s\S]*?BEGIN:VCALENDAR\r\n/, '').replace(/END:VCALENDAR[\s\S]*$/, '');
    for (const c of inner.match(/BEGIN:(\w+)\r\n[\s\S]*?END:\1\r\n/g) ?? []) {
      if (c.startsWith('BEGIN:VTIMEZONE')) zones.set(/^TZID:(.*)$/m.exec(c)?.[1] ?? c, c);
      else items.push(c);
    }
  }
  return ['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OpenMail//Export//EN\r\n', ...zones.values(), ...items, 'END:VCALENDAR\r\n'].join('');
}
