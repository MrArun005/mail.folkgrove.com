import { useEffect, useState } from 'react';
import { confirmIt } from './Dialog';
import { Button } from './Button';
import { fileSize } from './mailutil';
import type { Jmap, SharedFile } from './jmap';

/** Settings → Shared files: large files sent as download links (Compose offers this for files too big to attach). */
export function SharedFilesSection({ client }: { client: Jmap }) {
  const [list, setList] = useState<SharedFile[] | null | 'off'>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => { client.sharedFiles().then((l) => setList(l ?? 'off'), (e) => { setList([]); setMsg(e.message); }); }, [client]);

  async function revoke(f: SharedFile) {
    if (!(await confirmIt({ title: `Remove the link to ${f.name}?`, danger: true, confirm: 'Remove link',
      body: 'Anyone you sent it to won’t be able to download it any more, and the file is deleted from your storage.' }))) return;
    setMsg('');
    try { await client.revokeFile(f.id); setList((l) => (Array.isArray(l) ? l.filter((x) => x.id !== f.id) : l)); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(''), 2000); } catch { /* nothing else to do */ }
  }

  if (list === 'off') return null; // this server doesn't run the account service
  const when = (t: number) => new Date(t).toLocaleDateString([], { dateStyle: 'medium' });
  return (
    <section>
      <h3>Shared files</h3>
      <p className="fine">Files too big to attach, sent as download links. They use your storage until the link expires or you remove it.</p>
      {list === null && <p className="fine">Loading…</p>}
      {Array.isArray(list) && list.length === 0 && <p className="fine">Nothing shared yet. When you attach a file that’s too big for email, you can send it as a link instead.</p>}
      {Array.isArray(list) && list.length > 0 && (
        <ul className="rule-list files-list">
          {list.map((f) => (
            <li key={f.id}>
              <span className="grow">
                {f.name}
                <span className="fine"> · {fileSize(f.size)} · {f.downloads === 1 ? '1 download' : `${f.downloads} downloads`} · {f.expires ? `until ${when(f.expires)}` : 'no end date'}</span>
              </span>
              <Button variant="quiet" size="sm" icon={copied === f.url ? 'check' : 'copy'} label={`Copy the link to ${f.name}`} onClick={() => copy(f.url)} />
              <Button variant="quiet" size="sm" icon="trash" label={`Remove the link to ${f.name}`} onClick={() => revoke(f)} />
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
