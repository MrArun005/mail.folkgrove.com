import { describe, expect, it } from 'vitest';
import { formatRoute, HOME, parseRoute, step, type Route } from './route';

const r = (p: Partial<Route>): Route => ({ ...HOME, ...p });

describe('route', () => {
  it('the Inbox with nothing open has no hash', () => {
    expect(formatRoute(HOME)).toBe('');
    expect(parseRoute('')).toEqual(HOME);
    expect(parseRoute('#/')).toEqual(HOME);
  });

  it('round-trips folders, searches and conversations', () => {
    for (const x of [r({ view: 'starred' }), r({ view: 'b', thread: 'T1' }), r({ thread: 'T1' }),
      r({ query: 'from:priya has:attachment' }), r({ query: 'a/b #c', thread: 'x/y' })]) {
      expect(parseRoute(formatRoute(x))).toEqual(x);
    }
  });

  it('a search has no folder', () => {
    expect(formatRoute(r({ view: 'b', query: 'hello' }))).toBe('#/search/hello');
  });

  it('treats anything it does not understand as the Inbox', () => {
    expect(parseRoute('#access_token=abc')).toEqual(HOME);
    expect(parseRoute('#/nope/1/in')).toEqual(HOME);
    expect(parseRoute('#/in/%E0%A4%A')).toEqual(r({ view: '%E0%A4%A' })); // bad escape: kept as typed, not thrown
  });
});

describe('history steps', () => {
  it('opening a conversation is a step back can undo', () => {
    expect(step(HOME, r({ thread: 'T1' }), false)).toBe('push');
  });
  it('closing the conversation we opened goes back instead of adding an entry', () => {
    expect(step(r({ thread: 'T1' }), HOME, true)).toBe('back');
  });
  it('closing a conversation that was the first page (a link, a reload) replaces it', () => {
    expect(step(r({ thread: 'T1' }), HOME, false)).toBe('replace');
  });
  it('the next conversation replaces the current one', () => {
    expect(step(r({ thread: 'T1' }), r({ thread: 'T2' }), true)).toBe('replace');
  });
  it('another folder is a new step; typing in search is not', () => {
    expect(step(HOME, r({ view: 'sent' }), false)).toBe('push');
    expect(step(HOME, r({ query: 'p' }), false)).toBe('push');
    expect(step(r({ query: 'p' }), r({ query: 'pr' }), false)).toBe('replace');
    expect(step(r({ query: 'pr' }), HOME, false)).toBe('push');
  });
});
