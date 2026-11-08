import { useEffect, useState } from 'react';
import { RetentionSection } from './Retention';
import type { Jmap, Mailbox } from './jmap';
import { FiltersSection, FoldersSection, loadScript, saveScript } from './Filters';
import type { Rule, Vacation } from './rules';
import { Button } from './Button';
import { SecuritySection } from './Security';
import { AddressesSection } from './Addresses';
import { SharedFilesSection } from './SharedFiles';
import { DomainsSection } from './Domains';
import { ImportSection } from './Import';
import { DeleteAccountSection, ExportSection } from './Export';
import { InstallSection } from './Install';
import { disablePush, enablePush, notifyOn, notifySupported, setNotify } from './notify';
import { chooseSignature, textToHtml, type Signature } from './mailutil';
import { DelegatesSection } from './Sharing';
import { SmartComposeSetting } from './SmartCompose';
import { LANGUAGES, languagePref, pickLanguage, setLanguage, t, type Key, type Lang } from './i18n';

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(th: Theme) {
  if (th === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  try { localStorage.setItem('om:theme', th); } catch {}
}
export const savedTheme = (): Theme => { try { return (localStorage.getItem('om:theme') as Theme) || 'system'; } catch { return 'system'; } };

/** Display preferences, per device (like light/dark): each one is a data-* attribute on <html> read by styles.css. */
export const DISPLAY = {
  palette: { label: 'display.theme', options: [['clean', 'display.clean'], ['paper', 'display.paper']] },
  text: { label: 'display.text', options: [['small', 'display.small'], ['default', 'display.default'], ['large', 'display.large'], ['larger', 'display.larger']] },
  density: { label: 'display.density', options: [['comfortable', 'display.comfortable'], ['default', 'display.default'], ['compact', 'display.compact']] },
  reading: { label: 'display.font', options: [['sans', 'display.sans'], ['serif', 'display.serif']] },
  pane: { label: 'display.pane', options: [['full', 'display.full'], ['split', 'display.split']] },
} as const satisfies Record<string, { label: Key; options: readonly (readonly [string, Key])[] }>;
export type DisplayKey = keyof typeof DISPLAY;
const DEFAULTS: Record<DisplayKey, string> = { palette: 'clean', text: 'default', density: 'default', reading: 'sans', pane: 'full' };
export const displayPref = (k: DisplayKey) => { try { return localStorage.getItem(`om:${k}`) || DEFAULTS[k]; } catch { return DEFAULTS[k]; } };
export function setDisplayPref(k: DisplayKey, v: string) {
  if (v === DEFAULTS[k]) document.documentElement.removeAttribute(`data-${k}`); else document.documentElement.setAttribute(`data-${k}`, v);
  try { localStorage.setItem(`om:${k}`, v); } catch { /* lasts this session only */ }
}
export const applyDisplayPrefs = () => (Object.keys(DISPLAY) as DisplayKey[]).forEach((k) => setDisplayPref(k, displayPref(k)));

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export function Settings({ client, boxes, prefillRule, onClose, onSaved, onFoldersChanged, onIdentitiesChanged, onAccountDeleted }: {
  client: Jmap; boxes: Mailbox[]; prefillRule?: Partial<Rule>;
  onClose: () => void; onSaved: (msg: string) => void; onFoldersChanged: () => void; onIdentitiesChanged: () => void; onAccountDeleted: () => void;
}) {
  const [name, setName] = useState('');
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [sigNew, setSigNew] = useState<string | undefined>();
  const [sigReply, setSigReply] = useState<string | undefined>();
  const [vac, setVac] = useState<Vacation | null>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const [display, setDisplay] = useState(() => Object.fromEntries((Object.keys(DISPLAY) as DisplayKey[]).map((k) => [k, displayPref(k)])) as Record<DisplayKey, string>);
  const [notify, setNotifyState] = useState(notifyOn());
  const [langPref, setLangPref] = useState(languagePref);
  const [pushNote, setPushNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([client.getIdentityFresh(), loadScript(client)]).then(([id, script]) => {
      setName(id.name === id.email ? '' : id.name);
      const d = script.data;
      setSigs(d.signatures ?? (id.textSignature?.trim() ? [{ name: t('settings.signature'), text: id.textSignature }] : []));
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
    if (vac?.enabled && vac.from && vac.to && vac.to < vac.from) return setError(t('settings.vacationDates'));
    const list = sigs.map((x) => ({ name: x.name.trim(), text: x.text })).filter((x) => x.name || x.text.trim());
    if (list.some((x) => !x.name)) return setError(t('settings.sigNameNeeded'));
    if (new Set(list.map((x) => x.name)).size < list.length) return setError(t('settings.sigSameName'));
    setBusy(true); setError('');
    try {
      // The identity carries the new-message signature too, so other JMAP apps see it.
      const main = chooseSignature(list, sigNew)?.text ?? '';
      await client.setIdentity({ name: name.trim(), textSignature: main, htmlSignature: main.trim() ? textToHtml(main) : '' });
      await saveScript(client, boxes, (d) => ({ ...d, ...(vac && { vacation: vac }), signatures: list, sigNew, sigReply })); // filters etc. kept
      applyTheme(theme);
      onSaved(t('settings.saved'));
    } catch (err) { setError(t('common.couldntSave', { error: (err as Error).message })); }
    finally { setBusy(false); }
  }


  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="sheet settings" role="dialog" aria-label={t('settings.title')} onMouseDown={(e) => e.stopPropagation()} onSubmit={save}
>
        <h2>{t('settings.title')}</h2>

        <section>
          <h3>{t('settings.you')}</h3>
          <label>{t('settings.name')}<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.namePlaceholder')} autoFocus /></label>
        </section>

        <section>
          <h3>{t('settings.signatures')}</h3>
          {sigs.map((sg, i) => {
            const set = (p: Partial<Signature>) => setSigs(sigs.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="sig-card">
                <div className="sig-head">
                  <input className="input" aria-label={t('settings.sigName')} placeholder={t('settings.sigNamePlaceholder')} value={sg.name} onChange={(e) => set({ name: e.target.value })} />
                  <Button variant="quiet" size="sm" icon="trash" label={t('settings.deleteSig', { name: sg.name })} onClick={() => setSigs(sigs.filter((_, j) => j !== i))} />
                </div>
                <textarea className="input" rows={3} aria-label={t('settings.sigText', { name: sg.name })} value={sg.text} onChange={(e) => set({ text: e.target.value })} placeholder={t('settings.sigPlaceholder')} />
              </div>
            );
          })}
          <Button size="sm" icon="compose" className="start" onClick={() => setSigs([...sigs, { name: sigs.length ? '' : t('settings.signature'), text: '' }])}>{t('settings.addSig')}</Button>
          {sigs.length > 0 && (
            <div className="row2">
              <label>{t('settings.sigNew')}<SigSelect sigs={sigs} value={sigNew} onChange={setSigNew} /></label>
              <label>{t('settings.sigReply')}<SigSelect sigs={sigs} value={sigReply} onChange={setSigReply} /></label>
            </div>
          )}
          <p className="fine">{t('settings.sigNote')}</p>
        </section>

        <section>
          <h3>{t('settings.vacation')}</h3>
          {vac ? <>
            <label className="inline"><input type="checkbox" className="check" checked={vac.enabled} onChange={(e) => setVac({ ...vac, enabled: e.target.checked })} />{t('settings.vacationOn')}</label>
            <fieldset disabled={!vac.enabled}>
              <div className="row2">
                <label>{t('settings.firstDay')}<input className="input" type="date" value={dateOnly(vac.from ?? null)} onChange={(e) => setVac({ ...vac, from: e.target.value || null })} /></label>
                <label>{t('settings.lastDay')}<input className="input" type="date" value={dateOnly(vac.to ?? null)} onChange={(e) => setVac({ ...vac, to: e.target.value || null })} /></label>
              </div>
              <label>{t('settings.subject')}<input className="input" value={vac.subject ?? ''} onChange={(e) => setVac({ ...vac, subject: e.target.value })} placeholder={t('settings.vacationSubject')} /></label>
              <label>{t('settings.message')}<textarea className="input" rows={3} value={vac.body ?? ''} onChange={(e) => setVac({ ...vac, body: e.target.value })} placeholder={t('settings.vacationBody')} /></label>
            </fieldset>
            <p className="fine">{t('settings.vacationNote')}</p>
          </> : <p className="fine">{t('common.loading')}</p>}
        </section>

        <AddressesSection client={client} onChanged={onIdentitiesChanged} />
        <SharedFilesSection client={client} />
        <DomainsSection client={client} onChanged={onIdentitiesChanged} />
        <SecuritySection username={client.username} />
        <CategoriesSection client={client} boxes={boxes} />
        <ScreenerSection client={client} boxes={boxes} />
        <FiltersSection client={client} boxes={boxes} prefill={prefillRule} />
        <FoldersSection client={client} boxes={boxes} onChanged={onFoldersChanged} />
        <DelegatesSection client={client} />
        <ImportSection client={client} onDone={onFoldersChanged} />
        <ExportSection client={client} />
        <RetentionSection client={client} />

        <SmartComposeSetting />
        {notifySupported() && (
          <section>
            <h3>{t('settings.notifications')}</h3>
            <label className="inline"><input type="checkbox" className="check" checked={notify}
              onChange={async (e) => {
                const want = e.target.checked, on = await setNotify(want); setNotifyState(on);
                if (want && !on) return setError(t('settings.notifyBlocked'));
                if (on) setPushNote((await enablePush(client).catch(() => false)) ? t('settings.pushOn') : t('settings.pushOff'));
                else { await disablePush(client); setPushNote(''); }
              }} />
              {t('settings.notifyLabel')}</label>
            <p className="fine">{pushNote || t('settings.notifyNote')}</p>
          </section>
        )}
        <InstallSection />

        <section>
          <h3>{t('settings.appearance')}</h3>
          <div className="segmented" role="radiogroup" aria-label={t('settings.lightOrDark')}>
            {(['system', 'light', 'dark'] as const).map((th) => (
              <label key={th} className={theme === th ? 'on' : ''}>
                <input type="radio" name="theme" value={th} checked={theme === th} onChange={() => { setTheme(th); applyTheme(th); }} />
                {t(th === 'system' ? 'settings.matchDevice' : th === 'light' ? 'settings.light' : 'settings.dark')}
              </label>
            ))}
          </div>
          {(Object.keys(DISPLAY) as DisplayKey[]).map((k) => (
            <div key={k} className="pref-row">
              <span className="pref-label">{t(DISPLAY[k].label)}</span>
              <div className="segmented" role="radiogroup" aria-label={t(DISPLAY[k].label)}>
                {DISPLAY[k].options.map(([v, label]) => (
                  <label key={v} className={display[k] === v ? 'on' : ''}>
                    <input type="radio" name={k} value={v} checked={display[k] === v} onChange={() => { setDisplayPref(k, v); setDisplay({ ...display, [k]: v }); }} />{t(label)}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="pref-row">
            <label className="pref-label" htmlFor="pref-lang">{t('lang.label')}</label>
            {/* Applies at once, like the rows above; each language name is written in that language. */}
            <select id="pref-lang" className="input" value={langPref} onChange={(e) => { const v = e.target.value as Lang | 'auto'; setLangPref(v); setLanguage(v); }}>
              <option value="auto">{t('lang.auto', { language: LANGUAGES[pickLanguage(navigator.languages ?? [])] })}</option>
              {(Object.keys(LANGUAGES) as Lang[]).map((l) => <option key={l} value={l} lang={l}>{LANGUAGES[l]}</option>)}
            </select>
          </div>
          <p className="fine">{t('settings.appearanceNote')}</p>
        </section>

        <DeleteAccountSection client={client} onDeleted={onAccountDeleted} />

        {error && <p className="error" role="alert">{error}</p>}
        <footer>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? t('common.saving') : t('settings.saveSettings')}</Button>
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
    setOn(next); setNote(t('common.saving'));
    try {
      await saveScript(client, boxes, (d) => ({ ...d, categories: next }));
      const inbox = boxes.find((b) => b.role === 'inbox')?.id;
      const n = next && inbox ? await client.tagUpdates(inbox) : 0;
      setNote(next ? (n ? t('settings.categoriesMoved', { count: n }) : t('settings.categoriesOn')) : t('settings.categoriesOff'));
    } catch (e) { setOn(!next); setNote(t('common.couldntChange', { error: (e as Error).message })); }
  }
  return (
    <section>
      <h3>{t('settings.inbox')}</h3>
      <label className="inline"><input type="checkbox" className="check" checked={!!on} disabled={on === null}
        onChange={(e) => toggle(e.target.checked)} />{t('settings.categoriesLabel')}</label>
      <p className="fine">{note || t('settings.categoriesNote')}</p>
    </section>
  );
}

function ScreenerSection({ client, boxes }: { client: Jmap; boxes: Mailbox[] }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { loadScript(client).then(({ data }) => setOn(!!data.screener?.on), () => setOn(false)); }, [client]);
  async function toggle(next: boolean) {
    setOn(next); setNote(t('common.saving'));
    try {
      // First time on: everyone you already correspond with (and your contacts) is approved.
      const { data } = await loadScript(client);
      const seed = data.screener?.allow?.length ? [] : await knownSenders(client);
      let allow: string[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, screener: { on: next, allow: (allow = d.screener?.allow?.length ? d.screener.allow : seed) } }));
      setNote(next ? t('settings.screenerOn', { count: allow.length }) : t('settings.screenerOff'));
    } catch (e) { setOn(!next); setNote(t('common.couldntChange', { error: (e as Error).message })); }
  }
  return (
    <section>
      <h3>{t('settings.screener')}</h3>
      <label className="inline"><input type="checkbox" className="check" checked={!!on} disabled={on === null}
        onChange={(e) => toggle(e.target.checked)} />{t('settings.screenerLabel')}</label>
      <p className="fine">{note || t('settings.screenerNote')}</p>
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
      <option value="">{t('settings.noSignature')}</option>
    </select>
  );
}
