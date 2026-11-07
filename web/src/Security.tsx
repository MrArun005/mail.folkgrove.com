import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Jmap, type AppPassword } from './jmap';
import { stepUp } from './oauth';
import { newSecret, otpauthUrl, verifyTotp } from './totp';

/**
 * Settings → Security. Nothing here works with the everyday session: "Manage security" opens a fresh sign-in
 * (password + code), and the security token it returns lives only in this component's memory.
 */
export function SecuritySection({ username }: { username: string }) {
  const [sec, setSec] = useState<Jmap | null>(null);
  const [state, setState] = useState<{ twoFactor: boolean; appPasswords: AppPassword[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true); setError('');
    try {
      const token = await stepUp(username);
      const c = await Jmap.connect({ header: async () => `Bearer ${token}`, refresh: async () => { throw new Error('expired'); } });
      setSec(c); setState(await c.security());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const reload = async () => sec && setState(await sec.security());

  return (
    // Lives inside the Settings <form>: Enter here must not save and close Settings, and nested forms aren't valid HTML.
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault(); }}>
      <h3>Security</h3>
      {!sec ? <>
        <p className="fine">Two-factor sign-in, app passwords and your password. You’ll be asked to sign in again to change these.</p>
        <Button size="sm" icon="shield" className="start" disabled={busy} onClick={unlock}>{busy ? 'Waiting for sign-in…' : 'Manage security'}</Button>
      </> : state && <>
        <TwoFactor sec={sec} on={state.twoFactor} username={username} onChange={reload} />
        <AppPasswords sec={sec} list={state.appPasswords} onChange={reload} />
        <ChangePassword sec={sec} />
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
    if (!(await verifyTotp(setup!, code))) return setMsg('That code doesn’t match. Check the time on your phone and try the newest code.');
    setBusy(true); setMsg('');
    try { await sec.setTwoFactor(password, otpauthUrl(setup!, username), code.trim()); setSetup(null); setCode(''); setPassword(''); onChange(); }
    catch (e) { setMsg(`Couldn’t turn it on: ${(e as Error).message}. Check your current password.`); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setMsg('');
    try { await sec.setTwoFactor(password, null, code.trim()); setCode(''); setPassword(''); onChange(); }
    catch (e) { setMsg(`Couldn’t turn it off: ${(e as Error).message}. Check your password and code.`); }
    finally { setBusy(false); }
  }

  return (
    <div className="sec-block">
      <div className="sec-head">
        <span><b>Two-factor sign-in</b> <span className={on ? 'pill on' : 'pill'}>{on ? 'On' : 'Off'}</span></span>
        {!on && !setup && <Button size="sm" variant="primary" onClick={() => setSetup(newSecret())}>Turn on</Button>}
      </div>
      {!on && !setup && <p className="fine">Ask for a code from an authenticator app (like Google Authenticator, 1Password or Aegis) when signing in.</p>}
      {setup && (
        <div className="totp-setup">
          <img className="qr" src={qr} alt="QR code for your authenticator app" />
          <div className="steps">
            <p>1. Scan this with your authenticator app, or enter the key: <code className="key">{setup.match(/.{1,4}/g)!.join(' ')}</code></p>
            <label>2. Enter the 6-digit code it shows<input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label>3. Your current password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <div className="actions">
              <Button size="sm" onClick={() => { setSetup(null); setMsg(''); }}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={busy || !code || !password} onClick={enable}>{busy ? 'Turning on…' : 'Turn on two-factor'}</Button>
            </div>
          </div>
        </div>
      )}
      {on && (
        <div className="row2">
          <label>Current code<input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label>Current password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <Button size="sm" className="start" disabled={busy || !code || !password} onClick={disable}>Turn off two-factor</Button>
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
  return (
    <div className="sec-block">
      <div className="sec-head"><b>App passwords</b></div>
      <p className="fine">For mail apps that can’t use two-factor sign-in (Thunderbird, Outlook, a phone’s built-in mail). Each one can be revoked on its own.</p>
      {shown && (
        <p className="banner banner--safe" role="status">
          <span className="grow">Password for <b>{shown.name}</b>: <code className="key">{shown.secret}</code> It won’t be shown again.</span>
          <Button variant="link" onClick={() => navigator.clipboard?.writeText(shown.secret)}>Copy</Button>
        </p>
      )}
      {list.length > 0 && (
        <ul className="rule-list">
          {list.map((a) => (
            <li key={a.id}>
              <span>{a.description}{a.createdAt && <span className="fine"> · added {new Date(a.createdAt).toLocaleDateString()}</span>}</span>
              <Button variant="quiet" size="sm" icon="trash" label={`Revoke ${a.description}`}
                onClick={async () => { if (confirm(`Revoke “${a.description}”? Apps using it will be signed out.`)) { await sec.deleteAppPassword(a.id); onChange(); } }} />
            </li>
          ))}
        </ul>
      )}
      <div className="inline-form">
        <input className="input" placeholder="Name, e.g. Thunderbird on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="md" onClick={async () => {
        if (!name.trim()) return setMsg('Give it a name, like “Thunderbird on my laptop”.');
        try { const secret = await sec.createAppPassword(name.trim()); setShown({ name: name.trim(), secret }); setName(''); setMsg(''); onChange(); }
        catch (err) { setMsg(`Couldn’t create it: ${(err as Error).message}`); }
        }}>Create</Button>
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
      if (next.length < 12) return setMsg({ ok: false, text: 'Use at least 12 characters. A few unrelated words work well.' });
      if (next !== again) return setMsg({ ok: false, text: 'The new passwords don’t match.' });
      try { await sec.changePassword(current, next); setCurrent(''); setNext(''); setAgain(''); setMsg({ ok: true, text: 'Password changed.' }); }
      catch (err) { setMsg({ ok: false, text: `Couldn’t change it: ${(err as Error).message}. Check your current password.` }); }
  }
  return (
    <div className="sec-block">
      <div className="sec-head"><b>Password</b></div>
      <div className="row3">
        <label>Current<input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New<input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label>New, again<input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      </div>
      <Button size="sm" className="start" disabled={!current || !next} onClick={change}>Change password</Button>
      {msg && <p className={msg.ok ? 'fine ok' : 'error'} role="status">{msg.text}</p>}
    </div>
  );
}
