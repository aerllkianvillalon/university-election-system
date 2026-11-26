/// <reference lib="dom" />
// Support forms, in-person claim and password reset in a real browser against the real API. Queued emails are read from ops.outbox
// because email sending is not built yet (the reset link only sits in the queue).
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const DB = process.env.LIVE_DB ?? 'evlive', E = process.env.ELECTION_ID ?? '';
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', DB, '-c', q]).toString().trim();
const OLD = 'old password 1 battery', NEW = 'brand new password 2';
const REF = /Your reference is ([A-Z2-9]{4}-[A-Z2-9]{4})\./;

async function fillAndSend(page: Page, path: string, values: Record<string, string>, button: RegExp) {
  await page.goto(path);
  for (const [name, value] of Object.entries(values)) await page.locator(`[name="${name}"]`).fill(value);
  await page.getByRole('button', { name: button }).click();
}

for (const [path, kind, values, button] of [
  ['/protest', 'protest', { studentId: '2026-00001', subject: 'Posters after deadline', details: 'Posted on the day of voting.' }, /Submit protest/],
  ['/account-dispute', 'dispute', { studentId: '2026-00001', details: 'Someone else registered with my ID.' }, /Send dispute/],
  ['/report-fake-site', 'report', { url: 'http://ctu-vote.example', details: 'Came by SMS.' }, /Send report/],
] as const) {
  test(`${kind} form: the voter gets a reference and the record exists`, async ({ page }) => {
    await fillAndSend(page, path, { ...values }, button);
    const status = page.getByRole('status');
    await expect(status).toContainText(REF);
    const ref = (await status.innerText()).match(REF)![1];
    expect(sql(`SELECT kind FROM support.requests WHERE ref='${ref}' AND election_id='${E}'`)).toBe(kind);
    await expect(page.locator('main')).not.toContainText(/prototype|mock/i);
    if (kind === 'dispute') {
      await expect(status).toContainText(/claim code/);
      expect(sql(`SELECT count(*) FROM identity.accounts WHERE disputed`)).toBe('0');   // a public form never flags an account
    }
  });
}

test('a form with a missing field shows the generic message and stores nothing', async ({ page }) => {
  const before = sql('SELECT count(*) FROM support.requests');
  await fillAndSend(page, '/protest', { studentId: '2026-00001', subject: '', details: 'x' }, /Submit protest/);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(sql('SELECT count(*) FROM support.requests')).toBe(before);
});

test('in-person claim: a wrong code gets the generic refusal; the right code sets the password and the voter can sign in', async ({ page }) => {
  sql(`INSERT INTO identity.claim_codes(voter_id, code_hash, expires_at) SELECT id, hmac('ABCDE12345','pepper','sha256'), now()+interval '1 day' FROM election.voters WHERE student_id='2026-00004'`);
  await fillAndSend(page, '/claim-account', { studentId: '2026-00004', claimCode: 'WRONG-00000', password: NEW }, /Claim account/);
  await expect(page.getByRole('alert')).toBeVisible();
  await fillAndSend(page, '/claim-account', { studentId: '2026-00004', claimCode: 'abcde-12345', password: 'short' }, /Claim account/);
  await expect(page.getByRole('alert')).toContainText(/at least 8/);
  await fillAndSend(page, '/claim-account', { studentId: '2026-00004', claimCode: 'abcde-12345', password: NEW }, /Claim account/);
  await expect(page.getByRole('status')).toContainText(/account is ready/);
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.locator('#identifier').fill('2026-00004'); await page.locator('#password').fill(NEW);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/\/vote$/);
  expect(await page.evaluate(async () => (await fetch('/api/me')).status)).toBe(200);
});

test('password reset: link is checked, hidden from the address bar, works once; old password stops working', async ({ page }) => {
  await page.goto('/register');
  await page.locator('#student-id').fill('2026-00003'); await page.locator('#voucher').fill('DEMO-3'); await page.locator('#password').fill(OLD);
  await page.locator('#pick-program').selectOption('BSIT');
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: /Create/ }).click(); await expect(page).toHaveURL(/\/vote$/);
  await page.getByRole('button', { name: /Sign out/ }).first().click(); await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  await page.goto('/forgot-password');
  await page.locator('#identifier').fill('2026-00003'); await page.getByRole('button', { name: /Send instructions/ }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const body = sql(`SELECT body FROM ops.outbox WHERE to_email='2026-00003@test.invalid' ORDER BY id DESC LIMIT 1`);
  const token = body.match(/token=([A-Za-z0-9_-]+)/)![1];

  await page.goto(`/reset-password?token=${token}`);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  expect(page.url()).not.toContain(token);                                             // the secret is gone from the address bar
  await page.getByLabel('New password', { exact: true }).fill(NEW); await page.getByLabel('Confirm new password').fill('something else 123');
  await page.getByRole('button', { name: /Update password/ }).click();
  await expect(page.getByRole('alert')).toContainText(/do not match/);
  // reload loses the token (it was removed on purpose), so open the link again; the earlier check must not have used it up
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill(NEW); await page.getByLabel('Confirm new password').fill(NEW);
  await page.getByRole('button', { name: /Update password/ }).click();
  await expect(page.getByRole('status')).toContainText(/Password updated/);
  await expect(page.getByRole('button', { name: /Update password/ })).toBeDisabled();

  await page.goto(`/reset-password?token=${token}`);                                   // second use of the same link
  await expect(page.getByRole('alert')).toContainText(/no longer valid/);
  await expect(page.getByRole('link', { name: /Request a new link/ })).toBeVisible();

  for (const [pw, ok] of [[OLD, false], [NEW, true]] as const) {
    await page.goto('/login'); await page.locator('#identifier').fill('2026-00003'); await page.locator('#password').fill(pw);
    await page.getByRole('button', { name: /^Sign in/ }).click();
    if (ok) { await expect(page).toHaveURL(/\/vote$/); } else { await expect(page.getByRole('alert')).toBeVisible(); }
  }
});

test('a reset page without a token, or with a made-up one, says the link is not valid', async ({ page }) => {
  for (const url of ['/reset-password', '/reset-password?token=not-a-real-token']) {
    await page.goto(url);
    await expect(page.getByRole('alert')).toContainText(/no longer valid/);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  }
});
