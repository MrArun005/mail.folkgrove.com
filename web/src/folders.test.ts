import { expect, it } from 'vitest';
import { orderMailboxes, type Mailbox } from './jmap';

const b = (id: string, name: string, parentId: string | null = null, role: string | null = null): Mailbox =>
  ({ id, name, parentId, role, unreadEmails: 0, sortOrder: 0 });

it('orders system folders first, then your folders as a tree with paths', () => {
  const out = orderMailboxes([b('w', 'Work'), b('t', 'Trash', null, 'trash'), b('c', 'Clients', 'w'), b('a', 'Acme', 'c'), b('i', 'Inbox', null, 'inbox'), b('h', 'Home')]);
  expect(out.map((x) => [x.name, x.depth, x.path])).toEqual([
    ['Inbox', 0, 'Inbox'], ['Trash', 0, 'Trash'], ['Home', 0, 'Home'], ['Work', 0, 'Work'], ['Clients', 1, 'Work/Clients'], ['Acme', 2, 'Work/Clients/Acme'],
  ]);
});

it('a folder whose parent is hidden still shows, at the top level', () => {
  expect(orderMailboxes([b('x', 'Child', 'hidden')]).map((x) => x.depth)).toEqual([0]);
});
