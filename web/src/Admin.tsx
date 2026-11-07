import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';
import { RetentionAdmin } from './Retention';

/**
 * Admin console (/admin): users, blocked addresses and new-account limits, and the outgoing queue. Every call goes
 * to the account service (signup/admin.mjs), which checks that the signed-in account is on its ADMINS list.
 */
type Tab = 'overview' | 'users' | 'limits' | 'queue' | 'retention';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['users', 'Users'], ['limits', 'Blocked & limits'], ['queue', 'Message trace'], ['retention', 'Retention']];

interface User { id: string; name: string; email: string; description: string; createdAt: string; used: number; quota: number | null; aliases: number; enabled: boolean; admin: boolean; newAccount: boolean }
interface Blocked { id: string; address: string; reason: string; createdAt: string; expiresAt: string | null }
interface Queued { id: string; from: string; createdAt: string; nextRetry: string | null; size: number; recipients: { to: string; status: string; attempts: number; nextAttempt: string | null; error: string | null; code: string | null }[] }

const GB = 1024 ** 3;
const size = (b: number) => b >= GB ? `${(b / GB).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const REASONS: Record<string, string> = { authFailure: 'Too many failed sign-ins', rcptToFailure: 'Too many unknown recipients', loitering: 'Idle connections', portScanning: 'Port scanning', manual: 'Blocked by an admin', other: 'Other' };
const STATUS: Record<string, string> = { Scheduled: 'Waiting', TemporaryFailure: 'Retrying', PermanentFailure: 'Failed', Completed: 'Delivered' };

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
  try { await fn(); await then?.(); } catch (e) { await notify('That didn’t work', (e as Error).message); }
};

export function Admin({ client }: { client: Jmap }) {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="admin">
      <header className="admin-head">
        <p className="wordmark">OpenMail</p>
        <h1>Admin</h1>
        <span className="fine grow">{client.username}</span>
        <Button size="sm" onClick={() => location.assign('/')}>Back to your mail</Button>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      <main>
        {tab === 'overview' && <Overview client={client} go={setTab} />}
        {tab === 'users' && <Users client={client} />}
        {tab === 'limits' && <><BlockedIps client={client} /><NewAccounts client={client} /></>}
        {tab === 'queue' && <Queue client={client} />}
        {tab === 'retention' && <RetentionAdmin client={client} />}
      </main>
    </div>
  );
}

function Overview({ client, go }: { client: Jmap; go: (t: Tab) => void }) {
  const { data, error } = useLoad(() => client.admin<{ accounts: number; queued: number; blockedIps: number; newAccounts: number }>('overview'));
  if (error) return <p className="error" role="alert">{error}</p>;
  const stats: [string, number | undefined, Tab][] = [['Accounts', data?.accounts, 'users'], ['Waiting to send', data?.queued, 'queue'],
    ['Blocked IP addresses', data?.blockedIps, 'limits'], ['On new-account limits', data?.newAccounts, 'limits']];
  return (
    <section>
      <div className="stats">
        {stats.map(([label, n, t]) => (
          <div key={label} className="stat">
            <span className="num">{n ?? '–'}</span>
            <span className="fine">{label}</span>
            <Button variant="link" onClick={() => go(t)}>Open</Button>
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
    notify(`New password for ${email}: ${password}`, 'Copy it now and give it to them over a channel you trust. It won’t be shown again. They can change it in Settings → Security.');

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const limit = Number(gb);
    if (!name.trim()) return setMsg('Enter a username.');
    if (!(limit >= 0)) return setMsg('Enter the storage limit in GB, or 0 for no limit.');
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
        <input className="input" type="search" placeholder="Search by username or name" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">Search</Button>
      </form>
      <form className="admin-bar" onSubmit={create}>
        <label>New account<input className="input" placeholder="username" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="narrow">Storage (GB)<input className="input" inputMode="decimal" value={gb} onChange={(e) => setGb(e.target.value)} /></label>
        <Button type="submit" variant="primary">Create account</Button>
      </form>
      {msg && <p className="error" role="alert">{msg}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.users.length === 0 ? <p className="empty">No accounts match “{search}”. Search for a whole word, like a username.</p> : <>
        <p className="fine">{data.total > data.users.length ? `Showing ${data.users.length} of ${data.total}. Search to narrow it down.` : `${data.total} account${data.total === 1 ? '' : 's'}`}</p>
        <table className="admin-table">
          <thead><tr><th>Account</th><th>Created</th><th className="n">Storage used</th><th className="n">Addresses</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td data-label="Account"><b>{u.email}</b>{u.description && <span className="fine"> {u.description}</span>}</td>
                <td data-label="Created">{when(u.createdAt)}</td>
                <td data-label="Storage used" className="n">{size(u.used)}{u.quota ? ` of ${size(u.quota)}` : ''}</td>
                <td data-label="Addresses" className="n">{u.aliases}</td>
                <td data-label="Status">
                  <span className={u.enabled ? 'pill on' : 'pill'}>{u.enabled ? 'Active' : 'Disabled'}</span>
                  {u.newAccount && <span className="pill pill--warn">New-account limits</span>}
                  {u.admin && <span className="pill">Server admin</span>}
                </td>
                <td className="acts">
                  {!u.admin && <>
                    <Button size="sm" variant="quiet" onClick={async () => {
                      if (!(await confirmIt({ title: `Reset the password for ${u.email}?`, body: 'Their current password stops working and they’re signed out everywhere. App passwords keep working.', confirm: 'Reset password', danger: true }))) return;
                      await act(async () => { const r = await patch(u, { resetPassword: true }); await showPassword(u.email, r.password!); });
                    }}>Reset password</Button>
                    <Button size="sm" variant="quiet" onClick={async () => {
                      const v = await promptIt({ title: `Storage limit for ${u.email}`, body: `Using ${size(u.used)} now. Enter 0 for no limit.`, label: 'Limit in GB', value: u.quota ? String(+(u.quota / GB).toFixed(2)) : '0', confirm: 'Set limit' });
                      if (v === null) return;
                      const n = Number(v);
                      if (!(n >= 0)) return notify('That isn’t a number', 'Enter the limit in GB, like 5 or 0.5. Enter 0 for no limit.');
                      await act(() => patch(u, { quotaBytes: n === 0 ? null : Math.round(n * GB) }), reload);
                    }}>Set storage</Button>
                    {u.enabled
                      ? <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: `Disable ${u.email}?`, body: 'They’re signed out everywhere and can’t sign in or send until you enable the account again. Mail sent to them still arrives.', confirm: 'Disable', danger: true }))
                            await act(() => patch(u, { enabled: false }), reload);
                        }}>Disable</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { enabled: true }), reload)}>Enable</Button>}
                    <Button size="sm" variant="quiet" icon="trash" label={`Delete ${u.email}`} onClick={async () => {
                      if (await confirmIt({ title: `Delete ${u.email}?`, body: 'All of its mail, contacts, calendars and files are deleted, The address is retired: no one can take it later. This can’t be undone. To stop someone using it, disable it instead.', confirm: 'Delete account', danger: true }))
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
      <h2>Blocked IP addresses</h2>
      <p className="fine">The mail server blocks an address by itself after repeated failed sign-ins or probing. Unblock one when a real person got caught.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.blocked.length === 0 ? <p className="empty">No addresses are blocked.</p> : (
        <table className="admin-table">
          <thead><tr><th>Address</th><th>Why</th><th>Blocked</th><th>Until</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data.blocked.map((b) => (
              <tr key={b.id}>
                <td data-label="Address"><code>{b.address}</code></td>
                <td data-label="Why">{REASONS[b.reason] ?? b.reason}</td>
                <td data-label="Blocked">{when(b.createdAt)}</td>
                <td data-label="Until">{b.expiresAt ? when(b.expiresAt) : 'Until unblocked'}</td>
                <td className="acts"><Button size="sm" onClick={() => act(() => client.admin(`blocked/${b.id}`, 'DELETE'), reload)}>Unblock</Button></td>
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
      <h2>New-account limits</h2>
      <p className="fine">Accounts on this list send under the stricter limit for new accounts. Lift it once an account has earned trust; add one back if it starts sending too much.</p>
      <form className="admin-bar" onSubmit={async (e) => {
        e.preventDefault();
        if (address.trim()) await act(async () => { await client.admin('new-accounts', 'POST', { address: address.trim() }); setAddress(''); }, reload);
      }}>
        <input className="input" placeholder="username or full address" aria-label="Account to put on new-account limits" value={address} onChange={(e) => setAddress(e.target.value)} />
        <Button type="submit">Put on new-account limits</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.keys.length === 0 ? <p className="empty">No accounts are on new-account limits.</p> : (
        <ul className="rule-list">
          {data.keys.map((k) => (
            <li key={k.id}>
              <span>{k.address}</span>
              <Button size="sm" variant="quiet" onClick={() => act(() => client.admin(`new-accounts/${k.id}`, 'DELETE'), reload)}>Lift limits</Button>
            </li>
          ))}
        </ul>
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
      <p className="fine">Mail waiting to go out to other servers. Delivered and bounced mail leaves this list (the sender gets a bounce message).</p>
      <form className="admin-bar" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <input className="input" type="search" placeholder="Sender or recipient address" aria-label="Search the queue" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">Search</Button>
        <Button variant="quiet" onClick={reload}>Refresh</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.messages.length === 0 ? <p className="empty">{search ? `Nothing waiting from or to “${search}”.` : 'Nothing is waiting to be sent.'}</p> : (
        <table className="admin-table">
          <thead><tr><th>Queued</th><th>From</th><th>To</th><th>Status</th><th className="n">Tries</th><th>Next try</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data.messages.map((m) => (
              <tr key={m.id}>
                <td data-label="Queued">{when(m.createdAt)}</td>
                <td data-label="From">{m.from}</td>
                <td data-label="To">{m.recipients.map((r) => <div key={r.to}>{r.to}</div>)}</td>
                <td data-label="Status">{m.recipients.map((r) => (
                  <div key={r.to}>{STATUS[r.status] ?? r.status}{(r.error || r.code) && <span className="fine"> · {[r.code, r.error].filter(Boolean).join(' ')}</span>}</div>
                ))}</td>
                <td data-label="Tries" className="n">{m.recipients.map((r) => <div key={r.to}>{r.attempts}</div>)}</td>
                <td data-label="Next try">{when(m.nextRetry)}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={() => act(() => client.admin(`queue/${m.id}/retry`, 'POST'), reload)}>Retry now</Button>
                  <Button size="sm" variant="quiet" onClick={async () => {
                    if (await confirmIt({ title: 'Cancel this message?', body: `It won’t be delivered to anyone still waiting (${m.recipients.map((r) => r.to).join(', ')}).`, confirm: 'Cancel delivery', danger: true }))
                      await act(() => client.admin(`queue/${m.id}`, 'DELETE'), reload);
                  }}>Cancel</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
