import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify, promptIt } from './Dialog';
import type { Jmap } from './jmap';
import { RetentionAdmin } from './Retention';

/**
 * Admin console (/admin): users, blocked addresses and new-account limits, and the outgoing queue. Every call goes
 * to the account service (signup/admin.mjs), which checks that the signed-in account is on its ADMINS list.
 */
type Tab = 'overview' | 'users' | 'teams' | 'limits' | 'queue' | 'domains' | 'abuse' | 'retention';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['users', 'Users'], ['teams', 'Team mailboxes'], ['limits', 'Blocked & limits'], ['queue', 'Message trace'], ['domains', 'Domains'], ['abuse', 'Suspended & inactive'], ['retention', 'Retention']];

interface User { id: string; name: string; email: string; description: string; createdAt: string; used: number; quota: number | null; aliases: number; enabled: boolean; admin: boolean; newAccount: boolean; sending: boolean }
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
        {tab === 'teams' && <Teams client={client} />}
        {tab === 'limits' && <><BlockedIps client={client} /><NewAccounts client={client} /></>}
        {tab === 'queue' && <Queue client={client} />}
        {tab === 'domains' && <Domains client={client} />}
        {tab === 'abuse' && <><Suspended client={client} /><Inactive client={client} /></>}
        {tab === 'retention' && <RetentionAdmin client={client} />}
      </main>
    </div>
  );
}

function Overview({ client, go }: { client: Jmap; go: (t: Tab) => void }) {
  const { data, error } = useLoad(() => client.admin<{ accounts: number; queued: number; blockedIps: number; newAccounts: number; suspended: number }>('overview'));
  if (error) return <p className="error" role="alert">{error}</p>;
  const stats: [string, number | undefined, Tab][] = [['Accounts', data?.accounts, 'users'], ['Waiting to send', data?.queued, 'queue'],
    ['Blocked IP addresses', data?.blockedIps, 'limits'], ['On new-account limits', data?.newAccounts, 'limits'], ['Sending suspended', data?.suspended, 'abuse']];
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
                  {!u.sending && <span className="pill pill--warn">Sending suspended</span>}
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
                    {u.sending
                      ? <Button size="sm" variant="quiet" onClick={async () => {
                          if (await confirmIt({ title: `Suspend sending for ${u.email}?`, body: 'They can still sign in and read their mail, but can’t send until you allow it again. They see a notice saying an administrator did this.', confirm: 'Suspend sending', danger: true }))
                            await act(() => patch(u, { sending: false }), reload);
                        }}>Suspend sending</Button>
                      : <Button size="sm" variant="quiet" onClick={() => act(() => patch(u, { sending: true }), reload)}>Allow sending</Button>}
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

/** Users' own domains (signup/domains.mjs): who owns each and whether its ownership record is still there. */
function Domains({ client }: { client: Jmap }) {
  const { data, error } = useLoad(() => client.admin<{ domains: { name: string; owner: string | null; status: string; added: string; checked: string | null; missingSince: string | null; addresses: number }[] }>('domains'));
  const STATE: Record<string, string> = { active: 'Working', missing: 'Record missing', paused: 'Paused' };
  return (
    <section>
      <h2>Users’ domains</h2>
      <p className="fine">Domains people added in Settings → Your domain. Each belongs to one account. Its ownership record is checked every few hours; after 7 days without it, the domain’s addresses pause.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.domains.length === 0 ? <p className="empty">Nobody has added a domain yet.</p> : (
        <table className="admin-table">
          <thead><tr><th>Domain</th><th>Owner</th><th>Status</th><th>Addresses</th><th>Added</th><th>Last checked</th></tr></thead>
          <tbody>
            {data.domains.map((d) => (
              <tr key={d.name}>
                <td data-label="Domain"><code>{d.name}</code></td>
                <td data-label="Owner">{d.owner ?? 'Deleted account (kept, never reused)'}</td>
                <td data-label="Status"><span className={`pill ${d.status === 'active' ? 'on' : 'pill--warn'}`}>{STATE[d.status] ?? d.status}</span>{d.missingSince && <span className="fine"> since {when(d.missingSince)}</span>}</td>
                <td data-label="Addresses">{d.addresses}</td>
                <td data-label="Added">{when(d.added)}</td>
                <td data-label="Last checked">{when(d.checked)}</td>
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

interface Team { id: string; name: string; email: string; description: string; members: string[] }

/** Shared team mailboxes (support@, sales@): a Stalwart group account; its members open it from their account menu. */
function Teams({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ groups: Team[] }>('groups'));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <section>
      <p className="fine">A team mailbox has its own address. Mail to it lands in one shared Inbox that every member opens from their account menu. Members can reply as the team and leave comments for each other on a conversation.</p>
      <form className="admin-bar" onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim()) await act(async () => { await client.admin('groups', 'POST', { name: name.trim(), description: description.trim() }); setName(''); setDescription(''); }, reload);
      }}>
        <label>New team mailbox<input className="input" placeholder="e.g. support" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Name people see<input className="input" placeholder="e.g. Support team" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <Button type="submit" variant="primary">Create team mailbox</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.groups.length === 0 ? <p className="empty">No team mailboxes yet. Create one above, then add its members.</p> : (
        <table className="admin-table">
          <thead><tr><th>Team mailbox</th><th>Members</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={g.id}>
                <td data-label="Team mailbox"><b>{g.email}</b>{g.description && <span className="fine"> {g.description}</span>}</td>
                <td data-label="Members">{g.members.length === 0 ? <span className="fine">No members yet</span> : g.members.map((m) => (
                  <div key={m} className="member">{m}
                    <Button size="sm" variant="quiet" icon="close" label={`Remove ${m} from ${g.email}`} onClick={() => act(() => client.admin(`groups/${g.id}`, 'PATCH', { remove: m }), reload)} />
                  </div>
                ))}</td>
                <td className="acts">
                  <Button size="sm" variant="quiet" onClick={async () => {
                    const who = await promptIt({ title: `Add a member to ${g.email}`, body: 'They can read and answer its mail and send as the team.', label: 'Username or address', confirm: 'Add member' });
                    if (who) await act(() => client.admin(`groups/${g.id}`, 'PATCH', { add: who }), reload);
                  }}>Add member</Button>
                  <Button size="sm" variant="quiet" icon="trash" label={`Delete ${g.email}`} onClick={async () => {
                    if (await confirmIt({ title: `Delete ${g.email}?`, body: 'All of its mail and team comments are deleted, and the address is retired: no one can take it later. This can’t be undone.', confirm: 'Delete team mailbox', danger: true }))
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

function Suspended({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ suspended: { id: string; email: string; reason: string; at: string; by: string | null; times: number }[] }>('suspended'));
  return (
    <section>
      <h2>Sending suspended</h2>
      <p className="fine">Sending stops by itself when an account keeps hitting the sending limits or many of its messages bounce. People can switch it back on themselves once; a second time within a week lands here for you. They can still read their mail.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.suspended.length === 0 ? <p className="empty">No account has sending suspended.</p> : (
        <table className="admin-table">
          <thead><tr><th>Account</th><th>Why</th><th>Since</th><th className="n">This week</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data.suspended.map((x) => (
              <tr key={x.id}>
                <td data-label="Account"><b>{x.email}</b></td>
                <td data-label="Why">{x.reason}{x.by && <span className="fine"> · by {x.by}</span>}</td>
                <td data-label="Since">{when(x.at)}</td>
                <td data-label="This week" className="n">{x.times}×</td>
                <td className="acts"><Button size="sm" onClick={() => act(() => client.admin(`users/${x.id}`, 'PATCH', { sending: true }), reload)}>Allow sending</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function Inactive({ client }: { client: Jmap }) {
  const { data, error, reload } = useLoad(() => client.admin<{ months: number; since: string; accounts: { id: string; email: string; lastSeen: string | null; reminded: number | null; due: boolean; enabled: boolean }[] }>('inactive'));
  const list = data ? [...data.accounts].sort((a, b) => Number(b.due) - Number(a.due) || (a.reminded ?? 0) - (b.reminded ?? 0)) : [];
  return (
    <section>
      <h2>Inactive accounts</h2>
      {data && <p className="fine">{data.months
        ? `A daily check emails accounts with no sign-in for close to ${data.months} months (60, 30 and 7 days before). Accounts past ${data.months} months are listed as due: blocking or deleting them is up to you. Sign-ins are counted since ${when(data.since)}.`
        : 'The inactive-account check is off on this server (INACTIVE_MONTHS).'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.months > 0 || list.length > 0) && (list.length === 0 ? <p className="empty">No inactive accounts.</p> : (
        <table className="admin-table">
          <thead><tr><th>Account</th><th>Last sign-in</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td data-label="Account"><b>{x.email}</b></td>
                <td data-label="Last sign-in">{x.lastSeen ? when(x.lastSeen) : `Not since ${when(data.since)}`}</td>
                <td data-label="Status">
                  {x.due ? <span className="pill pill--warn">Due for blocking</span> : <span className="pill">Reminded ({x.reminded} days before)</span>}
                  {!x.enabled && <span className="pill">Disabled</span>}
                </td>
                <td className="acts">{x.due && x.enabled && <Button size="sm" variant="quiet" onClick={async () => {
                  if (await confirmIt({ title: `Disable ${x.email}?`, body: 'They can’t sign in or send until you enable the account again (Users tab). Nothing is deleted.', confirm: 'Disable', danger: true }))
                    await act(() => client.admin(`users/${x.id}`, 'PATCH', { enabled: false }), reload);
                }}>Disable</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
