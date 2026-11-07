import { useEffect, useState } from 'react';
import type { Jmap, Mailbox } from './jmap';
import { FiltersSection, FoldersSection, loadScript, saveScript } from './Filters';
import type { Rule, Vacation } from './rules';
import { Button } from './Button';
import { SecuritySection } from './Security';
import { AddressesSection } from './Addresses';
import { ImportSection } from './Import';
import { disablePush, enablePush, notifyOn, notifySupported, setNotify } from './notify';
import { chooseSignature, textToHtml, type Signature } from './mailutil';

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('om:theme', t); } catch {}
}
export const savedTheme = (): Theme => { try { return (localStorage.getItem('om:theme') as Theme) || 'system'; } catch { return 'system'; } };

/** Display preferences, per device (like light/dark): each one is a data-* attribute on <html> read by styles.css. */
export const DISPLAY = {
  palette: { label: 'Theme', options: [['clean', 'Clean'], ['paper', 'Paper']] },
  text: { label: 'Text size', options: [['small', 'Small'], ['default', 'Default'], ['large', 'Large'], ['larger', 'Larger']] },
  density: { label: 'Density', options: [['comfortable', 'Comfortable'], ['default', 'Default'], ['compact', 'Compact']] },
  reading: { label: 'Message font', options: [['sans', 'Sans'], ['serif', 'Serif']] },
} as const;
export type DisplayKey = keyof typeof DISPLAY;
const DEFAULTS: Record<DisplayKey, string> = { palette: 'clean', text: 'default', density: 'default', reading: 'sans' };
export const displayPref = (k: DisplayKey) => { try { return localStorage.getItem(`om:${k}`) || DEFAULTS[k]; } catch { return DEFAULTS[k]; } };
export function setDisplayPref(k: DisplayKey, v: string) {
  if (v === DEFAULTS[k]) document.documentElement.removeAttribute(`data-${k}`); else document.documentElement.setAttribute(`data-${k}`, v);
  try { localStorage.setItem(`om:${k}`, v); } catch { /* lasts this session only */ }
}
export const applyDisplayPrefs = () => (Object.keys(DISPLAY) as DisplayKey[]).forEach((k) => setDisplayPref(k, displayPref(k)));

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export function Settings({ client, boxes, prefillRule, onClose, onSaved, onFoldersChanged, onIdentitiesChanged }: {
  client: Jmap; boxes: Mailbox[]; prefillRule?: Partial<Rule>;
  onClose: () => void; onSaved: (msg: string) => void; onFoldersChanged: () => void; onIdentitiesChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [sigNew, setSigNew] = useState<string | undefined>();
  const [sigReply, setSigReply] = useState<string | undefined>();
  const [vac, setVac] = useState<Vacation | null>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const [display, setDisplay] = useState(() => Object.fromEntries((Object.keys(DISPLAY) as DisplayKey[]).map((k) => [k, displayPref(k)])) as Record<DisplayKey, string>);
  const [notify, setNotifyState] = useState(notifyOn());
  const [pushNote, setPushNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([client.getIdentityFresh(), loadScript(client)]).then(([id, script]) => {
      setName(id.name === id.email ? '' : id.name);
      const d = script.data;
      setSigs(d.signatures ?? (id.textSignature?.trim() ? [{ name: 'Signature', text: id.textSignature }] : []));
      setSigNew(d.sigNew); setSigReply(d.sigReply);
      setVac(script.data.vacation);
    }, (e) => setError(e.message));
  }, [client]);

  // Esc closes Settings wherever focus is (not only inside the sheet).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (vac?.enabled && vac.from && vac.to && vac.to < vac.from) return setError('The out-of-office end date is before the start date.');
    const list = sigs.map((x) => ({ name: x.name.trim(), text: x.text })).filter((x) => x.name || x.text.trim());
    if (list.some((x) => !x.name)) return setError('Give each signature a name.');
    if (new Set(list.map((x) => x.name)).size < list.length) return setError('Two signatures have the same name.');
    setBusy(true); setError('');
    try {
      // The identity carries the new-message signature too, so other JMAP apps see it.
      const main = chooseSignature(list, sigNew)?.text ?? '';
      await client.setIdentity({ name: name.trim(), textSignature: main, htmlSignature: main.trim() ? textToHtml(main) : '' });
      await saveScript(client, boxes, (d) => ({ ...d, ...(vac && { vacation: vac }), signatures: list, sigNew, sigReply })); // filters etc. kept
      applyTheme(theme);
      onSaved('Settings saved');
    } catch (err) { setError(`Couldn’t save: ${(err as Error).message}`); }
    finally { setBusy(false); }
  }


  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="sheet settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}
>
        <h2>Settings</h2>

        <section>
          <h3>You</h3>
          <label>Name people see<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice Martin" autoFocus /></label>
        </section>

        <section>
          <h3>Signatures</h3>
          {sigs.map((sg, i) => {
            const set = (p: Partial<Signature>) => setSigs(sigs.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="sig-card">
                <div className="sig-head">
                  <input className="input" aria-label="Signature name" placeholder="Name, e.g. Work" value={sg.name} onChange={(e) => set({ name: e.target.value })} />
                  <Button variant="quiet" size="sm" icon="trash" label={`Delete signature ${sg.name}`} onClick={() => setSigs(sigs.filter((_, j) => j !== i))} />
                </div>
                <textarea className="input" rows={3} aria-label={`Signature ${sg.name}`} value={sg.text} onChange={(e) => set({ text: e.target.value })} placeholder={'Alice Martin\nProduct lead'} />
              </div>
            );
          })}
          <Button size="sm" icon="compose" className="start" onClick={() => setSigs([...sigs, { name: sigs.length ? '' : 'Signature', text: '' }])}>Add signature</Button>
          {sigs.length > 0 && (
            <div className="row2">
              <label>For new messages<SigSelect sigs={sigs} value={sigNew} onChange={setSigNew} /></label>
              <label>For replies and forwards<SigSelect sigs={sigs} value={sigReply} onChange={setSigReply} /></label>
            </div>
          )}
          <p className="fine">You can switch or remove the signature in each message.</p>
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

        <AddressesSection client={client} onChanged={onIdentitiesChanged} />
        <SecuritySection username={client.username} />
        <CategoriesSection client={client} boxes={boxes} />
        <ScreenerSection client={client} boxes={boxes} />
        <FiltersSection client={client} boxes={boxes} prefill={prefillRule} />
        <FoldersSection client={client} boxes={boxes} onChanged={onFoldersChanged} />
        <ImportSection client={client} onDone={onFoldersChanged} />

        {notifySupported() && (
          <section>
            <h3>Notifications</h3>
            <label className="inline"><input type="checkbox" className="check" checked={notify}
              onChange={async (e) => {
                const want = e.target.checked, on = await setNotify(want); setNotifyState(on);
                if (want && !on) return setError('Your browser blocked notifications. Allow them for this site in the browser’s settings.');
                if (on) setPushNote((await enablePush(client).catch(() => false)) ? 'Also when OpenMail is closed.' : 'Only while OpenMail is open in a tab (this browser or server can’t do background push).');
                else { await disablePush(client); setPushNote(''); }
              }} />
              Show a desktop notification when new mail arrives in Primary</label>
            <p className="fine">{pushNote || 'On this device, while OpenMail isn’t the window you’re looking at.'}</p>
          </section>
        )}

        <section>
          <h3>Appearance</h3>
          <div className="segmented" role="radiogroup" aria-label="Light or dark">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <label key={t} className={theme === t ? 'on' : ''}>
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => { setTheme(t); applyTheme(t); }} />
                {t === 'system' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
              </label>
            ))}
          </div>
          {(Object.keys(DISPLAY) as DisplayKey[]).map((k) => (
            <div key={k} className="pref-row">
              <span className="pref-label">{DISPLAY[k].label}</span>
              <div className="segmented" role="radiogroup" aria-label={DISPLAY[k].label}>
                {DISPLAY[k].options.map(([v, t]) => (
                  <label key={v} className={display[k] === v ? 'on' : ''}>
                    <input type="radio" name={k} value={v} checked={display[k] === v} onChange={() => { setDisplayPref(k, v); setDisplay({ ...display, [k]: v }); }} />{t}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <p className="fine">Saved on this device. Your browser’s zoom (⌘ +/−) works too.</p>
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

/** Inbox categories on/off. Saves immediately (it's a server rule), and tags existing mail when turned on. */
function CategoriesSection({ client, boxes }: { client: Jmap; boxes: Mailbox[] }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { loadScript(client).then(({ data }) => setOn(data.categories !== false), () => setOn(true)); }, [client]);
  async function toggle(next: boolean) {
    setOn(next); setNote('Saving…');
    try {
      await saveScript(client, boxes, (d) => ({ ...d, categories: next }));
      const inbox = boxes.find((b) => b.role === 'inbox')?.id;
      const n = next && inbox ? await client.tagUpdates(inbox) : 0;
      setNote(next ? `On. ${n ? `${n} newsletters moved to Updates.` : 'New newsletters will go to Updates.'}` : 'Off. Everything stays in one Inbox.');
    } catch (e) { setOn(!next); setNote(`Couldn’t change this: ${(e as Error).message}`); }
  }
  return (
    <section>
      <h3>Inbox</h3>
      <label className="inline"><input type="checkbox" className="check" checked={!!on} disabled={on === null}
        onChange={(e) => toggle(e.target.checked)} />Sort newsletters and notifications into an Updates tab</label>
      <p className="fine">{note || 'People’s messages stay in Primary. Sorting happens on the server as mail arrives.'}</p>
    </section>
  );
}

function ScreenerSection({ client, boxes }: { client: Jmap; boxes: Mailbox[] }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { loadScript(client).then(({ data }) => setOn(!!data.screener?.on), () => setOn(false)); }, [client]);
  async function toggle(next: boolean) {
    setOn(next); setNote('Saving…');
    try {
      // First time on: everyone you already correspond with (and your contacts) is approved.
      const { data } = await loadScript(client);
      const seed = data.screener?.allow?.length ? [] : await knownSenders(client);
      let allow: string[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, screener: { on: next, allow: (allow = d.screener?.allow?.length ? d.screener.allow : seed) } }));
      setNote(next ? `On. ${allow.length} people you already know go straight to your Inbox.` : 'Off. New senders go to your Inbox again.');
    } catch (e) { setOn(!next); setNote(`Couldn’t change this: ${(e as Error).message}`); }
  }
  return (
    <section>
      <h3>Screener</h3>
      <label className="inline"><input type="checkbox" className="check" checked={!!on} disabled={on === null}
        onChange={(e) => toggle(e.target.checked)} />Hold mail from first-time senders until I approve them</label>
      <p className="fine">{note || 'New senders wait in the Screener folder. Say yes once and they reach your Inbox from then on; say no and they never do. Works on the server, even when this app is closed.'}</p>
    </section>
  );
}

export async function knownSenders(client: Jmap): Promise<string[]> {
  const [book, recent, mine] = await Promise.all([client.addressBook().catch(() => []), client.contacts(), client.identities()]);
  // Your own addresses too: a note to yourself is never "first-time".
  return [...new Set([...mine.map((i) => i.email), ...book.flatMap((p) => p.emails), ...recent.map((a) => a.email)].map((e) => e.toLowerCase()))];
}

/** '' means no signature; undefined (never chosen) shows as the first one. */
function SigSelect({ sigs, value, onChange }: { sigs: Signature[]; value: string | undefined; onChange: (v: string) => void }) {
  const named = sigs.filter((x) => x.name.trim());
  return (
    <select className="input" value={chooseSignature(named, value)?.name ?? ''} onChange={(e) => onChange(e.target.value)}>
      {named.map((x) => <option key={x.name} value={x.name.trim()}>{x.name}</option>)}
      <option value="">No signature</option>
    </select>
  );
}
