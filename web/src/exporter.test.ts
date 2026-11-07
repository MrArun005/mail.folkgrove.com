import { expect, it } from 'vitest';
import { dropLabels, headerText, placement, splitMbox } from './importer';
import { labelsFor, mboxEntry, mergeCalendars } from './exporter';

const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(b: Uint8Array, size: number) { for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); }
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Awkward on purpose: "From " lines (bare, already quoted, at the very start), CRLF and LF, 8-bit bytes, no final
// line break, a trailing blank line, a bare CR at the end.
const raws = [
  enc('From: a@x.test\r\nSubject: hi\r\n\r\nFrom here on\r\n>From quoted\r\n>>From twice\r\nbye\r\n'),
  enc('From nobody at the start\nSubject: odd\n\nbody without final newline'),
  Uint8Array.from([...enc('Subject: latin1 \xe9\n\n'), 0xe9, 0xff, 0x00, 0x0a, 0x0a]),
  enc('Subject: ends in CR\r\n\r\nx\r'),
  enc('Subject: blank\n\n\n\n'),
];

it('export → import gives back every message byte for byte, with its folders, stars and unread', async () => {
  const labels = [['Inbox', 'Starred'], ['Work/Clients', 'Unread'], ['Archived'], ['Sent'], ['Projects, old', 'Café']];
  const file = concat(raws.map((r, i) => mboxEntry(r, labels[i], new Date(Date.UTC(2026, 10, 3, 10)))));
  for (const size of [1, 7, 4096]) {
    const back: Uint8Array[] = [];
    for await (const m of splitMbox(chunks(file, size))) back.push(m);
    expect(back.map((m) => [...dropLabels(m)])).toEqual(raws.map((r) => [...r]));
    expect(placement(headerText(back[0]))).toEqual({ roles: ['inbox'], folders: [], keywords: { $flagged: true, $seen: true } });
    expect(placement(headerText(back[1]))).toEqual({ roles: [], folders: ['Work/Clients'], keywords: {} });
    expect(placement(headerText(back[2]))).toEqual({ roles: [], folders: [], keywords: { $seen: true } }); // → Archive
    expect(placement(headerText(back[4])).folders).toEqual(['Projects, old', 'Café']);
  }
});

it('labels: folders by path, special folders by Gmail name, archive-only marked', () => {
  const boxes = [{ id: 'i', role: 'inbox', name: 'Inbox' }, { id: 'a', role: 'archive', name: 'Archive' }, { id: 'w', role: null, name: 'Clients', path: 'Work/Clients' }];
  expect(labelsFor({ i: true, w: true }, { $seen: true, $flagged: true }, boxes)).toEqual(['Inbox', 'Work/Clients', 'Starred']);
  expect(labelsFor({ a: true }, {}, boxes)).toEqual(['Unread', 'Archived']);
});

it('merges per-event calendars into one file, each time zone once', () => {
  const ev = (uid: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:x\nBEGIN:VTIMEZONE\nTZID:Asia/Kolkata\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:${uid}\nBEGIN:VALARM\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR\n`;
  const out = mergeCalendars([ev('1'), ev('2')]);
  expect(out.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
  expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(out.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
  expect(out).toContain('UID:2\r\nBEGIN:VALARM\r\nEND:VALARM\r\nEND:VEVENT\r\n');
});
