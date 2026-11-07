import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { confirmIt } from './Dialog';
import type { Jmap, Note } from './jmap';

/** Notes: plain-text notes that sync everywhere. List on the left, editor on the right; saves as you type. */
export function NotesView({ client, say }: { client: Jmap; say: (t: string) => void }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [open, setOpen] = useState<Note | null>(null);
  // The editor's identity for one editing session. Not the note id: saving gives the note a new id, and remounting
  // mid-typing would drop what was just typed.
  const [editKey, setEditKey] = useState('');
  const show = (n: Note) => { setOpen(n); setEditKey(n.id || `new-${Date.now()}`); };
  const [query, setQuery] = useState('');
  const load = () => client.notes().then(setNotes, (e) => say(e.message));
  useEffect(() => { load(); }, [client]);

  const sorted = (notes ?? []).filter((n) => !query || `${n.title}\n${n.body}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));

  return (
    <section className="notes" aria-label="Notes">
      <div className="notes-list">
        <div className="notes-head">
          <input className="input" type="search" placeholder="Search notes" aria-label="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button variant="primary" icon="compose" onClick={() => show({ id: '', title: '', body: '', updatedAt: new Date().toISOString(), pinned: false })}>New note</Button>
        </div>
        {notes === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
        {notes?.length === 0 && <p className="empty">No notes yet. Ideas, lists, anything: they sync to every device.</p>}
        <ul>
          {sorted.map((n) => (
            <li key={n.id}>
              <button className={`note-row${open?.id === n.id ? ' active' : ''}`} onClick={() => show(n)}>
                <span className="title">{n.pinned && <span className="pill">Pinned</span>}{n.title || 'Untitled note'}</span>
                <span className="preview">{n.body.slice(0, 120) || 'No text'}</span>
                <time>{new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open ? <NoteEditor key={editKey} client={client} note={open} say={say}
        onSaved={(n) => { setOpen(n); setNotes((l) => [n, ...(l ?? []).filter((x) => x.id !== open.id && x.id !== n.id)]); }}
        onDeleted={() => { setNotes((l) => l?.filter((x) => x.id !== open.id) ?? l); setOpen(null); }} />
        : <div className="reader-empty"><p>Pick a note, or start a new one.</p></div>}
    </section>
  );
}

function NoteEditor({ client, note, say, onSaved, onDeleted }: {
  client: Jmap; note: Note; say: (t: string) => void; onSaved: (n: Note) => void; onDeleted: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [pinned, setPinned] = useState(note.pinned);
  const [status, setStatus] = useState('');
  const current = useRef(note.id); // the latest saved id (each save replaces the note)
  const timer = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const last = useRef(JSON.stringify({ title: note.title, body: note.body, pinned: note.pinned })); // skip saves that change nothing

  function save(next = { title, body, pinned }) {
    if (!next.title.trim() && !next.body.trim()) return;
    const snap = JSON.stringify(next);
    if (snap === last.current && current.current) return;
    last.current = snap;
    setStatus('Saving…');
    // One save at a time, in order: each replaces the previous copy.
    saving.current = saving.current.then(async () => {
      try {
        const id = await client.saveNote({ id: current.current || undefined, ...next });
        current.current = id; setStatus('Saved');
        onSaved({ id, ...next, updatedAt: new Date().toISOString() });
      } catch (e) { setStatus(''); say(`Couldn’t save the note: ${(e as Error).message}`); }
    });
  }
  const later = (next: { title: string; body: string; pinned: boolean }) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => save(next), 900); };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <article className="note-editor">
      <div className="note-tools">
        <span className="fine" role="status">{status}</span>
        <Button variant="quiet" size="sm" icon="star" iconFilled={pinned} label={pinned ? 'Unpin' : 'Pin to the top'} pressed={pinned}
          onClick={() => { setPinned(!pinned); save({ title, body, pinned: !pinned }); }} />
        {current.current && <Button variant="quiet" size="sm" icon="trash" label="Delete note" onClick={async () => {
          if (!(await confirmIt({ title: 'Delete this note?', body: 'It’s removed from every device.', confirm: 'Delete note', danger: true }))) return;
          await saving.current; await client.deleteNote(current.current); say('Note deleted'); onDeleted();
        }} />}
      </div>
      <input className="note-title" placeholder="Title" aria-label="Note title" value={title} autoFocus={!note.id}
        onChange={(e) => { setTitle(e.target.value); later({ title: e.target.value, body, pinned }); }} onBlur={() => { clearTimeout(timer.current); save(); }} />
      <textarea className="note-body" placeholder="Write anything" aria-label="Note" value={body}
        onChange={(e) => { setBody(e.target.value); later({ title, body: e.target.value, pinned }); }} onBlur={() => { clearTimeout(timer.current); save(); }} />
    </article>
  );
}
