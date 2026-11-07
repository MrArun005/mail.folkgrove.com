import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

/**
 * The app's own confirm / prompt / alert, instead of the browser's grey boxes. Promise-based so call sites stay
 * one line: `if (!(await confirmIt({ … }))) return;`. One <DialogHost/> (in App) renders whatever is asked.
 */
interface Ask {
  title: string;
  body?: string;
  confirm?: string;      // button label; omitted for a plain notice (alert)
  cancel?: string | false;
  danger?: boolean;      // destructive: the confirm button is red
  input?: { label: string; value?: string; placeholder?: string; secret?: boolean };
  choose?: { label: string; value: string; options: [value: string, label: string][] };
  resolve: (v: string | boolean) => void;
}

let show: ((a: Ask) => void) | null = null;
const open = (a: Omit<Ask, 'resolve'>) => new Promise<string | boolean>((resolve) => {
  if (show) show({ ...a, resolve });
  else resolve(a.input ? false : !!window.confirm(a.title)); // no host mounted (tests): fall back
});

export const confirmIt = (a: { title: string; body?: string; confirm: string; danger?: boolean }) =>
  open(a).then((v) => v === true);
/** Resolves with the trimmed text, or null when cancelled or left empty. */
/** secret: a password field, and the text is returned as typed (a passphrase's spaces matter). */
export const promptIt = (a: { title: string; body?: string; label: string; value?: string; placeholder?: string; confirm: string; secret?: boolean }) =>
  open({ title: a.title, body: a.body, confirm: a.confirm, input: { label: a.label, value: a.value, placeholder: a.placeholder, secret: a.secret } })
    .then((v) => (typeof v === 'string' && v.trim() ? (a.secret ? v : v.trim()) : null));
/** Resolves with the chosen option's value, or null when cancelled. */
export const chooseIt = (a: { title: string; body?: string; label: string; value: string; options: [string, string][]; confirm: string }) =>
  open({ title: a.title, body: a.body, confirm: a.confirm, choose: { label: a.label, value: a.value, options: a.options } })
    .then((v) => (typeof v === 'string' ? v : null));
export const notify = (title: string, body?: string) => open({ title, body, confirm: 'OK', cancel: false }).then(() => undefined);

export function DialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { show = (a) => { setValue(a.input?.value ?? a.choose?.value ?? ''); setAsk(a); }; return () => { show = null; }; }, []);
  useEffect(() => { if (ask && !ask.input) confirmRef.current?.focus(); }, [ask]);
  if (!ask) return null;

  const done = (v: string | boolean) => { ask.resolve(v); setAsk(null); };
  const ok = () => done(ask.input || ask.choose ? value : true);
  return createPortal(
    <div className="overlay" onMouseDown={() => done(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby={ask.body ? 'dlg-body' : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
          if (e.key === 'Enter' && ask.input) { e.preventDefault(); ok(); }
        }}>
        <h2 id="dlg-title">{ask.title}</h2>
        {ask.body && <p id="dlg-body">{ask.body}</p>}
        {ask.input && (
          <label>{ask.input.label}
            <input className="input" autoFocus type={ask.input.secret ? 'password' : 'text'} autoComplete={ask.input.secret ? 'current-password' : undefined} value={value} placeholder={ask.input.placeholder} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        {ask.choose && (
          <label>{ask.choose.label}
            <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
              {ask.choose.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          {ask.cancel !== false && <Button onClick={() => done(false)}>{ask.cancel ?? 'Cancel'}</Button>}
          <Button ref={confirmRef} variant="primary" className={ask.danger ? 'btn--danger' : ''} disabled={!!ask.input && !value.trim()} onClick={ok}>
            {ask.confirm ?? 'OK'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
