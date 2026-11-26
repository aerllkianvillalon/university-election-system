/// <reference lib="dom" />
// WCAG 2.1 A/AA (axe) on the screens a live voter really sees: signed-out prompts, every ballot step, review, receipt, support forms and reset states.
// Uses its own voters (2026-00005 and -00006), and runs after the other live specs (see playwright.live.config.ts).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function axe(page: Page, label: string) {
  await expect(page.locator('main')).toBeVisible();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations, `${label}: ` + JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
}

for (const vp of [{ name: 'mobile', width: 390, height: 844, n: 5 }, { name: 'desktop', width: 1440, height: 1000, n: 6 }]) {   // one voter per viewport: a voter can register and vote only once
  test.describe(`live screens, ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test('signed out: home, election, candidates prompt, ballot prompt, status, results, support forms, reset states', async ({ page }) => {
      for (const route of ['/', '/election', '/candidates', '/vote', '/status', '/results', '/protest', '/account-dispute', '/report-fake-site', '/claim-account', '/reset-password', '/forgot-password']) {
        await page.goto(route); await axe(page, route);
      }
    });
    test('signed in: candidates, every ballot step, review, receipt, status', async ({ page }) => {
      await page.goto('/register');
      await page.locator('#student-id').fill(`2026-0000${vp.n}`); await page.locator('#voucher').fill(`DEMO-${vp.n}`); await page.locator('#password').fill('a11y voter password 5');
      await page.locator('#pick-program').selectOption('BSIT');
      await page.getByRole('checkbox').check(); await page.getByRole('button', { name: /Create/ }).click(); await expect(page).toHaveURL(/\/vote$/);
      await page.goto('/candidates'); await axe(page, '/candidates (signed in)');
      await page.goto('/status'); await axe(page, '/status (signed in)');
      await page.goto('/vote');
      await page.getByRole('button', { name: /President 1/ }).click(); await axe(page, 'ballot step 1 with a selection'); await page.getByRole('button', { name: /Next contest/ }).click();
      await page.getByRole('button', { name: /Senators 1/ }).click(); await axe(page, 'ballot step 2 (multi-select)'); await page.getByRole('button', { name: /Next contest/ }).click();
      await page.getByLabel(/Abstain from this contest/).check(); await axe(page, 'ballot step 3 (abstain)');
      await page.getByRole('button', { name: /Review ballot/ }).click(); await axe(page, 'review');
      await page.getByRole('button', { name: /Submit my ballot/ }).click();
      await expect(page.getByRole('heading', { name: /Your ballot is recorded/i })).toBeVisible({ timeout: 10_000 }); await axe(page, 'receipt');
      await page.goto('/status'); await axe(page, '/status after voting');
    });
  });
}
