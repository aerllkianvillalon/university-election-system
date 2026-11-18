/// <reference lib="dom" />
// Live voter flow in a real browser against the real API and Postgres. Everything the voter does goes through the UI.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const DB = process.env.LIVE_DB ?? 'evlive', E = process.env.ELECTION_ID ?? '';
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', DB, '-c', q]).toString().trim();
const inbox = () => JSON.parse(execFileSync('node', ['server/inbox-dump.mjs'], { env: process.env }).toString()) as { round: number; selections: { contestId: string; candidateIds: string[]; abstain: boolean }[] }[];
const PASSWORD = 'correct horse 1 battery';
const calls: string[] = [];
test.beforeEach(({ page }) => { page.on('pageerror', (e) => calls.push(`pageerror: ${e.message}`)); });

async function register(page: Page, sid: string, voucher: string) {
  await page.goto('/register');
  await page.locator('#student-id').fill(sid); await page.locator('#voucher').fill(voucher); await page.locator('#password').fill(PASSWORD);
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: /Create/ }).click();
  await expect(page.getByRole('status')).toBeVisible();
}
async function signIn(page: Page, sid: string) {
  await page.goto('/login');
  await page.locator('#identifier').fill(sid); await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page.getByRole('status')).toBeVisible();
}
const meStatus = (page: Page) => page.evaluate(async () => (await fetch('/api/me', { credentials: 'same-origin' })).status);

test('a visitor who is not signed in gets a sign-in prompt on the ballot, not a crash', async ({ page }) => {
  await page.goto('/vote');
  await expect(page.locator('main').getByRole('link', { name: /sign in/i })).toBeVisible();
  expect(calls.filter((c) => c.startsWith('pageerror'))).toEqual([]);
});

test('register, sign in and sign out use the real server session', async ({ page }) => {
  await register(page, '2026-00001', 'DEMO-1');
  expect(await meStatus(page)).toBe(200);                        // the header says "Sign out" only if there really is a server session
  await expect(page.getByRole('button', { name: /Sign out/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Sign out/ }).first().click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();   // the UI flips only after the server has answered
  expect(await meStatus(page)).toBe(401);
  await signIn(page, '2026-00001');
  expect(await meStatus(page)).toBe(200);
  await page.reload();                                            // the cookie survives a reload and the header must say so
  await expect(page.getByRole('button', { name: /Sign out/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Sign out/ }).first().click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();   // the UI flips only after the server has answered
  expect(await meStatus(page)).toBe(401);                        // sign out must end the SERVER session, not only the UI state
});

test('election page shows the real organization and readable dates', async ({ page }) => {
  await page.goto('/election');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('BS IT Society');
  await expect(page.locator('main')).not.toContainText(/T\d\d:\d\d:\d\d/);   // no raw ISO timestamps
});

test('voter casts a ballot: pick, multi-pick and abstain; the stored ballot matches the choices', async ({ page }) => {
  await signIn(page, '2026-00001');
  await page.goto('/vote');
  await expect(page.getByRole('heading', { name: 'President', exact: true })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/mock|demo|fictional/i);   // a real voter must never be told this is a mock
  await page.getByRole('button', { name: /President 1/ }).click();
  await page.getByRole('button', { name: /Next contest/ }).click();
  await expect(page.getByRole('heading', { name: 'Senators', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Senators 1/ }).click(); await page.getByRole('button', { name: /Senators 3/ }).click();
  await page.getByRole('button', { name: /Next contest/ }).click();
  await expect(page.getByRole('heading', { name: 'BSIT Rep', exact: true })).toBeVisible();     // scope: BSIT voter sees BSIT Rep ...
  await page.getByLabel(/Abstain from this contest/).check();
  await page.getByRole('button', { name: /Review ballot/ }).click();
  await expect(page.getByText('BSED Rep')).toHaveCount(0);                                       // ... and never BSED Rep
  await expect(page.locator('main')).not.toContainText(/mock|demo|no real vote/i);
  await page.getByRole('button', { name: /Submit my ballot/ }).click();
  await expect(page.getByRole('heading', { name: /Your ballot is recorded/i })).toBeVisible({ timeout: 10_000 });
  expect(sql(`SELECT count(*) FROM participation.participation WHERE election_id='${E}'`)).toBe('1');
  const stored = inbox(); expect(stored).toHaveLength(1);
  const byTitle = Object.fromEntries(stored[0].selections.map((s) => [sql(`SELECT title FROM election.positions WHERE id='${s.contestId}'`), s]));
  const name = (id: string) => sql(`SELECT name FROM election.candidates WHERE id='${id}'`);
  expect(byTitle['President'].candidateIds.map(name)).toEqual(['President 1']);
  expect(byTitle['Senators'].candidateIds.map(name).sort()).toEqual(['Senators 1', 'Senators 3']);
  expect(byTitle['BSIT Rep']).toMatchObject({ candidateIds: [], abstain: true });
  expect(Object.keys(byTitle).sort()).toEqual(['BSIT Rep', 'President', 'Senators']);
});

test('after voting: status says voted, and a second ballot is refused with a clear message', async ({ page }) => {
  await signIn(page, '2026-00001');
  await page.goto('/status');
  await expect(page.locator('main')).toContainText(/ballot was recorded/i);
  await page.goto('/vote');
  await page.getByRole('button', { name: /President 2/ }).click(); await page.getByRole('button', { name: /Next contest/ }).click();
  await page.getByLabel(/Abstain from this contest/).check(); await page.getByRole('button', { name: /Next contest/ }).click();
  await page.getByLabel(/Abstain from this contest/).check();
  await page.getByRole('button', { name: /Review ballot/ }).click(); await page.getByRole('button', { name: /Submit my ballot/ }).click();
  await expect(page.getByRole('alert')).toContainText(/already voted/i);
  expect(sql(`SELECT count(*) FROM participation.participation WHERE election_id='${E}'`)).toBe('1');
});

test('a BSED voter sees BSED Rep and not BSIT Rep', async ({ page }) => {
  await register(page, '2026-00002', 'DEMO-2'); await signIn(page, '2026-00002');
  await page.goto('/vote'); await page.getByRole('button', { name: /President 1/ }).click(); await page.getByRole('button', { name: /Next contest/ }).click();
  await page.getByLabel(/Abstain from this contest/).check(); await page.getByRole('button', { name: /Next contest/ }).click();
  await expect(page.getByRole('heading', { name: 'BSED Rep', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'BSIT Rep', exact: true })).toHaveCount(0);
});
