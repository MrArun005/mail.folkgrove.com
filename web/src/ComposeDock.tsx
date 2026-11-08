// Several drafts at once (Gmail-style): compose windows side by side along the bottom, each minimizable to a bar and
// autosaving its own draft. "Pop out" moves one to its own browser window (this app at ?compose=<draftId>); when that
// window closes without sending, the draft comes back here as a bar. Phones keep one full-screen compose (styles.css).
import { useEffect, useRef, useState } from 'react';
import { Compose, type ComposeApi, type RecipientGroup } from './Compose';
import type { Address, Draft, Jmap } from './jmap';
import { draftFromEmail, type Signature } from './mailutil';

type Win = { key: number; draft: Draft; min?: boolean; id?: string };
type Msg = { om: 'draft'; id: string } | { om: 'done' } | { om: 'send'; d: Draft; sendAt?: string };
let seq = 0;
const POP = new URLSearchParams(location.search).get('compose');
/** This window is a popped-out compose window. */
export const isPopout = !!POP;

export function useComposeWindows(client: Jmap, opts: { send: (d: Draft, sendAt?: Date) => void; blocked: () => void }) {
  const [wins, setWins] = useState<Win[]>([]);
  const latest = useRef(opts); latest.current = opts;

  // In a popped-out window: open its draft.
  useEffect(() => {
    if (POP) client.email(POP).then((e) => e && setWins([{ key: ++seq, draft: draftFromEmail(e), id: e.id }]), () => {});
  }, [client]);

  /** Open a draft, or bring it up if it's open already. Others fold to bars when there's no room beside it. */
  function open(d: Draft) {
    setWins((ws) => {
      const same = d.id && ws.find((w) => (w.id ?? w.draft.id) === d.id);
      if (same) return ws.map((w) => (w === same ? { ...w, min: false } : w));
      const room = Math.floor(innerWidth / 680);
      const shown = ws.filter((w) => !w.min).length;
      return [...ws.map((w) => (shown + 1 > room ? { ...w, min: true } : w)), { key: ++seq, draft: d }];
    });
  }
  const update = (key: number, patch: Partial<Win>) => setWins((ws) => ws.map((w) => (w.key === key ? { ...w, ...patch } : w)));
  const remove = (key: number) => setWins((ws) => ws.filter((w) => w.key !== key));

  function popOut(key: number, id: string) {
    const w = window.open(`${location.pathname}?compose=${encodeURIComponent(id)}`, `compose-${key}`, 'popup,width=760,height=700');
    if (!w) return latest.current.blocked();
    remove(key);
    let last = id, done = false;
    const onMsg = (e: MessageEvent<Msg>) => {
      if (e.source !== w || e.origin !== location.origin) return;
      if (e.data?.om === 'draft') last = e.data.id;
      else if (e.data?.om === 'done') done = true;
      else if (e.data?.om === 'send') { done = true; latest.current.send(e.data.d, e.data.sendAt ? new Date(e.data.sendAt) : undefined); }
    };
    addEventListener('message', onMsg);
    // ponytail: polls for the window closing (no event for that); typing in the last moments before the window
    // is closed with its own close box may not be saved (autosave runs every few seconds).
    const timer = setInterval(async () => {
      if (!w.closed) return;
      clearInterval(timer); removeEventListener('message', onMsg);
      if (done) return;
      const e = await client.email(last).catch(() => null);
      if (e) setWins((ws) => [...ws, { key: ++seq, draft: draftFromEmail(e), id: e.id, min: true }]);
    }, 700);
  }

  return { wins, open, update, remove, popOut, expanded: wins.some((w) => !w.min) };
}

export function ComposeDock({ windows, contacts, groups, api, signatures, identities, onSend, onClose }: {
  windows: ReturnType<typeof useComposeWindows>; contacts: Address[]; groups: RecipientGroup[]; api: ComposeApi;
  signatures: Signature[]; identities: { name: string; email: string }[];
  onSend: (d: Draft, sendAt?: Date) => void; onClose: (outcome: 'saved' | 'discarded' | 'closed') => void;
}) {
  const { wins, update, remove, popOut } = windows;
  if (!wins.length) return null;
  const post = (m: Msg) => window.opener?.postMessage(m, location.origin);
  if (POP) {
    // The popped-out window: one compose filling it. Sending happens in the main window (its Undo, its Sent).
    const w = wins[0], hasOpener = !!window.opener && !window.opener.closed;
    return (
      <Compose key={w.key} initial={w.draft} contacts={contacts} groups={groups} api={api} signatures={signatures} identities={identities}
        onSaved={(id) => post({ om: 'draft', id })}
        onSend={(d, at) => { if (!hasOpener) return onSend(d, at); post({ om: 'send', d, sendAt: at?.toISOString() }); window.close(); }}
        onClose={(o) => { if (o === 'discarded') post({ om: 'done' }); if (hasOpener) window.close(); else { remove(w.key); onClose(o); } }} />
    );
  }
  return (
    <div className="compose-dock">
      {wins.map((w) => (
        <Compose key={w.key} initial={w.draft} contacts={contacts} groups={groups} api={api} signatures={signatures} identities={identities}
          minimized={!!w.min} onMinimize={(min) => update(w.key, { min })} onPopOut={(id) => popOut(w.key, id)} onSaved={(id) => update(w.key, { id })}
          onSend={(d, at) => { remove(w.key); onSend(d, at); }} onClose={(o) => { remove(w.key); onClose(o); }} />
      ))}
    </div>
  );
}
