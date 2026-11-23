import { defineConfig, devices } from '@playwright/test';

const isLab = process.env.PLAYWRIGHT_TARGET === 'lab';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? (isLab ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:3000');

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} },   // optional: use a browser you already have
  webServer: {
    command: isLab ? 'pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort' : 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
