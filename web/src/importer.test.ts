import { expect, it } from 'vitest';
import { headerText, placement, splitMbox } from './importer';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
async function* chunks(s: string, size: number) { const b = enc(s); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); }
const all = async (it: AsyncIterable<Uint8Array>) => { const out: string[] = []; for await (const m of it) out.push(dec(m)); return out; };

const mbox = [
  'From 1234@xxx Mon Nov 03 10:00:00 +0000 2026',
  'X-Gmail-Labels: Inbox,Starred,Work/Clients,Category Promotions',
  'Subject: one', '', 'Hello', '>From the archives', 'bye', '',
  'From 5678@xxx Mon Nov 03 11:00:00 +0000 2026',
  'X-Gmail-Labels: Sent,Unread', 'Subject: two', '', 'Second', '',
].join('\n');

it('splits an mbox at "From " lines, even when a separator straddles two chunks', async () => {
  for (const size of [7, 64, 100000]) {
    const msgs = await all(splitMbox(chunks(mbox, size)));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe('X-Gmail-Labels: Inbox,Starred,Work/Clients,Category Promotions\nSubject: one\n\nHello\nFrom the archives\nbye\n'); // keeps its own last line break
    expect(msgs[1].startsWith('X-Gmail-Labels: Sent,Unread')).toBe(true);
  }
});

it('a single .eml (no separator) is one message', async () => {
  expect(await all(splitMbox(chunks('Subject: x\n\nbody', 4)))).toEqual(['Subject: x\n\nbody']);
});

it('maps Gmail labels to folders and flags', () => {
  const p1 = placement(headerText(enc('X-Gmail-Labels: Inbox,Starred,Work/Clients,Category Promotions\nSubject: one\n\nHello')));
  expect(p1).toEqual({ roles: ['inbox'], folders: ['Work/Clients'], keywords: { $flagged: true, $seen: true } });
  const p2 = placement('X-Gmail-Labels: Sent,Unread\nSubject: two');
  expect(p2).toEqual({ roles: ['sent'], folders: [], keywords: {} });
  expect(placement('Subject: plain')).toEqual({ roles: [], folders: [], keywords: { $seen: true } });
});
