import { useEffect, useState } from 'react';
import { Jmap, JmapError } from './jmap';
import { Button } from './Button';
import { Mail } from './Mail';
import { applyTheme, savedTheme } from './Settings';
import { cache } from './store';

// Stay signed in across reloads in this tab; closing the tab signs out.
// ponytail: holds the password in sessionStorage. Replace with an OAuth refresh token before the public instance.
const session = {
  get(): { user: string; pass: string } | null { try { return JSON.parse(sessionStorage.getItem('om:session') ?? 'null'); } catch { return null; } },
  set(v: { user: string; pass: string } | null) { try { v ? sessionStorage.setItem('om:session', JSON.stringify(v)) : sessionStorage.removeItem('om:session'); } catch {} },
};

applyTheme(savedTheme());

export default function App() {
  const [client, setClient] = useState<Jmap | null>(null);
  const [restoring, setRestoring] = useState(() => !!session.get());
  useEffect(() => {
    const s = session.get();
    if (s) Jmap.login(s.user, s.pass).then(setClient, () => session.set(null)).finally(() => setRestoring(false));
  }, []);
  if (restoring) return <div className="reader-loading" aria-busy="true" />;
  if (!client) return <Login onLogin={setClient} />;
  return <Mail client={client} onLogout={() => { cache.clear(); session.set(null); setClient(null); }} />;
}

function Login({ onLogin }: { onLogin: (c: Jmap) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const user = String(f.get('email')).trim(), pass = String(f.get('password'));
    setBusy(true); setError('');
    try { const c = await Jmap.login(user, pass); session.set({ user, pass }); onLogin(c); }
    catch (err) { setError(err instanceof JmapError ? err.message : 'Can’t reach the mail server. Check your connection and try again.'); }
    finally { setBusy(false); }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <p className="wordmark">OpenMail</p>
        <h1>Sign in to your mailbox</h1>
        <label>Email address<input className="input" name="email" type="email" autoComplete="username" required autoFocus /></label>
        <label>Password<input className="input" name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="fine">No ads. No reading your mail. Open source.</p>
      </form>
    </main>
  );
}
