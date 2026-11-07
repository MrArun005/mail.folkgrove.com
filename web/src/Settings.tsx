import { useEffect, useState } from 'react';
import type { Jmap, Mailbox } from './jmap';
import { FiltersSection, FoldersSection, loadScript, saveScript } from './Filters';
import type { Rule, Vacation } from './rules';
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

export function Settings({ client, boxes, prefillRule, onClose, onSaved, onFoldersChanged }: {
  client: Jmap; boxes: Mailbox[]; prefillRule?: Partial<Rule>;
  onClose: () => void; onSaved: (msg: string) => void; onFoldersChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');
  const [vac, setVac] = useState<Vacation | null>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([client.getIdentityFresh(), loadScript(client)]).then(([id, script]) => {
      setName(id.name === id.email ? '' : id.name);
      setSignature(id.textSignature ?? '');
      setVac(script.data.vacation);
    }, (e) => setError(e.message));
  }, [client]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (vac?.enabled && vac.from && vac.to && vac.to < vac.from) return setError('The out-of-office end date is before the start date.');
    setBusy(true); setError('');
    try {
      await client.setIdentity({ name: name.trim(), textSignature: signature, htmlSignature: signature.trim() ? textToHtml(signature) : '' });
      if (vac) {
        const { data } = await loadScript(client); // keep the filters exactly as they are
        await saveScript(client, boxes, { ...data, vacation: vac });
      }
      applyTheme(theme);
      onSaved('Settings saved');
    } catch (err) { setError(`Couldn’t save: ${(err as Error).message}`); }
    finally { setBusy(false); }
  }


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
            <label className="inline"><input type="checkbox" className="check" checked={vac.enabled} onChange={(e) => setVac({ ...vac, enabled: e.target.checked })} />Automatically reply while I’m away</label>
            <fieldset disabled={!vac.enabled}>
              <div className="row2">
                <label>First day<input className="input" type="date" value={dateOnly(vac.from ?? null)} onChange={(e) => setVac({ ...vac, from: e.target.value || null })} /></label>
                <label>Last day<input className="input" type="date" value={dateOnly(vac.to ?? null)} onChange={(e) => setVac({ ...vac, to: e.target.value || null })} /></label>
              </div>
              <label>Subject<input className="input" value={vac.subject ?? ''} onChange={(e) => setVac({ ...vac, subject: e.target.value })} placeholder="Out of office" /></label>
              <label>Message<textarea className="input" rows={3} value={vac.body ?? ''} onChange={(e) => setVac({ ...vac, body: e.target.value })} placeholder="I’m away until Monday and will reply when I’m back." /></label>
            </fieldset>
            <p className="fine">Each sender gets the reply at most once a day. Blocked senders never get it.</p>
          </> : <p className="fine">Loading…</p>}
        </section>

        <FiltersSection client={client} boxes={boxes} prefill={prefillRule} />
        <FoldersSection client={client} boxes={boxes} onChanged={onFoldersChanged} />

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
