import { expect, it } from 'vitest';
import { addTrackers, ranked, readTally, type PrivacyTally } from './privacy';

const start = (): PrivacyTally => ({ since: '2026-11-01T00:00:00Z', messages: 0, trackers: 0, senders: {}, hosts: {}, seen: [] });

it('counts a message once, however often it is opened', () => {
  const a = addTrackers(start(), 'm1', { name: 'Shop', email: 'News@Shop.example' }, ['t.shop.example', 'pixel.ads.example']);
  expect(a).toMatchObject({ messages: 1, trackers: 2, senders: { 'news@shop.example': { name: 'Shop', n: 1 } } });
  expect(addTrackers(a, 'm1', { email: 'news@shop.example' }, ['t.shop.example'])).toBe(a);
});

it('a message without trackers is not counted', () => {
  const s = start();
  expect(addTrackers(s, 'm2', { email: 'a@b.example' }, [])).toBe(s);
});

it('ranks senders and tracking hosts, most first', () => {
  let t = start();
  t = addTrackers(t, 'm1', { name: 'Shop', email: 'news@shop.example' }, ['pixel.ads.example']);
  t = addTrackers(t, 'm2', { name: 'Shop', email: 'news@shop.example' }, ['pixel.ads.example', 't.shop.example']);
  t = addTrackers(t, 'm3', { email: 'hi@blog.example' }, ['t.blog.example']);
  const r = ranked(t);
  expect(r.senders.map((s) => [s.email, s.n])).toEqual([['news@shop.example', 2], ['hi@blog.example', 1]]);
  expect(r.hosts[0]).toEqual({ host: 'pixel.ads.example', n: 2 });
  expect(r.senders[1].name).toBe('hi@blog.example'); // no display name: the address
});

it('reads a missing or broken record as empty', () => {
  expect(readTally('x', { getItem: () => null }).messages).toBe(0);
  expect(readTally('x', { getItem: () => '{nope' }).messages).toBe(0);
});
