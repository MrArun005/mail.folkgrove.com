// Sharing: folders shared with other people on this server, delegation, team mailboxes and team comments.
// Everything is JMAP sharing on Stalwart (Mailbox.shareWith); see jmap.ts "Sharing" for the server shapes.
import { useCallback, useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt } from './Dialog';
import { Icon, roleIcon } from './icons';
import { loadScript, saveScript } from './Filters';
import { ACCESS, accessOf, type Access, type Comment, type Jmap, type Mailbox, type Person, type SharedAccount } from './jmap';
import { displayName } from './mailutil';
import { shortDate } from './Reader';

const ACCESS_LABEL: Record<Access, string> = { read: 'Can read', write: 'Can read and change', full: 'Full access' };
const who = (name: string) => name.replace(/@.*/, '');

/** Other accounts you can open, plus the ones you've hidden from the rail (kept in your Sieve settings, so synced). */
export function useShared(own: Jmap) {
  const [accounts, setAccounts] = useState<SharedAccount[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const reload = useCallback(() => { own.sharedAccounts().then(setAccounts, () => {}); }, [own]);
  useEffect(() => {
    reload();
    loadScript(own).then(({ data }) => setHidden(data.hiddenShares ?? []), () => {});
    window.addEventListener('focus', reload); // someone may have shared something since
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const setHide = async (change: (h: string[]) => string[]) => {
    let next: string[] = [];
    await saveScript(own, await own.mailboxes(), (d) => ({ ...d, hiddenShares: (next = change(d.hiddenShares ?? [])) }));
    setHidden(next);
  };
  return { accounts, hidden, reload, hide: (key: string) => setHide((h) => [...new Set([...h, key])]), unhideAll: () => setHide(() => []) };
}

/** The "Shared with me" group in the rail: whole mailboxes (team, delegated) and single shared folders. */
export function SharedRail({ accounts, hidden, current, onOpen, onHide, onUnhide }: {
  accounts: SharedAccount[]; hidden: string[]; current: { account: string | null; box: string | null };
  onOpen: (a: SharedAccount, box?: string) => void; onHide: (key: string) => void; onUnhide: () => void;
}) {
  const items = accounts.flatMap((a) => (a.whole
    ? [{ key: a.id, a, box: undefined as Mailbox | undefined, label: who(a.name), unread: a.boxes.find((b) => b.role === 'inbox')?.unreadEmails ?? 0 }]
    : a.boxes.map((b) => ({ key: `${a.id}/${b.id}`, a, box: b, label: `${b.name} · ${who(a.name)}`, unread: b.unreadEmails }))));
  const shown = items.filter((x) => !hidden.includes(x.key));
  if (!items.length) return null;
  return (
    <div className="saved shared-rail">
      <p className="rail-label">Shared with me</p>
      <ul>
        {shown.map((x) => {
          const on = current.account === x.a.id && (!x.box || current.box === x.box.id);
          return (
            <li key={x.key} className="saved-item">
              <button className={`nav-item${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} title={x.a.name} onClick={() => onOpen(x.a, x.box?.id)}>
                <Icon name={x.box ? roleIcon(x.box.role) : x.a.team ? 'inbox' : 'person'} /><span className="name">{x.label}</span>
                {x.unread > 0 && <span className="count">{x.unread}</span>}
              </button>
              <Button variant="quiet" size="sm" icon="close" label={`Hide ${x.label}`} onClick={() => onHide(x.key)} />
            </li>
          );
        })}
      </ul>
      {shown.length < items.length && <Button variant="link" className="rail-link" onClick={onUnhide}>Show {items.length - shown.length} hidden</Button>}
    </div>
  );
}

/** Settings → Folders → Share: who can see this folder, and how much they can do. */
export function ShareFolder({ client, box, onDone }: { client: Jmap; box: Mailbox; onDone: () => void }) {
  return <SharePanel client={client} boxIds={[box.id]} intro={`People on this server you share “${box.name}” with see it under “Shared with me”.`} onDone={onDone} />;
}

function SharePanel({ client, boxIds, intro, onDone }: { client: Jmap; boxIds: string[]; intro: string; onDone: () => void }) {
  const [people, setPeople] = useState<{ p: Person; access: Access }[] | null>(null);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<Access>('read');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const box = (await client.shares()).find((b) => b.id === boxIds[0]);
    const ids = Object.keys(box?.shareWith ?? {});
    const names = await client.sharedWith().catch(() => new Map<string, Person>());
    setPeople(ids.map((id) => ({ p: names.get(id) ?? { id, name: id, email: '' }, access: accessOf(box!.shareWith[id]) })));
  }, [client, boxIds.join()]);
  useEffect(() => { load().catch((e) => { setPeople([]); setMsg(e.message); }); }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg('');
    try { await fn(); await load(); onDone(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    const p = await client.findPerson(email);
    if (p.email.toLowerCase() === client.username.toLowerCase()) throw new Error('That’s you. Enter someone else’s address.');
    await client.share(boxIds, p.id, ACCESS[access]); setEmail('');
  });
  return (
    <div className="share-panel" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (email.trim()) add(); } }}>
      <p className="fine">{intro}</p>
      <div className="inline-form">
        <input className="input" type="email" placeholder="Their address, e.g. sam@example.com" aria-label="Share with" value={email} onChange={(e) => setEmail(e.target.value)} />
        <AccessSelect value={access} onChange={setAccess} label="What they can do" />
        <Button disabled={busy || !email.trim()} onClick={add}>Share</Button>
      </div>
      {people === null ? <p className="fine">Loading…</p> : people.length > 0 && (
        <ul className="rule-list">
          {people.map(({ p, access }) => (
            <li key={p.id}>
              <span className="grow">{p.email || p.name}</span>
              <span className="row-btns">
                <AccessSelect value={access} onChange={(a) => run(() => client.share(boxIds, p.id, ACCESS[a]))} label={`What ${p.email} can do`} />
                <Button variant="quiet" size="sm" icon="close" label={`Stop sharing with ${p.email || p.name}`} onClick={() => run(() => client.share(boxIds, p.id, null))} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}

function AccessSelect({ value, onChange, label }: { value: Access; onChange: (a: Access) => void; label: string }) {
  return (
    <select className="input input--sm" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Access)}>
      {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
    </select>
  );
}

/** Settings → Delegation: someone else reads, files and answers your mail, and may send on your behalf. */
export function DelegatesSection({ client }: { client: Jmap }) {
  const [list, setList] = useState<{ p: Person; send: boolean }[] | null>(null);
  const [email, setEmail] = useState('');
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const inbox = (await client.shares()).find((b) => b.role === 'inbox');
    const ids = Object.entries(inbox?.shareWith ?? {}).filter(([, r]) => accessOf(r) === 'full').map(([id]) => id);
    const names = await client.sharedWith().catch(() => new Map<string, Person>());
    setList(ids.map((id) => ({ p: names.get(id) ?? { id, name: id, email: '' }, send: !!inbox!.shareWith[id].maySubmit })));
  }, [client]);
  useEffect(() => { load().catch((e) => { setList([]); setMsg(e.message); }); }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg('');
    try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    const p = await client.findPerson(email);
    if (p.email.toLowerCase() === client.username.toLowerCase()) throw new Error('That’s you. Enter someone else’s address.');
    await client.delegate(p.id, send); setEmail('');
  });
  return (
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (email.trim()) add(); } }}>
      <h3>Delegation</h3>
      <p className="fine">Let someone on this server open your whole mailbox from their account menu, for example an assistant. They can read, file and delete your mail. With sending on, their replies go out from your address “on behalf of” them.</p>
      <div className="inline-form">
        <input className="input" type="email" placeholder="Their address" aria-label="Delegate to" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button disabled={busy || !email.trim()} onClick={add}>Give access</Button>
      </div>
      <label className="inline"><input type="checkbox" className="check" checked={send} onChange={(e) => setSend(e.target.checked)} />Also let them send on my behalf</label>
      {list === null ? <p className="fine">Loading…</p> : list.length > 0 && (
        <ul className="rule-list">
          {list.map(({ p, send }) => (
            <li key={p.id}>
              <span className="grow">{p.email || p.name}<span className="fine"> · {send ? 'can send on your behalf' : 'can’t send'}</span></span>
              <span className="row-btns">
                <Button variant="quiet" size="sm" onClick={() => run(() => client.delegate(p.id, !send))}>{send ? 'Stop sending' : 'Allow sending'}</Button>
                <Button variant="quiet" size="sm" icon="close" label={`Remove ${p.email || p.name}`} onClick={async () => {
                  if (await confirmIt({ title: `Remove ${p.email || p.name}?`, body: 'They can no longer open your mailbox or send on your behalf.', confirm: 'Remove access', danger: true }))
                    run(() => client.delegate(p.id, null));
                }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}

/** Internal notes on a conversation in a shared mailbox. Members only; never sent to anyone. */
export function TeamComments({ client, threadId, version, me }: { client: Jmap; threadId: string; version: number; me: string }) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => client.comments(threadId).then(setList, (e) => { setList([]); setMsg(e.message); }), [client, threadId]);
  useEffect(() => { load(); }, [load, version]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg('');
    try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="team-comments" aria-label="Team comments">
      <h2 className="rail-label">Team comments <span className="fine">· only people with access to this mailbox see these</span></h2>
      {list?.map((c) => (
        <div key={c.id} className="comment">
          <p className="comment-meta"><b>{displayName(c.author)}</b> <time dateTime={c.at}>{shortDate(c.at)}</time>
            {c.author.email.toLowerCase() === me.toLowerCase() && <Button variant="quiet" size="sm" icon="trash" label="Delete comment" onClick={() => run(() => client.deleteComment(c.id))} />}</p>
          <p className="comment-text">{c.text}</p>
        </div>
      ))}
      <div className="inline-form">
        <textarea className="input" rows={2} placeholder="Add a comment for your team" aria-label="Team comment" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) run(async () => { await client.addComment(threadId, text); setText(''); }); }} />
        <Button disabled={busy || !text.trim()} onClick={() => run(async () => { await client.addComment(threadId, text); setText(''); })}>Comment</Button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
