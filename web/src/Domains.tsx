import { useEffect, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import type { CustomDomain, DnsRecord, Jmap } from './jmap';

/**
 * Settings → Your domain: use an address at a domain you own (signup/domains.mjs). Add the domain, put a TXT record
 * at your DNS host to prove it's yours, then add the mail records shown. Addresses on it appear in Compose's From.
 * Lives inside the Settings <form>, so no nested form (Enter is handled by hand, as in Addresses.tsx).
 * ponytail: a domain still waiting for its TXT record lives only in this component; after a reload, add it again
 * (the record to add stays the same).
 */
const KIND: Record<DnsRecord['kind'], string> = { verify: 'Proves it’s yours', mx: 'Receive mail (MX)', spf: 'Allowed senders (SPF)', dkim: 'Signature key (DKIM)', dmarc: 'Policy (DMARC)' };
const STATUS: Record<CustomDomain['status'], [string, string]> = { pending: ['Waiting for you', ''], active: ['Working', 'on'], missing: ['Record missing', 'pill--warn'], paused: ['Paused', 'pill--warn'] };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

export function DomainsSection({ client, onChanged }: { client: Jmap; onChanged: () => void }) {
  const [list, setList] = useState<CustomDomain[] | null | 'off'>(null);
  const [max, setMax] = useState(0);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => client.customDomains().then((r) => {
    if (!r) return setList('off');
    setMax(r.maxDomains);
    setList((old) => [...r.domains, ...(Array.isArray(old) ? old.filter((d) => d.status === 'pending' && !r.domains.some((x: CustomDomain) => x.name === d.name)) : [])]);
  }, (e) => { setList((l) => (Array.isArray(l) ? l : [])); setMsg(e.message); });
  useEffect(() => { load(); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (d: CustomDomain) => setList((l) => (Array.isArray(l) ? (l.some((x) => x.name === d.name) ? l.map((x) => (x.name === d.name ? d : x)) : [...l, d]) : [d]));
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setMsg('');
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(''); }
  }
  const add = (name: string) => run(`add:${name}`, async () => {
    const { domain: d } = await client.customDomains('', 'POST', { domain: name });
    put(d); setDomain('');
    if (d.status !== 'pending') onChanged(); // its first address is now in the From menu
  });
  const remove = async (d: CustomDomain) => (d.status === 'pending' ? setList((l) => (Array.isArray(l) ? l.filter((x) => x !== d) : l))
    : await confirmIt({ title: `Remove ${d.name}?`, body: `${d.addresses.length === 1 ? 'Its address stops' : `All ${d.addresses.length} addresses on it stop`} working and can’t be used again, by you or anyone. Mail you already received stays.`, confirm: 'Remove domain', danger: true })
      && run(`rm:${d.name}`, async () => { await client.customDomains(`/${d.name}`, 'DELETE'); setList((l) => (Array.isArray(l) ? l.filter((x) => x.name !== d.name) : l)); onChanged(); }));

  if (list === 'off') return null; // this server doesn't offer custom domains
  return (
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).dataset.domainAdd !== undefined) { e.preventDefault(); if (domain.trim()) add(domain.trim()); } }}>
      <h3>Your domain</h3>
      <p className="fine">Use an address at a domain you own, like you@yourname.com. You’ll add a few records where you manage the domain’s DNS (usually where you bought it).</p>
      {Array.isArray(list) && list.map((d) => <DomainCard key={d.name} d={d} client={client} busy={busy} run={run} put={put} onChanged={onChanged} recheck={() => add(d.name)} remove={() => remove(d)} />)}
      {Array.isArray(list) && list.length < max && (
        <div className="inline-form">
          <input className="input" data-domain-add placeholder="yourname.com" aria-label="Your domain" autoCapitalize="off" spellCheck={false} value={domain} onChange={(e) => setDomain(e.target.value)} />
          <Button disabled={!!busy || !domain.trim()} onClick={() => add(domain.trim())}>Add domain</Button>
        </div>
      )}
      {list === null && <p className="fine">Loading…</p>}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}

function DomainCard({ d, client, busy, run, put, onChanged, recheck, remove }: {
  d: CustomDomain; client: Jmap; busy: string; run: (key: string, fn: () => Promise<void>) => Promise<void>;
  put: (d: CustomDomain) => void; onChanged: () => void; recheck: () => void; remove: () => void;
}) {
  const [name, setName] = useState('');
  const [copied, setCopied] = useState('');
  const [label, cls] = STATUS[d.status];
  const missing = d.records.filter((r) => r.ok !== true);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 2000); } catch { /* it's on screen */ }
  }
  const addAddress = () => run(`addr:${d.name}`, async () => {
    put((await client.customDomains(`/${d.name}/addresses`, 'POST', { name: name.trim() })).domain); setName(''); onChanged();
  });
  const dropAddress = async (email: string, n: string) => await confirmIt({ title: `Delete ${email}?`, body: 'Mail sent to it will bounce, and it can’t be brought back, by you or anyone.', confirm: 'Delete address', danger: true })
    && run(`addr:${d.name}`, async () => { put((await client.customDomains(`/${d.name}/addresses/${n}`, 'DELETE')).domain); onChanged(); });
  // DNS panels want the name without the domain ("@" for the domain itself).
  const host = (n: string) => (n === d.name ? '@' : n.slice(0, -(d.name.length + 1)));

  return (
    <div className="domain-card">
      <div className="domain-head">
        <strong className="grow">{d.name}</strong>
        <span className={`pill ${cls}`}>{label}</span>
        <Button variant="quiet" size="sm" icon="trash" label={`Remove ${d.name}`} disabled={!!busy} onClick={remove} />
      </div>
      <p className="fine">
        {d.status === 'pending' && 'Add the first record below at your DNS host, then press Check again. Changes can take a few minutes to show up (sometimes hours). You can add the others now too.'}
        {d.status === 'active' && (missing.length ? 'Yours. Add the records still marked “Not yet”: until then mail may bounce or land in spam.' : 'All set. Mail to these addresses arrives here, and you can send from them: pick the address in From when you write.')}
        {d.status === 'missing' && `We can’t find the first record any more. Put it back before ${day(d.pausesAt)}, or mail to and from ${d.name} will pause.`}
        {d.status === 'paused' && `Paused since we couldn’t find the first record for 7 days: mail to and from ${d.name} is stopped. Put it back and press Check again.`}
        {d.dkimPending && ' The signature keys are still being made: check again in a minute.'}
      </p>
      <ul className="rule-list dns-list">
        {d.records.map((r) => (
          <li key={r.kind + r.name}>
            <span className="grow">
              <span className="fine">{KIND[r.kind]} · {r.type} · name <code>{host(r.name)}</code></span>
              <code>{r.value}</code>
            </span>
            <span className={`pill ${r.ok ? 'on' : r.ok === null ? 'pill--warn' : ''}`}>{r.ok ? 'Found' : r.ok === null ? 'Couldn’t check' : 'Not yet'}</span>
            <Button variant="quiet" size="sm" icon={copied === r.value ? 'check' : 'copy'} label={`Copy the ${r.type} value`} onClick={() => copy(r.value)} />
          </li>
        ))}
      </ul>
      <p className="fine">Already have an SPF record (it starts with v=spf1)? Don’t add a second one: add <code>{d.records.find((r) => r.kind === 'spf')?.value.split(' ')[1]}</code> to yours. Changing MX moves mail for {d.name} here from wherever it goes now.</p>
      <div><Button size="sm" disabled={!!busy} onClick={recheck}>{busy === `add:${d.name}` ? 'Checking…' : 'Check again'}</Button></div>

      {d.status !== 'pending' && <>
        {d.addresses.length > 0 && (
          <ul className="rule-list alias-list">
            {d.addresses.map((a) => (
              <li key={a.email} className={a.enabled ? '' : 'off'}>
                <span className="grow"><code className="key">{a.email}</code>{a.main && <span className="fine"> · your main address here</span>}</span>
                <Button variant="quiet" size="sm" icon={copied === a.email ? 'check' : 'copy'} label={`Copy ${a.email}`} onClick={() => copy(a.email)} />
                {!a.main && <Button variant="quiet" size="sm" icon="trash" label={`Delete ${a.email}`} disabled={!!busy} onClick={() => dropAddress(a.email, a.name)} />}
              </li>
            ))}
          </ul>
        )}
        {d.addresses.length < d.maxAddresses && (
          <div className="inline-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (name.trim()) addAddress(); } }}>
            <input className="input" placeholder="hello" aria-label={`New address at ${d.name}`} autoCapitalize="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
            <span className="fine domain-at">@{d.name}</span>
            <Button disabled={!!busy || !name.trim()} onClick={addAddress}>Add address</Button>
          </div>
        )}
      </>}
    </div>
  );
}
