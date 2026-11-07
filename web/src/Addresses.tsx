import { useEffect, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import type { Jmap, MaskedAlias } from './jmap';

/**
 * Settings → Addresses: masked addresses that deliver to this inbox. One per site; if one leaks or starts getting
 * spam, switch it off and the sender gets "no such mailbox". They also appear in Compose's From menu.
 * Lives inside the Settings <form>, so no nested form: Enter in the name field creates instead of saving Settings.
 */
export function AddressesSection({ client, onChanged }: { client: Jmap; onChanged: () => void }) {
  const [list, setList] = useState<MaskedAlias[] | null | 'off'>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => { client.aliases().then((l) => setList(l ?? 'off'), (e) => { setList([]); setMsg(e.message); }); }, [client]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setMsg('');
    try { await fn(); onChanged(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  const create = () => run(async () => {
    const a = await client.createAlias(label.trim());
    setList((l) => (Array.isArray(l) ? [a, ...l] : [a])); setLabel('');
    await copy(a.email);
  });
  const patch = (a: MaskedAlias, p: { enabled?: boolean; label?: string }) => run(async () => {
    const n = await client.updateAlias(a.id, p);
    setList((l) => (Array.isArray(l) ? l.map((x) => (x.id === a.id ? n : x)) : l));
  });
  const remove = async (a: MaskedAlias) => await confirmIt({ title: `Delete ${a.email}?`, body: 'Mail sent to it will bounce, and it can’t be brought back. To pause it instead, switch it off.', confirm: 'Delete address', danger: true })
    && run(async () => { await client.deleteAlias(a.id); setList((l) => (Array.isArray(l) ? l.filter((x) => x.id !== a.id) : l)); });
  async function copy(email: string) {
    try { await navigator.clipboard.writeText(email); setCopied(email); setTimeout(() => setCopied(''), 2000); } catch { /* the address is on screen anyway */ }
  }

  if (list === 'off') return null; // this server doesn't run the account service
  return (
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (label.trim()) create(); } }}>
      <h3>Masked addresses</h3>
      <p className="fine">Give a different address to each shop, app or newsletter. Mail arrives here as usual. If one starts getting spam or gets sold, switch it off.</p>
      <div className="inline-form">
        <input className="input" placeholder="What is it for? e.g. Online shopping" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button disabled={busy || !label.trim()} onClick={create}>Create</Button>
      </div>
      {list === null && <p className="fine">Loading…</p>}
      {Array.isArray(list) && list.length > 0 && (
        <ul className="rule-list alias-list">
          {list.map((a) => (
            <li key={a.id} className={a.enabled ? '' : 'off'}>
              <span className="grow">
                <code className="key">{a.email}</code>
                <span className="fine"> · {a.label || 'Set by your administrator'}{a.enabled ? '' : ' · off'}</span>
              </span>
              <Button variant="quiet" size="sm" icon={copied === a.email ? 'check' : 'copy'} label={`Copy ${a.email}`} onClick={() => copy(a.email)} />
              <label className="switch" title={a.enabled ? 'Receiving mail' : 'Switched off'}>
                <input type="checkbox" checked={a.enabled} disabled={busy} onChange={(e) => patch(a, { enabled: e.target.checked })} aria-label={`Receive mail at ${a.email}`} />
                <span />
              </label>
              {a.masked && <Button variant="quiet" size="sm" icon="trash" label={`Delete ${a.email}`} disabled={busy} onClick={() => remove(a)} />}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
