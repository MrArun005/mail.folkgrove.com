import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { serverText, t } from './i18n';

// Public sign-up (signup/ service, proxied at /api/). The link only shows when that service answers,
// so self-hosted servers without public sign-up never show it. API contract: signup/README.md.

type Err = { code: string; message: string; field?: string };
// The legal sentence's {links}: page and link text.
const LEGAL = {
  terms: ['/legal/terms-of-service.html', 'signup.terms'],
  aup: ['/legal/acceptable-use.html', 'signup.acceptableUse'],
  privacy: ['/legal/privacy-policy.html', 'signup.privacy'],
} as const;

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
        setCheck(j.ok ? (j.available ? { ok: true, text: t('signup.available', { email: j.email }) } : { ok: false, text: serverText(j.code, j.message) }) : null);
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
      const j = await r.json().catch(() => ({ ok: false, error: { code: 'unavailable', message: t('server.unavailable') } }));
      if (j.ok && j.needCode) { setSentTo(j.sentTo); setCode(''); setBusy(false); return; }
      if (j.ok) return onDone(j.email);
      if (j.error?.code === 'code_expired' || j.error?.code === 'code_tries') setSentTo(''); // back to step one: ask again
      setErr(j.error);
    } catch { setErr({ code: 'network', message: t('server.network') }); }
    setBusy(false);
  }

  const errText = (x: Err) => serverText(x.code, x.message);
  const fieldErr = (f: string) => (err?.field === f ? <p className="error" role="alert">{errText(err)}</p> : null);

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <p className="wordmark">OpenMail</p>
        <h1>{sentTo ? t('signup.checkEmail') : t('signup.title')}</h1>
        {sentTo ? <>
          <p className="fine">{t('signup.codeSent', { email: sentTo })}</p>
          <label>{t('signup.code')}
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </label>
          {fieldErr('verifyCode')}
          {err && !err.field && <p className="error" role="alert">{errText(err)}</p>}
          <Button type="submit" variant="primary" size="lg" disabled={busy || code.trim().length < 6}>{busy ? t('signup.creating') : t('signup.create')}</Button>
          <Button variant="link" className="alt" onClick={() => { setSentTo(''); setErr(null); }}>{t('signup.differentEmail')}</Button>
        </> : <>
        <label>{t('signup.username')}
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
            autoCapitalize="none" spellCheck={false} required autoFocus aria-describedby="u-help" />
        </label>
        <p id="u-help" className={check ? (check.ok ? 'fine ok' : 'error') : 'fine'}>{check?.text ?? t('signup.usernameHelp')}</p>
        {fieldErr('username')}
        <label>{t('signup.password')}
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
        </label>
        <p className="fine">{t('signup.passwordHelp')}</p>
        {fieldErr('password')}
        <label>{t('signup.invite')}
          <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {fieldErr('inviteCode')}
        <label>{t('signup.recovery')}
          <input className="input" type="email" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="email" spellCheck={false} />
        </label>
        <p className="fine">{t('signup.recoveryHelp')}</p>
        {fieldErr('recoveryEmail')}
        {err && !err.field && <p className="error" role="alert">{errText(err)}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || check?.ok === false}>{busy ? t('signup.sendingCode') : t('signup.continue')}</Button>
        <Button variant="link" className="alt" onClick={onCancel}>{t('signup.haveMailbox')}</Button>
        <p className="fine legal-links">{t('signup.legal').split(/\{(\w+)\}/).map((part, i) => {
          const link = LEGAL[part as keyof typeof LEGAL];
          return i % 2 && link ? <a key={i} href={link[0]} target="_blank" rel="noopener">{t(link[1])}</a> : part;
        })}</p>
        </>}
      </form>
    </main>
  );
}
