import { useEffect, useState } from 'react';
import { Button } from './Button';
import type { Jmap, Task } from './jmap';
import { locale, t } from './i18n';

const today = () => new Date().toISOString().slice(0, 10);
const dueLabel = (d: string) => {
  const days = Math.round((Date.parse(d) - Date.parse(today())) / 86400e3);
  return days === 0 ? t('tasks.today') : days === 1 ? t('tasks.tomorrow') : days === -1 ? t('tasks.yesterday')
    : new Date(`${d}T12:00:00`).toLocaleDateString(locale(), { month: 'short', day: 'numeric', ...(days > 300 || days < -300 ? { year: 'numeric' } : {}) });
};

/** Tasks: a plain to-do list that syncs everywhere. Open tasks first (soonest due first), then finished ones. */
export function TaskList({ client, onOpenThread, say }: { client: Jmap; onOpenThread: (threadId: string) => void; say: (msg: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const load = () => client.tasks().then(setTasks, (e) => say(e.message));
  useEffect(() => { load(); }, [client]);

  async function add() {
    if (!title.trim()) return;
    const task = title, d = due;
    setTitle(''); setDue('');
    try { await client.addTask(task, { due: d || null }); await load(); } catch (e) { say((e as Error).message); setTitle(task); }
  }
  async function toggle(task: Task) {
    setTasks((l) => l?.map((x) => (x.id === task.id ? { ...x, done: !x.done } : x)) ?? l); // instant; the server follows
    try { await client.setTaskDone(task.id, !task.done); } catch (e) { say((e as Error).message); load(); }
  }
  async function remove(task: Task) {
    setTasks((l) => l?.filter((x) => x.id !== task.id) ?? l);
    try { await client.deleteTask(task.id); say(t('tasks.deleted')); } catch (e) { say((e as Error).message); load(); }
  }

  const byDue = (a: Task, b: Task) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt);
  const open = (tasks ?? []).filter((task) => !task.done).sort(byDue), done = (tasks ?? []).filter((task) => task.done);
  const row = (task: Task) => (
    <li key={task.id} className={`task${task.done ? ' done' : ''}`}>
      <input type="checkbox" className="check" checked={task.done} onChange={() => toggle(task)} aria-label={t(task.done ? 'tasks.reopen' : 'tasks.finish', { title: task.title })} />
      <span className="grow title">{task.title}</span>
      {task.due && <span className={`due${!task.done && task.due < today() ? ' late' : ''}`}>{dueLabel(task.due)}</span>}
      {task.threadId && <Button variant="quiet" size="sm" icon="unread" label={t('tasks.openEmail')} onClick={() => onOpenThread(task.threadId!)} />}
      <Button variant="quiet" size="sm" icon="trash" label={t('tasks.delete', { title: task.title })} onClick={() => remove(task)} />
    </li>
  );
  return (
    <div className="tasks">
      <div className="task-add" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
        <input className="input" placeholder={t('tasks.addPlaceholder')} aria-label={t('tasks.new')} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input input--date" type="date" aria-label={t('tasks.due')} value={due} onChange={(e) => setDue(e.target.value)} />
        <Button variant="primary" size="md" disabled={!title.trim()} onClick={add}>{t('common.add')}</Button>
      </div>
      {tasks === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
      {tasks?.length === 0 && <p className="empty">{t('tasks.empty')}</p>}
      {open.length > 0 && <ul className="task-list">{open.map(row)}</ul>}
      {done.length > 0 && <>
        <p className="list-section">{t('tasks.done')}</p>
        <ul className="task-list">{done.map(row)}</ul>
      </>}
    </div>
  );
}
