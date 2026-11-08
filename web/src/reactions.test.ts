// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { EmailFull } from './jmap';
import { groupReactions, isReaction, reactionBody, reactionDraft, reactionOf } from './reactions';

const mail = (over: Partial<EmailFull>): EmailFull => ({
  id: '1', threadId: 't', subject: 'Lunch', preview: '', receivedAt: '2026-11-07T12:00:00Z', keywords: {}, hasAttachment: false,
  from: [{ name: 'Carol', email: 'carol@x.org' }], to: [{ name: null, email: 'me@o.test' }, { name: null, email: 'dan@x.org' }],
  cc: null, bcc: null, replyTo: null, messageId: ['m1@x'], inReplyTo: null, references: ['m0@x'],
  blobId: 'b0', mailboxIds: {}, attachments: [], unsubscribe: null, receiptTo: null, html: null, text: 'hi', ...over,
});

it('a reaction is one emoji, nothing else (RFC 9078)', () => {
  for (const ok of ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🇫🇷', '1️⃣']) expect(isReaction(ok), ok).toBe(true);
  for (const bad of ['', 'ok', '👍 thanks', '1', '#', '<b>👍</b>']) expect(isReaction(bad), bad).toBe(false);
});

it('the reaction message: Reply all, threaded, a single text/plain part marked reaction', () => {
  const d = reactionDraft(mail({}), '👍', 'me@o.test');
  expect(d).toMatchObject({ to: [{ name: 'Carol', email: 'carol@x.org' }], cc: [{ name: null, email: 'dan@x.org' }], subject: 'Re: Lunch',
    inReplyTo: ['m1@x'], references: ['m0@x', 'm1@x'], text: '👍', html: '', attachments: [], reaction: '👍' });
  // What Email/set gets: Content-Disposition: reaction on a text/plain body holding only the emoji (the RFC's fallback
  // for mail apps without reactions is to show that text).
  expect(reactionBody('👍')).toEqual({ bodyValues: { t: { value: '👍' } }, bodyStructure: { partId: 't', type: 'text/plain', disposition: 'reaction' } });
});

it('reads reactions from fetched mail and groups them under their message', () => {
  const part = (disposition: string | null, value: string, inReplyTo: string[] | null = ['m1@x']) =>
    reactionOf({ textBody: [{ partId: '1', disposition }], bodyValues: { 1: { value } }, inReplyTo });
  expect(part('reaction', '😂\r\n')).toBe('😂');
  expect(part('inline', '😂')).toBeNull();
  expect(part('reaction', 'lol')).toBeNull(); // not an emoji: show it as an ordinary message
  expect(part('reaction', '😂', null)).toBeNull(); // nothing to attach it to
  const r = (id: string, email: string, reaction: string) => mail({ id, from: [{ name: null, email }], inReplyTo: ['m1@x'], reaction });
  const g = groupReactions([mail({}), r('2', 'dan@x.org', '👍'), r('3', 'eve@x.org', '👍'), r('4', 'dan@x.org', '👍'), r('5', 'dan@x.org', '😂')]);
  expect([...g.get('m1@x')!].map(([e, who]) => [e, who.map((a) => a.email)])).toEqual([['👍', ['dan@x.org', 'eve@x.org']], ['😂', ['dan@x.org']]]);
});
