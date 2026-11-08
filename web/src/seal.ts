// Confidential mode (Gmail's, done honestly). The message is encrypted in the sender's browser (AES-256-GCM,
// WebCrypto) and stored as a large-file link (signup/files.mjs: the sender's own storage, an unguessable id, expiry,
// revocable). Recipients get a link to /confidential.html with the key after "#": browsers never send that part
// to a server, so the account service only ever holds ciphertext.
//
// What it is not: the link (key included) is in the email, so whoever can read that email (the recipient, their
// mail server, our Sent folder) can open the message until it expires or is revoked. A passcode, shared some other
// way, is the second factor: it's mixed into the key, so the email alone isn't enough. Recipients can still copy,
// print or photograph what they see.

// No sender inside: it would be the sender's own claim, shown on our domain. The email that carries the link has the
// real, checked From line.
export interface Secret { subject: string; sent: string; text: string }

const enc = new TextEncoder();
// ponytail: PBKDF2 (WebCrypto has no Argon2). Anyone holding the link can guess passcodes offline against the
// ciphertext, so the UI asks for a few words, not a PIN. Raise ITER (old links keep working only if stored with it).
const ITER = 600_000;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function aesKey(k: Uint8Array<ArrayBuffer>, passcode: string, use: KeyUsage): Promise<CryptoKey> {
  if (!passcode) return crypto.subtle.importKey('raw', k, 'AES-GCM', false, [use]);
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode.normalize('NFKC').trim()), 'PBKDF2', false, ['deriveKey']);
  // The link's random key is the salt: both are needed, and each link derives a different key.
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: k, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
}

/** Encrypt a message: the bytes to store (12-byte IV, then ciphertext) and the key for the link. */
export async function seal(secret: Secret, passcode = ''): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string }> {
  const k = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(k, passcode, 'encrypt'), enc.encode(JSON.stringify(secret))));
  const blob = new Uint8Array(12 + ct.length); blob.set(iv); blob.set(ct, 12);
  return { blob, key: b64url(k) };
}

/** Decrypt; throws when the key or passcode is wrong (or the bytes were changed: GCM checks them). */
export async function unseal(blob: Uint8Array<ArrayBuffer>, key: string, passcode = ''): Promise<Secret> {
  const k = unb64url(key);
  if (k.length !== 32 || blob.length < 29) throw new Error('bad key');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, await aesKey(k, passcode, 'decrypt'), blob.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** The link recipients get. Everything after "#" stays in the browser. */
export const confidentialUrl = (origin: string, id: string, key: string, passcode: boolean) =>
  `${origin}/confidential.html#${new URLSearchParams({ id, k: key, ...(passcode && { p: '1' }) })}`;

/** Parts of a link (from location.hash). */
export function parseFragment(hash: string): { id: string; key: string; passcode: boolean } | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const id = q.get('id') ?? '', key = q.get('k') ?? '';
  return /^[A-Za-z0-9_-]{24}$/.test(id) && /^[A-Za-z0-9_-]{43}$/.test(key) ? { id, key, passcode: q.get('p') === '1' } : null;
}

/** Ids of confidential links to this server (`origin`) in a message body, once each: what the sender can revoke. */
export function confidentialIds(body: string, origin: string): string[] {
  const out = new Set<string>();
  for (const [, o, id] of body.replace(/&amp;|&#38;/g, '&').matchAll(/(https?:\/\/[a-z0-9.-]+(?::\d+)?)\/confidential\.html#id=([A-Za-z0-9_-]{24})/gi)) {
    try { if (new URL(o).origin === new URL(origin).origin) out.add(id); } catch { /* not ours */ }
  }
  return [...out];
}
