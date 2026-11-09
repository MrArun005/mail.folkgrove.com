// Automated accessibility checks (axe-core) on the screens people spend their time in. It catches the mechanical
// failures: missing names, bad contrast, broken ARIA. It can't judge whether the app is pleasant with a screen reader.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { row, SEEDED, signIn } from './helpers';

/** Serious and critical problems only, as "rule: target" lines (so a failure says what to fix). */
async function problems(page: Page, include?: string) {
  // Not inside messages: what a sender wrote isn't ours to fix, and a page of newsletters takes axe minutes.
  let axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('iframe');
  if (include) axe = axe.include(include);
  const { violations } = await axe.analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test('the Inbox and an open conversation', async ({ page }) => {
  await signIn(page);
  expect.soft(await problems(page)).toEqual([]);
  await row(page, SEEDED).locator('.open').click();
  await expect(page.locator('.thread .subject')).toBeVisible();
  expect.soft(await problems(page, '.reader')).toEqual([]);
});

test('the privacy report, Settings and the feed', async ({ page }) => {
  await signIn(page);
  await page.locator('.me').getByRole('button', { name: /Privacy report/ }).click();
  expect.soft(await problems(page, '.sheet.privacy')).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('.me').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-link').first()).toBeVisible();
  expect.soft(await problems(page, '.sheet.settings')).toEqual([]);
  await page.keyboard.press('Escape');
  if (await page.locator('.nav-more[aria-expanded=false]').count()) await page.locator('.nav-more').click();
  await page.locator('.rail .nav-item', { hasText: 'Feed' }).click();
  await expect(page.locator('.feed-head')).toBeVisible();
  expect.soft(await problems(page, '.feed')).toEqual([]);
});

test.describe('in the dark', () => {
  test.use({ colorScheme: 'dark' });
  test('the Inbox, a conversation and the privacy report keep their contrast', async ({ page }) => {
    await signIn(page);
    expect.soft(await problems(page)).toEqual([]);
    await page.locator('.me').getByRole('button', { name: /Privacy report/ }).click();
    expect.soft(await problems(page, '.sheet.privacy')).toEqual([]);
    await page.keyboard.press('Escape');
    await row(page, SEEDED).locator('.open').click();
    await expect(page.locator('.thread .subject')).toBeVisible();
    expect.soft(await problems(page, '.reader')).toEqual([]);
  });
});
