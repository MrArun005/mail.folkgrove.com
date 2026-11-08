import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';
import { t } from './i18n';

/**
 * How long mail is kept. The person's own setting lives in Settings; the server-wide rules, per-account rules and legal
 * hold are the admin console's Retention tab. Both talk to the account service (signup/retention.mjs).
 */
type Mine = { trashDays: number | null; serverTrashDays: number | null; maxAgeDays: number | null; held: boolean };
const years = (d: number) => (d % 365 === 0 ? t('retention.nYears', { count: d / 365 }) : t('retention.nDays', { count: d }));

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
    setNote(t('common.saving'));
    try { setR(await client.retention(days)); setNote(days ? t('retention.savedDays', { count: days }) : t('retention.saved')); }
    catch (e) { setNote(t('common.couldntChange', { error: (e as Error).message })); }
  }
  return (
    <section>
      <h3>{t('retention.title')}</h3>
      <label>{t('retention.empty')}
        <select className="input" value={r?.trashDays ?? ''} disabled={!r} onChange={(e) => change(e.target.value)}>
          <option value="">{server ? t('retention.afterDefault', { count: server }) : t('retention.never')}</option>
          {choices.map((d) => <option key={d} value={d}>{t('retention.after', { count: d })}</option>)}
        </select>
      </label>
      <p className="fine">
        {note || t('retention.note')}
        {r && r.maxAgeDays ? ` ${t('retention.orgMax', { age: years(r.maxAgeDays) })}` : ''}
        {r && r.held ? ` ${t('retention.youHeld')}` : ''}
      </p>
    </section>
  );
}

interface Row { id: string; email: string; held: boolean; maxAgeDays: number | null; trashDays: number | null }
interface View { trashJunkDays: number | null; maxAgeDays: number | null; accounts: Row[] }
interface Preview { accounts: { email: string; held: boolean; old: number; trash: number }[]; messages: number }
const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await notify(t('retention.failed'), (e as Error).message); } };
const summary = (p: Preview) => {
  const hit = p.accounts.filter((a) => a.old + a.trash > 0);
  return p.messages === 0 ? t('retention.nothing')
    : t('retention.summary', { messages: t('common.messages', { count: p.messages }), accounts: t('retention.nAccounts', { count: hit.length }),
      list: `${hit.slice(0, 5).map((a) => a.email).join(', ')}${hit.length > 5 ? ', …' : ''}` });
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
    if (!Number.isInteger(n) || n < 0) return notify(t('retention.notDays'), t('retention.notDaysBody'));
    await act(async () => load(await client.admin<View>('retention', 'PUT', { trashJunkDays: n })));
  }
  /** Any rule that deletes mail: show the dry-run count first, then save. */
  async function saveMaxAge(e: React.FormEvent) {
    e.preventDefault();
    const y = Number(maxYears);
    if (!(y >= 0)) return notify(t('retention.notYears'), t('retention.notYearsBody'));
    const maxAgeDays = y === 0 ? null : Math.max(30, Math.round(y * 365));
    await act(async () => {
      if (maxAgeDays) {
        const p = await client.admin<Preview>('retention/preview', 'POST', { maxAgeDays });
        if (!(await confirmIt({ title: t('retention.maxAgeTitle', { age: years(maxAgeDays) }),
          body: t('retention.maxAgeBody', { summary: summary(p) }),
          confirm: t('retention.saveRule'), danger: true }))) return;
      }
      load(await client.admin<View>('retention', 'PUT', { maxAgeDays }));
    });
  }
  async function account(): Promise<string | null> {
    const name = who.trim().toLowerCase();
    if (!name) { await notify(t('retention.which'), t('retention.whichBody')); return null; }
    const r = await client.admin<{ users: { id: string; name: string; email: string }[] }>(`users?q=${encodeURIComponent(name)}`);
    const u = r.users.find((x) => x.email.toLowerCase() === name || x.name.toLowerCase() === name.replace(/@.*$/, ''));
    if (!u) { await notify(t('retention.noAccount'), t('retention.noAccountBody', { name })); return null; }
    return u.id;
  }
  const patch = (id: string, body: object) => act(async () => load(await client.admin<View>(`retention/${id}`, 'PATCH', body)));
  async function hold(id: string, email: string, on: boolean) {
    if (on && !(await confirmIt({ title: t('retention.holdTitle', { email }), body: t('retention.holdBody'), confirm: t('retention.putOnHold') }))) return;
    await patch(id, { hold: on });
  }
  async function ownRule(id: string, email: string, current: number | null) {
    const val = await promptIt({ title: t('retention.ownTitle', { email }), body: t('retention.ownBody'),
      label: t('retention.yearsLabel'), value: current === null ? '' : String(+(current / 365).toFixed(2)), confirm: t('retention.next') });
    if (val === null) return;
    const y = val.trim() === '' ? null : Number(val);
    if (y !== null && !(y >= 0)) return notify(t('retention.notYears'), t('retention.notYearsOwn'));
    const maxAgeDays = y === null ? null : y === 0 ? 0 : Math.max(30, Math.round(y * 365));
    await act(async () => {
      if (maxAgeDays) {
        const p = await client.admin<Preview>('retention/preview', 'POST', { accountId: id, accountMaxAgeDays: maxAgeDays });
        if (!(await confirmIt({ title: t('retention.ownConfirmTitle', { email, age: years(maxAgeDays) }), body: t('retention.ownConfirmBody', { summary: summary(p) }), confirm: t('retention.saveRule'), danger: true }))) return;
      }
      load(await client.admin<View>(`retention/${id}`, 'PATCH', { maxAgeDays }));
    });
  }
  async function runNow() {
    await act(async () => {
      const p = await client.admin<Preview>('retention/preview', 'POST', {});
      if (!p.messages) return notify(t('retention.nothingToDelete'), t('retention.nothingToDeleteBody'));
      if (!(await confirmIt({ title: t('retention.runTitle'), body: t('retention.runBody', { summary: summary(p) }), confirm: t('retention.deleteNow'), danger: true }))) return;
      const r = await client.admin<Preview>('retention/run', 'POST', {});
      await notify(t('retention.doneTitle'), t('retention.doneBody', { count: r.messages }));
    });
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!v) return <p className="fine">{t('common.loading')}</p>;
  const held = v.accounts.some((a) => a.held);
  return <>
    <section>
      <h2>{t('retention.title')}</h2>
      <p className="fine">{t('retention.serverNote')}</p>
      <form className="admin-bar" onSubmit={saveTrash}>
        <label className="narrow">{t('retention.daysLabel')}<input className="input" inputMode="numeric" value={trash} onChange={(e) => setTrash(e.target.value)} /></label>
        <Button type="submit">{t('common.save')}</Button>
      </form>
      {held && v.trashJunkDays !== null && <p className="banner banner--info" role="note">{t('retention.heldBanner', { count: v.trashJunkDays })}</p>}
    </section>
    <section>
      <h2>{t('retention.deleteOld')}</h2>
      <p className="fine">{t('retention.deleteOldNote')}</p>
      <form className="admin-bar" onSubmit={saveMaxAge}>
        <label className="narrow">{t('retention.yearsLabel')}<input className="input" inputMode="decimal" value={maxYears} onChange={(e) => setMaxYears(e.target.value)} /></label>
        <Button type="submit">{t('common.save')}</Button>
        <Button variant="quiet" onClick={runNow}>{t('retention.runNow')}</Button>
      </form>
    </section>
    <section>
      <h2>{t('retention.accounts')}</h2>
      <p className="fine">{t('retention.accountsNote')}</p>
      <form className="admin-bar" onSubmit={async (e) => { e.preventDefault(); const id = await account(); if (id) await hold(id, who.trim(), true); }}>
        <input className="input" placeholder={t('retention.accountPlaceholder')} aria-label={t('retention.account')} value={who} onChange={(e) => setWho(e.target.value)} />
        <Button type="submit">{t('retention.putOnLegalHold')}</Button>
        <Button variant="quiet" onClick={async () => { const id = await account(); if (id) await ownRule(id, who.trim(), null); }}>{t('retention.setOwn')}</Button>
      </form>
      {v.accounts.length === 0 ? <p className="empty">{t('retention.noRules')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('retention.account')}</th><th>{t('retention.ageLimit')}</th><th>{t('retention.title')}</th><th>{t('retention.hold')}</th><th><span className="sr">{t('retention.actions')}</span></th></tr></thead>
          <tbody>
            {v.accounts.map((a) => (
              <tr key={a.id}>
                <td data-label={t('retention.account')}><b>{a.email}</b></td>
                <td data-label={t('retention.ageLimit')}>{a.maxAgeDays === null ? t('retention.serverRule') : a.maxAgeDays === 0 ? t('retention.keepForever') : years(a.maxAgeDays)}</td>
                <td data-label={t('retention.title')}>{a.trashDays ? t('retention.theirChoice', { count: a.trashDays }) : t('retention.serverDefault')}</td>
                <td data-label={t('retention.hold')}>{a.held ? <span className="pill pill--warn">{t('retention.legalHold')}</span> : '–'}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={() => ownRule(a.id, a.email, a.maxAgeDays)}>{t('retention.changeLimit')}</Button>
                  <Button size="sm" variant="quiet" onClick={() => hold(a.id, a.email, !a.held)}>{a.held ? t('retention.release') : t('retention.putOnHold')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </>;
}
