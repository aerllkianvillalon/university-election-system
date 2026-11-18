/// <reference lib="dom" />
// The live central build is online-only: no kiosk or proctor pages, and no lab endpoints on the server.
import { expect, test } from '@playwright/test';

for (const path of ['/lab/booth', '/lab/proctor']) test(`${path} does not exist in the online-only build`, async ({ page }) => {
  await page.goto(path); await expect(page.getByRole('heading', { name: /find that page/i })).toBeVisible();
  await expect(page.locator('.booth-screen')).toHaveCount(0);
});
test('the server has no lab endpoints', async ({ request }) => {
  expect((await request.get('/api/lab/board')).status()).toBe(404);
});
