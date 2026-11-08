import { useEffect, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import { fileSize } from './mailutil';
import type { Jmap, SharedFile } from './jmap';
import { locale, t } from './i18n';

/** Settings → Shared files: large files sent as download links (Compose offers this for files too big to attach). */
export function SharedFilesSection({ client }: { client: Jmap }) {
  const [list, setList] = useState<SharedFile[] | null | 'off'>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => { client.sharedFiles().then((l) => setList(l ?? 'off'), (e) => { setList([]); setMsg(e.message); }); }, [client]);

  async function revoke(f: SharedFile) {
    if (!(await confirmIt({ title: t('sharedfiles.removeTitle', { name: f.name }), danger: true, confirm: t('sharedfiles.removeConfirm'),
      body: t('sharedfiles.removeBody') }))) return;
    setMsg('');
    try { await client.revokeFile(f.id); setList((l) => (Array.isArray(l) ? l.filter((x) => x.id !== f.id) : l)); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(''), 2000); } catch { /* nothing else to do */ }
  }

  if (list === 'off') return null; // this server doesn't run the account service
  const when = (ms: number) => new Date(ms).toLocaleDateString(locale(), { dateStyle: 'medium' });
  return (
    <section>
      <h3>{t('sharedfiles.title')}</h3>
      <p className="fine">{t('sharedfiles.intro')}</p>
      {list === null && <p className="fine">{t('common.loading')}</p>}
      {Array.isArray(list) && list.length === 0 && <p className="fine">{t('sharedfiles.none')}</p>}
      {Array.isArray(list) && list.length > 0 && (
        <ul className="rule-list files-list">
          {list.map((f) => (
            <li key={f.id}>
              <span className="grow">
                {f.name}
                <span className="fine"> · {fileSize(f.size)} · {t('sharedfiles.downloads', { count: f.downloads })} · {f.expires ? t('sharedfiles.until', { date: when(f.expires) }) : t('sharedfiles.noEnd')}</span>
              </span>
              <Button variant="quiet" size="sm" icon={copied === f.url ? 'check' : 'copy'} label={t('sharedfiles.copy', { name: f.name })} onClick={() => copy(f.url)} />
              <Button variant="quiet" size="sm" icon="trash" label={t('sharedfiles.remove', { name: f.name })} onClick={() => revoke(f)} />
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
