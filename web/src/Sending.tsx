import { useEffect, useState } from 'react';
import { Button } from './Button';
import { notify } from './Dialog';
import { t } from './i18n';
import type { Jmap, SendingStatus } from './jmap';

/**
 * A notice above the inbox when sending is suspended for this account (signup/abuse.mjs): why, and what to do.
 * The first time, the person can switch sending back on themselves (once a day); a second time within a week needs
 * an admin. Reading mail keeps working either way.
 */
export function SendingBlocked({ client }: { client: Jmap }) {
  const [s, setS] = useState<SendingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = () => client.sendingStatus().then(setS, () => {});
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [client]);
  if (!s?.suspended) return null;

  async function unblock() {
    setBusy(true);
    try {
      await client.unblockSending();
      setS({ suspended: false });
      await notify(t('sending.backOn'), t('sending.backOnBody'));
    } catch (e) {
      await notify(t('sending.stillOff'), (e as Error).message);
      client.sendingStatus().then(setS, () => {});
    } finally { setBusy(false); }
  }

  const hours = s.retryAfter ? Math.max(1, Math.ceil(s.retryAfter / 3600)) : 0;
  return (
    <div className="banner banner--warn" role="alert">
      <span className="grow">
        <b>{t('sending.switchedOff')}</b> {s.reason} {t('sending.canStillRead')}{' '}
        {s.unblock === 'ok' && t('sending.changePassword')}
        {s.unblock === 'wait' && t('sending.waitHours', { count: hours })}
        {s.unblock === 'admin' && t('sending.admin')}
      </span>
      {s.unblock === 'ok' && <Button variant="link" disabled={busy} onClick={unblock}>{busy ? t('sending.switching') : t('sending.switchBackOn')}</Button>}
    </div>
  );
}
