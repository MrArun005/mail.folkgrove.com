import { useEffect, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import type { CustomDomain, DnsRecord, DomainInvitation, GivenAddress, Jmap } from './jmap';
import { locale, t, type Key } from './i18n';

/**
 * Settings → Your domain: use an address at a domain you own (signup/domains.mjs). Add the domain, put a TXT record
 * at your DNS host to prove it's yours, then add the mail records shown. Addresses on it appear in Compose's From.
 * The owner can also offer addresses on the domain to other people with an account here (an organisation's domain).
 * That is an invitation: the other person sees it below their own domains and accepts or declines; only an accepted
 * address is put on their account. What they accepted is listed below that, and they can give it up, nothing more.
 * Lives inside the Settings <form>, so no nested form (Enter is handled by hand, as in Addresses.tsx).
 * ponytail: a domain still waiting for its TXT record lives only in this component; after a reload, add it again
 * (the record to add stays the same).
 */
const KIND: Record<DnsRecord['kind'], Key> = { verify: 'domains.kindVerify', mx: 'domains.kindMx', spf: 'domains.kindSpf', dkim: 'domains.kindDkim', dmarc: 'domains.kindDmarc' };
const STATUS: Record<CustomDomain['status'], [Key, string]> = { pending: ['domains.pending', ''], active: ['domains.active', 'on'], missing: ['domains.missing', 'pill--warn'], paused: ['domains.paused', 'pill--warn'] };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale(), { dateStyle: 'medium' }) : '');

export function DomainsSection({ client, onChanged }: { client: Jmap; onChanged: () => void }) {
  const [list, setList] = useState<CustomDomain[] | null | 'off'>(null);
  const [max, setMax] = useState(0);
  const [given, setGiven] = useState<GivenAddress[]>([]);
  const [invites, setInvites] = useState<DomainInvitation[]>([]);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => client.customDomains().then((r) => {
    if (!r) return setList('off');
    setMax(r.maxDomains);
    setGiven(r.memberOf ?? []);
    setInvites(r.invitations ?? []);
    setList(r.domains);
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
  const remove = async (d: CustomDomain) => (d.status === 'pending' ? run(`rm:${d.name}`, async () => { await client.customDomains(`/${d.name}`, 'DELETE'); setList((l) => (Array.isArray(l) ? l.filter((x) => x !== d) : l)); })
    : await confirmIt({ title: t('domains.removeTitle', { domain: d.name }), body: t('domains.removeBody', { count: d.addresses.length + (d.members?.length ?? 0) }), confirm: t('domains.removeConfirm'), danger: true })
      && run(`rm:${d.name}`, async () => { await client.customDomains(`/${d.name}`, 'DELETE'); setList((l) => (Array.isArray(l) ? l.filter((x) => x.name !== d.name) : l)); onChanged(); }));
  const giveUp = async (g: GivenAddress) => await confirmIt({ title: t('domains.giveUpTitle', { email: g.email }), body: t('domains.giveUpBody'), confirm: t('domains.giveUpConfirm'), danger: true })
    && run(`given:${g.email}`, async () => { await client.customDomains(`/${g.domain}/members/${g.name}`, 'DELETE'); setGiven((l) => l.filter((x) => x.email !== g.email)); onChanged(); });
  // Accepting puts the address on this account (reload: it moves to "Addresses you were given" and into From).
  // Declining only removes the invitation, so it asks nothing. If either fails (withdrawn or expired meanwhile),
  // the list is read again so it shows what is still there.
  const answer = (i: DomainInvitation, accept: boolean) => run(`invite:${i.email}`, async () => {
    try { await client.customDomains(`/${i.domain}/invitations/${i.name}`, accept ? 'POST' : 'DELETE'); } finally { await load(); }
    if (accept) onChanged();
  });

  if (list === 'off') return null; // this server doesn't offer custom domains
  return (
    <section onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).dataset.domainAdd !== undefined) { e.preventDefault(); if (domain.trim()) add(domain.trim()); } }}>
      <h3>{t('domains.title')}</h3>
      <p className="fine">{t('domains.intro')}</p>
      {Array.isArray(list) && list.map((d) => <DomainCard key={d.name} d={d} client={client} busy={busy} run={run} put={put} onChanged={onChanged} recheck={() => add(d.name)} remove={() => remove(d)} />)}
      {Array.isArray(list) && list.length < max && (
        <div className="inline-form">
          <input className="input" data-domain-add placeholder={t('domains.placeholder')} aria-label={t('domains.title')} autoCapitalize="off" spellCheck={false} value={domain} onChange={(e) => setDomain(e.target.value)} />
          <Button disabled={!!busy || !domain.trim()} onClick={() => add(domain.trim())}>{t('domains.add')}</Button>
        </div>
      )}
      {invites.length > 0 && <>
        <p><strong>{t('domains.invitesTitle')}</strong></p>
        <p className="fine">{t('domains.invitesIntro')}</p>
        <ul className="rule-list alias-list">
          {invites.map((i) => (
            <li key={i.email}>
              <span className="grow"><code className="key">{i.email}</code>{i.owner && <span className="fine"> · {t('domains.givenBy', { owner: i.owner })}</span>}<span className="fine"> · {t('domains.inviteAnswerBy', { date: day(i.expires) })}</span></span>
              <Button size="sm" title={t('domains.acceptLabel', { email: i.email })} disabled={!!busy} onClick={() => answer(i, true)}>{t('domains.accept')}</Button>
              <Button size="sm" title={t('domains.declineLabel', { email: i.email })} disabled={!!busy} onClick={() => answer(i, false)}>{t('domains.decline')}</Button>
            </li>
          ))}
        </ul>
      </>}
      {given.length > 0 && <>
        <p><strong>{t('domains.givenTitle')}</strong></p>
        <p className="fine">{t('domains.givenIntro')}</p>
        <ul className="rule-list alias-list">
          {given.map((g) => (
            <li key={g.email} className={g.enabled ? '' : 'off'}>
              <span className="grow"><code className="key">{g.email}</code>{g.owner && <span className="fine"> · {t('domains.givenBy', { owner: g.owner })}</span>}{!g.enabled && <span className="fine"> · {t('domains.paused')}</span>}</span>
              <Button variant="quiet" size="sm" icon="trash" label={t('domains.giveUp', { email: g.email })} disabled={!!busy} onClick={() => giveUp(g)} />
            </li>
          ))}
        </ul>
      </>}
      {list === null && <p className="fine">{t('common.loading')}</p>}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}

function DomainCard({ d, client, busy, run, put, onChanged, recheck, remove }: {
  d: CustomDomain; client: Jmap; busy: string; run: (key: string, fn: () => Promise<void>) => Promise<void>;
  put: (d: CustomDomain) => void; onChanged: () => void; recheck: () => void; remove: () => void;
}) {
  const [name, setName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [account, setAccount] = useState('');
  const [copied, setCopied] = useState('');
  const members = d.members ?? [], invited = d.invitations ?? [];
  const used = d.addresses.length + members.length + invited.length; // one limit for the domain: yours, other people's, and invitations not answered yet
  const room = used < d.maxAddresses;
  const home = client.username.split('@')[1] ?? ''; // members are accounts on this server's own domain
  const [label, cls] = STATUS[d.status];
  const missing = d.records.filter((r) => r.ok !== true);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 2000); } catch { /* it's on screen */ }
  }
  const addAddress = () => run(`addr:${d.name}`, async () => {
    put((await client.customDomains(`/${d.name}/addresses`, 'POST', { name: name.trim() })).domain); setName(''); onChanged();
  });
  const dropAddress = async (email: string, n: string) => await confirmIt({ title: t('domains.deleteAddressTitle', { email }), body: t('domains.deleteAddressBody'), confirm: t('domains.deleteAddress'), danger: true })
    && run(`addr:${d.name}`, async () => { put((await client.customDomains(`/${d.name}/addresses/${n}`, 'DELETE')).domain); onChanged(); });
  const addMember = () => run(`member:${d.name}`, async () => {
    put((await client.customDomains(`/${d.name}/members`, 'POST', { account: account.trim(), name: memberName.trim() })).domain); setMemberName(''); setAccount('');
  });
  const withdraw = (n: string) => run(`member:${d.name}`, async () => { put((await client.customDomains(`/${d.name}/invitations/${n}`, 'DELETE')).domain); });
  const dropMember = async (email: string, n: string, who: string) => await confirmIt({ title: t('domains.takeBackTitle', { email, account: who }), body: t('domains.takeBackBody'), confirm: t('domains.takeBackConfirm'), danger: true })
    && run(`member:${d.name}`, async () => { put((await client.customDomains(`/${d.name}/members/${n}`, 'DELETE')).domain); });
  // DNS panels want the name without the domain ("@" for the domain itself).
  const host = (n: string) => (n === d.name ? '@' : n.slice(0, -(d.name.length + 1)));
  const spf = t('domains.spfNote', { include: '\0', domain: d.name }).split('\0'); // {include} is shown as code

  return (
    <div className="domain-card">
      <div className="domain-head">
        <strong className="grow">{d.name}</strong>
        <span className={`pill ${cls}`}>{t(label)}</span>
        <Button variant="quiet" size="sm" icon="trash" label={t('domains.remove', { domain: d.name })} disabled={!!busy} onClick={remove} />
      </div>
      <p className="fine">
        {d.status === 'pending' && t('domains.pendingNote')}
        {d.status === 'active' && (missing.length ? t('domains.activeMissing') : t('domains.activeNote'))}
        {d.status === 'missing' && t('domains.missingNote', { date: day(d.pausesAt), domain: d.name })}
        {d.status === 'paused' && t('domains.pausedNote', { domain: d.name })}
        {d.dkimPending && ` ${t('domains.dkimPending')}`}
      </p>
      <ul className="rule-list dns-list">
        {d.records.map((r) => (
          <li key={r.kind + r.name}>
            <span className="grow">
              <span className="fine">{t(KIND[r.kind])} · {r.type} · {t('domains.name')} <code>{host(r.name)}</code></span>
              <code>{r.value}</code>
            </span>
            <span className={`pill ${r.ok ? 'on' : r.ok === null ? 'pill--warn' : ''}`}>{r.ok ? t('domains.found') : r.ok === null ? t('domains.couldntCheck') : t('domains.notYet')}</span>
            <Button variant="quiet" size="sm" icon={copied === r.value ? 'check' : 'copy'} label={t('domains.copyValue', { type: r.type })} onClick={() => copy(r.value)} />
          </li>
        ))}
      </ul>
      <p className="fine">{spf[0]}<code>{d.records.find((r) => r.kind === 'spf')?.value.split(' ')[1]}</code>{spf[1]}</p>
      <div><Button size="sm" disabled={!!busy} onClick={recheck}>{busy === `add:${d.name}` ? t('domains.checking') : t('domains.checkAgain')}</Button></div>

      {d.status !== 'pending' && <>
        {d.addresses.length > 0 && (
          <ul className="rule-list alias-list">
            {d.addresses.map((a) => (
              <li key={a.email} className={a.enabled ? '' : 'off'}>
                <span className="grow"><code className="key">{a.email}</code>{a.main && <span className="fine"> · {t('domains.mainAddress')}</span>}</span>
                <Button variant="quiet" size="sm" icon={copied === a.email ? 'check' : 'copy'} label={t('domains.copy', { email: a.email })} onClick={() => copy(a.email)} />
                {!a.main && <Button variant="quiet" size="sm" icon="trash" label={t('domains.delete', { email: a.email })} disabled={!!busy} onClick={() => dropAddress(a.email, a.name)} />}
              </li>
            ))}
          </ul>
        )}
        {room && (
          <div className="inline-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (name.trim()) addAddress(); } }}>
            <input className="input" placeholder={t('domains.addressPlaceholder')} aria-label={t('domains.newAddress', { domain: d.name })} autoCapitalize="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
            <span className="fine domain-at">@{d.name}</span>
            <Button disabled={!!busy || !name.trim()} onClick={addAddress}>{t('domains.addAddress')}</Button>
          </div>
        )}

        <p><strong>{t('domains.membersTitle')}</strong></p>
        <p className="fine">{t('domains.membersIntro', { domain: d.name })} {t('domains.addressesUsed', { used, max: d.maxAddresses })}</p>
        {members.length + invited.length > 0 && (
          <ul className="rule-list alias-list">
            {members.map((m) => (
              <li key={m.email} className={m.enabled ? '' : 'off'}>
                <span className="grow"><code className="key">{m.email}</code><span className="fine"> · {t('domains.memberFor', { account: m.account })}</span></span>
                <Button variant="quiet" size="sm" icon="trash" label={t('domains.takeBack', { email: m.email })} disabled={!!busy} onClick={() => dropMember(m.email, m.name, m.account)} />
              </li>
            ))}
            {invited.map((i) => (
              <li key={i.email}>
                <span className="grow"><code className="key">{i.email}</code><span className="fine"> · {t('domains.memberFor', { account: i.account })} · {t('domains.invitedWaiting', { date: day(i.expires) })}</span></span>
                <Button size="sm" title={t('domains.withdrawLabel', { email: i.email })} disabled={!!busy} onClick={() => withdraw(i.name)}>{t('domains.withdraw')}</Button>
              </li>
            ))}
          </ul>
        )}
        {room && (
          <div className="inline-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (memberName.trim() && account.trim()) addMember(); } }}>
            <input className="input" placeholder={t('domains.memberNamePlaceholder')} aria-label={t('domains.memberNewAddress', { domain: d.name })} autoCapitalize="off" spellCheck={false} value={memberName} onChange={(e) => setMemberName(e.target.value)} />
            <span className="fine domain-at">@{d.name}</span>
            <input className="input" type="email" placeholder={t('domains.memberAccountPlaceholder', { domain: home })} aria-label={t('domains.memberAccountLabel', { domain: home })} autoCapitalize="off" spellCheck={false} value={account} onChange={(e) => setAccount(e.target.value)} />
            <Button disabled={!!busy || !memberName.trim() || !account.trim()} onClick={addMember}>{t('domains.invite')}</Button>
          </div>
        )}
      </>}
    </div>
  );
}
