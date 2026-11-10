import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';
import { RetentionAdmin } from './Retention';
import { save } from './Export';
import { importRows, parseCsv, toCsv, type ImportRow } from './csv';
import { locale, t } from './i18n';

/**
 * Admin console (/admin): users, blocked addresses and new-account limits, the outgoing queue, and the audit log of
 * what was changed here. Every call goes to the account service (signup/admin.mjs), which checks that the signed-in
 * account is on its ADMINS list.
 */
type Tab = 'overview' | 'users' | 'teams' | 'limits' | 'queue' | 'held' | 'domains' | 'abuse' | 'retention' | 'audit';
// What the helpdesk role (signup/admin.mjs HELPDESK_ROUTES) can open; the server refuses the rest anyway.
const HELPDESK_TABS: Tab[] = ['overview', 'users', 'held', 'abuse', 'audit'];
const TABS = [['overview', 'admin.tabOverview'], ['users', 'admin.tabUsers'], ['teams', 'admin.tabTeams'], ['limits', 'admin.tabLimits'], ['queue', 'admin.tabQueue'], ['held', 'admin.tabHeld'], ['domains', 'admin.tabDomains'], ['abuse', 'admin.tabAbuse'], ['retention', 'admin.tabRetention'], ['audit', 'admin.tabAudit']] as const;

interface User { id: string; name: string; email: string; description: string; createdAt: string; used: number; quota: number | null; aliases: number; enabled: boolean; sending: boolean; admin: boolean; helpdesk?: boolean; newAccount: boolean }
interface Stats { accounts: number; queued: number; blockedIps: number; newAccounts: number; suspended: number; held: number | null; role: 'admin' | 'helpdesk' }
interface Held { id: string; at: string; login: string; from: string; to: string[]; subject: string; size: number; score: number; reasons: string[] }
interface Blocked { id: string; address: string; reason: string; createdAt: string; expiresAt: string | null }
interface Queued { id: string; from: string; createdAt: string; nextRetry: string | null; size: number; recipients: { to: string; status: string; attempts: number; nextAttempt: string | null; error: string | null; code: string | null }[] }

const GB = 1024 ** 3;
const one = (n: number) => n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const size = (b: number) => b >= GB ? `${one(b / GB)} GB` : b >= 1024 ** 2 ? `${one(b / 1024 ** 2)} MB` : `${Math.ceil(b / 1024).toLocaleString(locale())} KB`;
const when = (d: string | null) => (d ? new Date(d).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '');
const REASONS = { authFailure: 'admin.reasonAuthFailure', rcptToFailure: 'admin.reasonRcptToFailure', loitering: 'admin.reasonLoitering', portScanning: 'admin.reasonPortScanning', manual: 'admin.reasonManual', other: 'admin.reasonOther' } as const;
const DOMAIN_STATE = { active: 'admin.stateWorking', missing: 'admin.stateMissing', paused: 'admin.statePaused' } as const;
// The audit log's codes (signup/admin.mjs AUDITED, and what its handlers note) in words.
const AUDIT_ACTION = {
  'user.create': 'admin.auditUserCreate', 'user.import': 'admin.auditUserImport', 'user.update': 'admin.auditUserUpdate', 'user.delete': 'admin.auditUserDelete',
  'team.create': 'admin.auditTeamCreate', 'team.members': 'admin.auditTeamMembers', 'team.delete': 'admin.auditTeamDelete',
  'ip.unblock': 'admin.auditIpUnblock', 'limits.add': 'admin.auditLimitsAdd', 'limits.lift': 'admin.auditLimitsLift',
  'queue.retry': 'admin.auditQueueRetry', 'queue.cancel': 'admin.auditQueueCancel', 'held.release': 'admin.auditHeldRelease', 'held.delete': 'admin.auditHeldDelete',
  'retention.rules': 'admin.auditRetentionRules', 'retention.run': 'admin.auditRetentionRun', 'retention.account': 'admin.auditRetentionAccount',
} as const;
const AUDIT_DETAIL = {
  enable: 'admin.auditEnable', disable: 'admin.auditDisable', sending_suspend: 'admin.auditSendingSuspend', sending_allow: 'admin.auditSendingAllow',
  password_reset: 'admin.auditPasswordReset', hold_on: 'admin.auditHoldOn', hold_off: 'admin.auditHoldOff',
} as const;
const AUDIT_PAGE = 50;
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
  // The overview is the first call; it also says the caller's role, which decides the tabs and buttons shown.
  const overview = useLoad(() => client.admin<Stats>('overview'));
  const desk = overview.data?.role === 'helpdesk';
  const tabs = TABS.filter(([id]) => !desk || HELPDESK_TABS.includes(id));
  return (
    <div className="admin">
      <header className="admin-head">
        <p className="wordmark">OpenMail</p>
        <h1>{t('admin.title')}</h1>
        <span className="fine grow">{client.username}{desk && ` · ${t('admin.roleHelpdesk')}`}</span>
        <Button size="sm" onClick={() => location.assign('/')}>{t('login.backToMail')}</Button>
      </header>
      <nav className="tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => { setTab(id); if (id === 'overview') overview.reload(); }}>{t(label)}</button>)}
      </nav>
      <main>
        {tab === 'overview' && <Overview {...overview} go={setTab} tabs={tabs.map(([id]) => id)} />}
        {tab === 'users' && <Users client={client} desk={desk} />}
        {tab === 'teams' && <Teams client={client} />}
        {tab === 'limits' && <><BlockedIps client={client} /><NewAccounts client={client} /></>}
        {tab === 'queue' && <Queue client={client} />}
        {tab === 'domains' && <Domains client={client} />}
        {tab === 'abuse' && <><Suspended client={client} />{!desk && <Inactive client={client} />}</>}
        {tab === 'held' && <HeldMail client={client} />}
        {tab === 'retention' && <RetentionAdmin client={client} />}
        {tab === 'audit' && <AuditLog client={client} />}
      </main>
    </div>
  );
}

function Overview({ data, error, go, tabs }: { data: Stats | null; error: string; go: (tab: Tab) => void; tabs: Tab[] }) {
  if (error) return <p className="error" role="alert">{error}</p>;
  const stats: [string, number | undefined, Tab][] = [[t('admin.statAccounts'), data?.accounts, 'users'], [t('admin.statQueued'), data?.queued, 'queue'],
    [t('admin.blockedIps'), data?.blockedIps, 'limits'], [t('admin.statNewAccounts'), data?.newAccounts, 'limits'], [t('admin.sendingSuspended'), data?.suspended, 'abuse'],
    ...(data?.held != null ? [[t('admin.statHeld'), data.held, 'held'] as [string, number, Tab]] : [])];
  return (
    <section>
      <div className="stats">
        {stats.filter(([, , tab]) => tabs.includes(tab)).map(([label, n, tab]) => (
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

/** desk: the helpdesk role sees only sign-in, password reset and lifting a suspension, and not on helpdesk accounts. */
function Users({ client, desk }: { client: Jmap; desk: boolean }) {
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
      {!desk && <form className="admin-bar" onSubmit={create}>
        <label>{t('admin.newAccount')}<input className="input" placeholder={t('admin.usernamePlaceholder')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="narrow">{t('admin.storageGb')}<input className="input" inputMode="decimal" value={gb} onChange={(e) => setGb(e.target.value)} /></label>
        <Button type="submit" variant="primary">{t('admin.createAccount')}</Button>
      </form>}
      {!desk && <CsvImport client={client} done={reload} />}
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
                  {u.helpdesk && <span className="pill">{t('admin.roleHelpdesk')}</span>}
                </td>
                <td className="acts">
                  {!u.admin && !(desk && u.helpdesk) && <>
                    <Button size="sm" variant="quiet" onClick={async () => {
                      if (!(await confirmIt({ title: t('admin.resetTitle', { email: u.email }), body: t('admin.resetBody'), confirm: t('admin.resetPassword'), danger: true }))) return;
                      await act(async () => { const r = await patch(u, { resetPassword: true }); await showPassword(u.email, r.password!); });
                    }}>{t('admin.resetPassword')}</Button>
                    {!desk && <Button size="sm" variant="quiet" onClick={async () => {
                      const v = await promptIt({ title: t('admin.storageTitle', { email: u.email }), body: t('admin.storageBody', { used: size(u.used) }), label: t('admin.limitGb'), value: u.quota ? String(+(u.quota / GB).toFixed(2)) : '0', confirm: t('admin.setLimit') });
                      if (v === null) return;
                      const n = Number(v);
                      if (!(n >= 0)) return notify(t('admin.notNumber'), t('admin.notNumberBody'));
                      await act(() => patch(u, { quotaBytes: n === 0 ? null : Math.round(n * GB) }), reload);
                    }}>{t('admin.setStorage')}</Button>}
                    {u.sending
                      ? !desk && <Button size="sm" variant="quiet" onClick={async () => {
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
                      ? !desk && <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: t('admin.suspendTitle', { email: u.email }), body: t('admin.suspendBody'), confirm: t('admin.suspendSending'), danger: true }))
                            await act(() => patch(u, { sending: false }), reload);
                        }}>{t('admin.suspendSending')}</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { sending: true }), reload)}>{t('admin.allowSending')}</Button>}
                    {!desk && <Button size="sm" variant="quiet" icon="trash" label={t('admin.deleteLabel', { email: u.email })} onClick={async () => {
                      if (await confirmIt({ title: t('admin.deleteTitle', { email: u.email }), body: t('admin.deleteUserBody'), confirm: t('admin.deleteAccount'), danger: true }))
                        await act(() => client.admin(`users/${u.id}`, 'DELETE'), reload);
                    }} />}
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

interface ImportResult { name: string; email?: string; password?: string; error?: string; message?: string }

/** Add accounts from a CSV (csv.ts): parsed here, checked by the server (its rules decide), then created in one
 *  request. Generated passwords are shown once, with a file to save them. */
function CsvImport({ client, done }: { client: Jmap; done: () => void }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [checks, setChecks] = useState<ImportResult[] | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = rows.filter((_, i) => checks && !checks[i]?.error);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await act(fn); setBusy(false); };
  const check = () => run(async () => {
    const r = importRows(parseCsv(text));
    setResults(null); setChecks(null);
    setChecks((await client.admin<{ results: ImportResult[] }>('users/check', 'POST', { rows: r })).results);
    setRows(r);
  });
  const add = () => run(async () => {
    const r = await client.admin<{ results: ImportResult[] }>('users/import', 'POST', { rows: ready });
    setResults(r.results); setChecks(null); setRows([]); setText('');
    done();
  });
  const passwords = results?.filter((r) => r.password) ?? [];
  const status = (r: ImportResult, ok: string) => r.error ? <span className="error">{r.message ?? r.error}</span> : <span className="pill on">{ok}</span>;
  return (
    <details>
      <summary>{t('admin.importTitle')}</summary>
      <p className="fine">{t('admin.importHelp')}</p>
      <div className="admin-bar">
        <label>{t('admin.importPaste')}<textarea className="input" rows={5} placeholder="username,display name,password,quota&#10;sam,Sam Lee,,5" value={text} onChange={(e) => { setText(e.target.value); setChecks(null); }} /></label>
      </div>
      <div className="admin-bar">
        <label>{t('admin.importFile')}<input className="input" type="file" accept=".csv,text/csv,text/plain" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setChecks(null); } e.target.value = ''; }} /></label>
        <Button disabled={!text.trim() || busy} onClick={check}>{t('admin.importCheck')}</Button>
      </div>
      {checks && <>
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAccount')}</th><th>{t('admin.colDisplayName')}</th><th>{t('admin.colPassword')}</th><th className="n">{t('admin.colStorage')}</th><th>{t('admin.colStatus')}</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td data-label={t('admin.colAccount')}><b>{r.name}</b></td>
                <td data-label={t('admin.colDisplayName')}>{r.description}</td>
                <td data-label={t('admin.colPassword')}>{r.password ? '••••••' : <span className="fine">{t('admin.importGenerated')}</span>}</td>
                <td data-label={t('admin.colStorage')} className="n">{typeof r.quotaBytes === 'number' ? (r.quotaBytes ? size(r.quotaBytes) : t('admin.importNoLimit')) : r.quotaBytes ?? <span className="fine">{t('admin.importDefault')}</span>}</td>
                <td data-label={t('admin.colStatus')}>{status(checks[i] ?? { name: r.name }, t('admin.importReady'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-bar"><Button variant="primary" disabled={!ready.length || busy} onClick={add}>{t('admin.importAdd', { count: ready.length })}</Button></div>
      </>}
      {results && <>
        <p role="status">{t('admin.importDone', { created: results.filter((r) => r.email).length, failed: results.filter((r) => r.error).length })}</p>
        {passwords.length > 0 && <div className="admin-bar">
          <p className="fine grow">{t('admin.importPasswordsOnce')}</p>
          <Button onClick={() => save(new Blob([toCsv([['username', 'email', 'password'], ...passwords.map((r) => [r.name, r.email!, r.password!])])], { type: 'text/csv' }), 'new-accounts.csv')}>{t('admin.importDownload')}</Button>
        </div>}
        <table className="admin-table">
          <thead><tr><th>{t('admin.colAccount')}</th><th>{t('admin.colPassword')}</th><th>{t('admin.colStatus')}</th></tr></thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td data-label={t('admin.colAccount')}><b>{r.email ?? r.name}</b></td>
                <td data-label={t('admin.colPassword')}>{r.password && <code>{r.password}</code>}</td>
                <td data-label={t('admin.colStatus')}>{status(r, t('admin.importCreated'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>}
    </details>
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
  const { data, error } = useLoad(() => client.admin<{ domains: { name: string; owner: string | null; status: string; added: string; checked: string | null; missingSince: string | null; addresses: number; members?: number }[] }>('domains'));
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
                <td data-label={t('admin.colAddresses')}>{d.addresses}{!!d.members && <span className="fine"> · {t('admin.domainMembers', { count: d.members })}</span>}</td>
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

interface AuditEntry { at: string; admin: string; role?: 'admin' | 'helpdesk'; action: string; target: string | null; detail?: string[]; outcome: string }

/** One "what was asked" code from the audit log ("quota:5000000", "member_add:sam@x") in words; unknown ones as they are. */
function auditDetail(code: string) {
  const i = code.indexOf(':'), kind = i < 0 ? code : code.slice(0, i), value = i < 0 ? '' : code.slice(i + 1), n = Number(value);
  if (kind === 'quota') return value === 'none' ? t('admin.auditQuotaNone') : t('admin.auditQuota', { size: size(n) });
  if (kind === 'created') return t('admin.auditCreated', { count: n });
  if (kind === 'failed') return t('admin.auditFailed', { count: n });
  if (kind === 'member_add') return t('admin.auditMemberAdd', { member: value });
  if (kind === 'member_remove') return t('admin.auditMemberRemove', { member: value });
  if (kind === 'trash_days') return n > 0 ? t('admin.auditTrashDays', { count: n }) : t('admin.auditTrashNever');
  if (kind === 'max_age_days') return value === 'server' ? t('admin.auditKeepServer') : n > 0 ? t('admin.auditKeepDays', { count: n }) : t('admin.auditKeepForever');
  return named(AUDIT_DETAIL, code);
}

/** What administrators changed in this console (signup/audit.mjs), newest first, a page at a time. */
function AuditLog({ client }: { client: Jmap }) {
  const [offset, setOffset] = useState(0);
  const { data, error, reload } = useLoad(() => client.admin<{ entries: AuditEntry[]; total: number }>(`audit?limit=${AUDIT_PAGE}&offset=${offset}`), [offset]);
  return (
    <section>
      <h2>{t('admin.tabAudit')}</h2>
      <p className="fine">{t('admin.auditHelp')}</p>
      <div className="admin-bar">
        <Button variant="quiet" onClick={() => (offset ? setOffset(0) : reload())}>{t('admin.refresh')}</Button>
        <Button variant="quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE))}>{t('admin.auditNewer')}</Button>
        <Button variant="quiet" disabled={!data || offset + AUDIT_PAGE >= data.total} onClick={() => setOffset(offset + AUDIT_PAGE)}>{t('admin.auditOlder')}</Button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.total === 0 ? <p className="empty">{t('admin.noAudit')}</p> : <>
        <p className="fine">{t('admin.auditShowing', { from: offset + 1, to: offset + data.entries.length, total: data.total })}</p>
        <table className="admin-table">
          <thead><tr><th>{t('admin.colTime')}</th><th>{t('admin.colAdmin')}</th><th>{t('admin.colAction')}</th><th>{t('admin.colTarget')}</th><th>{t('admin.colOutcome')}</th></tr></thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={`${e.at}${i}`}>
                <td data-label={t('admin.colTime')}>{when(e.at)}</td>
                <td data-label={t('admin.colAdmin')}>{e.admin}{e.role === 'helpdesk' && <span className="fine"> {t('admin.roleHelpdesk')}</span>}</td>
                <td data-label={t('admin.colAction')}>{named(AUDIT_ACTION, e.action)}{e.detail?.length ? <span className="fine"> · {e.detail.map(auditDetail).join(', ')}</span> : null}</td>
                <td data-label={t('admin.colTarget')}>{e.target ?? ''}</td>
                <td data-label={t('admin.colOutcome')}>{e.outcome === 'ok'
                  ? <span className="pill on">{t('admin.auditDone')}</span>
                  : <><span className="pill pill--warn">{t('admin.auditNotDone')}</span><span className="fine"> <code>{e.outcome}</code></span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>)}
    </section>
  );
}
