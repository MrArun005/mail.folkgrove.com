// OpenPGP for mail, with openpgp.js (the library Proton maintains). Loaded on demand: import('./pgp').
// Reads PGP/MIME (RFC 3156: multipart/encrypted and multipart/signed), which is also what Stalwart writes when it
// encrypts stored mail, and writes encrypted + signed PGP/MIME that Thunderbird, Proton and GnuPG read.
import * as openpgp from 'openpgp';
import { encodeHeader } from './mailutil';
import { wkdUrls } from './keys';
import { t } from './i18n';

// ── Bytes as "binary strings" (one char per byte), so signed parts keep their exact bytes ──

export const bin = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
export const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => bin(new TextEncoder().encode(s));

// ── MIME: just enough to read a decrypted message ──
// ponytail: no RFC 2231 continuations or encoded-word file names; nested message/rfc822 is shown as an attachment.

export interface Part { type: string; params: Record<string, string>; headers: Record<string, string>; raw: string; body: string; parts: Part[] }

function params(v: string): [string, Record<string, string>] {
  const p: Record<string, string> = {};
  for (const m of v.matchAll(/;\s*([\w*.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g)) p[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1');
  return [v.split(';')[0].trim().toLowerCase(), p];
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseMime(raw: string): Part {
  const cut = /^\r?\n|\r?\n\r?\n/.exec(raw);
  const head = cut ? raw.slice(0, cut.index) : raw, body = cut ? raw.slice(cut.index + cut[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':'), k = line.slice(0, i).trim().toLowerCase();
    if (i > 0 && !(k in headers)) headers[k] = line.slice(i + 1).trim();
  }
  const [type, p] = params(headers['content-type'] ?? 'text/plain');
  const parts: Part[] = [];
  if (type.startsWith('multipart/') && p.boundary) {
    // A part is everything between delimiter lines; the CRLF before a delimiter belongs to the delimiter (RFC 2046).
    const re = new RegExp(`(?:^|\\r?\\n)--${esc(p.boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
    let start = -1;
    for (let m; (m = re.exec(body));) {
      if (start >= 0) parts.push(parseMime(body.slice(start, m.index)));
      if (m[1]) break;
      start = re.lastIndex;
    }
  }
  return { type, params: p, headers, raw, body, parts };
}

export function decodeBody(p: Part): Uint8Array {
  const cte = (p.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (cte === 'base64') return bytes(atob(p.body.replace(/\s/g, '')));
  if (cte === 'quoted-printable') return bytes(p.body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return bytes(p.body);
}
const decodeText = (p: Part) => {
  const b = decodeBody(p);
  try { return new TextDecoder(p.params.charset || 'utf-8').decode(b); } catch { return new TextDecoder().decode(b); }
};

export interface MailFile { name: string; type: string; data: Uint8Array; cid: string | null }
export interface Mail { html: string | null; text: string | null; attachments: MailFile[] }

export function readMail(root: Part): Mail {
  const out: Mail = { html: null, text: null, attachments: [] };
  const walk = (p: Part) => {
    if (p.parts.length) return p.parts.forEach(walk);
    const [disp, dp] = params(p.headers['content-disposition'] ?? '');
    const name = dp.filename ?? p.params.name ?? null;
    if (disp !== 'attachment' && !name && (p.type === 'text/html' || p.type === 'text/plain')) {
      const k = p.type === 'text/html' ? 'html' : 'text';
      out[k] = (out[k] ? out[k] + '\n' : '') + decodeText(p);
    } else if (p.type !== 'application/pgp-signature') {
      out.attachments.push({ name: name ?? 'attachment', type: p.type, data: decodeBody(p), cid: p.headers['content-id']?.replace(/^<|>$/g, '') ?? null });
    }
  };
  walk(root);
  return out;
}

// ── Reading: decrypt and verify ──

/** verified: signed by the key we hold for the sender. bad: the signature doesn't match (changed, or forged).
 *  unknown: signed, but we don't have the sender's key to check it. null: not signed. */
export type SigState = 'verified' | 'bad' | 'unknown' | null;
export interface Opened { encrypted: boolean; signature: SigState; mail: Mail | null; error?: string }

async function sigState(sigs: { verified: Promise<unknown> }[]): Promise<SigState> {
  if (!sigs.length) return null;
  try { await sigs[0].verified; return 'verified'; }
  catch (e) { return /could not find|no (public )?key/i.test((e as Error).message) ? 'unknown' : 'bad'; }
}

/** Open a raw message (RFC 5322 bytes). privateKey: armored, unlocked. senderKeys: armored keys we hold for the From address. */
export async function openMessage(raw: Uint8Array, privateKey: string | undefined, senderKeys: string[]): Promise<Opened> {
  let root = parseMime(bin(raw)), encrypted = false, signature: SigState = null;
  const verificationKeys = (await Promise.all(senderKeys.map((k) => openpgp.readKey({ armoredKey: k }).catch(() => null)))).filter((k) => k !== null);
  if (root.type === 'multipart/encrypted') {
    encrypted = true;
    const payload = root.parts.find((p) => p.type !== 'application/pgp-encrypted');
    if (!payload) return { encrypted, signature, mail: null, error: t('pgp.damaged') };
    if (!privateKey) return { encrypted, signature, mail: null };
    try {
      const r = await openpgp.decrypt({
        message: await openpgp.readMessage({ armoredMessage: bin(decodeBody(payload)) }),
        decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }), verificationKeys, format: 'binary',
      });
      signature = await sigState(r.signatures);
      root = parseMime(bin(r.data as Uint8Array));
    } catch (e) {
      return { encrypted, signature, mail: null, error: /session key|decrypt/i.test((e as Error).message) ? t('pgp.otherKey') : t('pgp.couldntDecrypt', { error: (e as Error).message }) };
    }
  }
  if (root.type === 'multipart/signed') {
    // Exactly the signed part and its signature; anything else is a message built to mislead. Only part 1 is shown.
    if (root.parts.length !== 2) return { encrypted, signature: 'bad', mail: root.parts[0] ? readMail(root.parts[0]) : null };
    try {
      const v = await openpgp.verify({
        message: await openpgp.createMessage({ binary: bytes(root.parts[0].raw.replace(/\r?\n/g, '\r\n')) }),
        signature: await openpgp.readSignature({ armoredSignature: bin(decodeBody(root.parts[1])) }), verificationKeys,
      });
      signature = await sigState(v.signatures);
    } catch { signature = verificationKeys.length ? 'bad' : 'unknown'; }
    root = root.parts[0];
  }
  return { encrypted, signature, mail: readMail(root) };
}

// ── Writing: encrypted and signed PGP/MIME (RFC 3156 §6.2, signed and encrypted in one OpenPGP message) ──

export interface Outgoing {
  from: { name?: string | null; email: string }; to: { name?: string | null; email: string }[]; cc: { name?: string | null; email: string }[];
  subject: string; html: string; text: string; files: MailFile[]; inReplyTo?: string[]; references?: string[]; autocrypt?: string;
}

const addr = (a: { name?: string | null; email: string }) => (a.name ? `${encodeHeader(a.name.replace(/["\\\r\n]/g, ''))} <${a.email}>` : a.email);
const b64lines = (s: string) => btoa(s).replace(/.{76}/g, '$&\r\n');
const boundary = () => `om-${crypto.randomUUID()}`;
const ids = (l?: string[]) => l?.filter((x) => /^[^\s<>]+@[^\s<>]+$/.test(x)).map((x) => `<${x}>`).join(' ');

/** The message inside the encryption: text + HTML, and any files. */
export function innerMime(o: Pick<Outgoing, 'html' | 'text' | 'files'>): string {
  const b = boundary();
  const alt = [`Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(utf8(o.text)),
    `--${b}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(utf8(o.html)),
    `--${b}--`, ''].join('\r\n');
  if (!o.files.length) return alt;
  const m = boundary();
  return [`Content-Type: multipart/mixed; boundary="${m}"`, '', `--${m}`, alt,
    ...o.files.flatMap((f) => {
      const name = encodeHeader(f.name.replace(/["\\\r\n]/g, ''));
      return [`--${m}`, `Content-Type: ${f.type.replace(/[^\w.+/-]/g, '') || 'application/octet-stream'}; name="${name}"`,
        `Content-Disposition: ${f.cid ? 'inline' : 'attachment'}; filename="${name}"`, ...(f.cid ? [`Content-ID: <${f.cid}>`] : []),
        'Content-Transfer-Encoding: base64', '', b64lines(bin(f.data))];
    }),
    `--${m}--`, ''].join('\r\n');
}

/** The whole message, ready to upload and send. Encrypted to every recipient and to you (so Sent stays readable).
 *  ponytail: the Subject stays visible outside the encryption (no RFC 9788 header protection yet), and every
 *  recipient's key ID is in the message, Bcc included. */
export async function encryptedMessage(o: Outgoing, privateKey: string, keys: string[]): Promise<string> {
  const encryptionKeys = await Promise.all(keys.map((k) => openpgp.readKey({ armoredKey: k })));
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: bytes(innerMime(o)) }),
    encryptionKeys, signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
  });
  const b = boundary(), domain = o.from.email.split('@')[1];
  return [
    `From: ${addr(o.from)}`, ...(o.to.length ? [`To: ${o.to.map(addr).join(', ')}`] : []), ...(o.cc.length ? [`Cc: ${o.cc.map(addr).join(', ')}`] : []),
    `Subject: ${encodeHeader(o.subject.replace(/[\r\n]+/g, ' '))}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...(ids(o.inReplyTo) ? [`In-Reply-To: ${ids(o.inReplyTo)}`] : []), ...(ids(o.references) ? [`References: ${ids(o.references)}`] : []),
    ...(o.autocrypt ? [`Autocrypt: ${o.autocrypt}`] : []),
    'MIME-Version: 1.0', `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '',
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)', '',
    `--${b}`, 'Content-Type: application/pgp-encrypted', 'Content-Description: PGP/MIME version identification', '', 'Version: 1', '',
    `--${b}`, 'Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Disposition: inline; filename="encrypted.asc"', '',
    armored.replace(/\r?\n/g, '\r\n'), `--${b}--`, '',
  ].join('\r\n');
}

// ── Keys ──

/** A new key pair (Curve25519: small, fast, read by every current OpenPGP app). */
export async function createKey(name: string, email: string) {
  const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: name || undefined, email }], format: 'armored' });
  return privateKey;
}
/** Public half, fingerprint and Autocrypt keydata of an (unlocked) armored private key, or of a public key. */
export async function describeKey(armored: string) {
  const k = await openpgp.readKey({ armoredKey: armored });
  const pub = k.toPublic();
  return { fingerprint: k.getFingerprint().toUpperCase(), publicKey: pub.armor(), keydata: btoa(bin(pub.write())), isPrivate: k.isPrivate(),
    emails: k.users.map((u) => u.userID?.email?.toLowerCase()).filter((e): e is string => !!e) };
}
/** The backup file: the private key locked with the passphrase in OpenPGP's own format, so GnuPG, Thunderbird or
 *  Proton can import it too. */
export async function backupKey(armoredPrivate: string, passphrase: string) {
  return (await openpgp.encryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivate }), passphrase })).armor();
}
/** Read a backup (or any exported private key) and unlock it. Returns the unlocked armored key. */
export async function restoreKey(armored: string, passphrase: string) {
  const k = await openpgp.readPrivateKey({ armoredKey: armored });
  if (k.isDecrypted()) return k.armor();
  try { return (await openpgp.decryptKey({ privateKey: k, passphrase })).armor(); }
  catch { throw new Error(t('pgp.backupPassphrase')); }
}
/** Public keys in a pasted block or file, as [email, armored] pairs (one key can carry several addresses). */
export async function readPublicKeys(text: string) {
  const keys = await openpgp.readKeys({ armoredKeys: text });
  return (await Promise.all(keys.map(async (k) => (await describeKey(k.toPublic().armor())).emails.map((e) => [e, k.toPublic().armor()] as const)))).flat();
}
/** A key from keydata (Autocrypt) or a binary key (WKD), only if it is for this address. */
export async function keyFor(email: string, binary: Uint8Array): Promise<string | null> {
  try {
    const k = await openpgp.readKey({ binaryKey: binary });
    if (!k.users.some((u) => u.userID?.email?.toLowerCase() === email.toLowerCase())) return null;
    await k.getEncryptionKey(); // throws when the key can't encrypt (expired, revoked)
    return k.toPublic().armor();
  } catch { return null; }
}
export const autocryptKey = (email: string, header: string) => {
  const kv = Object.fromEntries(header.split(';').map((x) => { const i = x.indexOf('='); return [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()]; }));
  if (kv.addr?.toLowerCase() !== email.toLowerCase() || !kv.keydata) return Promise.resolve(null);
  try { return keyFor(email, bytes(atob(kv.keydata.replace(/\s/g, '')))); } catch { return Promise.resolve(null); }
};

/** Look a key up in the recipient domain's Web Key Directory. ownDomain: ask our own server (same origin) instead.
 *  ponytail: browsers can only read a WKD that sends Access-Control-Allow-Origin (Proton, mailbox.org and GnuPG's
 *  sample config do; some self-hosted ones don't). */
export async function wkdLookup(email: string, ownDomain?: string): Promise<string | null> {
  const urls = await wkdUrls(email);
  const list = ownDomain && email.toLowerCase().endsWith('@' + ownDomain.toLowerCase()) ? [urls[1].replace(/^https:\/\/[^/]+/, '')] : urls;
  for (const u of list) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
      if (r.ok) { const k = await keyFor(email, new Uint8Array(await r.arrayBuffer())); if (k) return k; }
    } catch { /* no WKD there, blocked by CORS, or offline */ }
  }
  return null;
}
