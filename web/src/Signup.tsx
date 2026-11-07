import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

// Public sign-up (signup/ service, proxied at /api/). The link only shows when that service answers,
// so self-hosted servers without public sign-up never show it. API contract: signup/README.md.

type Err = { code: string; message: string; field?: string };

/** Is a sign-up service running behind this origin? */
export async function signupAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/username-available?u=probe-name', { headers: { Accept: 'application/json' } });
    return (await r.json().catch(() => null))?.ok === true;
  } catch { return false; }
}

export function Signup({ onDone, onCancel }: { onDone: (email: string) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(0);

  // Live availability, debounced (the endpoint is rate-limited).
  const latest = useRef('');
  useEffect(() => {
    clearTimeout(timer.current);
    setCheck(null); // never show a verdict about text that's no longer in the box
    const u = username.trim().toLowerCase();
    latest.current = u;
    if (u.length < 3) return;
    timer.current = window.setTimeout(async () => {
      try {
        const j = await (await fetch(`/api/username-available?u=${encodeURIComponent(u)}`)).json();
        if (latest.current !== u) return; // a slower reply for an older name
        setCheck(j.ok ? (j.available ? { ok: true, text: `${j.email} is available` } : { ok: false, text: j.message }) : null);
      } catch { /* no verdict; the server checks again on submit */ }
    }, 400);
  }, [username]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, inviteCode: invite.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: { code: 'unavailable', message: 'Sign-up is unavailable right now. Try again in a few minutes.' } }));
      if (j.ok) return onDone(j.email);
      setErr(j.error);
    } catch { setErr({ code: 'network', message: 'Can’t reach the server. Check your connection and try again.' }); }
    setBusy(false);
  }

  const fieldErr = (f: string) => (err?.field === f ? <p className="error" role="alert">{err.message}</p> : null);

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <p className="wordmark">OpenMail</p>
        <h1>Create your mailbox</h1>
        <label>Username
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
            autoCapitalize="none" spellCheck={false} required autoFocus aria-describedby="u-help" />
        </label>
        <p id="u-help" className={check ? (check.ok ? 'fine ok' : 'error') : 'fine'}>{check?.text ?? '3–32 characters: letters, numbers, dots and hyphens.'}</p>
        {fieldErr('username')}
        <label>Password
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
        </label>
        <p className="fine">At least 12 characters. A few unrelated words make a strong, memorable password.</p>
        {fieldErr('password')}
        <label>Invite code
          <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {fieldErr('inviteCode')}
        {err && !err.field && <p className="error" role="alert">{err.message}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || check?.ok === false}>{busy ? 'Creating…' : 'Create mailbox'}</Button>
        <Button variant="link" className="alt" onClick={onCancel}>I already have a mailbox</Button>
      </form>
    </main>
  );
}
