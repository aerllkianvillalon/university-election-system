/// <reference lib="dom" />
import { expect, test } from '@playwright/test';

test('ballot stays in session and receipt records then seals without selections', async ({ page }) => {
  await page.goto('/vote');
  await expect(page.getByRole('heading', { name: 'President', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Aya Santos/ }).click();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toContain('aya-santos');
  await page.getByRole('button', { name: /Next contest/ }).click();
  await page.getByRole('button', { name: /Julio Reyes/ }).click();
  await page.getByRole('button', { name: /Next contest/ }).click();
  const mika = page.getByRole('button', { name: /Mika Dizon/ });
  await mika.click();
  await expect(mika).toHaveAttribute('aria-pressed', 'true');
  const abstain = page.getByLabel(/Abstain from this contest/);
  await abstain.check();
  await expect(mika).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(/Select up to 2 · 0 selected/)).toBeVisible();
  await mika.click();
  await expect(abstain).not.toBeChecked();
  await page.getByRole('button', { name: /Renzo Lim/ }).click();
  await expect(page.getByText(/Select up to 2 · 2 selected/)).toBeVisible();
  await page.getByRole('button', { name: /Review ballot/ }).click();
  await expect(page.getByText(/irreversible/i)).toBeVisible();
  await page.getByRole('button', { name: /Confirm mock ballot/ }).click();
  await expect(page.getByRole('heading', { name: /Your ballot is recorded/i })).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toBeNull();
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  await expect(page.locator('.receipt-status')).toHaveText(/sealed/i, { timeout: 5000 });
  await expect(page.getByText('We are checking your vote.')).toBeVisible();
});

test('auth form failures use the same generic copy', async ({ page }) => {
  const messages: string[] = [];
  for (const [route, button] of [['/login', 'Sign in'], ['/register', 'Create demo account'], ['/forgot-password', 'Send instructions']]) {
    await page.goto(route);
    if (route === '/login') {
      await page.getByLabel('Student ID or campus email').fill('unknown-student');
      await page.getByLabel('Password', { exact: true }).fill('wrong-password-123');
    } else if (route === '/register') {
      await page.getByLabel('Student ID').fill('2026-99999');
      await page.getByLabel('Election voucher').fill('INVALID-VOUCHER');
      await page.getByLabel('Password', { exact: true }).fill('wrong-password-123');
      await page.getByRole('checkbox').check();
    } else {
      await page.getByLabel('Student ID or email').fill('unknown-student@example.edu');
    }
    await page.getByRole('button', { name: new RegExp(button) }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    messages.push((await alert.textContent()) || '');
  }
  expect(new Set(messages).size).toBe(1);
  expect(messages[0]).toBe('We couldn’t complete that request. Check your details and try again.');
});

test('registration requires the demo voucher and Terms acceptance', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Student ID').fill('2026-00001');
  await page.getByLabel('Election voucher').fill('DANAO-2026-DEMO');
  await page.getByLabel('Password', { exact: true }).fill('safe-demo-password');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Create demo account/ }).click();
  await expect(page.getByRole('status')).toContainText('Your demo account is ready');
});

test('known recovery requests receive non-enumerating success copy', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Student ID or email').fill('demo-student@danao.ctu.edu.ph');
  await page.getByRole('button', { name: /Send instructions/ }).click();
  await expect(page.getByRole('status')).toHaveText('If the details match an account, instructions will be sent shortly.');
});

test('results remain locked until selecting a certified archive', async ({ page }) => {
  await page.goto('/results');
  await expect(page.getByText('Results are not available yet.')).toBeVisible();
  await page.getByRole('button', { name: /Certified archive/ }).click();
  await expect(page.getByText('Lia Navarro')).toBeVisible();
});

test('kiosk progresses to the wizard and auto-resets, clearing session selections', async ({ page }) => {
  await page.clock.install();
  await page.goto('/lab/booth');
  const boothWidth = await page.locator('.booth-screen').evaluate((element) => element.getBoundingClientRect().width);
  expect(boothWidth).toBe(page.viewportSize()?.width);
  await page.getByRole('button', { name: /Start check-in/ }).click();
  await page.getByRole('button', { name: /Enter assigned booth/ }).click();
  await page.evaluate(() => window.sessionStorage.setItem('ctu.demo.ballot.v1', JSON.stringify({ selections: { 'contest-president': ['aya-santos'] }, expiresAt: Date.now() + 60_000 })));
  await expect(page.getByText(/Auto reset in 45s/)).toBeVisible();
  await page.clock.runFor(46_000);
  await expect(page.getByRole('heading', { name: 'Booth reset.' })).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toBeNull();
});

test('sign-out clears ballot selections from the active session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Student ID or campus email').fill('demo-student');
  await page.getByLabel('Password', { exact: true }).fill('demopassword');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Sign out/ })).toBeVisible();
  await page.getByRole('link', { name: 'Candidates', exact: true }).click();
  await page.getByRole('link', { name: /Enter the ballot/ }).click();
  await page.getByRole('button', { name: /Aya Santos/ }).click();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toContain('aya-santos');
  await page.getByRole('button', { name: /Sign out/ }).click();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toBeNull();
  await expect(page).toHaveURL(/\/$/);
});

test('an expired ballot session clears its unsent draft', async ({ page }) => {
  await page.clock.install();
  await page.goto('/vote');
  await page.getByRole('button', { name: /Aya Santos/ }).click();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toContain('aya-santos');
  await page.clock.runFor(10 * 60 * 1000 + 1_000);
  await expect(page.getByRole('heading', { name: 'Ballot session expired.' })).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem('ctu.demo.ballot.v1'))).toBeNull();
});

test('organization cards load organization-specific election and candidate data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Engineering Society/ }).click();
  await expect(page).toHaveURL(/org=engineering-society/);
  await expect(page.getByRole('heading', { name: /Engineering Society election/ })).toBeVisible();
  await page.getByRole('link', { name: /Review candidate profiles/ }).click();
  await expect(page.getByRole('heading', { name: /Meet your candidates/ })).toBeVisible();
  await expect(page.getByText('Mika Dizon', { exact: true })).toBeVisible();
  await expect(page.getByText('Renzo Lim', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Enter the ballot/ }).click();
  await expect(page).toHaveURL(/vote\?org=engineering-society/);
  await expect(page.getByRole('heading', { name: 'Society President', exact: true })).toBeVisible();
});


test('proctor station scopes booth board and turnout to one organization', async ({ page }) => {
  await page.goto('/lab/proctor?org=engineering-society');
  await expect(page.getByLabel('Organization election')).toHaveValue('engineering-society');
  await expect(page.getByText('47%', { exact: true })).toBeVisible();
  await expect(page.getByText('Booth 02', { exact: true })).toBeVisible();
  await expect(page.getByText('Booth 03', { exact: true })).toHaveCount(0);
  await page.getByLabel('Organization election').selectOption('campus-arts');
  await expect(page.getByText('0%', { exact: true })).toBeVisible();
  await expect(page.getByText('Booth 01', { exact: true })).toBeVisible();
  await expect(page.getByText('Booth 02', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Candidate-level vote counts are never shown/)).toBeVisible();
});
