import { useEffect, useState } from 'react';
import { confirmIt, promptIt } from './Dialog';
import { Button } from './Button';
import type { Jmap, Mailbox } from './jmap';
import { describeRule, parseScript, toSieve, validateRule, type Rule, type RuleAction, type ScriptData } from './rules';

const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: 'move', label: 'Move to folder' }, { value: 'read', label: 'Mark as read' }, { value: 'star', label: 'Star it' },
  { value: 'trash', label: 'Delete it' }, { value: 'block', label: 'Block (send to Junk)' }, { value: 'forward', label: 'Forward to…' },
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
    } catch (e) { setError(`Couldn’t save filters: ${(e as Error).message}`); return false; }
  }

  async function add() {
    if (!draft) return;
    const problem = validateRule(draft);
    if (problem) return setError(problem);
    if (await save([...(rules ?? []), draft])) setDraft(null);
  }

  const set = (patch: Partial<Rule>) => setDraft((d) => d && { ...d, ...patch });

  return (
    <section>
      <h3>Filters</h3>
      <p className="fine">Filters run on the mail server as messages arrive, so they work even when this app is closed.</p>
      {rules === null ? <p className="fine">Loading…</p> : rules.length === 0 && !draft ? <p className="fine">No filters yet.</p> : (
        <ul className="rule-list">
          {rules.map((r) => (
            <li key={r.id}>
              <span>{describeRule(r)}</span>
              <Button variant="quiet" size="sm" icon="trash" label="Delete filter" onClick={() => save(rules.filter((x) => x.id !== r.id))} />
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <div className="rule-form">
          <div className="row3">
            <label>From contains<input className="input" value={draft.from ?? ''} onChange={(e) => set({ from: e.target.value })} placeholder="news@shop.com or shop.com" /></label>
            <label>To contains<input className="input" value={draft.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label>
            <label>Subject contains<input className="input" value={draft.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} /></label>
          </div>
          <div className="row3">
            <label>Then<select className="input" value={draft.action} onChange={(e) => set({ action: e.target.value as RuleAction })}>
              {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select></label>
            {draft.action === 'move' && (
              <label>Folder<select className="input" value={draft.folder ?? ''} onChange={(e) => set({ folder: e.target.value })}>
                <option value="" disabled>Choose a folder</option>
                {folders.map((f) => <option key={f.id} value={f.path ?? f.name}>{f.path ?? f.name}</option>)}
              </select></label>
            )}
            {draft.action === 'forward' && (
              <label>Forward to<input className="input" type="email" value={draft.forwardTo ?? ''} onChange={(e) => set({ forwardTo: e.target.value })} /></label>
            )}
          </div>
          <div className="actions">
            <Button size="sm" onClick={() => { setDraft(null); setError(''); }}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={add}>Add filter</Button>
          </div>
        </div>
      ) : <Button size="sm" icon="compose" className="start" onClick={() => setDraft({ id: crypto.randomUUID(), action: 'move' })}>New filter</Button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export function FoldersSection({ client, boxes, onChanged }: { client: Jmap; boxes: Mailbox[]; onChanged: () => void }) {
  const mine = boxes.filter((b) => !b.role);
  const [error, setError] = useState('');
  async function run(f: () => Promise<unknown>) {
    setError('');
    try { await f(); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  return (
    <section>
      <h3>Folders</h3>
      {mine.length === 0 ? <p className="fine">Folders you create (from Move to → New folder) appear here.</p> : (
        <ul className="rule-list">
          {mine.map((b) => (
            <li key={b.id} style={{ paddingLeft: `calc(var(--s3) + ${b.depth ?? 0} * var(--s5))` }}>
              <span className="grow">{b.name}</span>
              <span className="row-btns">
                <select className="input input--sm" aria-label={`Put ${b.name} inside`} value={b.parentId ?? ''}
                  onChange={(e) => run(() => client.moveMailbox(b.id, e.target.value || null))}>
                  <option value="">Top level</option>
                  {mine.filter((p) => p.id !== b.id && !(p.path ?? '').startsWith(`${b.path}/`)).map((p) => <option key={p.id} value={p.id}>Inside {p.path}</option>)}
                </select>
                <Button variant="quiet" size="sm" icon="folder" label={`New folder inside ${b.name}`} onClick={async () => {
                  const name = await promptIt({ title: `New folder inside “${b.name}”`, label: 'Folder name', confirm: 'Create folder' });
                  if (name) run(() => client.createMailbox(name, b.id));
                }} />
                <Button variant="quiet" size="sm" icon="compose" label={`Rename ${b.name}`} onClick={async () => {
                  const name = await promptIt({ title: `Rename “${b.name}”`, label: 'New name', value: b.name, confirm: 'Rename' });
                  if (name && name !== b.name) run(() => client.renameMailbox(b.id, name));
                }} />
                <Button variant="quiet" size="sm" icon="trash" label={`Delete ${b.name}`} onClick={async () => {
                  if (mine.some((x) => x.parentId === b.id)) return setError(`“${b.name}” has folders inside it. Move or delete those first.`);
                  if (await confirmIt({ title: `Delete the folder “${b.name}”?`, body: 'Messages that are only in this folder are deleted too.', confirm: 'Delete folder', danger: true })) run(() => client.deleteMailbox(b.id));
                }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
