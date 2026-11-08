// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { EmailFull, Mailbox } from './jmap';
import { handOver, isOwnDraft, takeHandOver } from './ComposeDock';

it('a popped-out window opens only a draft handed over once, never a raw id from the URL', () => {
  const store = window.sessionStorage;
  store.clear();
  expect(takeHandOver('Mabc123', store)).toBeNull(); // a message id in a crafted ?compose= link does nothing
  expect(takeHandOver(crypto.randomUUID(), store)).toBeNull(); // nor does a made-up token
  const token = handOver('Mdraft1', store);
  expect(token).not.toContain('Mdraft1');
  expect(takeHandOver(token, store)).toBe('Mdraft1');
  expect(takeHandOver(token, store)).toBeNull(); // one time only (a reload opens nothing)
});

it('only unsent drafts in Drafts open in compose', () => {
  const boxes = [{ id: 'd', role: 'drafts' }, { id: 'i', role: 'inbox' }] as Mailbox[];
  const mail = (keywords: Record<string, boolean>, mailboxIds: Record<string, boolean>) => ({ keywords, mailboxIds }) as EmailFull;
  expect(isOwnDraft(mail({ $draft: true }, { d: true }), boxes)).toBe(true);
  expect(isOwnDraft(mail({ $seen: true }, { i: true }), boxes)).toBe(false); // received mail
  expect(isOwnDraft(mail({ $draft: true }, { i: true }), boxes)).toBe(false); // a $draft-flagged message delivered to the Inbox
  expect(isOwnDraft(mail({}, { d: true }), boxes)).toBe(false);
});
