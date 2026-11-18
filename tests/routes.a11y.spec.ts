/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const routes = [
  '/', '/election', '/candidates', '/register', '/login', '/forgot-password', '/reset-password',
  '/status', '/results', '/vote', '/receipt', '/lab/booth', '/lab/proctor',
  '/legal/privacy', '/legal/terms', '/legal/election-rules', '/legal/accessibility',
];

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
  test.describe(`${viewport.name} route accessibility`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const route of routes) {
      test(`axe: ${route}`, async ({ page }) => {
        await page.goto(route);
        await expect(page.locator('main')).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(results.violations, JSON.stringify(results.violations.map((violation) => ({ id: violation.id, impact: violation.impact, description: violation.description, nodes: violation.nodes.map((node) => node.target) })), null, 2)).toEqual([]);
      });
    }
  });
}

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
  test(`inline navigation targets are at least 48px at ${viewport.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of ['/register', '/login', '/forgot-password', '/legal/privacy']) {
      await page.goto(route);
      const targets = await page.locator('.footer-links a, .form-links a, .checkline a').evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target.width, `${route} target width`).toBeGreaterThanOrEqual(48);
        expect(target.height, `${route} target height`).toBeGreaterThanOrEqual(48);
      }
    }
  });
}
