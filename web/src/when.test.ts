import { expect, it } from 'vitest';
import { quickTimes } from './when';

const fmt = (ws: { label: string; at: Date }[]) => ws.map((w) => `${w.label} ${w.at.getDay()} ${w.at.getHours()}:${w.at.getMinutes()}`);

it('weekday morning offers later today, tomorrow, weekend, next Monday', () => {
  expect(fmt(quickTimes(new Date(2026, 10, 4, 10, 25)))).toEqual([ // Wed 10:25
    'Later today 3 13:0', 'Tomorrow morning 4 8:0', 'This weekend 6 9:0', 'Next week 1 8:0',
  ]);
});

it('Friday evening skips later today and this weekend', () => {
  expect(fmt(quickTimes(new Date(2026, 10, 6, 19, 0)))).toEqual(['Tomorrow morning 6 8:0', 'Next week 1 8:0']);
});

it('on a Monday, next week means the following Monday', () => {
  const next = quickTimes(new Date(2026, 10, 9, 18, 0)).find((w) => w.label === 'Next week')!;
  expect(next.at.getDate()).toBe(16);
});
