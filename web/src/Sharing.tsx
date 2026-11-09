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
import { boxName, t, type Key } from './i18n';

const ACCESS_LABEL: Record<Access, Key> = { read: 'sharing.read', write: 'sharing.write', full: 'sharing.full' };
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
    : a.boxes.map((b) => ({ key: `${a.id}/${b.id}`, a, box: b, label: [boxName(b), who(a.name)].join(' · '), unread: b.unreadEmails }))));
  const shown = items.filter((x) => !hidden.includes(x.key));
  if (!items.length) return null;
  return (
    <div className="saved shared-rail">
      <p className="rail-label">{t('sharing.sharedWithMe')}</p>
      <ul>
        {shown.map((x) => {
          const on = current.account === x.a.id && (!x.box || current.box === x.box.id);
          return (
            <li key={x.key} className="saved-item">
              <button className={`nav-item${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} title={x.a.name} onClick={() => onOpen(x.a, x.box?.id)}>
                <Icon name={x.box ? roleIcon(x.box.role) : x.a.team ? 'inbox' : 'person'} /><span className="name">{x.label}</span>
                {x.unread > 0 && <span className="count">{x.unread}</span>}
              </button>
              <Button variant="quiet" size="sm" icon="close" label={t('sharing.hide', { name: x.label })} onClick={() => onHide(x.key)} />
            </li>
          );
        })}
      </ul>
      {shown.length < items.length && <Button variant="link" className="rail-link" onClick={onUnhide}>{t('sharing.showHidden', { count: items.length - shown.length })}</Button>}
    </div>
  );
}

/** Settings → Folders → Share: who can see this folder, and how much they can do. */
export function ShareFolder({ client, box, onDone }: { client: Jmap; box: Mailbox; onDone: () => void }) {
  return <SharePanel client={client} boxIds={[box.id]} intro={t('sharing.folderIntro', { name: box.name })} onDone={onDone} />;
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
    if (p.email.toLowerCase() === client.username.toLowerCase()) throw new Error(t('sharing.notYou'));
    await client.share(boxIds, p.id, ACCESS[access]); setEmail('');
  });
  return (
    <div className="share-panel" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (email.trim()) add(); } }}>
      <p className="fine">{intro}</p>
      <div className="inline-form">
        <input className="input" type="email" placeholder={t('sharing.addressPlaceholder')} aria-label={t('sharing.shareWith')} value={email} onChange={(e) => setEmail(e.target.value)} />
        <AccessSelect value={access} onChange={setAccess} label={t('sharing.whatTheyCanDo')} />
        <Button disabled={busy || !email.trim()} onClick={add}>{t('sharing.share')}</Button>
      </div>
      {people === null ? <p className="fine">{t('common.loading')}</p> : people.length > 0 && (
        <ul className="rule-list">
          {people.map(({ p, access }) => (
            <li key={p.id}>
              <span className="grow">{p.email || p.name}</span>
              <span className="row-btns">
                <AccessSelect value={access} onChange={(a) => run(() => client.share(boxIds, p.id, ACCESS[a]))} label={t('sharing.whatCanDo', { name: p.email || p.name })} />
                <Button variant="quiet" size="sm" icon="close" label={t('sharing.stop', { name: p.email || p.name })} onClick={() => run(() => client.share(boxIds, p.id, null))} />
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
      {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => <option key={a} value={a}>{t(ACCESS_LABEL[a])}</option>)}
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
    if (p.email.toLowerCase() === client.username.toLowerCase()) throw new Error(t('sharing.notYou'));
    await client.delegate(p.id, send); setEmail('');
  });
  return (
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (email.trim()) add(); } }}>
      <h3>{t('sharing.delegation')}</h3>
      <p className="fine">{t('sharing.delegationIntro')}</p>
      <div className="inline-form">
        <input className="input" type="email" placeholder={t('sharing.theirAddress')} aria-label={t('sharing.delegateTo')} value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button disabled={busy || !email.trim()} onClick={add}>{t('sharing.giveAccess')}</Button>
      </div>
      <label className="inline"><input type="checkbox" className="check" checked={send} onChange={(e) => setSend(e.target.checked)} />{t('sharing.alsoSend')}</label>
      {list === null ? <p className="fine">{t('common.loading')}</p> : list.length > 0 && (
        <ul className="rule-list">
          {list.map(({ p, send }) => (
            <li key={p.id}>
              <span className="grow">{p.email || p.name}<span className="fine"> · {send ? t('sharing.canSend') : t('sharing.cantSend')}</span></span>
              <span className="row-btns">
                <Button variant="quiet" size="sm" onClick={() => run(() => client.delegate(p.id, !send))}>{send ? t('sharing.stopSending') : t('sharing.allowSending')}</Button>
                <Button variant="quiet" size="sm" icon="close" label={t('sharing.remove', { name: p.email || p.name })} onClick={async () => {
                  if (await confirmIt({ title: t('sharing.removeTitle', { name: p.email || p.name }), body: t('sharing.removeBody'), confirm: t('sharing.removeAccess'), danger: true }))
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

/**
 * Notes under a conversation, never sent to anyone. In a shared mailbox they are the team's comments (members only);
 * in your own mailbox (`mine`) they are private notes, kept the same way: a hidden folder in that mailbox, synced.
 * Private notes stay out of the way until there is one: a single link opens the box.
 */
export function TeamComments({ client, threadId, version, me, mine = false }: { client: Jmap; threadId: string; version: number; me: string; mine?: boolean }) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [writing, setWriting] = useState(false);
  useEffect(() => { setWriting(false); setText(''); }, [threadId]);
  const load = useCallback(() => client.comments(threadId).then(setList, (e) => { setList([]); setMsg(e.message); }), [client, threadId]);
  useEffect(() => { load(); }, [load, version]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg('');
    try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (mine && !writing && !list?.length) return list === null ? null
    : <p className="team-comments note-add"><Button variant="link" onClick={() => setWriting(true)}><Icon name="note" size={16} />{t('threadNotes.add')}</Button></p>;
  return (
    <section className="team-comments" aria-label={t(mine ? 'threadNotes.private' : 'sharing.teamComments')}>
      <h2 className="rail-label">{t(mine ? 'threadNotes.private' : 'sharing.teamComments')} <span className="fine">· {t(mine ? 'threadNotes.privateNote' : 'sharing.teamCommentsNote')}</span></h2>
      {list?.map((c) => (
        <div key={c.id} className="comment">
          <p className="comment-meta">{!mine && <b>{displayName(c.author)}</b>} <time dateTime={c.at}>{shortDate(c.at)}</time>
            {c.author.email.toLowerCase() === me.toLowerCase() && <Button variant="quiet" size="sm" icon="trash" label={t(mine ? 'threadNotes.delete' : 'sharing.deleteComment')} onClick={() => run(() => client.deleteComment(c.id))} />}</p>
          <p className="comment-text">{c.text}</p>
        </div>
      ))}
      <div className="inline-form">
        <textarea className="input" rows={2} placeholder={t(mine ? 'threadNotes.placeholder' : 'sharing.commentPlaceholder')} aria-label={t(mine ? 'threadNotes.private' : 'sharing.comment')} autoFocus={mine && writing} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) run(async () => { await client.addComment(threadId, text); setText(''); }); }} />
        <Button disabled={busy || !text.trim()} onClick={() => run(async () => { await client.addComment(threadId, text); setText(''); })}>{t(mine ? 'threadNotes.save' : 'sharing.commentButton')}</Button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
