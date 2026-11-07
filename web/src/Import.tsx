import { useRef, useState } from 'react';
import { Button } from './Button';
import type { Jmap } from './jmap';
import { dropLabels, fileChunks, headerText, placement, splitMbox } from './importer';

const PARALLEL = 4; // uploads in flight at once

/**
 * Settings → Import mail. Gmail: Google Takeout → Mail → .mbox. Zoho, Thunderbird, Apple Mail: export to .mbox
 * or .eml. Everything runs in this browser tab; nothing goes anywhere but your own mail server.
 * Lives inside the Settings <form>: no nested form, buttons only.
 */
export function ImportSection({ client, onDone }: { client: Jmap; onDone: () => void }) {
  const [state, setState] = useState<{ done: number; failed: number; read: number; total: number; running: boolean } | null>(null);
  const [msg, setMsg] = useState('');
  const stop = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  async function run(files: File[]) {
    if (!files.length) return;
    stop.current = false; setMsg('');
    const total = files.reduce((n, f) => n + f.size, 0);
    let done = 0, failed = 0, read = 0;
    const tick = () => setState({ done, failed, read, total, running: !stop.current });
    tick();
    try {
      const boxes = await client.mailboxes();
      const role = (r: string) => boxes.find((b) => b.role === r)?.id;
      const known = new Map<string, string>();
      const importFolder = `Imported ${new Date().toISOString().slice(0, 10)}`;
      const inFlight = new Set<Promise<void>>();

      const one = async (raw: Uint8Array) => {
        const h = headerText(raw), p = placement(h);
        const ids = p.roles.map(role).filter((x): x is string => !!x);
        for (const f of p.folders) ids.push(await client.folderPath(f, known, boxes));
        // Gmail without Inbox = archived; a plain export (no Gmail labels) goes into one dated folder.
        if (!ids.length) ids.push(/^X-Gmail-Labels:/im.test(h) ? await client.mailboxFor('archive', 'Archive', boxes) : await client.folderPath(importFolder, known, boxes));
        const date = Date.parse(/^Date:\s*(.+)$/im.exec(h)?.[1] ?? '');
        await client.importMessage(dropLabels(raw), ids, p.keywords, Number.isFinite(date) ? new Date(date).toISOString().replace(/\.\d+Z$/, 'Z') : undefined);
      };

      for (const file of files) {
        let fileRead = 0;
        const counted = async function* () { for await (const c of fileChunks(file)) { fileRead += c.length; read += c.length; yield c; } };
        for await (const raw of splitMbox(counted())) {
          if (stop.current) break;
          const job: Promise<void> = one(raw).then(() => { done++; }, () => { failed++; }).finally(() => { inFlight.delete(job); tick(); });
          inFlight.add(job);
          if (inFlight.size >= PARALLEL) await Promise.race(inFlight);
        }
        read += file.size - fileRead; // count the tail of a stopped file so the bar ends
      }
      await Promise.all(inFlight);
      setMsg(stop.current ? `Stopped. ${done.toLocaleString()} messages imported.`
        : `Done. ${done.toLocaleString()} messages imported${failed ? `, ${failed.toLocaleString()} couldn’t be read` : ''}.`);
      onDone();
    } catch (e) { setMsg(`Import stopped: ${(e as Error).message}`); }
    finally { setState((s) => s && { ...s, running: false }); }
  }

  const pct = state ? Math.min(100, Math.round((state.read / Math.max(state.total, 1)) * 100)) : 0;
  return (
    <section>
      <h3>Import mail</h3>
      <p className="fine">
        From Gmail: Google Takeout → Mail → download the .mbox file. From Zoho, Outlook, Thunderbird or Apple Mail: export
        to .mbox or .eml. Gmail labels become folders; stars, unread and Sent are kept. Large files are fine.
      </p>
      <input ref={input} type="file" accept=".mbox,.eml,.mbx,application/mbox,message/rfc822" multiple hidden
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; run(f); }} />
      {!state?.running
        ? <Button size="sm" icon="download" className="start" onClick={() => input.current?.click()}>Choose files to import</Button>
        : (
          <div className="import-progress" role="status" aria-live="polite">
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
            <span className="fine">{state.done.toLocaleString()} imported{state.failed ? ` · ${state.failed} skipped` : ''} · {pct}%</span>
            <Button size="sm" onClick={() => { stop.current = true; }}>Stop</Button>
          </div>
        )}
      {msg && <p className={/stopped:/i.test(msg) ? 'error' : 'fine ok'} role="status">{msg}</p>}
    </section>
  );
}
