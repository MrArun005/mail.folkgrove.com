import { expect, it, describe as group } from 'vitest';
import { quickTimes, nextAt, usualTime } from './when';

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

group('when someone usually writes', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 9, h, m);
  it('finds the time their mail clusters round, to a quarter hour', () => {
    expect(usualTime([at(9, 5), at(9, 40), at(10, 10), at(9, 20)])).toBe(9 * 60 + 30);
  });
  it('wraps midnight instead of averaging to noon', () => {
    expect(usualTime([at(23, 30), at(0, 30), at(23, 45), at(0, 15)])).toBe(0);
  });
  it('gives nothing for too little mail or no pattern', () => {
    expect(usualTime([at(9), at(10)])).toBeNull();
    expect(usualTime([at(0), at(6), at(12), at(18)])).toBeNull();
  });
  it('the next such time is today if it is still ahead, otherwise tomorrow', () => {
    expect(nextAt(15 * 60, at(9))).toEqual(at(15));
    expect(nextAt(9 * 60, at(9))).toEqual(new Date(2026, 10, 10, 9));
    expect(nextAt(9 * 60 + 15, at(9))).toEqual(new Date(2026, 10, 10, 9, 15)); // less than half an hour away
  });
});
