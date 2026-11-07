import { useEffect, useState } from 'react';
import { Button } from './Button';
import type { Jmap, Task } from './jmap';

const today = () => new Date().toISOString().slice(0, 10);
const dueLabel = (d: string) => {
  const days = Math.round((Date.parse(d) - Date.parse(today())) / 86400e3);
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
    : new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(days > 300 || days < -300 ? { year: 'numeric' } : {}) });
};

/** Tasks: a plain to-do list that syncs everywhere. Open tasks first (soonest due first), then finished ones. */
export function TaskList({ client, onOpenThread, say }: { client: Jmap; onOpenThread: (threadId: string) => void; say: (t: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const load = () => client.tasks().then(setTasks, (e) => say(e.message));
  useEffect(() => { load(); }, [client]);

  async function add() {
    if (!title.trim()) return;
    const t = title, d = due;
    setTitle(''); setDue('');
    try { await client.addTask(t, { due: d || null }); await load(); } catch (e) { say((e as Error).message); setTitle(t); }
  }
  async function toggle(t: Task) {
    setTasks((l) => l?.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) ?? l); // instant; the server follows
    try { await client.setTaskDone(t.id, !t.done); } catch (e) { say((e as Error).message); load(); }
  }
  async function remove(t: Task) {
    setTasks((l) => l?.filter((x) => x.id !== t.id) ?? l);
    try { await client.deleteTask(t.id); say('Task deleted'); } catch (e) { say((e as Error).message); load(); }
  }

  const byDue = (a: Task, b: Task) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt);
  const open = (tasks ?? []).filter((t) => !t.done).sort(byDue), done = (tasks ?? []).filter((t) => t.done);
  const row = (t: Task) => (
    <li key={t.id} className={`task${t.done ? ' done' : ''}`}>
      <input type="checkbox" className="check" checked={t.done} onChange={() => toggle(t)} aria-label={`${t.done ? 'Reopen' : 'Finish'} ${t.title}`} />
      <span className="grow title">{t.title}</span>
      {t.due && <span className={`due${!t.done && t.due < today() ? ' late' : ''}`}>{dueLabel(t.due)}</span>}
      {t.threadId && <Button variant="quiet" size="sm" icon="unread" label="Open the email" onClick={() => onOpenThread(t.threadId!)} />}
      <Button variant="quiet" size="sm" icon="trash" label={`Delete ${t.title}`} onClick={() => remove(t)} />
    </li>
  );
  return (
    <div className="tasks">
      <div className="task-add" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
        <input className="input" placeholder="Add a task" aria-label="New task" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input input--date" type="date" aria-label="Due date (optional)" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button variant="primary" size="md" disabled={!title.trim()} onClick={add}>Add</Button>
      </div>
      {tasks === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
      {tasks?.length === 0 && <p className="empty">Nothing to do. Add a task above, or use “Add to Tasks” on any email.</p>}
      {open.length > 0 && <ul className="task-list">{open.map(row)}</ul>}
      {done.length > 0 && <>
        <p className="list-section">Done</p>
        <ul className="task-list">{done.map(row)}</ul>
      </>}
    </div>
  );
}
