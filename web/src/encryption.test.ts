// Encryption on the local dev server, with throwaway accounts made through the admin API (never alice or bob):
//  - at rest: after turning it on, delivered mail is stored as PGP/MIME, and the reader logic decrypts it;
//  - end to end: an encrypted + signed message sent to another account arrives encrypted and opens, verified;
//  - Autocrypt: plain mail carries the sender's key, and the recipient can read it from the header.
// Skips without the server or deploy/.dev-admin.json (or ADMIN_FILE). Node has no IndexedDB, so keys.ts's store is
// replaced by in-memory maps here; everything else (openpgp, JMAP, Stalwart) is real.
import { readFileSync, existsSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { MyKey, PeerKey } from './keys';
import type { Jmap as JmapClient } from './jmap';

const store = vi.hoisted(() => ({ me: new Map<string, MyKey>(), peers: new Map<string, PeerKey>(), unlocked: new Map<string, string>() }));
vi.mock('./keys', async (orig) => ({
  ...(await orig<typeof import('./keys')>()),
  myKey: async (u: string) => store.me.get(u.toLowerCase()),
  peerKey: async (e: string) => store.peers.get(e.toLowerCase()),
  unlockedKey: (u: string) => store.unlocked.get(u.toLowerCase()),
}));
const { Jmap } = await import('./jmap');
const { createKey, describeKey, openMessage, autocryptKey } = await import('./pgp');

const BASE = 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE ?? new URL('../../deploy/.dev-admin.json', import.meta.url).pathname;
const up = existsSync(ADMIN_FILE) && await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }).then(() => true, () => false);
const admin = up ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) : null;
const adminJmap = async (methodCalls: unknown[]) => (await (await fetch(`${BASE}/jmap/`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${admin.user}:${admin.pass}`) },
  body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
const made: string[] = [];
async function throwaway() {
  const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d: { name: string }) => d.name === 'openmail.test').id;
  const name = `t-enc-${Math.random().toString(36).slice(2, 8)}`;
  const r = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: 'throwaway passphrase 42' } } } } }, 'c']]);
  if (!r.created) throw new Error(JSON.stringify(r.notCreated));
  made.push(r.created.n.id);
  const email = `${name}@openmail.test`, c = await Jmap.login(email, 'throwaway passphrase 42', BASE);
  const key = await createKey('', email), d = await describeKey(key);
  return { c, email, key, ...d };
}
afterAll(async () => { if (made.length) await adminJmap([['x:Account/set', { destroy: made }, 'x']]); });

/** Deliver a message over SMTP, as mail from outside arrives. */
async function deliver(to: string, subject: string, body: string) {
  const net = await import('node:net');
  await new Promise<void>((ok, fail) => {
    const lines = ['EHLO test.example.org', 'MAIL FROM:<sender@example.org>', `RCPT TO:<${to}>`, 'DATA',
      `From: sender@example.org\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${subject}@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.`, 'QUIT'];
    const sock = net.connect(2525, 'localhost');
    let i = 0;
    sock.on('data', (d: Buffer) => { if (/^[45]/m.test(d.toString())) fail(new Error(d.toString())); if (i < lines.length) sock.write(lines[i++] + '\r\n'); });
    sock.on('close', () => ok()); sock.on('error', fail);
  });
}
async function arrived(c: JmapClient, subject: string) {
  for (let i = 0; i < 60; i++) {
    const hit = (await c.threads({ subject }))[0];
    if (hit) return (await c.thread(hit.threadId)).find((m) => m.subject === subject)!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`“${subject}” never arrived`);
}

describe.skipIf(!up)('encryption on the real server', () => {
  it('at rest: mail delivered after turning it on is stored encrypted, and the reader decrypts it', async () => {
    const a = await throwaway();
    const id = await a.c.addPublicKey(a.publicKey, 'OpenMail (test)');
    await a.c.setEncryptionAtRest(id);
    expect((await a.c.encryptionState())).toMatchObject({ atRest: id, keys: [{ id, kind: 'openPgp', fingerprints: [a.fingerprint] }] });

    const subject = `at-rest-${Date.now()}`;
    await deliver(a.email, subject, 'The vault code is 4417.');
    const m = await arrived(a.c, subject);
    const raw = await a.c.rawMessage(m.blobId);
    const text = new TextDecoder().decode(raw);
    expect(text).toMatch(/Content-Type: multipart\/encrypted;\s+protocol="application\/pgp-encrypted"/);
    expect(text).not.toContain('4417');
    // What the reader sees before decrypting: no body, the encrypted part as an attachment (how Reader detects it).
    expect(m.text ?? '').not.toContain('4417');
    expect(m.attachments.some((x) => x.type === 'application/pgp-encrypted' || x.name === 'encrypted.asc')).toBe(true);

    const opened = await openMessage(raw, a.key, []);
    expect(opened).toMatchObject({ encrypted: true, signature: null });
    expect(opened.mail!.text).toContain('The vault code is 4417.');

    await a.c.setEncryptionAtRest(null);
    expect((await a.c.encryptionState()).atRest).toBeNull();
  }, 40_000);

  it('end to end: encrypted + signed PGP/MIME arrives encrypted, opens and verifies; Sent stays readable', async () => {
    const [a, b] = [await throwaway(), await throwaway()];
    store.me.set(a.email, { fingerprint: a.fingerprint, publicKey: a.publicKey, keydata: a.keydata });
    store.unlocked.set(a.email, a.key);
    store.peers.set(b.email, { email: b.email, publicKey: b.publicKey, source: 'wkd', added: '' });
    const boxes = await a.c.mailboxes();
    const subject = `e2e-${Date.now()}`;
    const att = await a.c.upload(Object.assign(new Blob(['plan B'], { type: 'text/plain' }), { name: 'plan.txt' }));
    await a.c.send({ to: [{ name: 'B', email: b.email }], cc: [], subject, html: '<p>Café at <b>noon</b></p>', text: 'Café at noon', attachments: [att], encrypt: true }, boxes);

    const m = await arrived(b.c, subject);
    const raw = await b.c.rawMessage(m.blobId);
    expect(new TextDecoder().decode(raw)).not.toContain('noon');
    expect(m.autocrypt, 'Autocrypt header travels outside the encryption').toBeTruthy();
    const senderKey = await autocryptKey(a.email, m.autocrypt!);
    const opened = await openMessage(raw, b.key, [senderKey!]);
    expect(opened).toMatchObject({ encrypted: true, signature: 'verified', mail: { html: '<p>Café at <b>noon</b></p>', text: 'Café at noon' } });
    expect(opened.mail!.attachments.map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual([['plan.txt', 'plan B']]);

    const sent = boxes.find((x) => x.role === 'sent')!.id;
    let mine;
    for (let i = 0; i < 40 && !mine; i++) { await new Promise((r) => setTimeout(r, 250)); mine = (await a.c.threads({ operator: 'AND', conditions: [{ inMailbox: sent }, { subject }] }))[0]; }
    const copy = (await a.c.thread(mine!.threadId))[0];
    expect((await openMessage(await a.c.rawMessage(copy.blobId), a.key, [a.publicKey])).mail!.text).toBe('Café at noon');
  }, 40_000);

  it('plain mail carries the sender’s key in an Autocrypt header', async () => {
    const [a, b] = [await throwaway(), await throwaway()];
    store.me.set(a.email, { fingerprint: a.fingerprint, publicKey: a.publicKey, keydata: a.keydata });
    const subject = `autocrypt-${Date.now()}`;
    await a.c.send({ to: [{ name: null, email: b.email }], cc: [], subject, html: '<p>hi</p>', text: 'hi', attachments: [] }, await a.c.mailboxes());
    const m = await arrived(b.c, subject);
    const key = await autocryptKey(a.email, m.autocrypt!);
    expect((await describeKey(key!)).fingerprint).toBe(a.fingerprint);
  }, 40_000);
});
