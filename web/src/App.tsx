import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Jmap, JmapError } from './jmap';
import { Mail } from './Mail';
import { finishSignIn, Session, startSignIn } from './oauth';
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
        // Returning from the server's sign-in page, or resuming in this tab after a reload.
        const fresh = await finishSignIn();
        const s = fresh ? new Session(fresh) : Session.resume();
        if (s) { session.current = s; setClient(await Jmap.connect(s)); }
      } catch (e) {
        session.current = null;
        setError(e instanceof Error ? e.message : String(e));
      } finally { setBooting(false); }
    })();
  }, []);

  async function signOut() {
    cache.clear();
    await session.current?.signOut();
    session.current = null;
    setClient(null);
  }

  if (booting) return <div className="reader-loading" aria-busy="true" />;
  if (!client) return <Login initialError={error} onLogin={setClient} />;
  return <Mail client={client} onLogout={signOut} />;
}

function Login({ initialError, onLogin }: { initialError: string; onLogin: (c: Jmap) => void }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [withPassword, setWithPassword] = useState(false);
  const [canSignUp, setCanSignUp] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  useEffect(() => { signupAvailable().then(setCanSignUp); }, []);

  if (signingUp) return <Signup onCancel={() => setSigningUp(false)}
    onDone={(addr) => { setSigningUp(false); setEmail(addr); setNotice(`Your mailbox ${addr} is ready. Sign in to start using it.`); }} />;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const user = String(f.get('email')).trim();
    setBusy(true); setError('');
    if (!withPassword) return startSignIn(user); // the server's page takes the password and any two-factor code
    try { onLogin(await Jmap.login(user, String(f.get('password')))); } // fallback: not remembered across reloads
    catch (err) { setError(err instanceof JmapError ? err.message : 'Can’t reach the mail server. Check your connection and try again.'); setBusy(false); }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <p className="wordmark">OpenMail</p>
        <h1>Sign in to your mailbox</h1>
        {notice && <p className="banner banner--safe" role="status">{notice}</p>}
        <label>Email address<input className="input" name="email" type="email" autoComplete="username" required autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {withPassword && <label>Password<input className="input" name="password" type="password" autoComplete="current-password" required /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'Signing in…' : withPassword ? 'Sign in' : 'Continue'}</Button>
        {!withPassword
          ? <p className="fine">You’ll enter your password (and two-factor code, if you use one) on your mail server’s secure page.</p>
          : <p className="fine">Password sign-in isn’t remembered: you’ll sign in again after a reload.</p>}
        <Button variant="link" className="alt" onClick={() => { setWithPassword(!withPassword); setError(''); }}>
          {withPassword ? 'Use secure sign-in instead' : 'Sign in with a password instead'}
        </Button>
        {canSignUp && <Button variant="link" className="alt" onClick={() => setSigningUp(true)}>Create an account</Button>}
        <p className="fine">No ads. No reading your mail. Open source.</p>
      </form>
    </main>
  );
}
