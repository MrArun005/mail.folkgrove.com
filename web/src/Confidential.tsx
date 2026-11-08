import { useEffect, useState } from 'react';
import { Button } from './Button';
import { confirmIt } from './Dialog';
import { Icon } from './icons';
import type { Jmap } from './jmap';
import { confidentialIds } from './seal';
import { locale, t } from './i18n';

export type ConfidentialDays = 1 | 7 | 30;
const day = (ms: number) => new Date(ms).toLocaleDateString(locale(), { dateStyle: 'medium' });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What recipients get instead of the message: a short note and the link. */
export const confidentialHtml = (url: string, expires: number | null, passcode: boolean) =>
  `<p>${esc(t('confidential.mailIntro'))}</p><p><a href="${esc(url)}">${esc(t('confidential.mailOpen'))}</a></p>` +
  `<p>${esc(expires ? t('confidential.mailUntil', { date: day(expires) }) : '')}${passcode ? ' ' + esc(t('confidential.mailPasscode')) : ''}</p>`;

/** Compose: under the text while "Send confidentially" is on. Says plainly what it does and doesn't do. */
export function ConfidentialBar({ days, passcode, onPasscode, onOff }: { days: ConfidentialDays; passcode: string; onPasscode: (p: string) => void; onOff: () => void }) {
  return (
    <div className="banner banner--info confidential-bar" role="group" aria-label={t('confidential.compose')}>
      <Icon name="shield" size={16} />
      <span className="grow">{t('confidential.composeNote', { count: days })}</span>
      <input className="input input--sm" type="password" autoComplete="new-password" placeholder={t('confidential.passcodeOptional')}
        aria-label={t('confidential.passcodeOptional')} value={passcode} onChange={(e) => onPasscode(e.target.value)} />
      <Button variant="link" onClick={onOff}>{t('confidential.turnOff')}</Button>
      <span className="fine confidential-honest">{t('confidential.honestSender')}</span>
    </div>
  );
}

/** Reader: on a confidential message you sent (only render it for your own messages), its state and "Revoke access". */
export function ConfidentialSent({ client, body }: { client: Jmap; body: string }) {
  const [id] = confidentialIds(body, location.origin);
  const [state, setState] = useState<{ expires: number | null; opened: number } | 'gone' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    client.sharedFiles().then((l) => { if (!l) return; const f = l.find((x) => x.id === id); setState(f ? { expires: f.expires, opened: f.downloads } : 'gone'); }, () => {});
  }, [client, id]);
  if (!id || !state) return null;
  if (state === 'gone') return <p className="banner"><Icon name="shield" size={16} /><span className="grow">{t('confidential.sentGone')}</span></p>;
  async function revoke() {
    if (!(await confirmIt({ title: t('confidential.revokeTitle'), body: t('confidential.revokeBody'), confirm: t('confidential.revoke'), danger: true }))) return;
    setError('');
    try { await client.revokeFile(id); setState('gone'); }
    catch (e) { if ((e as { code?: string }).code === 'not_found') setState('gone'); else setError((e as Error).message); }
  }
  return (
    <p className="banner banner--info">
      <Icon name="shield" size={16} />
      <span className="grow">{t('confidential.sentState', { date: state.expires ? day(state.expires) : '', count: state.opened })}</span>
      <Button variant="link" onClick={revoke}>{t('confidential.revoke')}</Button>
      {error && <span className="error" role="alert">{error}</span>}
    </p>
  );
}
