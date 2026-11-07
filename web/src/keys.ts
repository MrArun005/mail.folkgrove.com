// Your OpenPGP key and the keys of people you write to, kept in this browser (IndexedDB, never on the server).
// The private key is stored wrapped with your passphrase: PBKDF2-SHA-256 (600,000 rounds) → AES-256-GCM, all WebCrypto.
// It is unwrapped into this tab's memory when you unlock it, and forgotten when the tab closes.
// No openpgp import here: this file is loaded with the app; the OpenPGP library (pgp.ts) loads only when needed.
//
// ponytail: PBKDF2, not Argon2 (WebCrypto has no memory-hard KDF). A stolen copy of this browser's storage can be
// brute-forced offline at PBKDF2 speed, so the passphrase must be strong (we ask for 12+ characters).

export interface MyKey {
  fingerprint: string;
  publicKey: string;   // armored
  keydata: string;     // the public key, binary as base64: Autocrypt's keydata
  /** The private key, wrapped. Missing when you only uploaded a public key (the private key lives in another app). */
  wrapped?: { salt: string; iv: string; data: string; rounds: number };
}
export type KeySource = 'wkd' | 'autocrypt' | 'attached' | 'imported';
export interface PeerKey { email: string; publicKey: string; source: KeySource; added: string }

const DB = 'openmail-keys', STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise((ok, fail) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
}));
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
  const d = await db();
  return new Promise<T>((ok, fail) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
};
const get = <T>(k: string) => tx<T | undefined>('readonly', (s) => s.get(k) as IDBRequest<T | undefined>).catch(() => undefined);
const put = (k: string, v: unknown) => tx('readwrite', (s) => s.put(v, k));

const lc = (s: string) => s.trim().toLowerCase();
export const myKey = (user: string) => get<MyKey>(`me:${lc(user)}`);
export const saveMyKey = (user: string, k: MyKey) => put(`me:${lc(user)}`, k);
export async function forgetMyKey(user: string) { unlocked.delete(lc(user)); await tx('readwrite', (s) => s.delete(`me:${lc(user)}`)); }
export const peerKey = (email: string) => get<PeerKey>(`peer:${lc(email)}`);
/** First key seen for an address wins (trust on first use); only a key you import yourself replaces it. */
export async function savePeerKey(k: PeerKey, replace = k.source === 'imported') {
  if (!replace && (await peerKey(k.email))) return;
  await put(`peer:${lc(k.email)}`, { ...k, email: lc(k.email) });
}

// ── Passphrase wrapping (WebCrypto only) ────────────────

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ROUNDS = 600_000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256

async function kek(passphrase: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrap(secret: string, passphrase: string): Promise<NonNullable<MyKey['wrapped']>> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kek(passphrase, salt, ROUNDS), new TextEncoder().encode(secret));
  return { salt: b64(salt), iv: b64(iv), data: b64(data), rounds: ROUNDS };
}
export async function unwrap(w: NonNullable<MyKey['wrapped']>, passphrase: string): Promise<string> {
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, await kek(passphrase, unb64(w.salt), w.rounds), unb64(w.data));
    return new TextDecoder().decode(out);
  } catch { throw new Error('That passphrase isn’t right.'); }
}

// Unlocked private keys, this tab's memory only.
const unlocked = new Map<string, string>();
export const unlockedKey = (user: string) => unlocked.get(lc(user));
export function keepUnlocked(user: string, armoredPrivate: string) { unlocked.set(lc(user), armoredPrivate); }
export async function unlock(user: string, passphrase: string): Promise<string> {
  const k = await myKey(user);
  if (!k?.wrapped) throw new Error('There’s no private key in this browser. Restore your key backup in Settings → Security.');
  const s = await unwrap(k.wrapped, passphrase);
  unlocked.set(lc(user), s);
  return s;
}

// ── Publishing and finding keys ─────────────────────────

/** Autocrypt (autocrypt.org Level 1) header value. Spaces in keydata let the server fold the long line. */
export const autocryptHeader = (email: string, keydata: string) =>
  `addr=${email}; prefer-encrypt=mutual; keydata=${keydata.match(/.{1,72}/g)!.join(' ')}`;

/** z-base-32 (the encoding WKD uses for its hashes). */
export function zbase32(data: Uint8Array) {
  const A = 'ybndrfg8ejkmcpqxot1uwisza345h769';
  let out = '', bits = 0, value = 0;
  for (const byte of data) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
/** WKD hash of a local part: z-base-32 of SHA-1 of the local part with A-Z lowercased (draft-koch-openpgp-webkey-service). */
export async function wkdHash(local: string) {
  const ascii = local.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return zbase32(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ascii))));
}
/** Where to look for someone's key: the advanced method first, then the direct one. */
export async function wkdUrls(email: string) {
  const at = email.lastIndexOf('@'), local = email.slice(0, at), domain = email.slice(at + 1).toLowerCase();
  const h = await wkdHash(local), l = encodeURIComponent(local);
  return [`https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${h}?l=${l}`, `https://${domain}/.well-known/openpgpkey/hu/${h}?l=${l}`];
}
