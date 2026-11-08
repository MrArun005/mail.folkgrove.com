import { useEffect, useRef, useState, type RefObject } from 'react';
import { canSmartCompose, completeText } from './ai';
import { t } from './i18n';

// Smart Compose: grey suggested words at the cursor, written by the browser's on-device model (ai.ts). Off unless
// turned on in Settings (per device), and only where the browser has such a model. Tab takes the words; any other
// key, a click or leaving the editor drops them.

const KEY = 'om:smartCompose';
const pref = () => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } };
export const smartComposeOn = () => pref() && canSmartCompose();
const WAIT_MS = 600; // after the last keystroke: typing never waits on the model

export function useSmartCompose(editor: RefObject<HTMLDivElement | null>) {
  const timer = useRef(0), abort = useRef<AbortController | null>(null);
  const on = useRef(smartComposeOn()).current;
  const clear = () => {
    clearTimeout(timer.current); abort.current?.abort(); abort.current = null;
    editor.current?.querySelectorAll('[data-ghost]').forEach((g) => g.remove());
  };
  useEffect(() => clear, []);

  /** At the end of a line of text, a moment after typing stops: ask for the next words. */
  function onInput() {
    if (!on) return;
    clear();
    timer.current = window.setTimeout(async () => {
      const ed = editor.current, sel = getSelection(), node = sel?.anchorNode;
      if (!ed || !sel?.isCollapsed || !node || node.nodeType !== 3 || !ed.contains(node) || sel.anchorOffset !== node.textContent!.length) return;
      const r = document.createRange(); r.setStart(ed, 0); r.setEnd(node, sel.anchorOffset);
      const before = r.toString().replace(/ /g, ' ');
      // ponytail: suggestions start after a space only (whole next words, never the rest of a half-typed word).
      if (before.trim().length < 12 || !/\S $/.test(before)) return;
      const ac = abort.current = new AbortController();
      const words = await completeText(before, ac.signal).catch(() => '');
      const now = getSelection();
      if (ac.signal.aborted || !words || now?.anchorNode !== node || now.anchorOffset !== node.textContent!.length) return;
      const ghost = Object.assign(document.createElement('span'), { className: 'ghost', textContent: words, contentEditable: 'false' });
      ghost.dataset.ghost = ''; ghost.setAttribute('aria-hidden', 'true');
      (node as Text).after(ghost);
    }, WAIT_MS);
  }

  /** Tab accepts (as typed text: one undo step); any other key dismisses. True when the key was used. */
  function onKeyDown(e: React.KeyboardEvent) {
    const ghost = editor.current?.querySelector<HTMLElement>('[data-ghost]');
    if (!ghost) return false;
    const words = ghost.textContent ?? '';
    clear();
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    e.preventDefault();
    document.execCommand('insertText', false, words);
    return true;
  }
  return { onInput, onKeyDown, clear, on };
}

/** Settings → Smart Compose. Hidden where the browser has no on-device model. */
export function SmartComposeSetting() {
  const [on, setOn] = useState(pref);
  if (!canSmartCompose()) return null;
  return (
    <section>
      <h3>{t('smart.title')}</h3>
      <label className="inline"><input type="checkbox" className="check" checked={on}
        onChange={(e) => { setOn(e.target.checked); try { localStorage.setItem(KEY, e.target.checked ? 'on' : 'off'); } catch { /* this session only */ } }} />
        {t('smart.label')}</label>
      <p className="fine">{t('smart.note')}</p>
    </section>
  );
}
