// Translate and summarise with the browser's built-in, on-device models (Chrome's Translator, LanguageDetector and
// Summarizer APIs). The message never leaves this computer: no server of ours, no AI company. Where the browser
// doesn't have them, the features simply don't appear. Models may download once on first use (the browser asks).

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

export const canTranslate = () => typeof g.Translator?.create === 'function' && typeof g.LanguageDetector?.create === 'function';
export const canSummarize = () => typeof g.Summarizer?.create === 'function';

/** The user's language, e.g. "en" from "en-IN". */
export const myLanguage = () => (navigator.language || 'en').split('-')[0].toLowerCase();

/** Detected language of the text, or null when unsure. */
export async function detectLanguage(text: string): Promise<string | null> {
  const d = await g.LanguageDetector.create();
  const [best] = await d.detect(text.slice(0, 2000));
  return best && best.confidence > 0.6 ? String(best.detectedLanguage) : null;
}

/** Translate plain text into the user's language. Returns null when it's already in that language. */
export async function translate(text: string, target = myLanguage()): Promise<{ from: string; text: string } | null> {
  const from = await detectLanguage(text);
  if (!from || from === target) return null;
  if ((await g.Translator.availability({ sourceLanguage: from, targetLanguage: target })) === 'unavailable')
    throw new Error(`Your browser can’t translate from ${languageName(from)} yet.`);
  const t = await g.Translator.create({ sourceLanguage: from, targetLanguage: target });
  // Paragraph by paragraph: keeps the shape of the message and stays under per-call input limits.
  const parts: string[] = [];
  for (const p of text.split(/\n{2,}/)) parts.push(p.trim() ? await t.translate(p) : p);
  return { from, text: parts.join('\n\n') };
}

/** A few key points about the text. */
export async function summarize(text: string): Promise<string> {
  if ((await g.Summarizer.availability()) === 'unavailable') throw new Error('Summaries aren’t available in this browser.');
  const s = await g.Summarizer.create({ type: 'key-points', format: 'plain-text', length: 'short' });
  return s.summarize(text.slice(0, 12000));
}

export const languageName = (code: string) => {
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
};

export const canRewrite = () => typeof g.Rewriter?.create === 'function';
export type RewriteStyle = 'formal' | 'casual' | 'shorter';

/** Rewrite plain text in another tone or length, on this device. */
export async function rewrite(text: string, style: RewriteStyle): Promise<string> {
  if ((await g.Rewriter.availability()) === 'unavailable') throw new Error('Writing help isn’t available in this browser.');
  const r = await g.Rewriter.create({
    tone: style === 'formal' ? 'more-formal' : style === 'casual' ? 'more-casual' : 'as-is',
    length: style === 'shorter' ? 'shorter' : 'as-is', format: 'plain-text',
  });
  return r.rewrite(text);
}

/**
 * The text a person actually sees in an HTML email. Hidden parts (display:none, visibility:hidden, zero size or
 * opacity, [hidden]) are dropped first: senders can hide text there to steer a summary or translation.
 */
export function visibleText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head, template, [hidden], [aria-hidden="true"]').forEach((el) => el.remove());
  const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9])|max-height\s*:\s*0(?![.\d]*[1-9])|(?:^|;)\s*(?:width|height)\s*:\s*0(?:px)?\s*(?:;|$)/i;
  doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => { if (hidden.test(el.getAttribute('style') ?? '')) el.remove(); });
  return (doc.body.innerText ?? doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
