// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { en } from './en';
import { LANGUAGES, pickLanguage, setLanguage, t, type Catalog, type Lang } from '.';

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const forms = (m: unknown) => (typeof m === 'string' ? [m] : Object.values(m as object) as string[]);

describe('catalogs', () => {
  const langs = (Object.keys(LANGUAGES) as Lang[]).filter((l) => l !== 'en');
  it.each(langs)('%s has only English keys, the same {vars}, and the same kind (text or plural)', async (l) => {
    const cat: Catalog = (await import(`./${l}.ts`)).default;
    for (const [k, m] of Object.entries(cat)) {
      expect(k in en, `${l}: unknown key ${k}`).toBe(true);
      const want = en[k as keyof typeof en];
      expect(typeof m, `${l}: ${k} plural vs text`).toBe(typeof want);
      const wantVars = vars(forms(want).join(' ')).split(',').filter((v, i, a) => a.indexOf(v) === i).join(',');
      for (const f of forms(m)) {
        // A plural form may leave out {count} ("one message" in words), but never invent a variable.
        for (const v of vars(f).split(',').filter(Boolean)) expect(wantVars.split(','), `${l}: ${k} has {${v}}`).toContain(v);
        if (typeof want === 'string') expect(vars(f), `${l}: ${k} vars`).toBe(vars(want));
      }
      if (typeof m !== 'string') expect((m as { other?: string }).other, `${l}: ${k} needs "other"`).toBeTruthy();
    }
  });
});

describe('t()', () => {
  afterAll(() => setLanguage('en', false));
  it('fills in variables and formats numbers', async () => {
    await setLanguage('en', false);
    expect(t('common.couldntSave', { error: 'offline' })).toBe('Couldn’t save: offline');
    expect(t('common.serverError', { status: 1234 })).toBe('The server returned an error (1,234)');
  });
  it('picks plural forms by count, per language', async () => {
    await setLanguage('en', false);
    expect(t('common.messages', { count: 1 })).toBe('1 message');
    expect(t('common.messages', { count: 2 })).toBe('2 messages');
    expect(t('common.messages', { count: 0 })).toBe('0 messages');
    await setLanguage('ar', false);
    // Arabic has six forms; whichever exist are chosen by Intl.PluralRules, and `other` covers the rest.
    const ar = ((await import('./ar')).default as Catalog)['common.messages'] as Record<string, string> | undefined;
    if (ar) for (const [n, cat] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']] as const)
      expect(t('common.messages', { count: n })).toBe((ar[cat] ?? ar.other).replace('{count}', n.toLocaleString('ar')));
    expect(document.documentElement.dir).toBe('rtl');
  });
  it('falls back to English for a missing key', async () => {
    await setLanguage('ja', false);
    const ja: Catalog = (await import('./ja')).default;
    const missing = (Object.keys(en) as (keyof typeof en)[]).find((k) => !(k in ja) && typeof en[k] === 'string');
    if (missing) expect(t(missing)).toBe(en[missing]);
  });
  it('matches browser languages to ours', () => {
    expect(pickLanguage(['pt-PT', 'en'])).toBe('pt-BR');
    expect(pickLanguage(['zh-TW', 'ja'])).toBe('ja');
    expect(pickLanguage(['sw', 'de-AT'])).toBe('de');
    expect(pickLanguage(['sw'])).toBe('en');
  });
});

// No English left in JSX: text between tags, and the common text props. Strings that are the same in every language
// (the brand, symbols, technical names) go in ALLOWED.
const ALLOWED = new Set(['OpenMail']);
describe('no hard-coded English in the interface', () => {
  const dir = join(__dirname, '..');
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
  const patterns = [
    // JSX text: after a tag's closing ">" (not "=>" or " > "), up to the next tag or {expression}.
    /(?<=[\w"'}/]>)([^<>{}]*[A-Za-z]{2}[^<>{}]*?)(?=<|\{)/g,
    // Text props as plain strings or string/template literals.
    /\b(?:title|label|placeholder|aria-label|alt|confirm|body|text)=(?:"([^"]*[A-Za-z]{2}[^"]*)"|\{\s*['`]([^'`]*[A-Za-z]{2}[^'`]*)['`]\s*\})/g,
    // Dialogs and messages built in code: confirmIt/promptIt/notify/say/set…Error({ title: 'Text' }) and friends.
    /\b(?:title|body|confirm|label|placeholder|text|cancel):\s*['`]([^'`]*[A-Za-z]{2}[^'`]*)['`]/g,
    /\b(?:notify|say|setError|setMsg|setNote|setStatus|setNotice|setPushNote)\(\s*['`]([^'`]*[A-Za-z]{2}[^'`]*)['`]/g,
  ];
  it.each(files)('%s', (f) => {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    const found: string[] = [];
    for (const re of patterns) for (const m of src.matchAll(re)) {
      const s = (m[1] ?? m[2] ?? '').trim();
      if (!s || ALLOWED.has(s) || /=>|&&|\|\||;|===|\)\s*$|^[(:)?]/.test(s)) continue; // code, not text
      found.push(s);
    }
    expect(found).toEqual([]);
  });
});
