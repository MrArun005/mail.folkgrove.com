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
  const [recovery, setRecovery] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState(''); // set once a code was emailed: the form shows the code step
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
        body: JSON.stringify({ username: username.trim(), password, inviteCode: invite.trim() || undefined,
          recoveryEmail: recovery.trim() || undefined, verifyCode: sentTo ? code.trim() : undefined }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: { code: 'unavailable', message: 'Sign-up is unavailable right now. Try again in a few minutes.' } }));
      if (j.ok && j.needCode) { setSentTo(j.sentTo); setCode(''); setBusy(false); return; }
      if (j.ok) return onDone(j.email);
      if (j.error?.code === 'code_expired' || j.error?.code === 'code_tries') setSentTo(''); // back to step one: ask again
      setErr(j.error);
    } catch { setErr({ code: 'network', message: 'Can’t reach the server. Check your connection and try again.' }); }
    setBusy(false);
  }

  const fieldErr = (f: string) => (err?.field === f ? <p className="error" role="alert">{err.message}</p> : null);

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <p className="wordmark">OpenMail</p>
        <h1>{sentTo ? 'Check your email' : 'Create your mailbox'}</h1>
        {sentTo ? <>
          <p className="fine">We sent a 6-digit code to {sentTo}. It works for 15 minutes.</p>
          <label>Code
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </label>
          {fieldErr('verifyCode')}
          {err && !err.field && <p className="error" role="alert">{err.message}</p>}
          <Button type="submit" variant="primary" size="lg" disabled={busy || code.trim().length < 6}>{busy ? 'Creating…' : 'Create mailbox'}</Button>
          <Button variant="link" className="alt" onClick={() => { setSentTo(''); setErr(null); }}>Use a different email, or send a new code</Button>
        </> : <>
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
        <label>Your current email
          <input className="input" type="email" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="email" spellCheck={false} />
        </label>
        <p className="fine">We’ll send it a code to confirm it’s you. It’s also how you get back in if you forget your password.</p>
        {fieldErr('recoveryEmail')}
        {err && !err.field && <p className="error" role="alert">{err.message}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || check?.ok === false}>{busy ? 'Sending code…' : 'Continue'}</Button>
        <Button variant="link" className="alt" onClick={onCancel}>I already have a mailbox</Button>
        </>}
      </form>
    </main>
  );
}
