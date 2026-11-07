import { useMemo, useState } from 'react';
import { Icon, type IconName } from './icons';

export interface Command { id: string; label: string; icon: IconName; hint?: string; run: () => void }

/** ⌘K / Ctrl+K: type to find any action or folder. Matches every word, in any order. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 9);
  }, [q, commands]);
  const run = (c: Command | undefined) => { if (c) { onClose(); c.run(); } };

  return (
    <div className="overlay top" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input autoFocus value={q} placeholder="Type a command or folder…" aria-controls="palette-list"
            aria-activedescendant={shown[i] ? `cmd-${shown[i].id}` : undefined}
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(shown[i]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }} />
        </div>
        <ul id="palette-list" role="listbox">
          {shown.map((c, n) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={n === i}
              onMouseEnter={() => setI(n)} onMouseDown={(e) => { e.preventDefault(); run(c); }}>
              <Icon name={c.icon} size={16} /><span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="none">No matching command</li>}
        </ul>
      </div>
    </div>
  );
}
