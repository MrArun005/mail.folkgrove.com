// TOTP (RFC 6238) with WebCrypto: create a secret for authenticator apps and check a code before turning 2FA on,
// so a mistyped setup can never lock someone out.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));

/** The 6-digit code for a 30-second step. */
export async function totp(secret: string, at = Date.now(), digits = 6, algo: 'SHA-1' | 'SHA-256' | 'SHA-512' = 'SHA-1'): Promise<string> {
  const counter = Math.floor(at / 30000);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter); // high 32 bits stay 0 until about the year 6053 (2^32 thirty-second steps)
  const key = await crypto.subtle.importKey('raw', fromBase32(secret).slice().buffer as ArrayBuffer, { name: 'HMAC', hash: algo }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** Accept the current step and one either side (clock drift between phone and computer). */
export async function verifyTotp(secret: string, code: string, at = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [0, -30000, 30000]) if (await totp(secret, at + d) === c) return true;
  return false;
}

export const otpauthUrl = (secret: string, account: string, issuer = 'OpenMail') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
