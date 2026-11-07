import { expect, it } from 'vitest';
import { parseMailto } from './launch';

it('parses mailto links (RFC 6068)', () => {
  expect(parseMailto('mailto:ann@x.org,bob@y.org?Subject=Hi%20there&cc=c@z.io&body=Line%201%0D%0A1+1%3D2&to=d@w.net')).toEqual({
    to: [{ name: null, email: 'ann@x.org' }, { name: null, email: 'bob@y.org' }, { name: null, email: 'd@w.net' }],
    cc: [{ name: null, email: 'c@z.io' }], bcc: [], subject: 'Hi there', body: 'Line 1\n1+1=2',
  });
  expect(parseMailto('mailto:%22Ann%20Lee%22%20%3Cann@x.org%3E').to).toEqual([{ name: 'Ann Lee', email: 'ann@x.org' }]);
  expect(parseMailto('MAILTO:?subject=x').to).toEqual([]);
});
