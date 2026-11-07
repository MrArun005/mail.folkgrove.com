// Encryption in the app: Settings → Security (your key, encryption at rest, people's keys), the reader (decrypt,
// verify, learn senders' keys) and compose (find recipients' keys). The OpenPGP library (pgp.ts) loads only when used.
import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import { Icon } from './icons';
import type { Attachment, EmailFull, Jmap } from './jmap';
import { forgetMyKey, keepUnlocked, myKey, peerKey, peerKeys, removePeerKey, saveMyKey, savePeerKey, senderAuthenticated, unlock, unlockedKey, wrap, type KeySource, type MyKey, type PeerKey } from './keys';
import { displayName, fileSize, parseAddresses } from './mailutil';
import type { MailFile, Opened } from './pgp';

const pgp = () => import('./pgp');

/** Ask for the passphrase if the key isn't unlocked in this tab yet. False when cancelled or there's no key here. */
export async function ensureUnlocked(user: string): Promise<boolean> {
  if (unlockedKey(user)) return true;
  if (!(await myKey(user))?.wrapped) { await notify('Your key isn’t in this browser', 'Restore your key backup in Settings → Security, then try again.'); return false; }
  for (;;) {
    const pass = await promptIt({ title: 'Unlock your key', body: 'Your passphrase unlocks it until you close this tab.', label: 'Passphrase', confirm: 'Unlock', secret: true });
    if (!pass) return false;
    try { await unlock(user, pass); return true; } catch (e) { await notify((e as Error).message, 'Check it and try again.'); }
  }
}

// ── Settings → Security ─────────────────────────────────

const FORBIDDEN = /forbidden|not authori[sz]ed/i;

export function EncryptionSection({ sec, username }: { sec: Jmap; username: string }) {
  const [server, setServer] = useState<Awaited<ReturnType<Jmap['encryptionState']>> | null>(null);
  const [local, setLocal] = useState<MyKey | null>(null);
  const [mode, setMode] = useState<'create' | 'restore' | 'public' | null>(null);
  const [pass, setPass] = useState(''), [again, setAgain] = useState(''), [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [made, setMade] = useState<{ key: string; backup: string; saved: boolean } | null>(null); // created, not yet stored
  const [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);

  const reload = async () => {
    setLocal((await myKey(username)) ?? null);
    try { setServer(await sec.encryptionState()); }
    catch (e) { setMsg(FORBIDDEN.test((e as Error).message) ? 'This server’s webmail can’t manage encryption yet. Your administrator needs to re-run the installer (it allows the “settings” permission); then sign in here again.' : (e as Error).message); }
  };
  useEffect(() => { reload(); }, []);
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setMsg('');
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const published = server?.keys.find((k) => local && k.fingerprints.includes(local.fingerprint));
  const reset = () => { setMode(null); setPass(''); setAgain(''); setText(''); setFile(null); setMade(null); };

  /** Keep the unlocked key in this browser (wrapped with the passphrase) and publish its public half. */
  async function keep(armoredPrivate: string, passphrase: string) {
    const d = await (await pgp()).describeKey(armoredPrivate);
    await saveMyKey(username, { fingerprint: d.fingerprint, publicKey: d.publicKey, keydata: d.keydata, wrapped: await wrap(armoredPrivate, passphrase) });
    keepUnlocked(username, armoredPrivate);
    if (!server?.keys.some((k) => k.fingerprints.includes(d.fingerprint))) await sec.addPublicKey(d.publicKey, 'OpenMail web');
    reset(); await reload();
  }
  const create = run(async () => {
    if (pass.length < 12) throw new Error('Use at least 12 characters. A few unrelated words work well.');
    if (pass !== again) throw new Error('The passphrases don’t match.');
    const p = await pgp(), key = await p.createKey('', username);
    setMade({ key, backup: await p.backupKey(key, pass), saved: false });
  });
  const download = () => {
    const url = URL.createObjectURL(new Blob([made!.backup], { type: 'application/pgp-keys' }));
    Object.assign(document.createElement('a'), { href: url, download: `openmail-key-${username.replace(/[^\w.@-]/g, '_')}.asc` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMade({ ...made!, saved: true });
  };
  const restore = run(async () => {
    if (!file) throw new Error('Choose your backup file first.');
    const key = await (await pgp()).restoreKey(await file.text(), pass);
    await keep(key, pass);
  });
  const addPublic = run(async () => {
    await sec.addPublicKey(text.trim(), 'Added by you');
    // An OpenPGP key also goes out with your mail (Autocrypt). An S/MIME certificate only serves encryption at rest.
    const d = await (await pgp()).describeKey(text.trim()).catch(() => null);
    if (d && !d.isPrivate) await saveMyKey(username, { fingerprint: d.fingerprint, publicKey: d.publicKey, keydata: d.keydata });
    reset(); await reload();
  });
  async function atRest(on: boolean) {
    const keyId = published?.id ?? server?.keys[0]?.id;
    if (on && !(await confirmIt({ danger: true, confirm: 'Encrypt stored mail', title: 'Encrypt stored mail?',
      body: `New mail will be stored so that only your key can open it. If you lose your key and its backup, that mail is gone for good: nobody can recover it, including us. Search won’t find words inside encrypted messages. Mail you already have stays as it is.${local?.wrapped ? '' : ' This browser doesn’t hold your private key, so you’ll read new mail only in an app that does.'}` }))) return;
    await run(async () => { await sec.setEncryptionAtRest(on ? keyId! : null); await reload(); })();
  }

  const pw = (label: string, v: string, set: (s: string) => void, auto = 'new-password') =>
    <label>{label}<input className="input" type="password" autoComplete={auto} value={v} onChange={(e) => set(e.target.value)} /></label>;

  return (
    <div className="sec-block">
      <div className="sec-head"><span><b>Encryption</b> {server?.atRest ? <span className="pill on">Stored mail encrypted</span> : null}</span></div>
      {local || server?.keys.length ? <>
        {(local ? [local.fingerprint] : server!.keys.flatMap((k) => k.fingerprints)).map((f) => (
          <p key={f} className="fine">Your key <code className="key">{f.match(/.{1,4}/g)!.join(' ')}</code>
            {local?.wrapped ? ' · in this browser' : local ? ' · public key only (the private key is in your other app)' : ' · not in this browser'}</p>
        ))}
        {!local?.wrapped && !mode && <Button size="sm" className="start" onClick={() => setMode('restore')}>Restore my key in this browser</Button>}
        <label className="inline"><input type="checkbox" className="check" checked={!!server?.atRest} disabled={busy || !server?.keys.length} onChange={(e) => atRest(e.target.checked)} />
          Encrypt stored mail</label>
        <p className="fine">New mail is stored encrypted to your key, so someone who gets hold of the server’s disks or backups can’t read it. It’s opened here, on your device. Search can’t see inside encrypted messages.</p>
        {local && <p className="fine">People can find your public key (WKD) and it goes out with your mail (Autocrypt), so they can write to you encrypted.
          {' '}<Button variant="link" onClick={async () => { if (await confirmIt({ danger: true, confirm: 'Remove key', title: 'Remove your key from this browser?', body: 'You’ll need your backup file and passphrase to read encrypted mail here again.' })) { await forgetMyKey(username); reload(); } }}>Remove it from this browser</Button></p>}
      </> : !mode && <>
        <p className="fine">One key lets you encrypt the mail stored on the server and send and receive end-to-end encrypted mail (OpenPGP: works with Proton, Thunderbird and GnuPG). Your private key stays in this browser, locked with a passphrase.</p>
        <div className="actions">
          <Button size="sm" variant="primary" onClick={() => setMode('create')}>Create a key</Button>
          <Button size="sm" onClick={() => setMode('restore')}>Restore from backup</Button>
          <Button size="sm" onClick={() => setMode('public')}>Use my own public key</Button>
        </div>
      </>}

      {mode === 'create' && !made && <>
        <p className="fine">Choose a passphrase. It locks your key in this browser and its backup file. We never see it and can’t reset it.</p>
        <div className="row2">{pw('Passphrase', pass, setPass)}{pw('Passphrase, again', again, setAgain)}</div>
        <div className="actions"><Button size="sm" onClick={reset}>Cancel</Button><Button size="sm" variant="primary" disabled={busy || !pass} onClick={create}>{busy ? 'Creating…' : 'Create key'}</Button></div>
      </>}
      {made && <>
        <p className="banner banner--danger" role="alert"><Icon name="lock" size={16} /><span className="grow">Save your backup file before you go on. Without it and your passphrase, encrypted mail can’t be opened by anyone, including us. Keep it somewhere other than this computer.</span></p>
        <div className="actions">
          <Button size="sm" variant={made.saved ? 'secondary' : 'primary'} icon="download" onClick={download}>{made.saved ? 'Download again' : 'Download backup'}</Button>
          <Button size="sm" variant={made.saved ? 'primary' : 'secondary'} disabled={!made.saved || busy} onClick={run(() => keep(made.key, pass))}>{busy ? 'Finishing…' : 'Finish setup'}</Button>
        </div>
      </>}
      {mode === 'restore' && <>
        <p className="fine">Your backup file (.asc) and its passphrase. A key exported from GnuPG, Thunderbird or Proton works too.</p>
        <div className="row2">
          <label>Backup file<input className="input" type="file" accept=".asc,.gpg,.key,.txt,application/pgp-keys,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {pw('Passphrase', pass, setPass, 'current-password')}
        </div>
        <div className="actions"><Button size="sm" onClick={reset}>Cancel</Button><Button size="sm" variant="primary" disabled={busy || !file} onClick={restore}>{busy ? 'Restoring…' : 'Restore key'}</Button></div>
      </>}
      {mode === 'public' && <>
        <p className="fine">Paste your OpenPGP public key or S/MIME certificate. Your private key stays in your other app, so encrypted mail opens there, not here.</p>
        <textarea className="input key" rows={5} aria-label="Public key or certificate" placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions"><Button size="sm" onClick={reset}>Cancel</Button><Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={addPublic}>Add key</Button></div>
      </>}
      {msg && <p className="error" role="alert">{msg}</p>}
      <PeopleKeys />
    </div>
  );
}

const fp = (f?: string) => f?.match(/.{1,4}/g)?.join(' ') ?? 'unknown fingerprint';
const SOURCE: Record<KeySource, string> = { wkd: 'from their mail service (WKD)', autocrypt: 'from their mail (Autocrypt)', attached: 'attached to their mail', imported: 'added by you' };
/** A key with its fingerprint, ready to store. */
async function peer(email: string, publicKey: string, source: KeySource): Promise<PeerKey> {
  return { email, publicKey, source, fingerprint: (await (await pgp()).describeKey(publicKey)).fingerprint, added: new Date().toISOString() };
}

/** People's keys: where each came from, its fingerprint, and any key that changed (you decide which one to trust). */
function PeopleKeys() {
  const [list, setList] = useState<PeerKey[]>([]);
  const [text, setText] = useState(''), [msg, setMsg] = useState('');
  const reload = () => peerKeys().then(setList);
  useEffect(() => { reload(); }, []);
  const add = async () => {
    try {
      const found = await (await pgp()).readPublicKeys(text);
      for (const [email, publicKey] of found) await savePeerKey(await peer(email, publicKey, 'imported'));
      setMsg(found.length ? `Added keys for ${[...new Set(found.map(([e]) => e))].join(', ')}.` : 'That key has no email address in it.'); setText('');
    } catch { setMsg('That doesn’t look like an OpenPGP public key.'); }
    reload();
  };
  return <>
    <p className="fine">People’s keys</p>
    {list.length > 0 && <ul className="rule-list">{list.map((k) => (
      <li key={k.email} className="peer-key">
        <span><b>{k.email}</b> <span className="fine">{SOURCE[k.source]}</span><br /><code className="key">{fp(k.fingerprint)}</code>
          {k.conflict && <span className="banner banner--danger" role="alert"><Icon name="shield" size={16} /><span className="grow">
            A different key turned up {SOURCE[k.conflict.source]}: <code className="key">{fp(k.conflict.fingerprint)}</code>. Someone may be pretending to be {k.email}. Encrypted mail to them is paused until you choose. Check with them another way.</span>
            <Button variant="link" onClick={async () => { await savePeerKey({ ...k.conflict!, email: k.email }, true); reload(); }}>Use the new key</Button>
            <Button variant="link" onClick={async () => { await savePeerKey({ ...k, conflict: undefined }, true); reload(); }}>Keep the current one</Button></span>}
        </span>
        <Button variant="quiet" size="sm" icon="trash" label={`Forget ${k.email}’s key`} onClick={async () => { await removePeerKey(k.email); reload(); }} />
      </li>))}</ul>}
    <div className="inline-form">
      <input className="input key" aria-label="Someone’s public key" placeholder="Paste someone’s public key (-----BEGIN PGP PUBLIC KEY BLOCK-----…)" value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="md" disabled={!text.trim()} onClick={add}>Add</Button>
    </div>
    {msg && <p className="fine" role="status">{msg}</p>}
  </>;
}

// ── Reader ──────────────────────────────────────────────

export type SecureKind = 'encrypted' | 'signed' | 'smime' | null;
export function secureKind(m: EmailFull): SecureKind {
  const t = m.attachments.map((a) => a.type.toLowerCase());
  if (t.includes('application/pgp-encrypted') || m.attachments.some((a) => a.name === 'encrypted.asc')) return 'encrypted';
  if (t.some((x) => /pkcs7-mime/.test(x))) return 'smime';
  return t.includes('application/pgp-signature') ? 'signed' : null;
}

/** Learn a sender's key from their Autocrypt header or an attached key, but only from mail whose sender the server
 *  authenticated (DMARC / aligned DKIM) and that isn't junk: a forged From must not plant a key. A key that differs
 *  from the one we have is kept aside as a conflict, never swapped in. */
async function learnKeys(client: Jmap, m: EmailFull, me: string, inJunk: boolean) {
  const from = m.from?.[0]?.email;
  const att = m.attachments.find((a) => a.type.toLowerCase() === 'application/pgp-keys' && a.size < 100_000);
  if (!from || (!m.autocrypt && !att) || inJunk || m.keywords.$junk || from.toLowerCase() === me.toLowerCase()) return;
  const own = me.split('@')[1] ?? '', ar = m.authResults?.[0], received = m.received ?? null;
  if (!senderAuthenticated(from, ar, own, { received })) return;
  const p = await pgp();
  // An Autocrypt header counts only when the sender's DKIM signature covers it (an attached key is in the signed body).
  const autocryptOk = !!m.autocrypt && senderAuthenticated(from, ar, own, { received, dkim: m.dkim, needHeader: 'autocrypt' });
  let key = autocryptOk ? await p.autocryptKey(from, m.autocrypt!) : null, source: KeySource = 'autocrypt';
  if (!key && att) { key = (await p.readPublicKeys(await (await client.download(att)).text()).catch(() => [])).find(([e]) => e === from.toLowerCase())?.[1] ?? null; source = 'attached'; }
  if (key) await savePeerKey(await peer(from, key, source));
}

/** Decrypts and verifies a message on this device. `inline` maps Content-ID → data: URL for embedded images.
 *  keyChanged: a different key turned up for this sender (see Settings). */
export function useSecureMail(client: Jmap, m: EmailFull, me: string, inJunk = false) {
  const kind = secureKind(m);
  const [state, setState] = useState<(Opened & { locked?: boolean; inline: Record<string, string> }) | null>(null);
  const [keyChanged, setKeyChanged] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState(null); setKeyChanged(false);
    (async () => {
      await learnKeys(client, m, me, inJunk).catch(() => {});
      const sender = m.from?.[0]?.email ?? '', theirs = await peerKey(sender);
      if (live) setKeyChanged(!!theirs?.conflict);
      if (kind !== 'encrypted' && kind !== 'signed') return;
      const mine = await myKey(me), priv = unlockedKey(me);
      if (kind === 'encrypted' && !priv) return live && setState({ encrypted: true, signature: null, mail: null, locked: !!mine?.wrapped, inline: {} });
      const known = sender.toLowerCase() === me.toLowerCase() ? mine?.publicKey : theirs?.publicKey;
      const p = await pgp(), opened = await p.openMessage(await client.rawMessage(m.blobId), priv, known ? [known] : []);
      // Embedded images as data: URLs (the message frame's CSP allows only those); raster types only, never SVG.
      const inline = Object.fromEntries((opened.mail?.attachments ?? []).filter((f) => f.cid && /^image\/(png|jpe?g|gif|webp)$/i.test(f.type))
        .map((f) => [f.cid!, `data:${f.type};base64,${btoa(p.bin(f.data))}`]));
      if (live) setState({ ...opened, inline });
    })().catch((e) => live && setState({ encrypted: kind === 'encrypted', signature: null, mail: null, error: `Couldn’t open it: ${(e as Error).message}`, inline: {} }));
    return () => { live = false; };
  }, [m.id, tick]);
  return { kind, state, keyChanged, retry: () => setTick((t) => t + 1) };
}

/** How the reader labels a message. Green only for a verified signature, or encryption with no signature claim. */
export function securityLabel(encrypted: boolean, sig: Opened['signature'], who: string): { tone: 'safe' | 'info' | 'danger'; text: string } {
  const what = encrypted ? 'Encrypted' : 'Signed';
  const tail = encrypted ? ' Search can’t see inside it.' : '';
  if (sig === 'verified') return { tone: 'safe', text: `${what} · Verified: signed by ${who}’s key.${tail}` };
  if (sig === 'bad') return { tone: 'danger', text: `The signature doesn’t match. This message was changed on the way, or isn’t really from ${who}. Don’t trust what it asks you to do.` };
  if (sig === 'unknown') return { tone: 'info', text: `${encrypted ? 'Encrypted · signature' : 'Signature'} unverified: we don’t have ${who}’s key to check it, so we can’t say who wrote this.${tail}` };
  return { tone: 'safe', text: `Encrypted · not signed.${tail}` };
}

/** What the reader says about an encrypted or signed message, plus its decrypted (or verified) attachments. */
export function SecureBanner({ me, m, kind, state, keyChanged, retry }: { me: string; m: EmailFull } & ReturnType<typeof useSecureMail>) {
  const who = displayName(m.from?.[0], me);
  const changed = keyChanged && <p className="banner banner--danger" role="alert"><Icon name="shield" size={16} /><span className="grow">{who}’s key has changed. It may be a new device, or someone pretending to be them. Check in Settings → Security before sending them anything private.</span></p>;
  if (kind === 'smime') return <>{changed}<p className="banner banner--info"><Icon name="lock" size={16} /><span className="grow">This message is encrypted with S/MIME. Open it in a mail app that has your certificate (Apple Mail, Outlook or Thunderbird).</span></p></>;
  if (!kind || !state) return <>{changed}{kind === 'encrypted' && <p className="banner banner--info"><Icon name="lock" size={16} /><span className="grow">Decrypting on this device…</span></p>}</>;
  if (state.error) return <>{changed}<p className="banner banner--danger" role="alert"><Icon name="lock" size={16} /><span className="grow">{state.error}</span></p></>;
  if (!state.mail) return <>{changed}
    <p className="banner banner--info"><Icon name="lock" size={16} />
      {state.locked
        ? <><span className="grow">This message is encrypted. Unlock your key to read it here.</span><Button variant="link" onClick={async () => { if (await ensureUnlocked(me)) retry(); }}>Unlock</Button></>
        : <span className="grow">This message is encrypted to your key, which isn’t in this browser. Restore your key backup in Settings → Security to read it here.</span>}
    </p></>;
  const label = securityLabel(state.encrypted, state.signature, who);
  const files = state.mail.attachments.filter((f) => !(f.cid && state.inline[f.cid]));
  return <>
    {changed}
    <p className={`banner banner--${label.tone}`} role={label.tone === 'danger' ? 'alert' : undefined}>
      <Icon name={state.encrypted ? 'lock' : 'shield'} size={16} /><span className="grow">{label.text}</span></p>
    {files.length > 0 && <ul className="chips" aria-label="Attachments">{files.map((f, i) => (
      <li key={i}><button className="chip" title={`Download ${f.name}`} onClick={() => saveFile(f)}>
        <Icon name="file" size={16} /><span className="fname">{f.name}</span><span className="fsize">{fileSize(f.data.length)}</span><Icon name="download" size={16} />
      </button></li>))}</ul>}
  </>;
}
function saveFile(f: MailFile) {
  // Always a download (application/octet-stream): never opened in this origin, whatever the sender called it.
  const url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'application/octet-stream' }));
  Object.assign(document.createElement('a'), { href: url, download: f.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
/** Parts of an encrypted message that are the encryption itself, not files to show. */
export const isCryptoPart = (a: Attachment) => /^application\/(pgp-encrypted|pgp-signature|pkcs7-signature|x-pkcs7-signature)$/i.test(a.type) || a.name === 'encrypted.asc';

// ── Compose ─────────────────────────────────────────────

const wkdSeen = new Map<string, Promise<string | null>>(); // this tab: look each address up once
/** Can we encrypt to everyone on the message? Looks keys up as recipients are typed: known keys, then WKD. */
export function useRecipientKeys(fields: string[], me: string) {
  const [state, setState] = useState<{ mine: boolean; missing: string[]; checking: boolean }>({ mine: false, missing: [], checking: false });
  const key = fields.join('\n');
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const mine = !!(await myKey(me))?.wrapped;
      if (!mine) return live && setState({ mine, missing: [], checking: false });
      const people = [...new Set(fields.flatMap((f) => parseAddresses(f).list.map((a) => a.email.toLowerCase())))];
      if (live) setState((s) => ({ ...s, mine, checking: true }));
      const have = await Promise.all(people.map(async (email) => {
        const known = await peerKey(email);
        // Keys learned from mail are checked against the domain's WKD: a different key there is a conflict to resolve.
        if (known && (known.source === 'imported' || known.source === 'wkd')) return !known.conflict;
        if (!wkdSeen.has(email)) wkdSeen.set(email, pgp().then((p) => p.wkdLookup(email, me.split('@')[1])));
        const k = await wkdSeen.get(email)!;
        const now = k ? await savePeerKey(await peer(email, k, 'wkd')) : known;
        return !!now && !now.conflict;
      }));
      if (live) setState({ mine, missing: people.filter((_, i) => !have[i]), checking: false });
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [key, me]);
  return { ...state, ready: state.mine && !state.checking && state.missing.length === 0 };
}
