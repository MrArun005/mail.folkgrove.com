import { afterEach, expect, it, vi } from 'vitest';
import { isOffline } from './offline';

afterEach(() => vi.unstubAllGlobals());

it('tells "no connection" from "the server said no", with or without a navigator', () => {
  const refused = new Error('Download failed (404)'), dropped = new TypeError('fetch failed');
  // Under Node before 21 (CI's integration tests) there is no navigator: asking must not throw.
  vi.stubGlobal('navigator', undefined);
  expect(isOffline(refused)).toBe(false);
  expect(isOffline(dropped)).toBe(true);
  vi.stubGlobal('navigator', { onLine: false });
  expect(isOffline(refused)).toBe(true);
  vi.stubGlobal('navigator', { onLine: true });
  expect(isOffline(refused)).toBe(false);
});
