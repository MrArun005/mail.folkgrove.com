import { describe, expect, it } from 'vitest';
import { citations, keywords } from './ai';

describe('ask your inbox', () => {
  it('falls back to plain keywords', () => {
    expect(keywords('When is my flight to Lisbon?')).toEqual(['flight', 'lisbon']);
    expect(keywords('what did Priya say about the Q3 budget')).toEqual(['budget', 'priya', 'say', 'q3']);
  });
  it('keeps only citations that exist', () => {
    expect(citations('It leaves at 9:40 [2][3], gate B [2]. See [9].', 3)).toEqual([2, 3]);
    expect(citations('Not found.', 3)).toEqual([]);
  });
});
