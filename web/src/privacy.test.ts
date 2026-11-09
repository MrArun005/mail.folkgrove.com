import { expect, it } from 'vitest';
import { addTrackers, ranked, readTally, week, type PrivacyTally } from './privacy';

const start = (): PrivacyTally => ({ since: '2026-11-01T00:00:00Z', messages: 0, trackers: 0, senders: {}, hosts: {}, days: {}, seen: [] });

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

it('this week and the week before, by local day', () => {
  const day = (d: number) => new Date(2026, 10, d, 12);
  let t = start();
  t = addTrackers(t, 'a', { email: 'a@x.example' }, ['h1', 'h2'], day(20)); // today
  t = addTrackers(t, 'b', { email: 'a@x.example' }, ['h1'], day(14));       // six days ago: still this week
  t = addTrackers(t, 'c', { email: 'a@x.example' }, ['h1', 'h2', 'h3'], day(13)); // last week
  const w = week(t, day(20));
  expect(w.total).toBe(3);
  expect(w.previous).toBe(3);
  expect(w.days.map((d) => d.n)).toEqual([1, 0, 0, 0, 0, 0, 2]);
});

it('a record from before days were counted still reads', () => {
  const old = JSON.stringify({ since: '2026-11-01T00:00:00Z', messages: 2, trackers: 3, senders: {}, hosts: {}, seen: ['x'] });
  const t = readTally('u', { getItem: () => old });
  expect(week(t).total).toBe(0);
  expect(addTrackers(t, 'y', { email: 'a@x.example' }, ['h']).trackers).toBe(4);
});
