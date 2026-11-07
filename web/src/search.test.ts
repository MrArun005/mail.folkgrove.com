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
