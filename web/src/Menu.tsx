import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { describe, quickTimes, toLocalInput } from './when';

/** Button + dropdown. Closes on outside click, Esc, or choosing an item. Arrow keys move between items. */
export function Menu({ button, label, children, align = 'left', up = false }: {
  button: ReactNode; label: string; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    ref.current?.querySelector<HTMLElement>('[role=menu] button, [role=menu] input')?.focus();
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
      if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const items = [...ref.current!.querySelectorAll<HTMLElement>('[role=menu] .menu-item')];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    }}>
      <span onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-controls={id}>{button}</span>
      {open && <div role="menu" id={id} aria-label={label} className={`menu-list ${align}${up ? ' up' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Quick times plus a date/time field. Used for Snooze and Schedule send. */
export function TimeChoices({ onPick, close, verb }: { onPick: (d: Date) => void; close: () => void; verb: string }) {
  const [custom, setCustom] = useState(toLocalInput(new Date(Date.now() + 86400e3)));
  return (
    <>
      {quickTimes().map((w) => (
        <button key={w.label} className="menu-item" role="menuitem" onClick={() => { close(); onPick(w.at); }}>
          <span>{w.label}</span><span className="hint">{describe(w.at)}</span>
        </button>
      ))}
      <form className="custom-time" onSubmit={(e) => {
        e.preventDefault();
        const d = new Date(custom);
        if (+d > Date.now()) { close(); onPick(d); }
      }}>
        <label>Pick a date and time<input className="input" type="datetime-local" value={custom} min={toLocalInput(new Date())} onChange={(e) => setCustom(e.target.value)} /></label>
        <Button type="submit" variant="primary" size="sm">{verb}</Button>
      </form>
    </>
  );
}
