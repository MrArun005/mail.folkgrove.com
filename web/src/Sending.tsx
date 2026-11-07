import { useEffect, useState } from 'react';
import { Button } from './Button';
import { notify } from './Dialog';
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
      await notify('Sending is back on', 'Please keep within the sending limits. If it happens again this week, an administrator has to switch it back on.');
    } catch (e) {
      await notify('Sending is still off', (e as Error).message);
      client.sendingStatus().then(setS, () => {});
    } finally { setBusy(false); }
  }

  const hours = s.retryAfter ? Math.max(1, Math.ceil(s.retryAfter / 3600)) : 0;
  return (
    <div className="banner banner--warn" role="alert">
      <span className="grow">
        <b>Sending is switched off for your account.</b> {s.reason} You can still read your mail.{' '}
        {s.unblock === 'ok' && 'If that wasn’t you, change your password first.'}
        {s.unblock === 'wait' && `You can ask to switch it back on in about ${hours} hour${hours === 1 ? '' : 's'}.`}
        {s.unblock === 'admin' && 'An administrator has to switch it back on. Write to them from another address and say what happened.'}
      </span>
      {s.unblock === 'ok' && <Button variant="link" disabled={busy} onClick={unblock}>{busy ? 'Switching on…' : 'Switch sending back on'}</Button>}
    </div>
  );
}
