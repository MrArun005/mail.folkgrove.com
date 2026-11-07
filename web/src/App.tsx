import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Jmap, JmapError, SESSION_EXPIRED } from './jmap';
import { Mail } from './Mail';
import { DialogHost } from './Dialog';
import { forgetSession, Session, signIn } from './oauth';
import { applyTheme, savedTheme } from './Settings';
import { Signup, signupAvailable } from './Signup';
import { cache } from './store';

applyTheme(savedTheme());

export default function App() {
  const [client, setClient] = useState<Jmap | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const session = useRef<Session | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Resuming in this tab after a reload.
        const s = Session.resume();
        if (s) { session.current = s; setClient(await Jmap.connect(s)); }
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

  async function signOut() {
    cache.clear();
    await session.current?.signOut();
    session.current = null;
    setClient(null);
  }

  if (booting) return <div className="reader-loading" aria-busy="true" />;
  if (!client) return <Login key={error} initialError={error} onLogin={(c, s) => { session.current = s; setError(''); setClient(c); }} />;
  return <><Mail client={client} onLogout={signOut} /><DialogHost /></>;
}

function Login({ initialError, onLogin }: { initialError: string; onLogin: (c: Jmap, s: Session) => void }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [canSignUp, setCanSignUp] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => { signupAvailable().then(setCanSignUp); }, []);

  if (signingUp) return <Signup onCancel={() => setSigningUp(false)}
    onDone={(addr) => { setSigningUp(false); setEmail(addr); setNotice(`Your mailbox ${addr} is ready. Sign in to start using it.`); }} />;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const s = await signIn(email.trim(), password, needCode ? code : undefined);
      if (s === 'code') { setNeedCode(true); setBusy(false); return; }
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
        <h1>{needCode ? 'Two-step verification' : 'Sign in to your mailbox'}</h1>
        {notice && <p className="banner banner--safe" role="status">{notice}</p>}
        {!needCode ? <>
          <label>Email address<input className="input" name="email" type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input className="input" name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        </> : <>
          <p className="fine">Enter the 6-digit code from your authenticator app for {email}.</p>
          <label>Code<input className="input" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={7}
            value={code} onChange={(e) => setCode(e.target.value)} /></label>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'Signing in…' : needCode ? 'Verify' : 'Sign in'}</Button>
        {needCode && <Button variant="link" className="alt" onClick={() => { setNeedCode(false); setCode(''); setError(''); }}>Use a different account</Button>}
        {!needCode && canSignUp && <Button variant="link" className="alt" onClick={() => setSigningUp(true)}>Create an account</Button>}
        <p className="fine">No ads. No reading your mail. Open source.</p>
      </form>
    </main>
  );
}
