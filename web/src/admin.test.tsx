// @vitest-environment happy-dom
// The admin console shows each role only what the server lets it do, and the CSV import checks, then adds.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { Admin } from './Admin';
import type { Jmap } from './jmap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = { id: 'u1', name: 'sam', email: 'sam@x.test', description: '', createdAt: '', used: 0, quota: null, aliases: 0, enabled: true, sending: true, admin: false, newAccount: false };

async function open(role: 'admin' | 'helpdesk', replies: Record<string, unknown> = {}) {
  const admin = vi.fn(async (path: string) => replies[path.replace(/\?.*/, '')] ?? (path === 'overview' ? { accounts: 1, queued: 0, blockedIps: 0, newAccounts: 0, suspended: 0, held: null, role } : { users: [user], total: 1 }));
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  await act(async () => createRoot(el).render(<Admin client={{ admin, username: 'me' } as unknown as Jmap} />));
  const click = (text: string) => act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
  const buttons = () => [...el.querySelectorAll('main button')].map((b) => b.textContent);
  return { el, admin, click, buttons };
}

describe('Admin console', () => {
  it('helpdesk: only its tabs, and no create, storage, suspend or delete', async () => {
    const { el, click, buttons } = await open('helpdesk');
    expect([...el.querySelectorAll('[role=tab]')].map((b) => b.textContent)).toEqual(['Overview', 'Users', 'Held mail', 'Suspended & inactive', 'Audit log']);
    await click('Users');
    expect(buttons()).toEqual(expect.arrayContaining(['Reset password', 'Disable']));
    expect(buttons().filter((b) => /Create account|Set storage|Suspend|Pause/.test(b ?? ''))).toEqual([]);
    expect(el.querySelector('[aria-label^="Delete"]')).toBeNull();
    expect(el.querySelector('details')).toBeNull(); // no CSV import
  });

  it('admin: CSV import is checked by the server, then only the good rows are added', async () => {
    const { el, admin, click } = await open('admin', {
      'users/check': { results: [{ name: 'ann' }, { name: 'postmaster', error: 'username_reserved', message: 'That username is reserved.' }] },
      'users/import': { results: [{ name: 'ann', email: 'ann@x.test', password: 'pw-123' }], created: 1 },
    });
    expect(el.querySelectorAll('[role=tab]').length).toBe(10);
    await click('Users');
    const area = el.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'username,name\nann,Ann\npostmaster');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Check the list');
    expect(admin).toHaveBeenCalledWith('users/check', 'POST', { rows: [{ name: 'ann', description: 'Ann', password: '' }, { name: 'postmaster', description: '', password: '' }] });
    expect(el.textContent).toContain('That username is reserved.');
    await click('Add 1 account');
    expect(admin).toHaveBeenCalledWith('users/import', 'POST', { rows: [{ name: 'ann', description: 'Ann', password: '' }] });
    expect(el.textContent).toContain('pw-123');
    expect(el.textContent).toContain('Download passwords (CSV)');
  });
});
