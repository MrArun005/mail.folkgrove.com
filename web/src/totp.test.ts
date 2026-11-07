import { expect, it } from 'vitest';
import { base32, fromBase32, newSecret, otpauthUrl, totp, verifyTotp } from './totp';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890"; the RFC uses 8 digits.
const RFC_SECRET = base32(new TextEncoder().encode('12345678901234567890'));

it('matches the RFC 6238 test vectors', async () => {
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']] as const)
    expect(await totp(RFC_SECRET, t * 1000, 8)).toBe(code);
});

it('base32 round-trips and new secrets are 160 bits', () => {
  expect(base32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  expect(new TextDecoder().decode(fromBase32('MZXW6YTBOI'))).toBe('foobar');
  const s = newSecret();
  expect(s).toMatch(/^[A-Z2-7]{32}$/);
  expect(fromBase32(s)).toHaveLength(20);
});

it('verifies the current code with one step of drift, rejects others', async () => {
  const s = newSecret(), now = 1_800_000_000_000;
  expect(await verifyTotp(s, await totp(s, now), now)).toBe(true);
  expect(await verifyTotp(s, await totp(s, now - 30000), now)).toBe(true);
  expect(await verifyTotp(s, await totp(s, now - 90000), now)).toBe(false);
  expect(await verifyTotp(s, '12345', now)).toBe(false);
  expect(await verifyTotp(s, 'abcdef', now)).toBe(false);
});

it('builds an otpauth URL authenticator apps accept', () => {
  expect(otpauthUrl('ABC', 'alice@o.test')).toBe('otpauth://totp/OpenMail:alice%40o.test?secret=ABC&issuer=OpenMail&algorithm=SHA1&digits=6&period=30');
});
