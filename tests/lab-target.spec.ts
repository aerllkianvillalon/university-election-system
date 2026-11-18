import { expect, test } from '@playwright/test';

test('lab target redirects to kiosk, hides the chatbot and makes no outbound runtime data requests', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const crossOrigin: string[] = [];
  const runtimeDataRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) crossOrigin.push(request.url());
    if (['fetch', 'xhr', 'websocket', 'eventsource', 'ping'].includes(request.resourceType())) runtimeDataRequests.push(`${request.resourceType()} ${request.url()}`);
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/lab\/booth$/);
  await expect(page.locator('.booth-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Your vote/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Election help/ })).toHaveCount(0);
  expect(crossOrigin).toEqual([]);
  expect(runtimeDataRequests).toEqual([]);
});
