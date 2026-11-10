import { expect, test } from '@playwright/test';
import { row, SEEDED, signIn, tempFolder } from './helpers';

test('Back closes a conversation, and a conversation has a link', async ({ page }) => {
  await signIn(page);
  await row(page, SEEDED).locator('.open').click();
  await expect(page.locator('.thread .subject')).toHaveText(SEEDED);
  await expect(page).toHaveURL(/#\/t\/.+/);
  const link = page.url();

  await page.goBack();
  await expect(page.locator('.thread')).toHaveCount(0);
  await expect(page).toHaveURL(/localhost:5173\/$/); // still in the app, on the Inbox

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
  await expect(editor).toContainText('Thanks, got it.');
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
