import { useRef, useState } from 'react';
import { Button } from './Button';
import { confirmIt, notify } from './Dialog';
import { loadScript } from './Filters';
import type { Jmap } from './jmap';
import { labelsFor, mboxEntry, mergeCalendars } from './exporter';

const PARALLEL = 4; // downloads in flight at once
const PART = 1024 ** 3; // without a save dialog, mail downloads in 1 GB files (the browser holds each one in memory)

/** Hand the browser a file to save (the fallback when there's no save dialog, and for the small files). */
function save(blob: Blob, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

type Sink = { write(b: Uint8Array): Promise<void>; close(): Promise<void> };
type SavePicker = (o: object) => Promise<FileSystemFileHandle>;

/** Mail in parts of about 1 GB: name.mbox, or name-1.mbox, name-2.mbox… All of them import together. */
function blobSink(name: string): Sink {
  let parts: BlobPart[] = [], size = 0, n = 0;
  const flush = (last: boolean) => {
    if (!size && n) return;
    n++; save(new Blob(parts, { type: 'application/mbox' }), last && n === 1 ? `${name}.mbox` : `${name}-${n}.mbox`);
    parts = []; size = 0;
  };
  return {
    async write(b) { parts.push(b.slice().buffer as ArrayBuffer); size += b.length; if (size >= PART) flush(false); },
    async close() { flush(true); },
  };
}

/**
 * Settings → Export your data. Every message as one .mbox (Settings → Import mail on any OpenMail reads it back with
 * its folders, stars and unread), plus contacts (.vcf), calendar (.ics) and settings (.json). Runs in this tab; the
 * files go straight to this computer. Lives inside the Settings <form>: buttons only.
 */
export function ExportSection({ client }: { client: Jmap }) {
  const [state, setState] = useState<{ done: number; failed: number; total: number; running: boolean } | null>(null);
  const [msg, setMsg] = useState('');
  const stop = useRef(false);

  async function run() {
    stop.current = false; setMsg('');
    const name = `${client.username.replace(/[^\w.@-]/g, '_')}-${new Date().toISOString().slice(0, 10)}`;
    // The save dialog first: browsers only open it straight from the click.
    const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let sink: Sink;
    if (pick) {
      let handle: FileSystemFileHandle;
      try { handle = await pick({ suggestedName: `${name}.mbox`, types: [{ description: 'Mailbox (mbox)', accept: { 'application/mbox': ['.mbox'] } }] }); }
      catch { return; } // cancelled
      const w = await handle.createWritable();
      sink = { write: (b) => w.write(b.slice().buffer as ArrayBuffer), close: () => w.close() };
    } else sink = blobSink(name);

    let done = 0, failed = 0, total = 0, fatal: unknown = null;
    const tick = () => setState({ done, failed, total, running: !stop.current });
    tick();
    const problems: string[] = [];
    try {
      const boxes = await client.mailboxes(true); // Templates, Notes and Tasks are mail too
      const inFlight = new Set<Promise<void>>();
      let writing = Promise.resolve();
      for (let position = 0; !stop.current;) {
        const page = await client.emailPage(position);
        total = page.total; position += page.list.length; tick();
        for (const e of page.list) {
          if (stop.current) break;
          const job: Promise<void> = client.rawMessage(e.blobId).then(
            (raw) => (writing = writing.then(() => sink.write(mboxEntry(raw, labelsFor(e.mailboxIds, e.keywords, boxes), new Date(e.receivedAt)))))
              .then(() => { done++; }, (err) => { fatal ??= err; stop.current = true; }), // can't write (disk full): stop
            () => { failed++; }, // one unreadable message doesn't stop the rest
          ).finally(() => { inFlight.delete(job); tick(); });
          inFlight.add(job);
          if (inFlight.size >= PARALLEL) await Promise.race(inFlight);
        }
        if (!page.list.length || position >= total) break;
      }
      await Promise.all(inFlight);
      await sink.close();
      if (fatal) throw fatal;
      if (stop.current) return setMsg(`Stopped. The file has the first ${done.toLocaleString()} messages.`);

      // The small files. Each one on its own: one missing doesn't lose the others.
      const part = async (what: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { problems.push(`${what} (${(e as Error).message})`); } };
      await part('contacts', async () => {
        const cards = await client.davObjects('card');
        if (cards.length) save(new Blob(cards.map((c) => c.trimEnd() + '\r\n'), { type: 'text/vcard' }), `${name}-contacts.vcf`);
      });
      await part('calendar', async () => {
        const events = await client.davObjects('cal');
        if (events.length) save(new Blob([mergeCalendars(events)], { type: 'text/calendar' }), `${name}-calendar.ics`);
      });
      await part('settings', async () => {
        const [script, identities, aliases] = await Promise.all([loadScript(client), client.identities(), client.aliases().catch(() => null)]);
        const device = Object.fromEntries(['theme', 'palette', 'text', 'density', 'reading'].map((k) => { try { return [k, localStorage.getItem(`om:${k}`)]; } catch { return [k, null]; } }));
        save(new Blob([JSON.stringify({
          account: client.username, exportedAt: new Date().toISOString(),
          identities: identities.map(({ name: n, email, textSignature, htmlSignature }) => ({ name: n, email, textSignature, htmlSignature })),
          settings: script.data, // filters, out-of-office, signatures, Screener, saved searches
          maskedAddresses: aliases, thisDevice: device,
        }, null, 2)], { type: 'application/json' }), `${name}-settings.json`);
      });
      setMsg(`Done. ${done.toLocaleString()} messages saved${failed ? `, ${failed.toLocaleString()} couldn’t be read` : ''}.`
        + (problems.length ? ` Not saved: ${problems.join('; ')}.` : ''));
    } catch (e) { setMsg(`Export stopped: ${(e as Error).message}`); }
    finally { setState((s) => s && { ...s, running: false }); }
  }

  const pct = state ? Math.min(100, Math.round(((state.done + state.failed) / Math.max(state.total, 1)) * 100)) : 0;
  return (
    <section>
      <h3>Export your data</h3>
      <p className="fine">
        Download a copy of everything: all your mail as one .mbox file (with folders, stars and unread), your contacts
        (.vcf), your calendar (.ics) and your settings (.json). Any mail app can open the .mbox; Import mail here reads it back.
      </p>
      {!state?.running
        ? <Button size="sm" icon="download" className="start" onClick={run}>Export everything</Button>
        : (
          <div className="import-progress" role="status" aria-live="polite">
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
            <span className="fine">{state.done.toLocaleString()} of {state.total.toLocaleString()} messages{state.failed ? ` · ${state.failed} skipped` : ''} · {pct}%</span>
            <Button size="sm" onClick={() => { stop.current = true; }}>Stop</Button>
          </div>
        )}
      {msg && <p className={/stopped:|not saved/i.test(msg) ? 'error' : 'fine ok'} role="status">{msg}</p>}
    </section>
  );
}

/**
 * Settings → Delete your account. Asks for the password (and two-factor code) and the address typed out, then
 * confirms once more. The account service (signup/account.mjs) checks all of it again on the server.
 */
export function DeleteAccountSection({ client, onDeleted }: { client: Jmap; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState<string | null>(null); // null until the server asks for one
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const me = client.username.toLowerCase();
  const ready = !!password && typed.trim().toLowerCase() === me && code !== '';

  async function remove() {
    if (!ready || busy) return;
    if (!(await confirmIt({ title: 'Delete your account for good?', danger: true, confirm: 'Delete my account',
      body: `All mail, contacts, calendars and settings in ${me} are erased from this server. This can’t be undone. The address will never be given to anyone else.` }))) return;
    setBusy(true); setError('');
    try {
      await client.deleteAccount({ password, confirm: typed.trim(), ...(code && { code: code.trim() }) });
      await notify('Your account has been deleted', 'You’re now signed out.');
      onDeleted();
    } catch (e) {
      if ((e as { code?: string }).code === 'code_required') setCode('');
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    // Inside the Settings <form>: Enter here must not save and close Settings.
    <section className="delete-account" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); remove(); } }}>
      <h3>Delete your account</h3>
      <p className="fine">Erases your mail, contacts, calendars and settings from this server. Export your data first if you want a copy. Your address is retired, never reused.</p>
      {!open
        ? <Button size="sm" icon="trash" className="start" onClick={() => setOpen(true)}>Delete account…</Button>
        : <>
            <div className="row2">
              <label>Your password<input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              {code !== null && <label>Code from your app<input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></label>}
            </div>
            <label>Type your address, {me}, to confirm<input className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={me} /></label>
            <div className="actions">
              <Button size="sm" onClick={() => { setOpen(false); setPassword(''); setTyped(''); setCode(null); setError(''); }}>Cancel</Button>
              <Button size="sm" disabled={!ready || busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete account'}</Button>
            </div>
          </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
