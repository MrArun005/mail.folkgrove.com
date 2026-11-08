// Settings → App: install the web app, open email links with it, or (in the native shells) change server.
import { useEffect, useState } from 'react';
import { Button } from './Button';
import { canInstall, changeServer, handleMailto, install, installed, shell } from './launch';
import { t } from './i18n';

export function InstallSection() {
  const [, redraw] = useState(0);
  const [note, setNote] = useState('');
  useEffect(() => {
    const f = () => redraw((n) => n + 1);
    addEventListener('beforeinstallprompt', f); addEventListener('appinstalled', f);
    return () => { removeEventListener('beforeinstallprompt', f); removeEventListener('appinstalled', f); };
  }, []);
  const where = shell();
  return (
    <section>
      <h3>{t('install.title')}</h3>
      {where === 'mobile' ? <>
        <p className="fine">{t('install.opensOn', { host: location.host })}</p>
        <Button className="start" onClick={changeServer}>{t('install.changeServer')}</Button>
      </> : where === 'desktop' ? (
        <p className="fine">{t('install.desktop', { host: location.host })}</p>
      ) : installed() ? (
        <p className="fine">{t('install.installed')}</p>
      ) : canInstall() ? <>
        <Button className="start" onClick={async () => setNote((await install()) ? t('install.done') : '')}>{t('install.install')}</Button>
        <p className="fine">{t('install.why')}</p>
      </> : (
        <p className="fine">{/iPhone|iPad/.test(navigator.userAgent)
          ? t('install.ios')
          : t('install.other')}</p>
      )}
      {!where && 'registerProtocolHandler' in navigator && (
        <Button className="start" onClick={() => { handleMailto(); setNote(t('install.mailtoNote')); }}>{t('install.mailto')}</Button>
      )}
      {note && <p className="fine" role="status">{note}</p>}
    </section>
  );
}
