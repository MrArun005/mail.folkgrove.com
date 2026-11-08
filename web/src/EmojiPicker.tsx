import { useState } from 'react';
import { COMMON_REACTIONS, isReaction } from './reactions';
import { t } from './i18n';

// ponytail: a hand-picked set with English search words, no emoji database. Typing or pasting any emoji into the
// search box (the system emoji keyboard) offers that emoji too, so nothing is out of reach.
const EMOJI: [string, string][] = [
  ['👍', 'thumbs up yes ok like good'], ['❤️', 'heart love red'], ['😂', 'laugh joy tears lol funny'], ['😮', 'wow surprised open mouth'],
  ['😢', 'sad cry tear'], ['🙏', 'thanks please pray hands'], ['😀', 'smile grin happy'], ['😊', 'smile blush happy'],
  ['😉', 'wink'], ['😍', 'love heart eyes'], ['🤔', 'thinking hmm'], ['😅', 'sweat relief phew'], ['🙂', 'smile slight'],
  ['😎', 'cool sunglasses'], ['🥳', 'party celebrate'], ['😴', 'sleep tired'], ['🤯', 'mind blown'], ['😬', 'grimace awkward oops'],
  ['🙄', 'eye roll'], ['😡', 'angry mad'], ['🥲', 'smile tear grateful'], ['🤗', 'hug'], ['😇', 'angel innocent'],
  ['👏', 'clap applause bravo'], ['🙌', 'hooray raise hands celebrate'], ['👋', 'wave hello hi bye'], ['👌', 'ok perfect'],
  ['✌️', 'peace victory'], ['🤞', 'fingers crossed luck hope'], ['💪', 'strong muscle'], ['👎', 'thumbs down no dislike'],
  ['👀', 'eyes look see'], ['🤝', 'handshake deal agree'], ['✅', 'check done yes tick'], ['❌', 'cross no wrong'],
  ['⚠️', 'warning caution'], ['❓', 'question'], ['❗', 'exclamation important'], ['💯', 'hundred perfect'],
  ['🔥', 'fire hot lit'], ['✨', 'sparkles magic new'], ['⭐', 'star favourite favorite'], ['🎉', 'party tada celebrate congrats'],
  ['🎂', 'birthday cake'], ['🎁', 'gift present'], ['🏆', 'trophy win award'], ['🚀', 'rocket launch ship'],
  ['💡', 'idea light bulb'], ['📌', 'pin'], ['📎', 'paperclip attachment'], ['📅', 'calendar date'], ['⏰', 'alarm clock time'],
  ['☕', 'coffee tea break'], ['🍕', 'pizza food lunch'], ['🍻', 'cheers beer drinks'], ['🌞', 'sun sunny'], ['🌧️', 'rain'],
  ['❄️', 'snow cold winter'], ['🌈', 'rainbow'], ['🌍', 'world earth globe'], ['🏠', 'home house'], ['✈️', 'plane travel flight'],
  ['🚗', 'car drive'], ['💰', 'money'], ['📈', 'chart up growth'], ['📉', 'chart down'], ['📝', 'note memo write'],
  ['📧', 'email mail'], ['📞', 'phone call'], ['💻', 'laptop computer'], ['🐛', 'bug'], ['🐶', 'dog'], ['🐱', 'cat'],
  ['💔', 'broken heart'], ['💙', 'blue heart'], ['💚', 'green heart'], ['🧡', 'orange heart'], ['💜', 'purple heart'],
];

/** The six usual emoji, a search box, and (for writing) a wider grid. Picking one closes the menu. */
export function EmojiPicker({ onPick, close, wide = false }: { onPick: (emoji: string) => void; close: () => void; wide?: boolean }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const list = !term ? (wide ? EMOJI.map(([e]) => e) : COMMON_REACTIONS)
    : [...(isReaction(term) ? [term] : []), ...EMOJI.filter(([e, k]) => e !== term && k.split(' ').some((w) => w.startsWith(term))).map(([e]) => e)];
  const pick = (e: string) => { close(); onPick(e); };
  return (
    <div className="emoji-picker">
      <input className="input" type="search" value={q} placeholder={t('emoji.search')} aria-label={t('emoji.search')}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); pick(list[0]); } }} />
      <div className="emoji-grid">
        {list.slice(0, 48).map((e) => <button key={e} className="menu-item" role="menuitem" aria-label={e} onClick={() => pick(e)}>{e}</button>)}
      </div>
      {term && !list.length && <p className="menu-note">{t('emoji.none')}</p>}
    </div>
  );
}
