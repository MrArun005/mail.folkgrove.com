import { useEffect, useState } from 'react';
import { Button } from './Button';
import type { Contact } from './jmap';
import { parseAddresses } from './mailutil';
import { t } from './i18n';

export const fullName = (c: Pick<Contact, 'given' | 'surname'>) => `${c.given} ${c.surname}`.trim();
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const Avatar = ({ c }: { c: Contact }) => (
  <span className="avatar" aria-hidden="true" style={{ '--h': hue(c.emails[0] ?? fullName(c)) } as React.CSSProperties}>
    {(fullName(c) || c.emails[0] || '?').slice(0, 1).toUpperCase()}
  </span>
);

/** List pane: filter as you type; rows share the conversation list's rhythm. */
export function ContactList({ contacts, selected, onSelect, onNew }: {
  contacts: Contact[] | null; selected: string | null; onSelect: (id: string) => void; onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = contacts?.filter((c) => words.every((w) => [fullName(c), c.org, ...c.emails].join(' ').toLowerCase().includes(w)));
  return (
    <>
      <div className="contacts-tools">
        <input className="input" type="search" placeholder={t('contacts.find')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('contacts.find')} />
        <Button icon="compose" onClick={onNew}>{t('contacts.newButton')}</Button>
      </div>
      {contacts === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
      {contacts?.length === 0 && <p className="empty">{t('contacts.empty')}</p>}
      {contacts && contacts.length > 0 && shown?.length === 0 && <p className="empty">{t('contacts.noMatch', { query: q })}</p>}
      <ul className="subs">
        {shown?.map((c) => (
          <li key={c.id}>
            <button className={`sub contact-row${c.id === selected ? ' active' : ''}`} onClick={() => onSelect(c.id!)}>
              <Avatar c={c} />
              <span className="who">
                <span className="name">{fullName(c) || c.emails[0]}</span>
                <span className="meta">{[c.org, c.emails[0]].filter(Boolean).join(', ')}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Reader pane: a contact's details, or the editor. */
export function ContactPanel({ contact, editing, onEdit, onSave, onDelete, onCancel, onEmail }: {
  contact: Contact | null; editing: boolean;
  onEdit: () => void; onSave: (c: Contact) => Promise<void>; onDelete: (c: Contact) => void; onCancel: () => void; onEmail: (c: Contact) => void;
}) {
  if (editing) return <ContactEditor initial={contact} onSave={onSave} onCancel={onCancel} />;
  if (!contact) return <div className="reader-empty"><p>{t('contacts.select')}</p></div>;
  return (
    <article className="thread contact">
      <div className="toolbar">
        <span className="only-mobile" />
        <Button variant="quiet" icon="compose" label={t('contacts.edit')} onClick={onEdit} />
        <Button variant="quiet" icon="trash" label={t('contacts.delete')} onClick={() => onDelete(contact)} />
      </div>
      <header className="contact-head">
        <Avatar c={contact} />
        <div>
          <h1 className="subject">{fullName(contact) || contact.emails[0]}</h1>
          {contact.org && <p className="fine">{contact.org}</p>}
        </div>
      </header>
      <dl className="contact-fields">
        {contact.emails.map((e) => (
          <div key={e}><dt>{t('contacts.email')}</dt><dd><Button variant="link" onClick={() => onEmail({ ...contact, emails: [e] })}>{e}</Button></dd></div>
        ))}
        {contact.phones.map((p) => <div key={p}><dt>{t('contacts.phone')}</dt><dd><a href={`tel:${p.replace(/[^\d+]/g, '')}`}>{p}</a></dd></div>)}
        {contact.note && <div><dt>{t('contacts.note')}</dt><dd className="note">{contact.note}</dd></div>}
      </dl>
      {contact.emails[0] && <div className="reply-bar"><Button icon="compose" onClick={() => onEmail(contact)}>{contact.given ? t('contacts.emailName', { name: contact.given }) : t('contacts.emailThem')}</Button></div>}
    </article>
  );
}

function ContactEditor({ initial, onSave, onCancel }: { initial: Contact | null; onSave: (c: Contact) => Promise<void>; onCancel: () => void }) {
  const [c, setC] = useState<Contact>(initial ?? { given: '', surname: '', emails: [''], phones: [''], org: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initial) setC({ ...initial, emails: initial.emails.length ? initial.emails : [''], phones: initial.phones.length ? initial.phones : [''] }); }, [initial?.id]);
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));
  const list = (k: 'emails' | 'phones', i: number, v: string) => set({ [k]: c[k].map((x, j) => (j === i ? v : x)) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const emails = c.emails.map((x) => x.trim()).filter(Boolean);
    const bad = emails.filter((x) => !parseAddresses(x).list.length);
    if (!c.given.trim() && !c.surname.trim() && !emails.length) return setError(t('contacts.needNameOrEmail'));
    if (bad.length) return setError(t('contacts.checkAddresses', { count: bad.length, addresses: bad.join(', ') }));
    setBusy(true); setError('');
    try { await onSave({ ...c, emails, phones: c.phones.map((x) => x.trim()).filter(Boolean) }); }
    catch (err) { setError(t('common.couldntSave', { error: (err as Error).message })); setBusy(false); }
  }

  return (
    <form className="thread contact-form" onSubmit={submit}>
      <h1 className="subject">{initial ? t('contacts.edit') : t('contacts.new')}</h1>
      <div className="row2">
        <label>{t('contacts.firstName')}<input className="input" value={c.given} onChange={(e) => set({ given: e.target.value })} autoFocus /></label>
        <label>{t('contacts.lastName')}<input className="input" value={c.surname} onChange={(e) => set({ surname: e.target.value })} /></label>
      </div>
      {c.emails.map((v, i) => (
        <label key={`e${i}`}>{i ? t('contacts.anotherEmail') : t('contacts.email')}<input className="input" type="email" value={v} onChange={(e) => list('emails', i, e.target.value)} /></label>
      ))}
      <Button variant="link" className="start" onClick={() => set({ emails: [...c.emails, ''] })}>{t('contacts.addEmail')}</Button>
      {c.phones.map((v, i) => (
        <label key={`p${i}`}>{i ? t('contacts.anotherPhone') : t('contacts.phone')}<input className="input" type="tel" value={v} onChange={(e) => list('phones', i, e.target.value)} /></label>
      ))}
      <label>{t('contacts.company')}<input className="input" value={c.org} onChange={(e) => set({ org: e.target.value })} /></label>
      <label>{t('contacts.note')}<textarea className="input" rows={3} value={c.note} onChange={(e) => set({ note: e.target.value })} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? t('common.saving') : t('contacts.save')}</Button>
      </footer>
    </form>
  );
}

