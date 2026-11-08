import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';
import { RetentionAdmin } from './Retention';
import { locale, t } from './i18n';

/**
 * Admin console (/admin): users, blocked addresses and new-account limits, and the outgoing queue. Every call goes
 * to the account service (signup/admin.mjs), which checks that the signed-in account is on its ADMINS list.
 */
type Tab = 'overview' | 'users' | 'teams' | 'limits' | 'queue' | 'held' | 'domains' | 'abuse' | 'retention';
const TABS = [['overview', 'admin.tabOverview'], ['users', 'admin.tabUsers'], ['teams', 'admin.tabTeams'], ['limits', 'admin.tabLimits'], ['queue', 'admin.tabQueue'], ['held', 'admin.tabHeld'], ['domains', 'admin.tabDomains'], ['abuse', 'admin.tabAbuse'], ['retention', 'admin.tabRetention']] as const;

interface User { id: string; name: string; email: string; description: string; createdAt: string; used: number; quota: number | null; aliases: number; enabled: boolean; sending: boolean; admin: boolean; newAccount: boolean }
interface Held { id: string; at: string; login: string; from: string; to: string[]; subject: string; size: number; score: number; reasons: string[] }
interface Blocked { id: string; address: string; reason: string; createdAt: string; expiresAt: string | null }
interface Queued { id: string; from: string; createdAt: string; nextRetry: string | null; size: number; recipients: { to: string; status: string; attempts: number; nextAttempt: string | null; error: string | null; code: string | null }[] }

const GB = 1024 ** 3;
const one = (n: number) => n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const size = (b: number) => b >= GB ? `${one(b / GB)} GB` : b >= 1024 ** 2 ? `${one(b / 1024 ** 2)} MB` : `${Math.ceil(b / 1024).toLocaleString(locale())} KB`;
const when = (d: string | null) => (d ? new Date(d).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '');
const REASONS = { authFailure: 'admin.reasonAuthFailure', rcptToFailure: 'admin.reasonRcptToFailure', loitering: 'admin.reasonLoitering', portScanning: 'admin.reasonPortScanning', manual: 'admin.reasonManual', other: 'admin.reasonOther' } as const;
const DOMAIN_STATE = { active: 'admin.stateWorking', missing: 'admin.stateMissing', paused: 'admin.statePaused' } as const;
const STATUS = { Scheduled: 'admin.statusWaiting', TemporaryFailure: 'admin.statusRetrying', PermanentFailure: 'admin.statusFailed', Completed: 'admin.statusDelivered' } as const;
/** A server code's words, or the code itself when we don't know it. */
const named = <M extends Record<string, Parameters<typeof t>[0]>>(map: M, code: string) => (code in map ? t(map[code as keyof M]) : code);

/** Load once and on demand; errors become a message instead of a broken page. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = () => load().then((d) => { setData(d); setError(''); }, (e) => setError((e as Error).message));
  useEffect(() => { reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload };
}
/** Run an action; show what went wrong in a dialog. */
const act = async (fn: () => Promise<unknown>, then?: () => unknown) => {
  try { await fn(); await then?.(); } catch (e) { await notify(t('admin.didntWork'), (e as Error).message); }
};

export function Admin({ client }: { client: Jmap }) {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="admin">
      <header className="admin-head">
        <p className="wordmark">OpenMail</p>
        <h1>{t('admin.title')}</h1>
        <span className="fine grow">{client.username}</span>
        <Button size="sm" onClick={() => location.assign('/')}>{t('login.backToMail')}</Button>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{t(label)}</button>)}
      </nav>
      <main>
        {tab === 'overview' && <Overview client={client} go={setTab} />}
        {tab === 'users' && <Users client={client} />}
        {tab === 'teams' && <Teams client={client} />}
        {tab === 'limits' && <><BlockedIps client={client} /><NewAccounts client={client} /></>}
        {tab === 'queue' && <Queue client={client} />}
        {tab === 'domains' && <Domains client={client} />}
        {tab === 'abuse' && <><Suspended client={client} /><Inactive client={client} /></>}
        {tab === 'held' && <HeldMail client={client} />}
        {tab === 'retention' && <RetentionAdmin client={client} />}
      </main>
    </div>
  );
}

function Overview({ client, go }: { client: Jmap; go: (tab: Tab) => void }) {
  const { data, error } = useLoad(() => client.admin<{ accounts: number; queued: number; blockedIps: number; newAccounts: number; suspended: number; held: number | null }>('overview'));
  if (error) return <p className="error" role="alert">{error}</p>;
  const stats: [string, number | undefined, Tab][] = [[t('admin.statAccounts'), data?.accounts, 'users'], [t('admin.statQueued'), data?.queued, 'queue'],
    [t('admin.blockedIps'), data?.blockedIps, 'limits'], [t('admin.statNewAccounts'), data?.newAccounts, 'limits'], [t('admin.sendingSuspended'), data?.suspended, 'abuse'],
    ...(data?.held != null ? [[t('admin.statHeld'), data.held, 'held'] as [string, number, Tab]] : [])];
  return (
    <section>
      <div className="stats">
        {stats.map(([label, n, tab]) => (
          <div key={label} className="stat">
            <span className="num">{n ?? '–'}</span>
            <span className="fine">{label}</span>
            <Button variant="link" onClick={() => go(tab)}>{t('admin.open')}</Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Users({ client }: { client: Jmap }) {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, reload } = useLoad(() => client.admin<{ users: User[]; total: number }>(`users?q=${encodeURIComponent(search)}`), [search]);
  const [name, setName] = useState('');
  const [gb, setGb] = useState('1');
  const [msg, setMsg] = useState('');
  const patch = (u: User, body: object) => client.admin<{ user: User; password?: string }>(`users/${u.id}`, 'PATCH', body);
  const showPassword = (email: string, password: string) =>
    notify(t('admin.newPasswordTitle', { email, password }), t('admin.newPasswordBody'));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const limit = Number(gb);
    if (!name.trim()) return setMsg(t('admin.enterUsername'));
    if (!(limit >= 0)) return setMsg(t('admin.enterLimit'));
    setMsg('');
    await act(async () => {
      const r = await client.admin<{ user: User; password: string }>('users', 'POST', { name: name.trim(), quotaBytes: Math.round(limit * GB) });
      setName('');
      await showPassword(r.user.email, r.password);
    }, reload);
  }

  return (
    <section>
      <form className="admin-bar" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <input className="input" type="search" placeholder={t('admin.searchUsersPlaceholder')} aria-label={t('admin.searchUsers')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">{t('admin.search')}</Button>
      </form>
      <form className="admin-bar" onSubmit={create}>
        <label>{t('admin.newAccount')}<input className="input" placeholder={t('admin.usernamePlaceholder')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="narrow">{t('admin.storageGb')}<input className="input" inputMode="decimal" value={gb} onChange={(e) => setGb(e.target.value)} /></label>
        <Button type="submit" variant="primary">{t('admin.createAccount')}</Button>
      </form>
      {msg && <p className="error" role="alert">{msg}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.users.length === 0 ? <p className="empty">{t('admin.noUsersMatch', { query: search })}</p> : <>
        <p className="fine">{data.total > data.users.length ? t('admin.showing', { shown: data.users.length, total: data.total }) : t('admin.accounts', { count: data.total })}</p>
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAccount')}</th><th>{t('admin.colCreated')}</th><th className="n">{t('admin.colStorage')}</th><th className="n">{t('admin.colAddresses')}</th><th>{t('admin.colStatus')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td data-label={t('admin.colAccount')}><b>{u.email}</b>{u.description && <span className="fine"> {u.description}</span>}</td>
                <td data-label={t('admin.colCreated')}>{when(u.createdAt)}</td>
                <td data-label={t('admin.colStorage')} className="n">{u.quota ? t('admin.usedOf', { used: size(u.used), quota: size(u.quota) }) : size(u.used)}</td>
                <td data-label={t('admin.colAddresses')} className="n">{u.aliases}</td>
                <td data-label={t('admin.colStatus')}>
                  <span className={u.enabled ? 'pill on' : 'pill'}>{u.enabled ? t('admin.active') : t('admin.disabled')}</span>
                  {!u.sending && <span className="pill pill--warn">{t('admin.sendingPaused')}</span>}
                  {u.newAccount && <span className="pill pill--warn">{t('admin.newAccountLimits')}</span>}
                  {!u.sending && <span className="pill pill--warn">{t('admin.sendingSuspended')}</span>}
                  {u.admin && <span className="pill">{t('admin.serverAdmin')}</span>}
                </td>
                <td className="acts">
                  {!u.admin && <>
                    <Button size="sm" variant="quiet" onClick={async () => {
                      if (!(await confirmIt({ title: t('admin.resetTitle', { email: u.email }), body: t('admin.resetBody'), confirm: t('admin.resetPassword'), danger: true }))) return;
                      await act(async () => { const r = await patch(u, { resetPassword: true }); await showPassword(u.email, r.password!); });
                    }}>{t('admin.resetPassword')}</Button>
                    <Button size="sm" variant="quiet" onClick={async () => {
                      const v = await promptIt({ title: t('admin.storageTitle', { email: u.email }), body: t('admin.storageBody', { used: size(u.used) }), label: t('admin.limitGb'), value: u.quota ? String(+(u.quota / GB).toFixed(2)) : '0', confirm: t('admin.setLimit') });
                      if (v === null) return;
                      const n = Number(v);
                      if (!(n >= 0)) return notify(t('admin.notNumber'), t('admin.notNumberBody'));
                      await act(() => patch(u, { quotaBytes: n === 0 ? null : Math.round(n * GB) }), reload);
                    }}>{t('admin.setStorage')}</Button>
                    {u.sending
                      ? <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: t('admin.pauseTitle', { email: u.email }), body: t('admin.pauseBody'), confirm: t('admin.pauseSending'), danger: true }))
                            await act(() => patch(u, { sending: false }), reload);
                        }}>{t('admin.pauseSending')}</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { sending: true }), reload)}>{t('admin.letSend')}</Button>}
                    {u.enabled
                      ? <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: t('admin.disableTitle', { email: u.email }), body: t('admin.disableBody'), confirm: t('admin.disable'), danger: true }))
                            await act(() => patch(u, { enabled: false }), reload);
                        }}>{t('admin.disable')}</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { enabled: true }), reload)}>{t('admin.enable')}</Button>}
                    {u.sending
                      ? <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: t('admin.suspendTitle', { email: u.email }), body: t('admin.suspendBody'), confirm: t('admin.suspendSending'), danger: true }))
                            await act(() => patch(u, { sending: false }), reload);
                        }}>{t('admin.suspendSending')}</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { sending: true }), reload)}>{t('admin.allowSending')}</Button>}
                    <Button size="sm" variant="quiet" icon="trash" label={t('admin.deleteLabel', { email: u.email })} onClick={async () => {
                      if (await confirmIt({ title: t('admin.deleteTitle', { email: u.email }), body: t('admin.deleteUserBody'), confirm: t('admin.deleteAccount'), danger: true }))
                        await act(() => client.admin(`users/${u.id}`, 'DELETE'), reload);
                    }} />
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>)}
    </section>
  );
}

function BlockedIps({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ blocked: Blocked[] }>('blocked'));
  return (
    <section>
      <h2>{t('admin.blockedIps')}</h2>
      <p className="fine">{t('admin.blockedHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.blocked.length === 0 ? <p className="empty">{t('admin.noBlocked')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAddress')}</th><th>{t('admin.colWhy')}</th><th>{t('admin.colBlocked')}</th><th>{t('admin.colUntil')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.blocked.map((b) => (
              <tr key={b.id}>
                <td data-label={t('admin.colAddress')}><code>{b.address}</code></td>
                <td data-label={t('admin.colWhy')}>{named(REASONS, b.reason)}</td>
                <td data-label={t('admin.colBlocked')}>{when(b.createdAt)}</td>
                <td data-label={t('admin.colUntil')}>{b.expiresAt ? when(b.expiresAt) : t('admin.untilUnblocked')}</td>
                <td className="acts"><Button size="sm" onClick={() => act(() => client.admin(`blocked/${b.id}`, 'DELETE'), reload)}>{t('admin.unblock')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function NewAccounts({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ keys: { id: string; address: string }[] }>('new-accounts'));
  const [address, setAddress] = useState('');
  return (
    <section>
      <h2>{t('admin.newAccountLimits')}</h2>
      <p className="fine">{t('admin.newLimitsHelp')}</p>
      <form className="admin-bar" onSubmit={async (e) => {
        e.preventDefault();
        if (address.trim()) await act(async () => { await client.admin('new-accounts', 'POST', { address: address.trim() }); setAddress(''); }, reload);
      }}>
        <input className="input" placeholder={t('admin.newLimitsPlaceholder')} aria-label={t('admin.newLimitsLabel')} value={address} onChange={(e) => setAddress(e.target.value)} />
        <Button type="submit">{t('admin.newLimitsAdd')}</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.keys.length === 0 ? <p className="empty">{t('admin.noNewLimits')}</p> : (
        <ul className="rule-list">
          {data.keys.map((k) => (
            <li key={k.id}>
              <span>{k.address}</span>
              <Button size="sm" variant="quiet" onClick={() => act(() => client.admin(`new-accounts/${k.id}`, 'DELETE'), reload)}>{t('admin.liftLimits')}</Button>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

/** Users' own domains (signup/domains.mjs): who owns each and whether its ownership record is still there. */
function Domains({ client }: { client: Jmap }) {
  const { data, error } = useLoad(() => client.admin<{ domains: { name: string; owner: string | null; status: string; added: string; checked: string | null; missingSince: string | null; addresses: number }[] }>('domains'));
  return (
    <section>
      <h2>{t('admin.domainsTitle')}</h2>
      <p className="fine">{t('admin.domainsHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.domains.length === 0 ? <p className="empty">{t('admin.noDomains')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colDomain')}</th><th>{t('admin.colOwner')}</th><th>{t('admin.colStatus')}</th><th>{t('admin.colAddresses')}</th><th>{t('admin.colAdded')}</th><th>{t('admin.colLastChecked')}</th></tr></thead>
          <tbody>
            {data.domains.map((d) => (
              <tr key={d.name}>
                <td data-label={t('admin.colDomain')}><code>{d.name}</code></td>
                <td data-label={t('admin.colOwner')}>{d.owner ?? t('admin.ownerDeleted')}</td>
                <td data-label={t('admin.colStatus')}><span className={`pill ${d.status === 'active' ? 'on' : 'pill--warn'}`}>{named(DOMAIN_STATE, d.status)}</span>{d.missingSince && <span className="fine"> {t('admin.missingSince', { date: when(d.missingSince) })}</span>}</td>
                <td data-label={t('admin.colAddresses')}>{d.addresses}</td>
                <td data-label={t('admin.colAdded')}>{when(d.added)}</td>
                <td data-label={t('admin.colLastChecked')}>{when(d.checked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function Queue({ client }: { client: Jmap }) {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, reload } = useLoad(() => client.admin<{ messages: Queued[] }>(`queue?q=${encodeURIComponent(search)}`), [search]);
  return (
    <section>
      <p className="fine">{t('admin.queueHelp')}</p>
      <form className="admin-bar" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <input className="input" type="search" placeholder={t('admin.queueSearchPlaceholder')} aria-label={t('admin.queueSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">{t('admin.search')}</Button>
        <Button variant="quiet" onClick={reload}>{t('admin.refresh')}</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.messages.length === 0 ? <p className="empty">{search ? t('admin.nothingFromTo', { query: search }) : t('admin.nothingWaiting')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colQueued')}</th><th>{t('admin.colFrom')}</th><th>{t('admin.colTo')}</th><th>{t('admin.colStatus')}</th><th className="n">{t('admin.colTries')}</th><th>{t('admin.colNextTry')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.messages.map((m) => (
              <tr key={m.id}>
                <td data-label={t('admin.colQueued')}>{when(m.createdAt)}</td>
                <td data-label={t('admin.colFrom')}>{m.from}</td>
                <td data-label={t('admin.colTo')}>{m.recipients.map((r) => <div key={r.to}>{r.to}</div>)}</td>
                <td data-label={t('admin.colStatus')}>{m.recipients.map((r) => (
                  <div key={r.to}>{named(STATUS, r.status)}{(r.error || r.code) && <span className="fine"> · {[r.code, r.error].filter(Boolean).join(' ')}</span>}</div>
                ))}</td>
                <td data-label={t('admin.colTries')} className="n">{m.recipients.map((r) => <div key={r.to}>{r.attempts}</div>)}</td>
                <td data-label={t('admin.colNextTry')}>{when(m.nextRetry)}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={() => act(() => client.admin(`queue/${m.id}/retry`, 'POST'), reload)}>{t('admin.retryNow')}</Button>
                  <Button size="sm" variant="quiet" onClick={async () => {
                    if (await confirmIt({ title: t('admin.cancelTitle'), body: t('admin.cancelBody', { recipients: m.recipients.map((r) => r.to).join(', ') }), confirm: t('admin.cancelDelivery'), danger: true }))
                      await act(() => client.admin(`queue/${m.id}`, 'DELETE'), reload);
                  }}>{t('admin.cancelMessage')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

interface Team { id: string; name: string; email: string; description: string; members: string[] }

/** Shared team mailboxes (support@, sales@): a Stalwart group account; its members open it from their account menu. */
function Teams({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ groups: Team[] }>('groups'));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <section>
      <p className="fine">{t('admin.teamsHelp')}</p>
      <form className="admin-bar" onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim()) await act(async () => { await client.admin('groups', 'POST', { name: name.trim(), description: description.trim() }); setName(''); setDescription(''); }, reload);
      }}>
        <label>{t('admin.newTeam')}<input className="input" placeholder={t('admin.teamPlaceholder')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t('admin.teamNameLabel')}<input className="input" placeholder={t('admin.teamNamePlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <Button type="submit" variant="primary">{t('admin.createTeam')}</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.groups.length === 0 ? <p className="empty">{t('admin.noTeams')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colTeam')}</th><th>{t('admin.colMembers')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={g.id}>
                <td data-label={t('admin.colTeam')}><b>{g.email}</b>{g.description && <span className="fine"> {g.description}</span>}</td>
                <td data-label={t('admin.colMembers')}>{g.members.length === 0 ? <span className="fine">{t('admin.noMembers')}</span> : g.members.map((m) => (
                  <div key={m} className="member">{m}
                    <Button size="sm" variant="quiet" icon="close" label={t('admin.removeMember', { member: m, team: g.email })} onClick={() => act(() => client.admin(`groups/${g.id}`, 'PATCH', { remove: m }), reload)} />
                  </div>
                ))}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={async () => {
                    const who = await promptIt({ title: t('admin.addMemberTitle', { team: g.email }), body: t('admin.addMemberBody'), label: t('admin.addMemberLabel'), confirm: t('admin.addMember') });
                    if (who) await act(() => client.admin(`groups/${g.id}`, 'PATCH', { add: who }), reload);
                  }}>{t('admin.addMember')}</Button>
                  <Button size="sm" variant="quiet" icon="trash" label={t('admin.deleteLabel', { email: g.email })} onClick={async () => {
                    if (await confirmIt({ title: t('admin.deleteTitle', { email: g.email }), body: t('admin.deleteTeamBody'), confirm: t('admin.deleteTeam'), danger: true }))
                      await act(() => client.admin(`groups/${g.id}`, 'DELETE'), reload);
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function HeldMail({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ held: Held[] }>('held'));
  return (
    <section>
      <p className="fine">{t('admin.heldHelp')}</p>
      <div className="admin-bar"><Button variant="quiet" onClick={reload}>{t('admin.refresh')}</Button></div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.held.length === 0 ? <p className="empty">{t('admin.noHeld')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colHeld')}</th><th>{t('admin.colFrom')}</th><th>{t('admin.colTo')}</th><th>{t('admin.colSubject')}</th><th>{t('admin.colWhy')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.held.map((m) => (
              <tr key={m.id}>
                <td data-label={t('admin.colHeld')}>{when(m.at)}</td>
                <td data-label={t('admin.colFrom')}>{m.from}{m.login.toLowerCase() !== m.from.toLowerCase() && <span className="fine"> {t('admin.signedInAs', { login: m.login })}</span>}</td>
                <td data-label={t('admin.colTo')}>{m.to.map((to) => <div key={to}>{to}</div>)}</td>
                <td data-label={t('admin.colSubject')}>{m.subject || <span className="fine">{t('admin.noSubject')}</span>}<span className="fine"> · {size(m.size)}</span></td>
                <td data-label={t('admin.colWhy')}>{m.reasons.includes('GTUBE') ? t('admin.spamTest') : t('admin.spamScore', { score: m.score })}{m.reasons.length > 0 && !m.reasons.includes('GTUBE') && <span className="fine"> · {m.reasons.slice(0, 4).join(', ')}</span>}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={async () => {
                    if (await confirmIt({ title: t('admin.sendTitle'), body: t('admin.sendBody', { recipients: m.to.join(', ') }), confirm: t('admin.sendIt') }))
                      await act(() => client.admin(`held/${m.id}/release`, 'POST'), reload);
                  }}>{t('admin.send')}</Button>
                  <Button size="sm" variant="quiet" icon="trash" label={t('common.delete')} onClick={async () => {
                    if (await confirmIt({ title: t('admin.deleteHeldTitle'), body: t('admin.deleteHeldBody'), confirm: t('common.delete'), danger: true }))
                      await act(() => client.admin(`held/${m.id}`, 'DELETE'), reload);
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function Suspended({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ suspended: { id: string; email: string; reason: string; at: string; by: string | null; times: number }[] }>('suspended'));
  return (
    <section>
      <h2>{t('admin.sendingSuspended')}</h2>
      <p className="fine">{t('admin.suspendedHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.suspended.length === 0 ? <p className="empty">{t('admin.noSuspended')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAccount')}</th><th>{t('admin.colWhy')}</th><th>{t('admin.colSince')}</th><th className="n">{t('admin.colThisWeek')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {data.suspended.map((x) => (
              <tr key={x.id}>
                <td data-label={t('admin.colAccount')}><b>{x.email}</b></td>
                <td data-label={t('admin.colWhy')}>{x.reason}{x.by && <span className="fine"> · {x.by === 'spam complaints' ? t('admin.byComplaints') : x.by === 'spam hold' ? t('admin.byHold') : t('admin.byWho', { who: x.by })}</span>}</td>
                <td data-label={t('admin.colSince')}>{when(x.at)}</td>
                <td data-label={t('admin.colThisWeek')} className="n">{x.times}×</td>
                <td className="acts"><Button size="sm" onClick={() => act(() => client.admin(`users/${x.id}`, 'PATCH', { sending: true }), reload)}>{t('admin.allowSending')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function Inactive({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ months: number; since: string; accounts: { id: string; email: string; lastSeen: string | null; reminded: number | null; due: boolean; enabled: boolean; refusingMail?: boolean }[] }>('inactive'));
  const list = data ? [...data.accounts].sort((a, b) => Number(b.due) - Number(a.due) || (a.reminded ?? 0) - (b.reminded ?? 0)) : [];
  return (
    <section>
      <h2>{t('admin.inactiveTitle')}</h2>
      {data && <p className="fine">{data.months
        ? t('admin.inactiveHelp', { count: data.months, since: when(data.since) })
        : t('admin.inactiveOff')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.months > 0 || list.length > 0) && (list.length === 0 ? <p className="empty">{t('admin.noInactive')}</p> : (
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAccount')}</th><th>{t('admin.colLastSignIn')}</th><th>{t('admin.colStatus')}</th><th><span className="sr">{t('admin.actions')}</span></th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td data-label={t('admin.colAccount')}><b>{x.email}</b></td>
                <td data-label={t('admin.colLastSignIn')}>{x.lastSeen ? when(x.lastSeen) : t('admin.notSince', { date: when(data.since) })}</td>
                <td data-label={t('admin.colStatus')}>
                  {x.due ? <span className="pill pill--warn">{t('admin.dueBlocking')}</span> : <span className="pill">{t('admin.reminded', { count: x.reminded ?? 0 })}</span>}
                  {!x.enabled && <span className="pill">{t('admin.disabled')}</span>}
                  {x.refusingMail && <span className="pill pill--warn">{t('admin.refusingMail')}</span>}
                </td>
                <td className="acts">{x.due && x.enabled && <Button size="sm" variant="quiet" onClick={async () => {
                  if (await confirmIt({ title: t('admin.disableTitle', { email: x.email }), body: t('admin.disableInactiveRefuses'), confirm: t('admin.disable'), danger: true }))
                    await act(() => client.admin(`users/${x.id}`, 'PATCH', { enabled: false }), reload);
                }}>{t('admin.disable')}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
