import { useCallback, useRef } from 'react';

const EDGE = 24;      // px from the screen's sides left to the browser's own back/forward gesture
const DECIDE = 10;    // px of movement before we know whether this is a swipe or a scroll
const SETTLE = 160;   // ms for the row to slide away or spring back

/**
 * Swipe a row left or right on a touch screen. Returns a ref for the row.
 * The row follows the finger (CSS shows what will happen: styles.css, ".row.swiping"); letting go past a third
 * of its width does it, less springs back. Vertical movement is left alone, so the list still scrolls.
 * Physical left/right on purpose: a swipe is a direction of the hand, the same in right-to-left languages.
 */
export function useSwipe<T extends HTMLElement>(opts: { off?: boolean; onLeft: () => void; onRight: () => void }) {
  const live = useRef(opts); live.current = opts;
  return useCallback((el: T | null) => {
    if (!el) return;
    let x0 = 0, y0 = 0, dx = 0, mode: 'idle' | 'undecided' | 'swipe' | 'scroll' = 'idle', swipedAt = 0;
    const reset = () => { el.classList.remove('swiping', 'settling'); el.style.translate = ''; el.removeAttribute('data-dir'); };
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      if (live.current.off || e.touches.length !== 1 || t.clientX < EDGE || t.clientX > innerWidth - EDGE) { mode = 'idle'; return; }
      x0 = t.clientX; y0 = t.clientY; dx = 0; mode = 'undecided';
    };
    const move = (e: TouchEvent) => {
      if (mode === 'idle' || mode === 'scroll') return;
      const t = e.touches[0];
      dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (mode === 'undecided') {
        if (Math.abs(dy) > DECIDE && Math.abs(dy) >= Math.abs(dx)) { mode = 'scroll'; return; }
        if (Math.abs(dx) < DECIDE) return;
        mode = 'swipe'; el.classList.remove('settling'); el.classList.add('swiping');
      }
      if (e.cancelable) e.preventDefault(); // ours now: the page must not scroll sideways or start a text selection
      el.dataset.dir = dx < 0 ? 'left' : 'right';
      el.style.translate = `${dx}px`;
    };
    const end = () => {
      if (mode !== 'swipe') { mode = 'idle'; return; }
      mode = 'idle'; swipedAt = Date.now();
      const far = Math.abs(dx) > Math.min(140, el.offsetWidth / 3);
      el.classList.add('settling');
      if (!far) { el.style.translate = '0px'; setTimeout(reset, SETTLE); return; }
      const left = dx < 0;
      el.style.translate = left ? '-100%' : '100%';
      setTimeout(() => { reset(); (left ? live.current.onLeft : live.current.onRight)(); }, SETTLE);
    };
    // A swipe that ends over the row must not also open it.
    const click = (e: MouseEvent) => { if (Date.now() - swipedAt < 400) { e.stopPropagation(); e.preventDefault(); } };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end);
      el.removeEventListener('click', click, true);
    };
  }, []);
}
