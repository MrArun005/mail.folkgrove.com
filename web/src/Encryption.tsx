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
import { t, type Key } from './i18n';

const pgp = () => import('./pgp');

/** Ask for the passphrase if the key isn't unlocked in this tab yet. False when cancelled or there's no key here. */
export async function ensureUnlocked(user: string): Promise<boolean> {
  if (unlockedKey(user)) return true;
  if (!(await myKey(user))?.wrapped) { await notify(t('encryption.notHere'), t('encryption.notHereBody')); return false; }
  for (;;) {
    const pass = await promptIt({ title: t('encryption.unlockTitle'), body: t('encryption.unlockBody'), label: t('encryption.passphrase'), confirm: t('encryption.unlock'), secret: true });
    if (!pass) return false;
    try { await unlock(user, pass); return true; } catch (e) { await notify((e as Error).message, t('encryption.tryAgain')); }
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
    catch (e) { setMsg(FORBIDDEN.test((e as Error).message) ? t('encryption.forbidden') : (e as Error).message); }
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
    if (pass.length < 12) throw new Error(t('encryption.tooShort'));
    if (pass !== again) throw new Error(t('encryption.mismatch'));
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
    if (!file) throw new Error(t('encryption.chooseFile'));
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
    if (on && !(await confirmIt({ danger: true, confirm: t('encryption.atRestConfirm'), title: t('encryption.atRestTitle'),
      body: t('encryption.atRestBody') + (local?.wrapped ? '' : ' ' + t('encryption.atRestNoKey')) }))) return;
    await run(async () => { await sec.setEncryptionAtRest(on ? keyId! : null); await reload(); })();
  }

  const pw = (label: string, v: string, set: (s: string) => void, auto = 'new-password') =>
    <label>{label}<input className="input" type="password" autoComplete={auto} value={v} onChange={(e) => set(e.target.value)} /></label>;

  return (
    <div className="sec-block">
      <div className="sec-head"><span><b>{t('encryption.title')}</b> {server?.atRest ? <span className="pill on">{t('encryption.storedEncrypted')}</span> : null}</span></div>
      {local || server?.keys.length ? <>
        {(local ? [local.fingerprint] : server!.keys.flatMap((k) => k.fingerprints)).map((f) => {
          const [before, after] = t(local?.wrapped ? 'encryption.keyHere' : local ? 'encryption.keyPublicOnly' : 'encryption.keyNotHere').split('{fp}');
          return <p key={f} className="fine">{before}<code className="key">{f.match(/.{1,4}/g)!.join(' ')}</code>{after}</p>;
        })}
        {!local?.wrapped && !mode && <Button size="sm" className="start" onClick={() => setMode('restore')}>{t('encryption.restoreHere')}</Button>}
        <label className="inline"><input type="checkbox" className="check" checked={!!server?.atRest} disabled={busy || !server?.keys.length} onChange={(e) => atRest(e.target.checked)} />
          {t('encryption.atRestLabel')}</label>
        <p className="fine">{t('encryption.atRestInfo')}</p>
        {local && <p className="fine">{t('encryption.published')}
          {' '}<Button variant="link" onClick={async () => { if (await confirmIt({ danger: true, confirm: t('encryption.removeKey'), title: t('encryption.removeTitle'), body: t('encryption.removeBody') })) { await forgetMyKey(username); reload(); } }}>{t('encryption.removeLink')}</Button></p>}
      </> : !mode && <>
        <p className="fine">{t('encryption.intro')}</p>
        <div className="actions">
          <Button size="sm" variant="primary" onClick={() => setMode('create')}>{t('encryption.create')}</Button>
          <Button size="sm" onClick={() => setMode('restore')}>{t('encryption.restoreBackup')}</Button>
          <Button size="sm" onClick={() => setMode('public')}>{t('encryption.usePublic')}</Button>
        </div>
      </>}

      {mode === 'create' && !made && <>
        <p className="fine">{t('encryption.choosePass')}</p>
        <div className="row2">{pw(t('encryption.passphrase'), pass, setPass)}{pw(t('encryption.passAgain'), again, setAgain)}</div>
        <div className="actions"><Button size="sm" onClick={reset}>{t('common.cancel')}</Button><Button size="sm" variant="primary" disabled={busy || !pass} onClick={create}>{busy ? t('encryption.creating') : t('encryption.createKey')}</Button></div>
      </>}
      {made && <>
        <p className="banner banner--danger" role="alert"><Icon name="lock" size={16} /><span className="grow">{t('encryption.saveBackup')}</span></p>
        <div className="actions">
          <Button size="sm" variant={made.saved ? 'secondary' : 'primary'} icon="download" onClick={download}>{made.saved ? t('encryption.downloadAgain') : t('encryption.downloadBackup')}</Button>
          <Button size="sm" variant={made.saved ? 'primary' : 'secondary'} disabled={!made.saved || busy} onClick={run(() => keep(made.key, pass))}>{busy ? t('encryption.finishing') : t('encryption.finish')}</Button>
        </div>
      </>}
      {mode === 'restore' && <>
        <p className="fine">{t('encryption.restoreInfo')}</p>
        <div className="row2">
          <label>{t('encryption.backupFile')}<input className="input" type="file" accept=".asc,.gpg,.key,.txt,application/pgp-keys,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {pw(t('encryption.passphrase'), pass, setPass, 'current-password')}
        </div>
        <div className="actions"><Button size="sm" onClick={reset}>{t('common.cancel')}</Button><Button size="sm" variant="primary" disabled={busy || !file} onClick={restore}>{busy ? t('encryption.restoring') : t('encryption.restoreKey')}</Button></div>
      </>}
      {mode === 'public' && <>
        <p className="fine">{t('encryption.publicInfo')}</p>
        <textarea className="input key" rows={5} aria-label={t('encryption.publicLabel')} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions"><Button size="sm" onClick={reset}>{t('common.cancel')}</Button><Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={addPublic}>{t('encryption.addKey')}</Button></div>
      </>}
      {msg && <p className="error" role="alert">{msg}</p>}
      <PeopleKeys />
    </div>
  );
}

const fp = (f?: string) => f?.match(/.{1,4}/g)?.join(' ') ?? t('encryption.unknownFp');
const SOURCE: Record<KeySource, Key> = { wkd: 'encryption.fromWkd', autocrypt: 'encryption.fromAutocrypt', attached: 'encryption.fromAttached', imported: 'encryption.fromYou' };
/** The key-conflict warning, split around the new key's fingerprint (shown as code). */
const conflictText = (k: PeerKey) => t('encryption.conflict', { source: t(SOURCE[k.conflict!.source]), email: k.email }).split('{fp}');
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
      setMsg(found.length ? t('encryption.addedKeys', { list: [...new Set(found.map(([e]) => e))].join(', ') }) : t('encryption.noEmail')); setText('');
    } catch { setMsg(t('encryption.notAKey')); }
    reload();
  };
  return <>
    <p className="fine">{t('encryption.peopleKeys')}</p>
    {list.length > 0 && <ul className="rule-list">{list.map((k) => (
      <li key={k.email} className="peer-key">
        <span><b>{k.email}</b> <span className="fine">{t(SOURCE[k.source])}</span><br /><code className="key">{fp(k.fingerprint)}</code>
          {k.conflict && <span className="banner banner--danger" role="alert"><Icon name="shield" size={16} /><span className="grow">
            {conflictText(k)[0]}<code className="key">{fp(k.conflict.fingerprint)}</code>{conflictText(k)[1]}</span>
            <Button variant="link" onClick={async () => { await savePeerKey({ ...k.conflict!, email: k.email }, true); reload(); }}>{t('encryption.useNew')}</Button>
            <Button variant="link" onClick={async () => { await savePeerKey({ ...k, conflict: undefined }, true); reload(); }}>{t('encryption.keepCurrent')}</Button></span>}
        </span>
        <Button variant="quiet" size="sm" icon="trash" label={t('encryption.forget', { email: k.email })} onClick={async () => { await removePeerKey(k.email); reload(); }} />
      </li>))}</ul>}
    <div className="inline-form">
      <input className="input key" aria-label={t('encryption.someonesKey')} placeholder={t('encryption.pastePlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="md" disabled={!text.trim()} onClick={add}>{t('common.add')}</Button>
    </div>
    {msg && <p className="fine" role="status">{msg}</p>}
  </>;
}

// ── Reader ──────────────────────────────────────────────

export type SecureKind = 'encrypted' | 'signed' | 'smime' | null;
export function secureKind(m: EmailFull): SecureKind {
  const types = m.attachments.map((a) => a.type.toLowerCase());
  if (types.includes('application/pgp-encrypted') || m.attachments.some((a) => a.name === 'encrypted.asc')) return 'encrypted';
  if (types.some((x) => /pkcs7-mime/.test(x))) return 'smime';
  return types.includes('application/pgp-signature') ? 'signed' : null;
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
    })().catch((e) => live && setState({ encrypted: kind === 'encrypted', signature: null, mail: null, error: t('encryption.couldntOpen', { error: (e as Error).message }), inline: {} }));
    return () => { live = false; };
  }, [m.id, tick]);
  return { kind, state, keyChanged, retry: () => setTick((n) => n + 1) };
}

/** How the reader labels a message. Green only for a verified signature, or encryption with no signature claim. */
export function securityLabel(encrypted: boolean, sig: Opened['signature'], who: string): { tone: 'safe' | 'info' | 'danger'; text: string } {
  if (sig === 'verified') return { tone: 'safe', text: t(encrypted ? 'encryption.verifiedEncrypted' : 'encryption.verifiedSigned', { who }) };
  if (sig === 'bad') return { tone: 'danger', text: t('encryption.badSignature', { who }) };
  if (sig === 'unknown') return { tone: 'info', text: t(encrypted ? 'encryption.unverifiedEncrypted' : 'encryption.unverifiedSigned', { who }) };
  return { tone: 'safe', text: t('encryption.notSigned') };
}

/** What the reader says about an encrypted or signed message, plus its decrypted (or verified) attachments. */
export function SecureBanner({ me, m, kind, state, keyChanged, retry }: { me: string; m: EmailFull } & ReturnType<typeof useSecureMail>) {
  const who = displayName(m.from?.[0], me);
  const changed = keyChanged && <p className="banner banner--danger" role="alert"><Icon name="shield" size={16} /><span className="grow">{t('encryption.keyChanged', { who })}</span></p>;
  if (kind === 'smime') return <>{changed}<p className="banner banner--info"><Icon name="lock" size={16} /><span className="grow">{t('encryption.smime')}</span></p></>;
  if (!kind || !state) return <>{changed}{kind === 'encrypted' && <p className="banner banner--info"><Icon name="lock" size={16} /><span className="grow">{t('encryption.decrypting')}</span></p>}</>;
  if (state.error) return <>{changed}<p className="banner banner--danger" role="alert"><Icon name="lock" size={16} /><span className="grow">{state.error}</span></p></>;
  if (!state.mail) return <>{changed}
    <p className="banner banner--info"><Icon name="lock" size={16} />
      {state.locked
        ? <><span className="grow">{t('encryption.locked')}</span><Button variant="link" onClick={async () => { if (await ensureUnlocked(me)) retry(); }}>{t('encryption.unlock')}</Button></>
        : <span className="grow">{t('encryption.noKeyHere')}</span>}
    </p></>;
  const label = securityLabel(state.encrypted, state.signature, who);
  const files = state.mail.attachments.filter((f) => !(f.cid && state.inline[f.cid]));
  return <>
    {changed}
    <p className={`banner banner--${label.tone}`} role={label.tone === 'danger' ? 'alert' : undefined}>
      <Icon name={state.encrypted ? 'lock' : 'shield'} size={16} /><span className="grow">{label.text}</span></p>
    {files.length > 0 && <ul className="chips" aria-label={t('encryption.attachments')}>{files.map((f, i) => (
      <li key={i}><button className="chip" title={t('encryption.download', { name: f.name })} onClick={() => saveFile(f)}>
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
    const timer = setTimeout(async () => {
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
    return () => { live = false; clearTimeout(timer); };
  }, [key, me]);
  return { ...state, ready: state.mine && !state.checking && state.missing.length === 0 };
}
