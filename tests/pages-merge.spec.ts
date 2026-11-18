/// <reference lib="dom" />
// Merged pages: one help page with tabs (old addresses still work) and one legal page with tabs. Runs in mock mode and in live mode.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const OLD_TO_NEW: [string, RegExp, string][] = [
  ['/claim-account', /\/help\/claim$/, 'Claim your account in person'], ['/protest', /\/help\/protest$/, 'File an election protest'],
  ['/account-dispute', /\/help\/dispute$/, 'Dispute an account'], ['/report-fake-site', /\/help\/report$/, 'Report a fake site or message'],
];
for (const [old, url, title] of OLD_TO_NEW) test(`old address ${old} still works and lands on the help page`, async ({ page }) => {
  await page.goto(old); await expect(page).toHaveURL(url); await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
});

test('the help page has one tab bar; each tab shows its own form and marks itself current', async ({ page }) => {
  await page.goto('/help'); await expect(page).toHaveURL(/\/help\/claim$/);                     // /help alone goes to the first tab
  const tabs = page.getByRole('navigation', { name: 'Kinds of help' }); await expect(tabs.getByRole('link')).toHaveCount(4);
  await tabs.getByRole('link', { name: 'File a protest' }).click(); await expect(page).toHaveURL(/\/help\/protest$/);
  await expect(page.getByLabel('What are you protesting?')).toBeVisible(); await expect(page.getByLabel('Claim code')).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'File a protest' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/help/nonsense'); await expect(page).toHaveURL(/\/help\/claim$/);              // an unknown kind never shows a blank page
});

test('one legal page: four tabs, each address unchanged, an unknown one is not found', async ({ page }) => {
  await page.goto('/legal/terms'); const tabs = page.getByRole('navigation', { name: 'Policies' }); await expect(tabs.getByRole('link')).toHaveCount(4);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Terms of use');
  await tabs.getByRole('link', { name: 'Privacy notice' }).click(); await expect(page).toHaveURL(/\/legal\/privacy$/); await expect(page.getByRole('heading', { level: 1 })).toContainText('Privacy notice');
  await page.goto('/legal/election-rules'); await expect(page.getByRole('heading', { level: 1 })).toContainText('Election rules');
  await page.goto('/legal/accessibility'); await expect(page.getByRole('heading', { level: 1 })).toContainText('Accessibility');
  await page.goto('/legal/nonsense'); await expect(page.getByRole('heading', { name: /not found|find that page/i })).toBeVisible();
});

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
  test(`axe: help tabs and legal tabs at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of ['/help/claim', '/help/protest', '/help/dispute', '/help/report', '/legal/privacy', '/legal/terms']) {
      await page.goto(route); await page.getByRole('heading', { level: 1 }).waitFor();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${route}: ${v.id}`)).toEqual([]);
    }
  });
}

test('the old mock /admin address goes to the real staff console, and the retired /demo/states is gone', async ({ page }) => {
  await page.goto('/admin'); await expect(page).toHaveURL(/\/staff/);
  await page.goto('/demo/states'); await expect(page.getByRole('heading', { name: /find that page/i })).toBeVisible();
});
