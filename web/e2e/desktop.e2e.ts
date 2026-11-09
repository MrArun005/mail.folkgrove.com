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
