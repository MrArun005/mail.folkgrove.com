import { useEffect, useState } from 'react';
import type { Jmap, Vacation } from './jmap';
import { Button } from './Button';
import { textToHtml } from './mailutil';

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('om:theme', t); } catch {}
}
export const savedTheme = (): Theme => { try { return (localStorage.getItem('om:theme') as Theme) || 'system'; } catch { return 'system'; } };

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export function Settings({ client, onClose, onSaved }: { client: Jmap; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');
  const [vac, setVac] = useState<Vacation | null>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([client.getIdentityFresh(), client.vacation()]).then(([id, v]) => {
      setName(id.name === id.email ? '' : id.name);
      setSignature(id.textSignature ?? '');
      setVac(v);
    }, (e) => setError(e.message));
  }, [client]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (vac?.isEnabled && vac.fromDate && vac.toDate && vac.toDate < vac.fromDate) return setError('The out-of-office end date is before the start date.');
    setBusy(true); setError('');
    try {
      await client.setIdentity({ name: name.trim(), textSignature: signature, htmlSignature: signature.trim() ? textToHtml(signature) : '' });
      if (vac) await client.setVacation({
        isEnabled: vac.isEnabled, subject: vac.subject || null, textBody: vac.textBody || null,
        fromDate: vac.fromDate || null, toDate: vac.toDate || null,
      });
      applyTheme(theme);
      onSaved('Settings saved');
    } catch (err) { setError(`Couldn’t save: ${(err as Error).message}`); }
    finally { setBusy(false); }
  }

  const day = (v: string) => (v ? new Date(v + 'T00:00:00').toISOString().replace(/\.\d+Z$/, 'Z') : null);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="sheet settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2>Settings</h2>

        <section>
          <h3>You</h3>
          <label>Name people see<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice Martin" autoFocus /></label>
          <label>Signature<textarea className="input" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={'Alice Martin\nProduct lead'} /></label>
          <p className="fine">Added to new messages and replies. You can edit it in each message.</p>
        </section>

        <section>
          <h3>Out-of-office reply</h3>
          {vac ? <>
            <label className="inline"><input type="checkbox" className="check" checked={vac.isEnabled} onChange={(e) => setVac({ ...vac, isEnabled: e.target.checked })} />Automatically reply while I’m away</label>
            <fieldset disabled={!vac.isEnabled}>
              <div className="row2">
                <label>First day<input className="input" type="date" value={dateOnly(vac.fromDate)} onChange={(e) => setVac({ ...vac, fromDate: day(e.target.value) })} /></label>
                <label>Last day<input className="input" type="date" value={dateOnly(vac.toDate)} onChange={(e) => setVac({ ...vac, toDate: day(e.target.value) })} /></label>
              </div>
              <label>Subject<input className="input" value={vac.subject ?? ''} onChange={(e) => setVac({ ...vac, subject: e.target.value })} placeholder="Out of office" /></label>
              <label>Message<textarea className="input" rows={3} value={vac.textBody ?? ''} onChange={(e) => setVac({ ...vac, textBody: e.target.value })} placeholder="I’m away until Monday and will reply when I’m back." /></label>
            </fieldset>
            <p className="fine">Each sender gets the reply at most once while it’s on.</p>
          </> : <p className="fine">Loading…</p>}
        </section>

        <section>
          <h3>Appearance</h3>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <label key={t} className={theme === t ? 'on' : ''}>
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => { setTheme(t); applyTheme(t); }} />
                {t === 'system' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
              </label>
            ))}
          </div>
        </section>

        {error && <p className="error" role="alert">{error}</p>}
        <footer>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
        </footer>
      </form>
    </div>
  );
}
