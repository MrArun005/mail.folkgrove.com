// Compose add-ons: the extra formatting bar (size, colour, highlight, emoji, table), image sizes, and
// "Help me schedule". Compose.tsx wires them to its editor; everything they write passes cleanHtml (mailutil.ts).
import { useState } from 'react';
import { Button } from './Button';
import { Menu } from './Menu';
import { EmojiPicker } from './EmojiPicker';
import { freeSlots, type CalEvent } from './calendar';
import { locale, t, type Key } from './i18n';

const keep = (e: React.MouseEvent) => e.preventDefault(); // the editor keeps its selection
const TEXT: [string, Key][] = [['#d93025', 'fmt.red'], ['#e37400', 'fmt.orange'], ['#188038', 'fmt.green'], ['#1a73e8', 'fmt.blue'], ['#9334e6', 'fmt.purple'], ['#5f6368', 'fmt.grey']];
const MARK: [string, Key][] = [['#fff59d', 'fmt.yellow'], ['#c8e6c9', 'fmt.green'], ['#bbdefb', 'fmt.blue'], ['#f8bbd0', 'fmt.pink']];
const SIZES: [string, Key, string][] = [['2', 'fmt.small', 'small'], ['3', 'fmt.normal', 'medium'], ['5', 'fmt.large', 'x-large']];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * apply: an editing command on the selection (styled with CSS, so cleanHtml can keep it); insert: HTML at the cursor;
 * text: plain text at the cursor.
 */
export function FormatBar({ apply, insert, text }: { apply: (cmd: string, arg: string) => void; insert: (html: string) => void; text: (s: string) => void }) {
  const [rows, setRows] = useState(3), [cols, setCols] = useState(3);
  const tool = (icon: Parameters<typeof Button>[0]['icon'], label: string) => <Button variant="quiet" icon={icon} label={label} onMouseDown={keep} />;
  const swatches = (list: [string, Key][], cmd: string, close: () => void) => (
    <div className="swatches">
      {list.map(([c, k]) => <button key={c} className="menu-item swatch" role="menuitem" aria-label={t(k)} title={t(k)} style={{ '--c': c } as React.CSSProperties}
        onClick={() => { close(); apply(cmd, c); }} />)}
    </div>
  );
  return (
    <div className="fmt-bar" role="toolbar" aria-label={t('fmt.more')}>
      <Menu label={t('fmt.size')} up button={tool('textSize', t('fmt.size'))}>
        {(close) => <>
          <p className="menu-title">{t('fmt.size')}</p>
          {SIZES.map(([v, k, css]) => <button key={v} className="menu-item" role="menuitem" onClick={() => { close(); apply('fontSize', v); }}><span style={{ fontSize: css }}>{t(k)}</span></button>)}
        </>}
      </Menu>
      <Menu label={t('fmt.color')} up button={tool('color', t('fmt.color'))}>
        {(close) => <>
          <p className="menu-title">{t('fmt.textColor')}</p>{swatches(TEXT, 'foreColor', close)}
          <p className="menu-title">{t('fmt.highlight')}</p>{swatches(MARK, 'hiliteColor', close)}
          <p className="menu-note">{t('fmt.colorNote')}</p>
        </>}
      </Menu>
      <Menu label={t('fmt.emoji')} up button={tool('emoji', t('fmt.emoji'))}>
        {(close) => <EmojiPicker wide close={close} onPick={text} />}
      </Menu>
      <Menu label={t('fmt.table')} up button={tool('table', t('fmt.table'))}>
        {(close) => (
          <form className="custom-time" onSubmit={(e) => {
            e.preventDefault(); close();
            const cell = '<td style="border: 1px solid #c4c7c5; padding: 4px 8px"><br></td>';
            insert(`<table style="border-collapse: collapse"><tbody>${`<tr>${cell.repeat(cols)}</tr>`.repeat(rows)}</tbody></table><div><br></div>`);
          }}>
            <div className="row2">
              <label>{t('fmt.rows')}<input className="input" type="number" min={1} max={20} value={rows} onChange={(e) => setRows(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} /></label>
              <label>{t('fmt.columns')}<input className="input" type="number" min={1} max={8} value={cols} onChange={(e) => setCols(Math.min(8, Math.max(1, Number(e.target.value) || 1)))} /></label>
            </div>
            <Button type="submit" variant="primary" size="sm">{t('fmt.insertTable')}</Button>
          </form>
        )}
      </Menu>
    </div>
  );
}

/** Small / medium / original for the image the cursor is on. ponytail: three sizes, no drag handles. */
export function ImageSize({ img, onChange }: { img: HTMLImageElement; onChange: () => void }) {
  const now = img.style.width;
  const set = (w: number) => { if (w) { img.style.width = `${w}px`; img.style.maxWidth = '100%'; } else img.removeAttribute('style'); onChange(); };
  return (
    <div className="fmt-bar" role="toolbar" aria-label={t('fmt.imageSize')}>
      <span className="fine">{t('fmt.imageSize')}</span>
      {([[160, 'fmt.small'], [320, 'fmt.medium'], [0, 'fmt.original']] as const).map(([w, k]) => (
        <Button key={w} size="sm" pressed={w ? now === `${w}px` : !now} onMouseDown={keep} onClick={() => set(w)}>{t(k)}</Button>
      ))}
    </div>
  );
}

/** "Help me schedule": free times from your own calendar, inserted as a list the recipient can answer. */
export function ScheduleMenu({ events, close, onInsert, onError }: {
  events: (from: Date, to: Date) => Promise<CalEvent[]>; close: () => void; onInsert: (html: string) => void; onError: (msg: string) => void;
}) {
  const [days, setDays] = useState(5), [minutes, setMinutes] = useState(30), [busy, setBusy] = useState(false);
  return (
    <form className="custom-time" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      try {
        const now = new Date();
        const slots = freeSlots(await events(now, new Date(+now + (days + 1) * 86400e3)), now, { days, minutes, count: 5 });
        close();
        if (!slots.length) return onError(t('schedule.none', { count: days }));
        const fmt = new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        onInsert(`<div>${esc(t('schedule.intro'))}</div><ul>${slots.map((s) => `<li>${esc(fmt.formatRange(s.start, s.end))}</li>`).join('')}</ul><div><br></div>`);
      } catch (err) { close(); onError((err as Error).message); }
    }}>
      <p className="menu-title">{t('schedule.title')}</p>
      <label>{t('schedule.within')}
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[3, 5, 7, 10].map((d) => <option key={d} value={d}>{t('schedule.nextDays', { count: d })}</option>)}
        </select>
      </label>
      <label>{t('schedule.length')}
        <select className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[30, 60].map((m) => <option key={m} value={m}>{t('schedule.minutes', { count: m })}</option>)}
        </select>
      </label>
      <p className="menu-note">{t('schedule.note')}</p>
      <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t('common.loading') : t('schedule.insert')}</Button>
    </form>
  );
}
