// Settings → App: install the web app, open email links with it, or (in the native shells) change server.
import { useEffect, useState } from 'react';
import { Button } from './Button';
import { canInstall, changeServer, handleMailto, install, installed, shell } from './launch';

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
      <h3>App</h3>
      {where === 'mobile' ? <>
        <p className="fine">This app opens your mail on {location.host}.</p>
        <Button className="start" onClick={changeServer}>Change server</Button>
      </> : where === 'desktop' ? (
        <p className="fine">This app opens your mail on {location.host}. To use another server, choose File → Change Server.</p>
      ) : installed() ? (
        <p className="fine">OpenMail is installed on this device.</p>
      ) : canInstall() ? <>
        <Button className="start" onClick={async () => setNote((await install()) ? 'Installed. Open OpenMail from your apps from now on.' : '')}>Install the app</Button>
        <p className="fine">Its own window, the unread count on its icon, and “Share to OpenMail” from other apps.</p>
      </> : (
        <p className="fine">{/iPhone|iPad/.test(navigator.userAgent)
          ? 'To install, tap Share, then “Add to Home Screen”.'
          : 'To install, open your browser’s menu and choose “Install OpenMail” or “Add to Home screen”.'}</p>
      )}
      {!where && 'registerProtocolHandler' in navigator && (
        <Button className="start" onClick={() => { handleMailto(); setNote('If your browser asks, allow it. Email links then open a new message here.'); }}>Open email links with OpenMail</Button>
      )}
      {note && <p className="fine" role="status">{note}</p>}
    </section>
  );
}
