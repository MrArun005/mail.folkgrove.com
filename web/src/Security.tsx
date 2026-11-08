import qrcode from 'qrcode-generator';
import { confirmIt } from './Dialog';
import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Jmap, type AppPassword } from './jmap';
import { stepUp } from './oauth';
import { newSecret, otpauthUrl, verifyTotp } from './totp';
import { EncryptionSection } from './Encryption';
import { locale, t } from './i18n';

/**
 * Settings → Security. Nothing here works with the everyday session: "Manage security" asks for the password
 * (and two-factor code) again, and the security token it returns lives only in this component's memory.
 */
export function SecuritySection({ username }: { username: string }) {
  const [sec, setSec] = useState<Jmap | null>(null);
  const [state, setState] = useState<{ twoFactor: boolean; appPasswords: AppPassword[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState<string | null>(null); // null until the server asks for one

  async function unlock() {
    if (!password) return;
    setBusy(true); setError('');
    try {
      const token = await stepUp(username, password, code ?? undefined);
      if (token === 'code') { setCode(''); return; }
      const c = await Jmap.connect({ header: async () => `Bearer ${token}`, refresh: async () => { throw new Error('expired'); } });
      setPassword(''); setCode(null);
      setSec(c); setState(await c.security());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } };
  const reload = async () => sec && setState(await sec.security());

  return (
    // Lives inside the Settings <form>: Enter here must not save and close Settings, and nested forms aren't valid HTML.
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault(); }}>
      <h3>{t('security.title')}</h3>
      {!sec ? <>
        <p className="fine">{t('security.intro')}</p>
        {!asking
          ? <Button size="sm" icon="shield" className="start" onClick={() => setAsking(true)}>{t('security.manage')}</Button>
          : <div className="row2">
              <label>{t('security.yourPassword')}<input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={enter} /></label>
              {code !== null && <label>{t('security.codeFromApp')}<input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={enter} /></label>}
              <Button size="sm" variant="primary" className="start" disabled={busy || !password || code === ''} onClick={unlock}>{busy ? t('security.checking') : t('security.continue')}</Button>
            </div>}
      </> : state && <>
        <TwoFactor sec={sec} on={state.twoFactor} username={username} onChange={reload} />
        <AppPasswords sec={sec} list={state.appPasswords} onChange={reload} />
        <ChangePassword sec={sec} />
        <EncryptionSection sec={sec} username={username} />
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function TwoFactor({ sec, on, username, onChange }: { sec: Jmap; on: boolean; username: string; onChange: () => void }) {
  const [setup, setSetup] = useState<string | null>(null); // secret while setting up
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Rendered as an image (data: URL), never as injected markup.
  const qr = setup ? (() => { const q = qrcode(0, 'M'); q.addData(otpauthUrl(setup, username)); q.make(); return q.createDataURL(5, 2); })() : '';

  async function enable() {
    if (!(await verifyTotp(setup!, code))) return setMsg(t('security.codeWrong'));
    setBusy(true); setMsg('');
    try { await sec.setTwoFactor(password, otpauthUrl(setup!, username), code.trim()); setSetup(null); setCode(''); setPassword(''); onChange(); }
    catch (e) { setMsg(t('security.couldntTurnOn', { error: (e as Error).message })); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setMsg('');
    try { await sec.setTwoFactor(password, null, code.trim()); setCode(''); setPassword(''); onChange(); }
    catch (e) { setMsg(t('security.couldntTurnOff', { error: (e as Error).message })); }
    finally { setBusy(false); }
  }

  return (
    <div className="sec-block">
      <div className="sec-head">
        <span><b>{t('security.twoFactor')}</b> <span className={on ? 'pill on' : 'pill'}>{on ? t('common.on') : t('common.off')}</span></span>
        {!on && !setup && <Button size="sm" variant="primary" onClick={() => setSetup(newSecret())}>{t('security.turnOn')}</Button>}
      </div>
      {!on && !setup && <p className="fine">{t('security.twoFactorNote')}</p>}
      {setup && (
        <div className="totp-setup">
          <img className="qr" src={qr} alt={t('security.qr')} />
          <div className="steps">
            <p>{t('security.step1')} <code className="key">{setup.match(/.{1,4}/g)!.join(' ')}</code></p>
            <label>{t('security.step2')}<input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label>{t('security.step3')}<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <div className="actions">
              <Button size="sm" onClick={() => { setSetup(null); setMsg(''); }}>{t('common.cancel')}</Button>
              <Button size="sm" variant="primary" disabled={busy || !code || !password} onClick={enable}>{busy ? t('security.turningOn') : t('security.turnOnTwoFactor')}</Button>
            </div>
          </div>
        </div>
      )}
      {on && (
        <div className="row2">
          <label>{t('security.currentCode')}<input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label>{t('security.currentPassword')}<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <Button size="sm" className="start" disabled={busy || !code || !password} onClick={disable}>{t('security.turnOffTwoFactor')}</Button>
        </div>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}

function AppPasswords({ sec, list, onChange }: { sec: Jmap; list: AppPassword[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [shown, setShown] = useState<{ name: string; secret: string } | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => () => setShown(null), []);
  const forName = t('security.passwordFor', { name: '\0' }).split('\0'); // the name goes in bold, wherever the language puts it
  return (
    <div className="sec-block">
      <div className="sec-head"><b>{t('security.appPasswords')}</b></div>
      <p className="fine">{t('security.appPasswordsNote')}</p>
      {shown && (
        <p className="banner banner--safe" role="status">
          <span className="grow">{forName[0]}<b>{shown.name}</b>{forName[1]} <code className="key">{shown.secret}</code> {t('security.notAgain')}</span>
          <Button variant="link" onClick={() => navigator.clipboard?.writeText(shown.secret)}>{t('common.copy')}</Button>
        </p>
      )}
      {list.length > 0 && (
        <ul className="rule-list">
          {list.map((a) => (
            <li key={a.id}>
              <span>{a.description}{a.createdAt && <span className="fine"> · {t('security.added', { date: new Date(a.createdAt).toLocaleDateString(locale()) })}</span>}</span>
              <Button variant="quiet" size="sm" icon="trash" label={t('security.revoke', { name: a.description })}
                onClick={async () => { if (await confirmIt({ title: t('security.revokeTitle', { name: a.description }), body: t('security.revokeBody'), confirm: t('security.revokeConfirm'), danger: true })) { await sec.deleteAppPassword(a.id); onChange(); } }} />
            </li>
          ))}
        </ul>
      )}
      <div className="inline-form">
        <input className="input" placeholder={t('security.appNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="md" onClick={async () => {
        if (!name.trim()) return setMsg(t('security.appNameNeeded'));
        try { const secret = await sec.createAppPassword(name.trim()); setShown({ name: name.trim(), secret }); setName(''); setMsg(''); onChange(); }
        catch (err) { setMsg(t('security.couldntCreate', { error: (err as Error).message })); }
        }}>{t('security.create')}</Button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}

function ChangePassword({ sec }: { sec: Jmap }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function change() {
      if (next.length < 12) return setMsg({ ok: false, text: t('security.tooShort') });
      if (next !== again) return setMsg({ ok: false, text: t('security.noMatch') });
      try { await sec.changePassword(current, next); setCurrent(''); setNext(''); setAgain(''); setMsg({ ok: true, text: t('security.changed') }); }
      catch (err) { setMsg({ ok: false, text: t('security.couldntChange', { error: (err as Error).message }) }); }
  }
  return (
    <div className="sec-block">
      <div className="sec-head"><b>{t('security.password')}</b></div>
      <div className="row3">
        <label>{t('security.current')}<input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>{t('security.new')}<input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label>{t('security.again')}<input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      </div>
      <Button size="sm" className="start" disabled={!current || !next} onClick={change}>{t('security.changePassword')}</Button>
      {msg && <p className={msg.ok ? 'fine ok' : 'error'} role="status">{msg.text}</p>}
    </div>
  );
}
