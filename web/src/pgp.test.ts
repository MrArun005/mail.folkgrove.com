import { describe, expect, it } from 'vitest';
import * as openpgp from 'openpgp';
import { autocryptHeader, mergePeerKey, senderAuthenticated, unwrap, wkdHash, wkdUrls, wrap, type PeerKey } from './keys';
import { securityLabel } from './Encryption';
import { autocryptKey, backupKey, bytes, createKey, describeKey, encryptedMessage, openMessage, parseMime, restoreKey } from './pgp';

const enc = (s: string) => new TextEncoder().encode(s);

describe('WKD', () => {
  it('hashes the local part like the spec example (z-base-32 of SHA-1, A-Z lowercased)', async () => {
    expect(await wkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(await wkdUrls('Joe.Doe@Example.ORG')).toEqual([
      'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    ]);
  });
});

describe('passphrase wrapping', () => {
  it('round-trips and refuses a wrong passphrase', async () => {
    const w = await wrap('secret key text', 'correct horse battery');
    expect(await unwrap(w, 'correct horse battery')).toBe('secret key text');
    await expect(unwrap(w, 'wrong')).rejects.toThrow('passphrase');
  }, 20_000);
});

describe('PGP/MIME', () => {
  it('encrypts + signs, then decrypts and verifies; a tampered message fails', async () => {
    const alice = await createKey('Alice', 'alice@example.org'), bob = await createKey('', 'bob@example.org');
    const [a, b] = await Promise.all([describeKey(alice), describeKey(bob)]);
    const raw = await encryptedMessage({
      from: { name: 'Alice', email: 'alice@example.org' }, to: [{ email: 'bob@example.org' }], cc: [], subject: 'Plans ✓',
      html: '<p>Meet at <b>noon</b></p>', text: 'Meet at noon', files: [{ name: 'notes.txt', type: 'text/plain', data: enc('café'), cid: null }],
      autocrypt: autocryptHeader('alice@example.org', a.keydata),
    }, alice, [b.publicKey, a.publicKey]);
    expect(raw).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/m);
    expect(raw).not.toContain('noon');

    const opened = await openMessage(bytes(raw), bob, [a.publicKey]);
    expect(opened).toMatchObject({ encrypted: true, signature: 'verified' });
    expect(opened.mail!.html).toBe('<p>Meet at <b>noon</b></p>');
    expect(opened.mail!.text).toBe('Meet at noon');
    expect(opened.mail!.attachments.map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual([['notes.txt', 'café']]);
    // Alice can read her own Sent copy; without the sender's key the signature is "unknown"; a stranger's key can't decrypt.
    expect((await openMessage(bytes(raw), alice, [])).signature).toBe('unknown');
    expect((await openMessage(bytes(raw), await createKey('', 'eve@example.org'), [])).error).toMatch(/different key/);
    // Bob learns Alice's key from the Autocrypt header.
    const header = parseMime(raw).headers.autocrypt;
    expect(await autocryptKey('alice@example.org', header)).toBeTruthy();
    expect(await autocryptKey('mallory@example.org', header)).toBeNull();
  }, 30_000);

  it('verifies multipart/signed (detached signature over the exact first part)', async () => {
    const key = await createKey('', 'carol@example.org'), { publicKey } = await describeKey(key);
    const part = 'Content-Type: text/plain; charset=utf-8\r\n\r\nSigned words.'; // the CRLF before "--b" isn't signed
    const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: enc(part) }), signingKeys: await openpgp.readPrivateKey({ armoredKey: key }), detached: true });
    const mail = (body: string) => bytes(['From: carol@example.org', 'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="b"', '',
      '--b', body, '--b', 'Content-Type: application/pgp-signature', '', sig, '--b--', ''].join('\r\n'));
    expect(await openMessage(mail(part), undefined, [publicKey])).toMatchObject({ encrypted: false, signature: 'verified', mail: { text: 'Signed words.' } });
    expect((await openMessage(mail(part.replace('Signed', 'Forged')), undefined, [publicKey])).signature).toBe('bad');
    expect((await openMessage(mail(part), undefined, [])).signature).toBe('unknown');
    // An extra, unsigned part slipped into multipart/signed: flagged, and only the signed part is shown.
    const extra = bytes(new TextDecoder().decode(mail(part)).replace('--b--', '--b\r\nContent-Type: text/plain\r\n\r\nWire the money today.\r\n--b--'));
    const sneaky = await openMessage(extra, undefined, [publicKey]);
    expect(sneaky.signature).toBe('bad');
    expect(sneaky.mail!.text).toBe('Signed words.');
  }, 30_000);

  it('backup file is a passphrase-locked OpenPGP key that restores to the same key', async () => {
    const key = await createKey('', 'dan@example.org');
    const backup = await backupKey(key, 'long enough passphrase');
    expect(backup).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    expect((await openpgp.readPrivateKey({ armoredKey: backup })).isDecrypted()).toBe(false);
    await expect(restoreKey(backup, 'nope')).rejects.toThrow('passphrase');
    expect((await describeKey(await restoreKey(backup, 'long enough passphrase'))).fingerprint).toBe((await describeKey(key)).fingerprint);
  }, 30_000);
});

describe('learning keys safely', () => {
  const k = (fingerprint: string, source: PeerKey['source'] = 'autocrypt'): PeerKey => ({ email: 'Ann@Example.org', publicKey: `key ${fingerprint}`, fingerprint, source, added: '' });
  it('keeps the first key; a different one is held as a conflict, never swapped in silently', () => {
    const first = mergePeerKey(undefined, k('AAA'));
    expect(first).toMatchObject({ email: 'ann@example.org', fingerprint: 'AAA' });
    expect(mergePeerKey(first, k('AAA'))).toBe(first);
    const clash = mergePeerKey(first, k('BBB', 'wkd'));
    expect(clash).toMatchObject({ fingerprint: 'AAA', conflict: { fingerprint: 'BBB', source: 'wkd' } });
    expect(mergePeerKey(clash, k('CCC', 'imported'))).toEqual({ ...k('CCC', 'imported'), email: 'ann@example.org' }); // your own choice wins
  });

  it('learns only from mail the server authenticated for the From domain', () => {
    const ar = (s: string) => `mx.ours.test; spf=pass smtp.mailfrom=x@evil.test; ${s}`;
    expect(senderAuthenticated('ann@example.org', ar('dmarc=pass (p=reject) header.from=example.org'), 'ours.test')).toBe(true);
    expect(senderAuthenticated('ann@example.org', ar('dkim=pass header.d=example.org header.s=s1'), 'ours.test')).toBe(true);
    expect(senderAuthenticated('ann@mail.example.org', ar('dkim=pass header.d=example.org'), 'ours.test')).toBe(true); // relaxed alignment
    expect(senderAuthenticated('ann@example.org', ar('dkim=pass header.d=evil.test; dmarc=fail header.from=example.org'), 'ours.test')).toBe(false);
    expect(senderAuthenticated('ann@example.org', ar('dmarc=pass header.from=evil.test'), 'ours.test')).toBe(false);
    expect(senderAuthenticated('ann@example.org', 'mx.ours.test; dkim=fail (dkim=pass header.d=example.org) header.d=example.org', 'ours.test')).toBe(false); // comments don't count
    expect(senderAuthenticated('ann@example.org', null, 'ours.test')).toBe(false); // outside mail always has the server's header
    expect(senderAuthenticated('bo@ours.test', null, 'ours.test')).toBe(true); // between accounts here: authenticated at submission
  });

  it('green only for a verified signature; unverified is neutral, a bad one red', () => {
    expect(securityLabel(false, 'verified', 'Ann').tone).toBe('safe');
    expect(securityLabel(false, 'unknown', 'Ann')).toMatchObject({ tone: 'info', text: expect.stringContaining('unverified') });
    expect(securityLabel(true, 'unknown', 'Ann').tone).toBe('info');
    expect(securityLabel(false, 'bad', 'Ann').tone).toBe('danger');
    expect(securityLabel(true, null, 'Ann')).toMatchObject({ tone: 'safe', text: expect.stringContaining('not signed') });
  });
});
