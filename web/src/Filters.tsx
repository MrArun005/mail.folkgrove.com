import { useEffect, useState } from 'react';
import { confirmIt, promptIt } from './Dialog';
import { Button } from './Button';
import { hue } from './Contacts';
import { Icon } from './icons';
import { Menu } from './Menu';
import type { EmailSummary, Jmap, Mailbox } from './jmap';
import { describeRule, matchesRule, parseScript, toSieve, validateRule, type Rule, type RuleAction, type ScriptData } from './rules';
import { displayName } from './mailutil';
import { ShareFolder } from './Sharing';
import { boxName, t, type Key } from './i18n';

const ACTIONS: { value: RuleAction; msg: Key }[] = [
  { value: 'move', msg: 'filters.move' }, { value: 'read', msg: 'filters.read' }, { value: 'star', msg: 'filters.star' },
  { value: 'trash', msg: 'filters.trash' }, { value: 'block', msg: 'filters.block' }, { value: 'forward', msg: 'filters.forward' },
];

/** The one server-side script holding filters + out-of-office. Always read-modify-write through these two. */
export async function loadScript(client: Jmap): Promise<{ id: string | null; data: ScriptData }> {
  const { id, script } = await client.getRules();
  return { id, data: parseScript(script) };
}
/**
 * Save the settings script. Pass a change function, not a copy: it is applied to the newest version on the server
 * and saved only if nobody saved in between (ifInState); if another tab or device did, it re-reads and re-applies,
 * so two devices changing different settings never overwrite each other.
 */
export async function saveScript(client: Jmap, boxes: Mailbox[], change: (d: ScriptData) => ScriptData) {
  // Keep the server's separate vacation script off: only one Sieve script can be active, and it must be ours.
  if ((await client.vacation().catch(() => null))?.isEnabled) await client.setVacation({ isEnabled: false });
  for (let attempt = 0; ; attempt++) {
    const { id, script, state } = await client.getRules();
    const mine = toSieve(change(parseScript(script)), folderNames(boxes));
    try {
      await client.saveRules(mine, id, state);
      // Two saves at the same instant can both pass the server's state check; the later one wins. Read back once:
      // if ours isn't what's stored, someone saved over it, so re-apply our change on top of theirs.
      // ponytail: a save landing after this read can still win; only true simultaneous saves, rare across devices.
      if ((await client.getRules()).script === mine || attempt >= 4) return;
    } catch (e) {
      // stateMismatch (JMAP) or Stalwart's own "Another process modified this script": both mean retry.
      if (attempt >= 4 || !/stateMismatch|another process modified/i.test((e as Error).message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150)); // de-synchronise two retrying devices
  }
}

/** Shared by Settings → Filters and the reader's "Block sender" / "Filter messages like this". */
export async function addRule(client: Jmap, boxes: Mailbox[], rule: Rule) {
  await saveScript(client, boxes, (d) => ({ ...d, rules: [...d.rules, rule] }));
}
const folderNames = (boxes: Mailbox[]) => ({
  trash: boxes.find((b) => b.role === 'trash')?.name ?? 'Trash', junk: boxes.find((b) => b.role === 'junk')?.name ?? 'Junk',
});

export function FiltersSection({ client, boxes, prefill }: { client: Jmap; boxes: Mailbox[]; prefill?: Partial<Rule> }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [draft, setDraft] = useState<Rule | null>(prefill ? { id: crypto.randomUUID(), action: 'move', ...prefill } : null);
  const [error, setError] = useState('');
  const folders = boxes.filter((b) => !b.role || b.role === 'archive');

  useEffect(() => {
    loadScript(client).then(({ data }) => setRules(data.rules), (e) => setError(e.message));
  }, [client]);

  async function save(next: Rule[]) {
    setError('');
    try {
      await saveScript(client, boxes, (d) => ({ ...d, rules: next })); // everything else in the script is kept
      setRules(next);
      return true;
    } catch (e) { setError(t('filters.couldntSave', { error: (e as Error).message })); return false; }
  }

  async function add() {
    if (!draft) return;
    const problem = validateRule(draft);
    if (problem) return setError(problem);
    if (await save([...(rules ?? []), draft])) setDraft(null);
  }

  const set = (patch: Partial<Rule>) => setDraft((d) => d && { ...d, ...patch });

  // Try it first: the newest 100 conversations in the Inbox, read once when the form opens, and matched in the
  // browser as you type (rules.ts matchesRule: the same tests the server will run).
  // ponytail: the list has To but not Cc, so a "To" rule that would match only a Cc isn't counted here.
  const [recent, setRecent] = useState<EmailSummary[] | null>(null);
  const editing = !!draft;
  useEffect(() => {
    const inbox = boxes.find((b) => b.role === 'inbox')?.id;
    if (!editing || !inbox) return;
    let live = true;
    client.threads({ inMailbox: inbox }, 100).then((l) => live && setRecent(l), () => {});
    return () => { live = false; };
  }, [client, editing]);
  const caught = draft && recent && (draft.from?.trim() || draft.to?.trim() || draft.subject?.trim()) ? recent.filter((m) => matchesRule(draft, m)) : null;

  return (
    <section>
      <h3>{t('filters.title')}</h3>
      <p className="fine">{t('filters.intro')}</p>
      {rules === null ? <p className="fine">{t('common.loading')}</p> : rules.length === 0 && !draft ? <p className="fine">{t('filters.none')}</p> : (
        <ul className="rule-list">
          {rules.map((r) => (
            <li key={r.id}>
              <span>{describeRule(r)}</span>
              <Button variant="quiet" size="sm" icon="trash" label={t('filters.delete')} onClick={() => save(rules.filter((x) => x.id !== r.id))} />
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <div className="rule-form">
          <div className="row3">
            <label>{t('filters.from')}<input className="input" value={draft.from ?? ''} onChange={(e) => set({ from: e.target.value })} placeholder={t('filters.fromPlaceholder')} /></label>
            <label>{t('filters.to')}<input className="input" value={draft.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label>
            <label>{t('filters.subject')}<input className="input" value={draft.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} /></label>
          </div>
          <div className="row3">
            <label>{t('filters.then')}<select className="input" value={draft.action} onChange={(e) => set({ action: e.target.value as RuleAction })}>
              {ACTIONS.map((a) => <option key={a.value} value={a.value}>{t(a.msg)}</option>)}
            </select></label>
            {draft.action === 'move' && (
              <label>{t('filters.folder')}<select className="input" value={draft.folder ?? ''} onChange={(e) => set({ folder: e.target.value })}>
                <option value="" disabled>{t('filters.chooseFolder')}</option>
                {folders.map((f) => <option key={f.id} value={f.path ?? f.name}>{f.role ? boxName(f) : f.path ?? f.name}</option>)}
              </select></label>
            )}
            {draft.action === 'forward' && (
              <label>{t('filters.forwardTo')}<input className="input" type="email" value={draft.forwardTo ?? ''} onChange={(e) => set({ forwardTo: e.target.value })} /></label>
            )}
          </div>
          {caught && recent && (
            <div className="rule-preview" role="status">
              <p>{caught.length ? t('filters.wouldCatch', { count: caught.length, of: recent.length }) : t('filters.wouldCatchNone', { of: recent.length })}</p>
              {caught.length > 0 && <ul>{caught.slice(0, 4).map((m) => <li key={m.id}><b>{displayName(m.from?.[0])}</b> {m.subject || t('mail.noSubject')}</li>)}
                {caught.length > 4 && <li className="fine">{t('filters.andMore', { count: caught.length - 4 })}</li>}</ul>}
            </div>
          )}
          <div className="actions">
            <Button size="sm" onClick={() => { setDraft(null); setError(''); }}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" onClick={add}>{t('filters.add')}</Button>
          </div>
        </div>
      ) : <Button size="sm" icon="compose" className="start" onClick={() => setDraft({ id: crypto.randomUUID(), action: 'move' })}>{t('filters.new')}</Button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** The colours offered for a folder (hue, name). */
const FOLDER_HUES = [[25, 'colour.red'], [55, 'colour.orange'], [95, 'colour.yellow'], [145, 'colour.green'], [195, 'colour.teal'], [245, 'colour.blue'], [295, 'colour.purple'], [340, 'colour.pink']] as const;

export function FoldersSection({ client, boxes, onChanged }: { client: Jmap; boxes: Mailbox[]; onChanged: () => void }) {
  const mine = boxes.filter((b) => !b.role);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState<string | null>(null);
  // Colours live with the other synced settings (the filter script), so every device shows the same ones.
  const [colors, setColors] = useState<Record<string, number>>({});
  useEffect(() => { loadScript(client).then(({ data }) => setColors(data.colors ?? {}), () => {}); }, [client]);
  async function paint(id: string, h: number | null) {
    const next = { ...colors };
    if (h === null) delete next[id]; else next[id] = h;
    setColors(next); setError('');
    try {
      // Colours of folders that no longer exist are dropped on the way.
      await saveScript(client, boxes, (d) => ({ ...d, colors: Object.fromEntries(Object.entries({ ...d.colors, [id]: h }).filter(([k, v]) => v !== null && boxes.some((b) => b.id === k))) as Record<string, number> }));
      onChanged();
    } catch (e) { setError((e as Error).message); }
  }
  async function run(f: () => Promise<unknown>) {
    setError('');
    try { await f(); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  return (
    <section>
      <h3>{t('folders.title')}</h3>
      {mine.length === 0 ? <p className="fine">{t('folders.empty')}</p> : (
        <ul className="rule-list">
          {mine.map((b) => (
            <li key={b.id} style={{ paddingLeft: `calc(var(--s3) + ${b.depth ?? 0} * var(--s5))` }}>
              <span className="grow">{b.name}</span>
              <span className="row-btns">
                <Menu label={t('folders.colourTitle')} align="right" button={
                  <button type="button" className="hue-btn" aria-label={t('folders.colour', { name: b.name })} title={t('folders.colour', { name: b.name })}>
                    <span className="hue-dot" style={{ '--h': colors[b.id] ?? hue(b.name) } as React.CSSProperties} />
                  </button>}>
                  {(close) => <>
                    <p className="menu-title">{t('folders.colourTitle')}</p>
                    <div className="hue-grid">
                      {FOLDER_HUES.map(([h, name]) => (
                        <button key={h} type="button" role="menuitemradio" aria-checked={colors[b.id] === h} className={`hue-btn${colors[b.id] === h ? ' on' : ''}`}
                          aria-label={t(name)} title={t(name)} onClick={() => { close(); paint(b.id, h); }}><span className="hue-dot" style={{ '--h': h } as React.CSSProperties} /></button>
                      ))}
                    </div>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => { close(); paint(b.id, null); }}><Icon name={colors[b.id] === undefined ? 'check' : 'clearFormat'} size={16} />{t('folders.colourAuto')}</button>
                  </>}
                </Menu>
                <select className="input input--sm" aria-label={t('folders.putInside', { name: b.name })} value={b.parentId ?? ''}
                  onChange={(e) => run(() => client.moveMailbox(b.id, e.target.value || null))}>
                  <option value="">{t('folders.topLevel')}</option>
                  {mine.filter((p) => p.id !== b.id && !(p.path ?? '').startsWith(`${b.path}/`)).map((p) => <option key={p.id} value={p.id}>{t('folders.inside', { path: p.path ?? p.name })}</option>)}
                </select>
                <Button variant="quiet" size="sm" icon="person" label={t('folders.share', { name: b.name })} pressed={sharing === b.id} onClick={() => setSharing(sharing === b.id ? null : b.id)} />
                <Button variant="quiet" size="sm" icon="folder" label={t('folders.newInside', { name: b.name })} onClick={async () => {
                  const name = await promptIt({ title: t('folders.newInsideTitle', { name: b.name }), label: t('folders.name'), confirm: t('folders.create') });
                  if (name) run(() => client.createMailbox(name, b.id));
                }} />
                <Button variant="quiet" size="sm" icon="compose" label={t('folders.rename', { name: b.name })} onClick={async () => {
                  const name = await promptIt({ title: t('folders.renameTitle', { name: b.name }), label: t('folders.newName'), value: b.name, confirm: t('folders.renameConfirm') });
                  if (name && name !== b.name) run(() => client.renameMailbox(b.id, name));
                }} />
                <Button variant="quiet" size="sm" icon="trash" label={t('folders.delete', { name: b.name })} onClick={async () => {
                  if (mine.some((x) => x.parentId === b.id)) return setError(t('folders.hasChildren', { name: b.name }));
                  if (await confirmIt({ title: t('folders.deleteTitle', { name: b.name }), body: t('folders.deleteBody'), confirm: t('folders.deleteConfirm'), danger: true })) run(() => client.deleteMailbox(b.id));
                }} />
              </span>
              {sharing === b.id && <ShareFolder client={client} box={b} onDone={() => {}} />}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
