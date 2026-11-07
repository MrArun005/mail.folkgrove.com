import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';

/**
 * How long mail is kept. The person's own setting lives in Settings; the server-wide rules, per-account rules and legal
 * hold are the admin console's Retention tab. Both talk to the account service (signup/retention.mjs).
 */
type Mine = { trashDays: number | null; serverTrashDays: number | null; maxAgeDays: number | null; held: boolean };
const years = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

/** Settings → Trash and Junk: empty them sooner than the server does. Saves immediately. */
export function RetentionSection({ client }: { client: Jmap }) {
  const [r, setR] = useState<Mine | null | 'off'>(null);
  const [note, setNote] = useState('');
  useEffect(() => { client.retention().then((x) => setR(x ?? 'off'), () => setR('off')); }, [client]);
  if (r === 'off') return null; // no account service on this server
  const server = r?.serverTrashDays ?? null;
  const choices = [1, 7, 14, 30].filter((d) => server === null || d < server);
  async function change(v: string) {
    const days = v ? Number(v) : null;
    setNote('Saving…');
    try { setR(await client.retention(days)); setNote(days ? `Saved. Mail in Trash and Junk is removed after ${days} day${days === 1 ? '' : 's'}.` : 'Saved.'); }
    catch (e) { setNote(`Couldn’t change this: ${(e as Error).message}`); }
  }
  return (
    <section>
      <h3>Trash and Junk</h3>
      <label>Empty Trash and Junk automatically
        <select className="input" value={r?.trashDays ?? ''} disabled={!r} onChange={(e) => change(e.target.value)}>
          <option value="">{server ? `After ${server} days (server default)` : 'Never (server default)'}</option>
          {choices.map((d) => <option key={d} value={d}>After {d} day{d === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <p className="fine">
        {note || 'Counted from when the message arrived, so old mail you delete goes at the next nightly clean-up.'}
        {r && r.maxAgeDays ? ` Your organisation also deletes mail older than ${years(r.maxAgeDays)}.` : ''}
        {r && r.held ? ' Your account is on hold, so nothing is deleted for good right now.' : ''}
      </p>
    </section>
  );
}

interface Row { id: string; email: string; held: boolean; maxAgeDays: number | null; trashDays: number | null }
interface View { trashJunkDays: number | null; maxAgeDays: number | null; accounts: Row[] }
interface Preview { accounts: { email: string; held: boolean; old: number; trash: number }[]; messages: number }
const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await notify('That didn’t work', (e as Error).message); } };
const summary = (p: Preview) => {
  const hit = p.accounts.filter((a) => a.old + a.trash > 0);
  return p.messages === 0 ? 'Nothing would be deleted right now.'
    : `${p.messages} message${p.messages === 1 ? '' : 's'} in ${hit.length} account${hit.length === 1 ? '' : 's'} (${hit.slice(0, 5).map((a) => a.email).join(', ')}${hit.length > 5 ? ', …' : ''}).`;
};

/** Admin console → Retention. */
export function RetentionAdmin({ client }: { client: Jmap }) {
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [trash, setTrash] = useState('');
  const [maxYears, setMaxYears] = useState('');
  const [who, setWho] = useState('');
  const load = (x?: View) => (x ? Promise.resolve(x) : client.admin<View>('retention')).then((d) => {
    setV(d); setError(''); setTrash(String(d.trashJunkDays ?? 0)); setMaxYears(d.maxAgeDays ? String(+(d.maxAgeDays / 365).toFixed(2)) : '0');
  }, (e) => setError((e as Error).message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveTrash(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(trash);
    if (!Number.isInteger(n) || n < 0) return notify('That isn’t a number of days', 'Enter whole days, like 30. Enter 0 to never empty them automatically.');
    await act(async () => load(await client.admin<View>('retention', 'PUT', { trashJunkDays: n })));
  }
  /** Any rule that deletes mail: show the dry-run count first, then save. */
  async function saveMaxAge(e: React.FormEvent) {
    e.preventDefault();
    const y = Number(maxYears);
    if (!(y >= 0)) return notify('That isn’t a number of years', 'Enter years, like 7. Enter 0 to keep mail forever.');
    const maxAgeDays = y === 0 ? null : Math.max(30, Math.round(y * 365));
    await act(async () => {
      if (maxAgeDays) {
        const p = await client.admin<Preview>('retention/preview', 'POST', { maxAgeDays });
        if (!(await confirmIt({ title: `Delete mail older than ${years(maxAgeDays)} in every account?`,
          body: `If it ran now: ${summary(p)} It runs every night from now on. Deleted mail can’t be brought back. Accounts on hold and accounts set to “keep forever” are skipped.`,
          confirm: 'Save rule', danger: true }))) return;
      }
      load(await client.admin<View>('retention', 'PUT', { maxAgeDays }));
    });
  }
  async function account(): Promise<string | null> {
    const name = who.trim().toLowerCase();
    if (!name) { await notify('Which account?', 'Enter a username or full address.'); return null; }
    const r = await client.admin<{ users: { id: string; name: string; email: string }[] }>(`users?q=${encodeURIComponent(name)}`);
    const u = r.users.find((x) => x.email.toLowerCase() === name || x.name.toLowerCase() === name.replace(/@.*$/, ''));
    if (!u) { await notify('No such account', `There is no account called “${name}”.`); return null; }
    return u.id;
  }
  const patch = (id: string, body: object) => act(async () => load(await client.admin<View>(`retention/${id}`, 'PATCH', body)));
  async function hold(id: string, email: string, on: boolean) {
    if (on && !(await confirmIt({ title: `Put ${email} on legal hold?`, body: 'Nothing in this account can be deleted for good: not by its owner, not by retention rules, and the account itself can’t be deleted. They can still read, send and move mail.', confirm: 'Put on hold' }))) return;
    await patch(id, { hold: on });
  }
  async function ownRule(id: string, email: string, current: number | null) {
    const val = await promptIt({ title: `Mail age limit for ${email}`, body: 'Delete this account’s mail older than this many years. 0 keeps it forever. Leave empty to follow the server rule.',
      label: 'Years', value: current === null ? '' : String(+(current / 365).toFixed(2)), confirm: 'Next' });
    if (val === null) return;
    const y = val.trim() === '' ? null : Number(val);
    if (y !== null && !(y >= 0)) return notify('That isn’t a number of years', 'Enter years, like 7, or 0 to keep forever.');
    const maxAgeDays = y === null ? null : y === 0 ? 0 : Math.max(30, Math.round(y * 365));
    await act(async () => {
      if (maxAgeDays) {
        const p = await client.admin<Preview>('retention/preview', 'POST', { accountId: id, accountMaxAgeDays: maxAgeDays });
        if (!(await confirmIt({ title: `Delete ${email}’s mail older than ${years(maxAgeDays)}?`, body: `If it ran now: ${summary(p)} Deleted mail can’t be brought back.`, confirm: 'Save rule', danger: true }))) return;
      }
      load(await client.admin<View>(`retention/${id}`, 'PATCH', { maxAgeDays }));
    });
  }
  async function runNow() {
    await act(async () => {
      const p = await client.admin<Preview>('retention/preview', 'POST', {});
      if (!p.messages) return notify('Nothing to delete', 'No mail is past its limit right now.');
      if (!(await confirmIt({ title: 'Run the clean-up now?', body: `This deletes ${summary(p)} Deleted mail can’t be brought back.`, confirm: 'Delete now', danger: true }))) return;
      const r = await client.admin<Preview>('retention/run', 'POST', {});
      await notify('Clean-up done', `${r.messages} message${r.messages === 1 ? '' : 's'} deleted.`);
    });
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!v) return <p className="fine">Loading…</p>;
  const held = v.accounts.some((a) => a.held);
  return <>
    <section>
      <h2>Trash and Junk</h2>
      <p className="fine">The mail server empties every account’s Trash and Junk after this many days. People can choose a shorter time in their own Settings.</p>
      <form className="admin-bar" onSubmit={saveTrash}>
        <label className="narrow">Days<input className="input" inputMode="numeric" value={trash} onChange={(e) => setTrash(e.target.value)} /></label>
        <Button type="submit">Save</Button>
      </form>
      {held && v.trashJunkDays !== null && <p className="banner banner--info" role="note">An account is on legal hold, but the mail server still empties its Trash and Junk after {v.trashJunkDays} days (this can’t be set per account). Set Days to 0 to keep them while the hold lasts.</p>}
    </section>
    <section>
      <h2>Delete old mail</h2>
      <p className="fine">Delete mail older than this, in every account, every night. 0 keeps mail forever. You’ll see how much would go before anything is saved.</p>
      <form className="admin-bar" onSubmit={saveMaxAge}>
        <label className="narrow">Years<input className="input" inputMode="decimal" value={maxYears} onChange={(e) => setMaxYears(e.target.value)} /></label>
        <Button type="submit">Save</Button>
        <Button variant="quiet" onClick={runNow}>Run clean-up now</Button>
      </form>
    </section>
    <section>
      <h2>Accounts</h2>
      <p className="fine">Give one account its own limit, or put it on legal hold: nothing in it can then be deleted for good, by anyone, until you release it.</p>
      <form className="admin-bar" onSubmit={async (e) => { e.preventDefault(); const id = await account(); if (id) await hold(id, who.trim(), true); }}>
        <input className="input" placeholder="username or full address" aria-label="Account" value={who} onChange={(e) => setWho(e.target.value)} />
        <Button type="submit">Put on legal hold</Button>
        <Button variant="quiet" onClick={async () => { const id = await account(); if (id) await ownRule(id, who.trim(), null); }}>Set its own limit</Button>
      </form>
      {v.accounts.length === 0 ? <p className="empty">No account has its own rule or a hold.</p> : (
        <table className="admin-table">
          <thead><tr><th>Account</th><th>Mail age limit</th><th>Trash and Junk</th><th>Hold</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {v.accounts.map((a) => (
              <tr key={a.id}>
                <td data-label="Account"><b>{a.email}</b></td>
                <td data-label="Mail age limit">{a.maxAgeDays === null ? 'Server rule' : a.maxAgeDays === 0 ? 'Keep forever' : years(a.maxAgeDays)}</td>
                <td data-label="Trash and Junk">{a.trashDays ? `${a.trashDays} days (their choice)` : 'Server default'}</td>
                <td data-label="Hold">{a.held ? <span className="pill pill--warn">Legal hold</span> : '–'}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={() => ownRule(a.id, a.email, a.maxAgeDays)}>Change limit</Button>
                  <Button size="sm" variant="quiet" onClick={() => hold(a.id, a.email, !a.held)}>{a.held ? 'Release hold' : 'Put on hold'}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </>;
}
