import { expect, it } from 'vitest';
import { buildReply, parseInvite } from './ics';

const invite = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VTIMEZONE', 'TZID:X', 'END:VTIMEZONE', 'BEGIN:VEVENT',
  'UID:abc-123@example.org', 'SEQUENCE:2', 'DTSTAMP:20261107T090000Z',
  'DTSTART;TZID=Europe/London:20261110T093000', 'DTEND;TZID=Europe/London:20261110T103000',
  'SUMMARY:Quarterly design review\\, part 2', 'LOCATION:Room 4',
  'ORGANIZER;CN=Priya Raman:mailto:priya@example.org',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Alice:mailto:alice@openmail.test',
  'DESCRIPTION:A very long description that goes past the seventy-five character limit and so is fol',
  ' ded onto a second line',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

it('reads what a reply needs from an invitation', () => {
  expect(parseInvite(invite)).toEqual({
    method: 'REQUEST', uid: 'abc-123@example.org', sequence: '2', summary: 'Quarterly design review, part 2',
    organizer: 'CN=Priya Raman:mailto:priya@example.org', organizerEmail: 'priya@example.org',
    timing: ['DTSTART;TZID=Europe/London:20261110T093000', 'DTEND;TZID=Europe/London:20261110T103000'],
  });
  expect(parseInvite('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeNull();
});

it('builds an iTIP REPLY the organizer’s calendar will accept', () => {
  const r = buildReply(parseInvite(invite)!, { email: 'alice@openmail.test', name: 'Alice' }, 'ACCEPTED', new Date('2026-11-07T12:00:00Z'));
  expect(r).toContain('METHOD:REPLY');
  expect(r).toContain('UID:abc-123@example.org');
  expect(r).toContain('SEQUENCE:2');
  expect(r).toContain('DTSTAMP:20261107T120000Z');
  expect(r).toContain('ORGANIZER;CN=Priya Raman:mailto:priya@example.org');
  expect(r).toContain('DTSTART;TZID=Europe/London:20261110T093000');
  expect(r).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN="Alice":mailto:alice@openmail.test');
  expect(r).toContain('SUMMARY:Quarterly design review\\, part 2');
  expect(r.split('\r\n').every((l) => l.length <= 75)).toBe(true);
  expect(r.endsWith('END:VCALENDAR\r\n')).toBe(true);
});

it('organizer without parameters keeps the colon form', () => {
  const plain = invite.replace('ORGANIZER;CN=Priya Raman:mailto:priya@example.org', 'ORGANIZER:mailto:priya@example.org');
  const inv = parseInvite(plain)!;
  expect(inv.organizer).toBe('mailto:priya@example.org');
  expect(buildReply(inv, { email: 'a@b.c' }, 'DECLINED')).toContain('ORGANIZER:mailto:priya@example.org');
});
