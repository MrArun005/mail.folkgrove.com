import { expect, it } from 'vitest';
import type { Mailbox } from './jmap';
import { parseSearch } from './search';

const boxes: Mailbox[] = [
  { id: 'a', name: 'Inbox', role: 'inbox', unreadEmails: 0, sortOrder: 0 },
  { id: 'j', name: 'Junk Mail', role: 'junk', unreadEmails: 0, sortOrder: 0 },
  { id: 'p', name: 'Projects', role: null, unreadEmails: 0, sortOrder: 0 },
];

it('plain words are a text search', () => {
  expect(parseSearch('lake house')).toEqual({ text: 'lake house' });
  expect(parseSearch('   ')).toEqual({});
});

it('combines operators with AND, keeping leftover text', () => {
  expect(parseSearch('from:priya has:attachment is:unread agenda', boxes)).toEqual({
    operator: 'AND',
    conditions: [{ from: 'priya' }, { hasAttachment: true }, { notKeyword: '$seen' }, { text: 'agenda' }],
  });
});

it('supports quotes, folders by name or role, dates and negation', () => {
  expect(parseSearch('to:"Carol Diaz" in:spam in:projects after:2026-10-01 -subject:newsletter', boxes)).toEqual({
    operator: 'AND',
    conditions: [
      { to: 'Carol Diaz' }, { inMailbox: 'j' }, { inMailbox: 'p' }, { after: '2026-10-01T00:00:00Z' },
      { operator: 'NOT', conditions: [{ subject: 'newsletter' }] },
    ],
  });
});

it('never drops what it does not understand', () => {
  expect(parseSearch('in:nowhere before:yesterday re:lunch', boxes)).toEqual({ text: 'in:nowhere before:yesterday re:lunch' });
});

it('understands sizes, relative dates, label: and mailing lists', () => {
  expect(parseSearch('larger:5M')).toEqual({ minSize: 5 * 1024 * 1024 });
  expect(parseSearch('smaller:200k')).toEqual({ maxSize: 204800 });
  expect(parseSearch('larger:1.5mb')).toEqual({ minSize: 1572864 });
  expect(parseSearch('label:projects', boxes)).toEqual({ inMailbox: 'p' });
  expect(parseSearch('list:announce.example.org')).toEqual({ header: ['List-Id', 'announce.example.org'] });
  const week = parseSearch('older_than:7d') as { before: string };
  expect(Math.round((Date.now() - +new Date(week.before)) / 86400e3)).toBe(7);
  expect(Object.keys(parseSearch('newer_than:2w'))).toEqual(['after']);
  // Not a size or an age: searched as typed, never dropped.
  expect(parseSearch('larger:huge older_than:soon')).toEqual({ text: 'larger:huge older_than:soon' });
});

it('OR finds either side; each side keeps its own operators', () => {
  expect(parseSearch('from:priya OR from:carol')).toEqual({ operator: 'OR', conditions: [{ from: 'priya' }, { from: 'carol' }] });
  expect(parseSearch('from:priya is:unread OR invoice')).toEqual({ operator: 'OR', conditions: [
    { operator: 'AND', conditions: [{ from: 'priya' }, { notKeyword: '$seen' }] }, { text: 'invoice' }] });
  expect(parseSearch('black or white')).toEqual({ text: 'black or white' }); // lower case is a word
});
