import { Icon } from './icons';
import type { Address } from './jmap';
import { t } from './i18n';

/** Gmail-style one-click filters under the search box, plus "From <person>" for a name being typed. */
export function SearchChips({ query, contacts, onChange }: { query: string; contacts: Address[]; onChange: (q: string) => void }) {
  const week = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const chips: [string, string, RegExp][] = [
    [t('mail.chipUnread'), 'is:unread', /(^|\s)is:unread\b/], [t('folder.starred'), 'is:starred', /(^|\s)is:starred\b/],
    [t('mail.chipAttachment'), 'has:attachment', /(^|\s)has:attach\w*/], [t('mail.chipLastWeek'), `after:${week}`, /(^|\s)after:\S+/],
    [t('folder.sent'), 'in:sent', /(^|\s)in:sent\b/], [t('smarts.chipPurchases'), 'is:purchase', /(^|\s)is:purchases?\b/],
  ];
  const toggle = (token: string, re: RegExp) => onChange(re.test(query) ? query.replace(re, ' ').replace(/\s+/g, ' ').trim() : `${query.trim()} ${token}`.trim());
  // The last word, if it's plain text, may be the start of a name: offer people who match.
  const last = /(?:^|\s)([^\s:"]{2,})$/.exec(query)?.[1]?.toLowerCase();
  const people = last ? contacts.filter((c) => c.email.toLowerCase().includes(last) || c.name?.toLowerCase().includes(last)).slice(0, 3) : [];
  return (
    <div className="search-chips" role="toolbar" aria-label={t('mail.searchFilters')}>
      {people.map((c) => (
        <button key={c.email} className="filter-chip person" onClick={() => onChange(query.replace(new RegExp(`${last!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), `from:${c.email}`))}>
          <Icon name="person" size={14} />{t('mail.fromPerson', { name: c.name || c.email })}
        </button>
      ))}
      {chips.map(([label, token, re]) => (
        <button key={label} className={`filter-chip${re.test(query) ? ' on' : ''}`} aria-pressed={re.test(query)} onClick={() => toggle(token, re)}>{label}</button>
      ))}
    </div>
  );
}
