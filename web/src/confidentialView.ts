// The page a confidential message's link opens (/confidential.html#id=…&k=…). Static, no React, no sign-in:
// fetch the ciphertext (/f/<id>, the large-file link it's stored as), decrypt here with the key from the address,
// show it as plain text. Everything the sender wrote goes in through textContent only.
import { languagePref, locale, setLanguage, t } from './i18n';
import { parseFragment, unseal, type Secret } from './seal';
import './styles.css';

const root = document.getElementById('root')!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e;
};
const show = (...kids: Node[]) => root.replaceChildren(el('div', { className: 'confidential-card' }, ...kids));
const problem = (text: string) => show(el('h1', { textContent: t('confidential.title') }), el('p', { className: 'error', role: 'alert', textContent: text }));

async function main() {
  await setLanguage(languagePref(), false);
  document.title = t('confidential.title');
  const link = parseFragment(location.hash);
  if (!link) return problem(t('confidential.badLink'));
  const r = await fetch(`/f/${link.id}`, { cache: 'no-store', credentials: 'omit' }).catch(() => null);
  if (!r) return problem(t('confidential.offline'));
  if (r.status === 404) return problem(t('confidential.gone'));
  if (!r.ok) return problem(t('confidential.unavailable'));
  const blob = new Uint8Array(await r.arrayBuffer());
  if (!link.passcode) return unseal(blob, link.key).then(render, () => problem(t('confidential.badLink')));

  // Passcode: asked here, mixed into the key in this browser. Never sent anywhere.
  const input = el('input', { className: 'input', type: 'password', autocomplete: 'off', required: true });
  const err = el('p', { className: 'error', role: 'alert' });
  const button = el('button', { type: 'submit', className: 'btn btn--primary btn--md', textContent: t('confidential.open') });
  const form = el('form', {}, el('label', {}, t('confidential.passcode'), input), button, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true; err.textContent = '';
    try { render(await unseal(blob, link.key, input.value)); }
    catch { err.textContent = t('confidential.wrongPasscode'); button.disabled = false; input.select(); }
  });
  show(el('h1', { textContent: t('confidential.title') }), el('p', { className: 'fine', textContent: t('confidential.askPasscode') }), form);
  input.focus();
}

function render(m: Secret) {
  const sent = new Date(m.sent);
  show(
    el('h1', { textContent: m.subject || t('confidential.title') }),
    ...(isNaN(+sent) ? [] : [el('p', { className: 'fine', textContent: t('confidential.sentOn', { date: sent.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) }) })]),
    el('div', { className: 'letter', textContent: m.text }),
    el('p', { className: 'fine', textContent: t('confidential.honest') }),
  );
}

main().catch(() => problem(t('confidential.unavailable')));
