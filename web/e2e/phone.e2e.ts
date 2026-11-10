import { expect, test } from '@playwright/test';
import { row, SEEDED, signIn, swipe } from './helpers';

test('the drawer holds the folders and the account, and closes when you pick one', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('.rail')).not.toBeVisible();
  await page.getByRole('button', { name: 'Folders and account' }).click();
  await expect(page.locator('.rail .nav-item', { hasText: 'Sent' })).toBeVisible();
  await expect(page.locator('.me').getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.locator('.rail .nav-item', { hasText: 'Sent' }).click();
  await expect(page.locator('.app.nav-open')).toHaveCount(0);
  await expect(page.locator('.topbar-title')).toHaveText('Sent');
  await page.goBack();
  await expect(page.locator('.topbar-title')).toHaveText('Inbox');
});

test('Back closes a conversation, Settings, and saves a draft', async ({ page }) => {
  await signIn(page);
  await row(page, SEEDED).locator('.open').tap();
  await expect(page.locator('.thread')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.list')).toBeVisible();

  await page.locator('.topbar').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.settings')).toHaveCount(0);
  await expect(page.locator('.list')).toBeVisible();

  await page.locator('.compose-btn').tap();
  const subject = `e2e draft ${Date.now()}`;
  await page.locator('.compose label.field', { hasText: 'Subject' }).locator('input').fill(subject);
  await page.goBack();
  await expect(page.locator('.compose')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Draft saved');
  await expect(page.locator('.list')).toBeVisible();

  // Tidy: discard the draft from Drafts.
  await page.getByRole('button', { name: 'Folders and account' }).click();
  await page.locator('.rail .nav-item', { hasText: 'Drafts' }).click();
  await row(page, subject).locator('.open').tap();
  await page.locator('.compose').getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click(); // "What you wrote will be deleted."
  await expect(page.locator('.compose')).toHaveCount(0);
});

test('swipe left archives, Undo puts it back; a short swipe does nothing', async ({ page, browserName }) => {
  // swipe() drives the finger through Chromium's DevTools protocol; WebKit and Firefox have no equivalent here.
  test.skip(browserName !== 'chromium', 'touch input is sent through a Chromium-only protocol');
  await signIn(page);
  await swipe(page, SEEDED, -40);
  await page.waitForTimeout(400);
  await expect(row(page, SEEDED)).toHaveCount(1);
  await expect(page.locator('.toast')).toHaveCount(0);

  await swipe(page, SEEDED, -220);
  await expect(page.locator('.toast')).toContainText('archived');
  await expect(row(page, SEEDED)).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, SEEDED)).toHaveCount(1);
});

test('accessibility: the phone list and the open drawer', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const problems = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('iframe').analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
  await signIn(page);
  expect.soft(await problems()).toEqual([]);
  await page.getByRole('button', { name: 'Folders and account' }).click();
  await expect(page.locator('.rail .nav-item').first()).toBeVisible();
  expect.soft(await problems()).toEqual([]);
});
