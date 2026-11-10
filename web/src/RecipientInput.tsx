import { useId, useMemo, useState } from 'react';
import type { Address } from './jmap';
import { formatAddress, withGroups } from './mailutil';
import { t } from './i18n';
import { Icon } from './icons';

type Group = { name: string; members: Address[] };
type Option = Address | Group;
const isGroup = (o: Option): o is Group => 'members' in o;

/**
 * Comma-separated recipients with suggestions for the address being typed.
 * Follows the ARIA combobox pattern: arrows move, Enter/Tab picks, Esc closes.
 */
export function RecipientInput({ value, onChange, contacts, groups = [], chips = [], onChips, inputRef, label }: {
  value: string; onChange: (v: string) => void; contacts: Address[];
  /** Contact groups offered as suggestions. */
  groups?: Group[];
  /** Groups picked so far, each one chip "Name (N)": removed in one go, or expanded into its members' addresses to
   *  edit them. Without onChips, picking a group adds its members as addresses straight away. */
  chips?: Group[]; onChips?: (g: Group[]) => void;
  inputRef?: React.Ref<HTMLInputElement>; label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const head = value.slice(0, value.lastIndexOf(',') + 1); // everything before the address being typed
  const term = value.slice(head.length).trim().toLowerCase();
  const already = useMemo(() => new Set(head.toLowerCase().match(/[^\s<>,;]+@[^\s<>,;]+/g) ?? []), [head]);
  const matches = useMemo((): Option[] => !term ? [] : [
    ...groups.filter((g) => g.members.length && g.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(term))).slice(0, 3),
    ...contacts
      .filter((c) => !already.has(c.email.toLowerCase()))
      .filter((c) => c.email.toLowerCase().includes(term) || c.name?.toLowerCase().split(/\s+/).some((w) => w.startsWith(term)))
      .slice(0, 6)], [term, contacts, groups, already]);
  const show = open && matches.length > 0;

  function pick(o: Option) {
    if (isGroup(o) && onChips) {
      if (!chips.some((g) => g.name === o.name)) onChips([...chips, o]);
      onChange(head ? `${head} ` : '');
      return setOpen(false);
    }
    const add = isGroup(o) ? o.members.filter((m) => !already.has(m.email.toLowerCase())) : [o];
    onChange(`${head}${head ? ' ' : ''}${add.map(formatAddress).join(', ')}, `);
    setOpen(false);
  }

  return (
    <span className="recipients">
      {chips.map((g) => (
        <span key={g.name} className="chip group-chip">
          <button type="button" className="fname" title={g.members.map(formatAddress).join(', ')} aria-label={t('compose.groupExpand', { name: g.name })}
            onClick={() => { onChange(`${withGroups(value, [g])}, `); onChips?.(chips.filter((x) => x !== g)); }}>{g.name} ({g.members.length})</button>
          <button type="button" className="btn" aria-label={t('compose.groupRemove', { name: g.name })} onClick={() => onChips?.(chips.filter((x) => x !== g))}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      <input ref={inputRef} value={value} aria-label={label} spellCheck={false} autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={show ? `${listId}-${active}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]); }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        }} />
      {show && (
        <ul className="suggestions" role="listbox" id={listId}>
          {matches.map((c, i) => (
            <li key={isGroup(c) ? `group:${c.name}` : c.email} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(i)}>
              <span className="sname">{isGroup(c) ? c.name : c.name ?? c.email}</span>
              {isGroup(c) ? <span className="semail">{t('contacts.groupOf', { count: c.members.length })}</span> : c.name && <span className="semail">{c.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
