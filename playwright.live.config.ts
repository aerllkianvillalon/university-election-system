// Live voter-flow test: real browser -> built frontend -> real API -> real Postgres. Run via tests/run-live.sh.
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, reporter: 'list', retries: 0,
  projects: [   // the a11y project casts ballots of its own, so it runs after the flows whose counts it would change
    { name: 'flows', testMatch: /(live-(voter|support|online-only)|pages-merge)\.spec\.ts/ },
    { name: 'a11y', testMatch: /live-a11y\.spec\.ts/, dependencies: ['flows'] },
    { name: 'staff', testMatch: /live-staff\.spec\.ts/, dependencies: ['a11y'] },   // closes, tallies and certifies the election through the console
    { name: 'accounts', testMatch: /live-accounts\.spec\.ts/, dependencies: ['a11y'] },   // appoints, sets up and disables staff accounts; independent of the election
    { name: 'results', testMatch: /live-results\.spec\.ts/, dependencies: ['staff'] },   // then checks what the public sees of that certified election
  ],
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4174', trace: 'retain-on-failure', ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} },
});
