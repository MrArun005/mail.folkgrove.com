import { useSyncExternalStore } from 'react';
import { en } from './en';

// The app's own translations: t('key', { vars }), plurals with Intl.PluralRules, numbers with Intl.NumberFormat.
// ponytail: no i18n framework; ~80 lines cover what we use. ICU select/ordinals can come when a string needs them.

export type Key = keyof typeof en;
/** A plural message: one form per Intl plural category that the language uses; `other` is always required. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Msg = string | Plural;
/** Another language: any subset of the English keys (missing ones fall back to English). */
export type Catalog = { [K in Key]?: (typeof en)[K] extends string ? string : Plural };
export type Vars = Record<string, string | number>;

/** Language code → its own name (shown as is in every language, so people can find theirs). */
export const LANGUAGES = {
  en: 'English', hi: 'हिन्दी', kn: 'ಕನ್ನಡ', ta: 'தமிழ்', es: 'Español', fr: 'Français', de: 'Deutsch',
  'pt-BR': 'Português (Brasil)', ar: 'العربية', ja: '日本語', 'zh-CN': '简体中文',
} as const;
export type Lang = keyof typeof LANGUAGES;
const RTL = new Set<string>(['ar']);

// One dynamic import each: Vite splits every language into its own file, so English users download nothing extra.
const LOAD: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Catalog }>> = {
  hi: () => import('./hi'), kn: () => import('./kn'), ta: () => import('./ta'), es: () => import('./es'), fr: () => import('./fr'),
  de: () => import('./de'), 'pt-BR': () => import('./pt-BR'), ar: () => import('./ar'), ja: () => import('./ja'), 'zh-CN': () => import('./zh-CN'),
};

/** The first of the browser's languages we have: exact tag, then the base language ("pt-PT" → pt-BR, "zh" → zh-CN). */
export function pickLanguage(wanted: readonly string[]): Lang {
  for (const w of wanted) {
    const l = w.toLowerCase();
    const exact = (Object.keys(LANGUAGES) as Lang[]).find((x) => x.toLowerCase() === l);
    if (exact) return exact;
    // ponytail: zh-TW/zh-HK read Traditional characters; skip them rather than show Simplified. Add zh-TW when someone translates it.
    if (/^zh-(tw|hk|mo|hant)/.test(l)) continue;
    const base = (Object.keys(LANGUAGES) as Lang[]).find((x) => x.split('-')[0] === l.split('-')[0]);
    if (base) return base;
  }
  return 'en';
}

/** The setting: 'auto' (the browser's languages) or a language code. Per device, like the other display preferences. */
export const languagePref = (): Lang | 'auto' => {
  try { const v = localStorage.getItem('om:lang'); return v && v in LANGUAGES ? (v as Lang) : 'auto'; } catch { return 'auto'; }
};
const browserLanguages = () => (typeof navigator !== 'undefined' && navigator.languages?.length ? navigator.languages : ['en']);

let current: Lang = 'en';
let catalog: Catalog = {};
const listeners = new Set<() => void>();

/** The language on screen. */
export const lang = () => current;
/** For Intl and toLocale…(): the browser's own tag when it's the same language ("en-GB" keeps day-month dates), else ours. */
export const locale = () => browserLanguages().find((b) => pickLanguage([b]) === current) ?? current;

/** Loads a language (or 'auto'), sets <html lang dir>, saves the choice and re-renders whoever uses useLanguage(). */
export async function setLanguage(pref: Lang | 'auto', save = true) {
  const next = pref === 'auto' ? pickLanguage(browserLanguages()) : pref;
  const cat = next === 'en' ? {} : (await LOAD[next]().catch(() => ({ default: {} }))).default; // offline: English for now
  current = next; catalog = cat; plurals.clear();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    document.documentElement.dir = RTL.has(next) ? 'rtl' : 'ltr';
  }
  if (save) try { if (pref === 'auto') localStorage.removeItem('om:lang'); else localStorage.setItem('om:lang', pref); } catch { /* this session only */ }
  listeners.forEach((f) => f());
}

/** Re-renders the component (App, so everything) when the language changes. */
export const useLanguage = () => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, lang);

const plurals = new Map<string, Intl.PluralRules>();
const rules = () => { let r = plurals.get(current); if (!r) plurals.set(current, (r = new Intl.PluralRules(current))); return r; };
const num = (n: number) => n.toLocaleString(locale());

/** The message for `key` in the current language, with {name} filled in. Plural messages pick their form by `count`. */
export function t(key: Key, vars?: Vars): string {
  const m: Msg = (catalog[key] as Msg | undefined) ?? en[key];
  let s: string;
  if (typeof m === 'string') s = m;
  else {
    const n = Number(vars?.count ?? 0);
    // Exact 0 / 1 / 2 categories only apply where the language has them ('zero' in Arabic, not in English).
    s = m[rules().select(n)] ?? m.other;
  }
  return vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? (typeof vars[k] === 'number' ? num(vars[k] as number) : String(vars[k])) : all)) : s;
}

/** Messages from the account service: a known `code` gets our wording in your language; otherwise the server's English. */
export function serverText(code: string | undefined, message: string): string {
  // ponytail: in English the server's own text is kept (it's often more specific, e.g. names the limit).
  if (current === 'en' || !code) return message;
  const k = `server.${code}` as Key;
  return k in en ? t(k) : message;
}

/** A folder's name on screen: the server's own folders (by role) in your language, folders you made as you named them. */
export const boxName = (b: { role?: string | null; name: string }) => {
  const k = `folder.${b.role}` as Key;
  return b.role && k in en ? t(k) : b.name;
};
