import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Jmap, JmapError, SESSION_EXPIRED } from './jmap';
import { Mail } from './Mail';
import { Admin } from './Admin';
import { DialogHost } from './Dialog';
import { signOutPush } from './notify';
import { offlineStore } from './offline';
import { adoptSso, canRememberDevice, forgetSession, Session, signedInAccounts, signIn, ssoError, ssoProvider } from './oauth';
import { applyDisplayPrefs, applyTheme, savedTheme } from './Settings';
import { Signup, signupAvailable } from './Signup';
import { cache } from './store';

applyTheme(savedTheme());
applyDisplayPrefs();

export default function App() {
  const [client, setClient] = useState<Jmap | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const session = useRef<Session | null>(null);
  const [adding, setAdding] = useState(false); // signing in to another account while one is open

  useEffect(() => {
    (async () => {
      try {
        // Back from single sign-on (signup/sso.mjs): /?sso=<username> or /?sso_error=<code>.
        const q = new URLSearchParams(location.search);
        if (q.has('sso') || q.has('sso_error')) {
          history.replaceState(null, '', location.pathname);
          if (q.get('sso')) adoptSso(q.get('sso')!); else setError(ssoError(q.get('sso_error')!));
        }
        // Resuming in this tab after a reload.
        const s = Session.resume();
        if (s) { session.current = s; const c = await Jmap.connect(s); c.offline = s.remembered; setClient(c); }
      } catch (e) {
        session.current = null; forgetSession();
        setError(e instanceof Error ? e.message : String(e));
      } finally { setBooting(false); }
    })();
  }, []);

  // A session that can't be renewed sends you back to sign in, with a reason, instead of a page of errors.
  useEffect(() => {
    const expired = () => { cache.clear(); session.current = null; setClient(null); setError('Your session has ended. Please sign in again.'); };
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, []);

  async function open(s: Session) {
    const c = await Jmap.connect(s);
    c.offline = s.remembered; // offline mail only on devices the person chose to trust
    session.current = s; s.remember(); setClient(c);
  }
  /** Sign out of the current account; stay signed in to any others (switch to the next one). */
  async function signOut() {
    if (session.current) cache.clear(`${session.current.username}:`); // their mail leaves this tab now, not later
    // While still signed in: stop this account's background notifications on this browser.
    if (client) await signOutPush(client, signedInAccounts().length > 1);
    if (client) client.offline = false; // a request still in flight can't save again after the wipe
    // Saved mail leaves with them. Both names: the session's (sign-in) and the server's (cache keys).
    for (const u of new Set([session.current?.username, client?.username])) if (u) await offlineStore.clear(`${u}:`);
    await session.current?.signOut();
    session.current = null;
    const next = Session.resume();
    if (next) { try { return await open(next); } catch { /* fall through to sign-in */ } }
    cache.clear();
    setClient(null);
  }
  async function switchTo(username: string) {
    const s = Session.resume(username);
    if (!s) return;
    try { await open(s); } catch (e) { setError((e as Error).message); }
  }

  if (booting) return <div className="reader-loading" aria-busy="true" />;
  if (!client || adding) return <Login key={error} initialError={error} onCancel={adding ? () => setAdding(false) : undefined}
    onLogin={(c, s) => { session.current = s; c.offline = s.remembered; setError(''); setAdding(false); setClient(c); }} />;
  // The admin console is a separate screen of the same app (no router): /admin, for admins only (checked by the server).
  if (location.pathname === '/admin') return <><Admin client={client} /><DialogHost /></>;
  return <><Mail key={client.username} client={client} onLogout={signOut} accounts={signedInAccounts()}
    onSwitch={switchTo} onAddAccount={() => setAdding(true)} /><DialogHost /></>;
}

function Login({ initialError, onLogin, onCancel }: { initialError: string; onLogin: (c: Jmap, s: Session) => void; onCancel?: () => void }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [canSignUp, setCanSignUp] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [canKeep, setCanKeep] = useState(false);
  const [keep, setKeep] = useState(true);
  const [sso, setSso] = useState<string | null>(null);
  useEffect(() => { signupAvailable().then(setCanSignUp); canRememberDevice().then(setCanKeep); ssoProvider().then(setSso); }, []);

  if (signingUp) return <Signup onCancel={() => setSigningUp(false)}
    onDone={(addr) => { setSigningUp(false); setEmail(addr); setNotice(`Your mailbox ${addr} is ready. Sign in to start using it.`); }} />;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const s = await signIn(email.trim(), password, needCode ? code : undefined);
      if (s === 'code') { setNeedCode(true); setBusy(false); return; }
      if (canKeep && keep) await s.rememberOnDevice(); // falls back to this-tab-only if the service says no
      onLogin(await Jmap.connect(s), s);
    } catch (err) {
      setError(err instanceof JmapError || err instanceof Error ? err.message : 'Can’t reach the mail server. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <p className="wordmark">OpenMail</p>
        <h1>{needCode ? 'Two-step verification' : onCancel ? 'Add another account' : 'Sign in to your mailbox'}</h1>
        {notice && <p className="banner banner--safe" role="status">{notice}</p>}
        {sso ? <>
          {/* With single sign-on the server takes no passwords at all (Stalwart's directory is server-wide). */}
          <Button variant="primary" size="lg" onClick={() => location.assign('/api/sso/start')}>Sign in with {sso}</Button>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="fine">You’ll sign in on {sso}’s page and come straight back. This device stays signed in until you sign out.</p>
          {onCancel && <Button variant="link" className="alt" onClick={onCancel}>Back to your mail</Button>}
        </> : <>
        {!needCode ? <>
          <label>Email address<input className="input" name="email" type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input className="input" name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {canKeep && <label className="inline keep"><input type="checkbox" className="check" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep me signed in on this device</label>}
        </> : <>
          <p className="fine">Enter the 6-digit code from your authenticator app for {email}.</p>
          <label>Code<input className="input" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={7}
            value={code} onChange={(e) => setCode(e.target.value)} /></label>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'Signing in…' : needCode ? 'Verify' : 'Sign in'}</Button>
        {needCode && <Button variant="link" className="alt" onClick={() => { setNeedCode(false); setCode(''); setError(''); }}>Use a different account</Button>}
        {!needCode && canSignUp && <Button variant="link" className="alt" onClick={() => setSigningUp(true)}>Create an account</Button>}
        {onCancel && <Button variant="link" className="alt" onClick={onCancel}>Back to your mail</Button>}
        </>}
        <p className="fine">No ads. No reading your mail. Open source.</p>
      </form>
    </main>
  );
}
