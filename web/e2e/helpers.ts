import { expect, type Page } from '@playwright/test';

export const USER = 'alice@openmail.test', PASS = 'alice-dev-pass';
const SERVER = 'http://localhost:8080';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

export async function signIn(page: Page, path = '/') {
  await page.goto(path);
  await page.fill('input[name=email]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button[type=submit]');
  await expect(page.locator('.rows .row').first()).toBeVisible({ timeout: 20_000 });
}

/** A conversation row by its subject. */
export const row = (page: Page, subject: string) => page.locator('.rows .row', { hasText: subject });

/** Straight to the mail server (JMAP), for setting a test up and tidying after it. */
export async function jmap(calls: [string, object, string][]) {
  const res = await fetch(`${SERVER}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }) });
  return (await res.json()).methodResponses as [string, any, string][];
}
export async function account() {
  const s = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: auth } })).json();
  return Object.keys(s.accounts)[0];
}

/** A folder for one test; returns its id and a function that removes it (mail in it goes back to the Inbox first). */
export async function tempFolder(name: string) {
  const accountId = await account();
  const [[, boxes]] = await jmap([['Mailbox/get', { accountId, properties: ['name', 'role'] }, 'm']]);
  const inbox = boxes.list.find((b: any) => b.role === 'inbox').id;
  const old = boxes.list.find((b: any) => b.name === name)?.id;
  const id = old ?? (await jmap([['Mailbox/set', { accountId, create: { f: { name } } }, 'c']]))[0][1].created.f.id;
  return { id, remove: async () => {
    const [[, q]] = await jmap([['Email/query', { accountId, filter: { inMailbox: id } }, 'q']]);
    if (q.ids.length) await jmap([['Email/set', { accountId, update: Object.fromEntries(q.ids.map((e: string) => [e, { [`mailboxIds/${inbox}`]: true, [`mailboxIds/${id}`]: null }])) }, 's']]);
    await jmap([['Mailbox/set', { accountId, destroy: [id] }, 'd']]);
  } };
}

/** The subject of a seeded conversation that's read and in the Inbox: safe to move about and put back. */
export const SEEDED = 'Welcome to OpenMail';

/** A finger dragging across a row (touch events through the browser's own input pipeline). */
export async function swipe(page: Page, subject: string, dx: number) {
  await row(page, subject).evaluate((el) => el.scrollIntoView({ block: 'center' })); // clear of the sticky header and the Compose button
  const box = (await row(page, subject).boundingBox())!;
  const y = box.y + box.height / 2, from = dx < 0 ? box.x + box.width * 0.6 : box.x + 60; // left of the floating Compose button
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] } as any);
  await touch('touchStart', from);
  const steps = 10;
  for (let i = 1; i <= steps; i++) { await touch('touchMove', from + (dx * i) / steps); await page.waitForTimeout(16); }
  await touch('touchEnd', from + dx);
}
