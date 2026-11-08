// Your OpenPGP key and the keys of people you write to, kept in this browser (IndexedDB, never on the server).
// The private key is stored wrapped with your passphrase: PBKDF2-SHA-256 (600,000 rounds) → AES-256-GCM, all WebCrypto.
// It is unwrapped into this tab's memory when you unlock it, and forgotten when the tab closes.
// No openpgp import here: this file is loaded with the app; the OpenPGP library (pgp.ts) loads only when needed.
//
// ponytail: PBKDF2, not Argon2 (WebCrypto has no memory-hard KDF). A stolen copy of this browser's storage can be
// brute-forced offline at PBKDF2 speed, so the passphrase must be strong (we ask for 12+ characters).

import { t } from './i18n';
export interface MyKey {
  fingerprint: string;
  publicKey: string;   // armored
  keydata: string;     // the public key, binary as base64: Autocrypt's keydata
  /** The private key, wrapped. Missing when you only uploaded a public key (the private key lives in another app). */
  wrapped?: { salt: string; iv: string; data: string; rounds: number };
}
export type KeySource = 'wkd' | 'autocrypt' | 'attached' | 'imported';
export interface PeerKey {
  email: string; publicKey: string; fingerprint: string; source: KeySource; added: string;
  /** A different key that turned up later. Never used until you choose it in Settings (it may be an attacker's). */
  conflict?: Omit<PeerKey, 'conflict' | 'email'>;
}

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
/** The first key seen for an address is kept (trust on first use). A different one later is kept aside as a conflict
 *  for you to decide on; only a key you import (or choose) yourself replaces it. */
export function mergePeerKey(old: PeerKey | undefined, k: PeerKey, replace = k.source === 'imported'): PeerKey {
  const { conflict: _, ...incoming } = { ...k, email: lc(k.email) };
  if (!old || replace) return incoming;
  if (old.fingerprint === k.fingerprint) return old;
  return { ...old, conflict: { publicKey: k.publicKey, fingerprint: k.fingerprint, source: k.source, added: k.added } };
}
export async function savePeerKey(k: PeerKey, replace?: boolean) {
  const old = await peerKey(k.email), next = mergePeerKey(old, k, replace);
  if (next !== old) await put(`peer:${lc(k.email)}`, next);
  return next;
}
export const removePeerKey = (email: string) => tx('readwrite', (s) => s.delete(`peer:${lc(email)}`));
export async function peerKeys(): Promise<PeerKey[]> {
  const all = await tx<PeerKey[]>('readonly', (s) => s.getAll(IDBKeyRange.bound('peer:', 'peer:\uffff')) as IDBRequest<PeerKey[]>).catch(() => []);
  return all.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Did the server authenticate the sender's domain? Only then may a key that came with the mail be learned (a forged
 * From could otherwise plant a key for someone else). `ar` is the topmost Authentication-Results header, the one our
 * server adds on delivery: DMARC pass for the From domain, or a passing DKIM signature aligned with it. Mail between
 * accounts on this server has no such header; it was authenticated at submission, so it counts for our own domain.
 * ponytail: we don't check the header's authserv-id (the app doesn't know the server's name); a header forged by the
 * sender sits below the server's, and mail from our own users is trusted to be theirs.
 */
/**
 * Did our server authenticate this sender? From the topmost Authentication-Results header, which Stalwart adds on
 * delivery, and only if it names the same host as the topmost Received line (also ours): a header the sender wrote
 * themselves never counts. No such header at all: mail between accounts on this server.
 * needHeader (e.g. "autocrypt"): also require an aligned DKIM signature that covers that header, so someone replaying
 * a genuinely signed message can't add their own key header to it.
 */
export function senderAuthenticated(from: string, ar: string | null | undefined, ownDomain: string,
  opts: { received?: string | null; dkim?: string[]; needHeader?: string } = {}): boolean {
  const domain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
  if (!ar) return domain === ownDomain.toLowerCase();
  const authserv = ar.split(';')[0].trim().toLowerCase();
  const by = /\bby\s+([^\s(;]+)/i.exec(opts.received ?? '')?.[1]?.toLowerCase();
  if (opts.received !== undefined && (!by || by !== authserv)) return false;
  const aligned = (d?: string) => !!d && (d = d.toLowerCase().replace(/^@/, '').replace(/.*@/, ''), d === domain || domain.endsWith('.' + d) || d.endsWith('.' + domain));
  const passes = ar.split(';').slice(1).map((r) => {
    const v = r.replace(/\([^)]*\)/g, ' ');
    const prop = (k: string) => new RegExp(`(?:^|\\s)${k.replace('.', '\\.')}=("?)([^\\s";]+)\\1`, 'i').exec(v)?.[2];
    const dkim = /^\s*dkim=pass\b/i.test(v);
    return { dmarc: /^\s*dmarc=pass\b/i.test(v) && aligned(prop('header.from')), dkim: dkim ? (prop('header.d') ?? prop('header.i')) : undefined,
      s: dkim ? prop('header.s') : undefined, b: dkim ? prop('header.b') : undefined };
  });
  if (!opts.needHeader) return passes.some((p) => p.dmarc || aligned(p.dkim));
  // The signatures that verified result can be: same d=, and the same selector and b= prefix where the result names
  // them. Every one of them must cover the header, so a second, forged signature claiming it can't vouch for it.
  const tags = (sig: string) => (t: string) => new RegExp(`(?:^|;)\\s*${t}=([^;]*)`, 'i').exec(sig.replace(/\s+/g, ''))?.[1]?.toLowerCase();
  const covered = (p: { dkim?: string; s?: string; b?: string }) => {
    const d = p.dkim!.toLowerCase().replace(/.*@/, '');
    const sigs = (opts.dkim ?? []).map(tags).filter((tag) => tag('d') === d && (!p.s || tag('s') === p.s.toLowerCase())
      && (!p.b || (tag('b') ?? '').startsWith(p.b.toLowerCase().replace(/\s+/g, ''))));
    return sigs.length > 0 && sigs.every((tag) => (tag('h') ?? '').split(':').includes(opts.needHeader!.toLowerCase()));
  };
  return passes.some((p) => aligned(p.dkim) && covered(p));
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
  } catch { throw new Error(t('keys.wrongPassphrase')); }
}

// Unlocked private keys, this tab's memory only.
const unlocked = new Map<string, string>();
export const unlockedKey = (user: string) => unlocked.get(lc(user));
export function keepUnlocked(user: string, armoredPrivate: string) { unlocked.set(lc(user), armoredPrivate); }
export async function unlock(user: string, passphrase: string): Promise<string> {
  const k = await myKey(user);
  if (!k?.wrapped) throw new Error(t('keys.noPrivateKey'));
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
