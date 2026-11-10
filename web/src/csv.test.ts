import { describe, expect, it } from 'vitest';
import { importRows, parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('reads quotes, doubled quotes, line breaks inside quotes, CRLF and blank lines', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n\r\n"two\nlines",,x\n')).toEqual([['a', 'b, c', 'say "hi"'], ['two\nlines', '', 'x']]);
  });
  it('round-trips what it writes', () => {
    const rows = [['sam', 'p"w,1'], ['ann', 'plain']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('maps columns, skips a header, keeps an unreadable limit for the server to report', () => {
    expect(importRows(parseCsv('username,display name,password,quota\nsam, Sam Lee ,,1.5\nann\nbob,,secret,lots'))).toEqual([
      { name: 'sam', description: 'Sam Lee', password: '', quotaBytes: 1.5 * 1024 ** 3 },
      { name: 'ann', description: '', password: '' },
      { name: 'bob', description: '', password: 'secret', quotaBytes: 'lots' },
    ]);
  });
});
