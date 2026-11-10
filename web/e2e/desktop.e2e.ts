import { expect, test } from '@playwright/test';
import { account, jmap, row, SEEDED, signIn, tempFolder } from './helpers';

test('Back closes a conversation, and a conversation has a link', async ({ page }) => {
  await signIn(page);
  await row(page, SEEDED).locator('.open').click();
  await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
  await expect(page).toHaveURL(/#\/t\/.+/);
  const link = page.url();

  await page.goBack();
  await expect(page.locator('.thread')).toHaveCount(0);
  await expect(page).toHaveURL(/localhost:\d+\/$/); // still in the app, on the Inbox

  // The link opens the same conversation in a fresh page load.
  await page.goto(link); await page.reload();
  await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
});

test('folders and searches are steps Back returns from', async ({ page }) => {
  await signIn(page);
  await page.locator('.rail .nav-item', { hasText: 'Sent' }).click();
  await expect(page).toHaveURL(/#\/in\/.+/);
  await page.goBack();
  await expect(page.locator('.rail .nav-item.active')).toContainText('Inbox');

  await page.fill('input[type=search]', 'from:priya');
  await expect(page).toHaveURL(/#\/search\/from%3Apriya/);
  await page.reload();
  await expect(page.locator('input[type=search]')).toHaveValue('from:priya');
  await expect(page.locator('.rows .row').first()).toContainText('Priya');
});

test('archive from a row, then Undo puts it back', async ({ page }) => {
  await signIn(page);
  const r = row(page, SEEDED);
  await r.hover();
  await r.getByRole('button', { name: 'Archive' }).click();
  await expect(page.locator('.toast')).toContainText('archived');
  await expect(r).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.toast')).toContainText('Undone');
  await expect(r).toHaveCount(1);
});

test('drag a conversation onto a folder, then Undo', async ({ page }) => {
  const folder = await tempFolder('E2E drag');
  try {
    await signIn(page);
    const target = page.locator('.rail .nav-item', { hasText: 'E2E drag' });
    await expect(target).toBeVisible();
    await row(page, SEEDED).dragTo(target);
    await expect(page.locator('.toast')).toContainText('moved to E2E drag');
    await expect(row(page, SEEDED)).toHaveCount(0);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, SEEDED)).toHaveCount(1);
  } finally { await folder.remove(); }
});

test('the privacy report opens from the rail and closes with Escape', async ({ page }) => {
  await signIn(page);
  await page.locator('.me').getByRole('button', { name: 'Privacy report' }).click();
  await expect(page.getByRole('dialog', { name: 'Privacy report' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Privacy report' })).toHaveCount(0);
});

test('a private note stays with the conversation, and can be deleted', async ({ page }) => {
  await signIn(page);
  await row(page, SEEDED).locator('.open').click();
  await page.getByRole('button', { name: 'Add a private note' }).click();
  const text = `note ${Date.now()}`;
  await page.locator('.team-comments textarea').fill(text);
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('.comment-text')).toHaveText(text);

  // Still there after closing and reopening the conversation.
  await page.goBack();
  await row(page, SEEDED).locator('.open').click();
  await expect(page.locator('.comment-text')).toHaveText(text);

  await page.locator('.comment').getByRole('button', { name: 'Delete note' }).click();
  await expect(page.locator('.comment-text')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a private note' })).toBeVisible();
});

test('the feed shows newsletters whole and opens the conversation', async ({ page }) => {
  await signIn(page);
  if (await page.locator('.nav-more[aria-expanded=false]').count()) await page.locator('.nav-more').click();
  await page.locator('.rail .nav-item', { hasText: 'Feed' }).click();
  await expect(page).toHaveURL(/#\/in\/feed/);
  const first = page.locator('.feed-item').first();
  await expect(first.locator('.feed-body iframe')).toBeVisible(); // the message itself, not just a preview
  const title = await first.locator('.feed-title').innerText();
  await first.locator('.feed-title').click();
  await expect(page.locator('.thread .subject')).toHaveText(title);
});

test('a filter being written shows what it would have caught', async ({ page }) => {
  await signIn(page);
  await page.locator('.me').getByRole('button', { name: 'Settings' }).click();
  await page.locator('.settings-link', { hasText: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.rule-form input').first().fill('priya@example.org');
  await expect(page.locator('.rule-preview')).toContainText('would have caught');
  await expect(page.locator('.rule-preview li').first()).toContainText('Priya');
  await page.locator('.rule-form input').first().fill('nobody-at-all@nowhere.example');
  await expect(page.locator('.rule-preview')).toContainText('would not have caught any');
});

test('quick reply sends from under the conversation; Undo brings it back as a draft', async ({ page }) => {
  await signIn(page);
  await row(page, SEEDED).first().locator('.open').click();
  const box = page.locator('.quick-reply textarea');
  await expect(box).toHaveAttribute('placeholder', /Reply to /);
  await box.click();
  await box.fill('Thanks, got it.');
  await page.locator('.quick-reply').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.toast')).toContainText('Sending');
  await expect(box).toHaveValue('');

  // Undo: nothing is sent; what was written comes back in the editor, under nothing but the quote.
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  const editor = page.locator('.compose [contenteditable]').first();
  await expect(editor).toContainText('Thanks, got it.', { timeout: 30_000 }); // Undo waits for the server to take the message back
  await expect(editor).toContainText('wrote:'); // the quoted message is there
  await page.locator('.compose').getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.compose')).toHaveCount(0);
});

test('a reply does not offer to add the quoted message\'s date to the calendar', async ({ page }) => {
  await signIn(page);
  // "Re: Venue for the March offsite" quotes an earlier message under an "On … wrote:" line.
  await row(page, 'Venue for the March offsite').first().locator('.open').click();
  await expect(page.locator('.thread .subject')).toBeVisible();
  await expect(page.locator('.thread .message').last()).toBeVisible();
  await expect(page.getByText('This message mentions')).toHaveCount(0);
});

/** Put the seeded conversation back as the tests expect it, whatever a failed test left: read and unstarred (every
 * message in it: stars and read marks apply to the whole conversation), and the message itself in the Inbox. */
async function tidySeeded() {
  const accountId = await account();
  const [[, boxes]] = await jmap([['Mailbox/get', { accountId, properties: ['role'] }, 'm']]);
  const [, [, got]] = await jmap([['Email/query', { accountId, filter: { subject: SEEDED } }, 'q'],
    ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'threadId'] }, 'g']]);
  const seeded = got.list.filter((e: any) => e.subject === SEEDED);
  if (!seeded.length) return;
  const [[, threads]] = await jmap([['Thread/get', { accountId, ids: seeded.map((e: any) => e.threadId) }, 't']]);
  const role = (r: string) => boxes.list.find((b: any) => b.role === r).id;
  const update: Record<string, object> = {};
  for (const t of threads.list) for (const id of t.emailIds) update[id] = { 'keywords/$seen': true, 'keywords/$flagged': null };
  for (const e of seeded) update[e.id] = { ...update[e.id], [`mailboxIds/${role('inbox')}`]: true, [`mailboxIds/${role('archive')}`]: null };
  await jmap([['Email/set', { accountId, update }, 's']]);
}

test('star, unstar and mark unread from the keyboard; opening it reads it again', async ({ page }) => {
  try {
    await signIn(page);
    await row(page, SEEDED).locator('.open').click();
    await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
    const reader = page.locator('.reader');
    await expect(reader.getByRole('button', { name: 'Star', exact: true })).toBeVisible(); // the conversation has loaded
    await page.keyboard.press('s');
    await expect(reader.getByRole('button', { name: 'Unstar' })).toBeVisible();
    await page.keyboard.press('s');
    await expect(reader.getByRole('button', { name: 'Star', exact: true })).toBeVisible();
    await page.keyboard.press('u');
    await expect(page.locator('.toast')).toContainText('Marked as unread');
    await expect(page.locator('.thread')).toHaveCount(0); // marking the open conversation unread closes it
    await expect(row(page, SEEDED)).toHaveClass(/unread/);
    await row(page, SEEDED).locator('.open').click();
    await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
    await page.keyboard.press('Escape');
    await expect(row(page, SEEDED)).not.toHaveClass(/unread/);
  } finally { await tidySeeded(); }
});

test('archiving the open conversation opens the next one, and z puts it back', async ({ page }) => {
  try {
    await signIn(page);
    const rows = page.locator('.rows .row');
    await row(page, SEEDED).locator('.open').click();
    await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
    const opened = page.url();
    const subjects = await rows.locator('.subject').allTextContents(); // the list as it is now (it can reorder as it loads)
    const at = subjects.findIndex((s) => s.includes(SEEDED)); // a row's subject also holds its folder labels
    const next = at < subjects.length - 1 ? at + 1 : at - 1; // the one below, or above at the end of the list
    await page.keyboard.press('e');
    await expect(page.locator('.toast')).toContainText('Conversation archived');
    await expect(page).not.toHaveURL(opened);
    await expect(page).toHaveURL(/#\/t\/.+/);
    const advanced = page.url();
    await page.keyboard.press('z');
    await expect(page.locator('.toast')).toContainText('Undone');
    await page.keyboard.press('Escape');
    await expect(row(page, SEEDED)).toHaveCount(1);
    expect(await rows.locator('.subject').allTextContents()).toEqual(subjects);
    await rows.nth(next).locator('.open').click(); // the conversation it advanced to was that neighbour
    await expect(page).toHaveURL(advanced);
  } finally { await tidySeeded(); }
});
