import { useMemo, useState } from 'react';
import { Icon, type IconName } from './icons';
import { t } from './i18n';
import { AskInbox } from './Ask';
import type { Jmap } from './jmap';

export interface Command { id: string; label: string; icon: IconName; hint?: string; run: () => void }

/** ⌘K / Ctrl+K: type to find any action or folder. Matches every word, in any order. */
/** `ask`: only when the browser has an on-device language model (ai.ts canAsk); adds "Ask your inbox". */
export function Palette({ commands, onClose, ask }: { commands: Command[]; onClose: () => void; ask?: { client: Jmap; open: (threadId: string) => void } }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [asked, setAsked] = useState<string | null>(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const found = commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 9);
    // A question goes first; anything else keeps commands first.
    const askCmd: Command | null = ask && q.trim() ? { id: 'ask', label: t('ask.command', { question: q.trim() }), icon: 'search', run: () => setAsked(q.trim()) } : null;
    return askCmd ? (q.trim().endsWith('?') ? [askCmd, ...found] : [...found, askCmd]) : found;
  }, [q, commands, ask]);
  const run = (c: Command | undefined) => { if (!c) return; if (c.id !== 'ask') onClose(); c.run(); };

  return (
    <div className="overlay top" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={t('palette.label')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input autoFocus value={q} placeholder={ask ? t('ask.placeholder') : t('palette.placeholder')} aria-controls="palette-list"
            aria-activedescendant={shown[i] ? `cmd-${shown[i].id}` : undefined}
            onChange={(e) => { setQ(e.target.value); setI(0); setAsked(null); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(shown[i]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }} />
        </div>
        {asked && ask ? <AskInbox client={ask.client} question={asked} onOpen={(tid) => { onClose(); ask.open(tid); }} /> :
        <ul id="palette-list" role="listbox">
          {shown.map((c, n) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={n === i}
              onMouseEnter={() => setI(n)} onMouseDown={(e) => { e.preventDefault(); run(c); }}>
              <Icon name={c.icon} size={16} /><span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="none">{t('palette.none')}</li>}
        </ul>}
      </div>
    </div>
  );
}
