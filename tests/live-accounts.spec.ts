/// <reference lib="dom" />
// The staff account lifecycle in a real browser: first administrators appointed with the setup tool, one-time setup, password change, authenticator
// replacement, recovery codes, and inviting / approving / disabling colleagues from separate browser contexts. TOTP is computed here with its own
// implementation (RFC 6238), so the page and the server are not each other's only witness.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DB = process.env.LIVE_DB ?? 'evlive';
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', DB, '-c', q]).toString().trim();
test.describe.configure({ mode: 'serial' });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret: string, offset = 0): string {
  let bits = 0, v = 0; const bytes: number[] = [];
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((v >>> (bits - 8)) & 255); bits -= 8; v &= (1 << bits) - 1; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest(), o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}
const cli = (...args: string[]) => execFileSync('node', ['server/staff-admin.mjs', ...args], { env: { ...process.env, DATABASE_URL: `postgresql:///${DB}`, PEPPER: 'pepper', PGHOST: process.env.PGHOST ?? '/var/run/postgresql', PGUSER: process.env.PGUSER ?? execFileSync('id', ['-un']).toString().trim() } }).toString();
const codeFrom = (out: string) => out.match(/Setup code for \S+: ([A-Z0-9-]+)/)![1];
const relax = (user: string) => { sql("DELETE FROM security.rate_limits WHERE key LIKE 'staff:%' OR key LIKE 'acct:%'"); sql(`UPDATE admin.admins SET totp_last_step = 0 WHERE username='${user}'`); };   // test shortcut: forget replay and limiter memory (both are tested in the backend suite)
const PW = 'first-password-123', PW2 = 'second-password-456';
type Person = { secret: string; recovery: string[]; password: string };
const people: Record<string, Person> = {};

const go = (p: Page, id: string) => p.evaluate((h) => { window.location.hash = h; }, id);   // the console shows one section at a time
async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations, `${label}: ` + JSON.stringify(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
}
async function setup(page: Page, username: string, setupCode: string, password = PW) {
  await page.goto('/staff/setup'); await page.locator('#username').fill(username); await page.locator('#setup-code').fill(setupCode); await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByLabel('Authenticator setup key').innerText()).replace(/\s/g, '');
  await page.locator('#password').fill(password); await page.locator('#confirm').fill(password); await page.locator('#code').fill(totp(secret, 0)); await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Your account is ready.')).toBeVisible();
  const recovery = (await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()).map((t) => t.trim());
  return { secret, recovery, password } satisfies Person;
}
async function signIn(page: Page, username: string, p: Person, how: 'code' | 'recovery' = 'code', recoveryCode = '') {
  relax(username); await page.goto('/staff/login'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(p.password); await page.getByRole('button', { name: 'Continue' }).click();
  if (how === 'recovery') { await page.getByRole('button', { name: /use a recovery code/i }).click(); await page.getByLabel('Recovery code').fill(recoveryCode); await page.getByRole('button', { name: 'Sign in' }).click(); } else await page.getByLabel('6-digit code').fill(totp(p.secret, 1));   // the code box signs in by itself on the sixth digit

}
async function refusedAtPassword(page: Page, username: string, password: string) {
  relax(username); await page.goto('/staff/login'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('Check your username and password'); await expect(page.getByLabel('6-digit code')).toHaveCount(0);   // no way forward without the password
}
async function ensureSignedIn(page: Page, username: string, p: Person) {   // a long-lived page may still hold a valid session: the sign-in page then sends it straight to the console
  await page.goto('/staff'); await expect(page.getByRole('navigation', { name: 'Console sections' }).or(page.locator('#username'))).toBeVisible();
  if (await page.locator('#username').isVisible()) await signIn(page, username, p);
}
const signedIn = async (page: Page) => { await expect(page.getByRole('navigation', { name: 'Console sections' })).toBeVisible(); await go(page, 'account'); await expect(page.locator('#account')).toBeVisible(); };
const revealed = async (page: Page) => (await page.locator('#people [role=status]').filter({ hasText: 'Setup code for' }).locator('strong').first().innerText()).trim();

let ctxB: BrowserContext, b: Page;
test.beforeAll(async ({ browser }: { browser: Browser }) => { ctxB = await browser.newContext(); b = await ctxB.newPage(); });
test.afterAll(async () => { await ctxB?.close(); });

test('setup: a wrong or reused code is refused; the right one gives a key, a password, recovery codes once', async ({ page }) => {
  const c1 = codeFrom(cli('invite', '--org', 'bsit', '--username', 'acc1', '--name', 'Acc One', '--role', 'ADMIN')), c2 = codeFrom(cli('invite', '--org', 'bsit', '--username', 'acc2', '--name', 'Acc Two', '--role', 'ADMIN'));
  await page.goto('/staff/setup'); await axe(page, 'staff setup, code step');
  await page.locator('#username').fill('acc1'); await page.locator('#setup-code').fill('AAAA-BBBB-CCCC'); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('do not match'); await expect(page.getByLabel('Authenticator setup key')).toHaveCount(0);
  await page.locator('#setup-code').fill(c1.toLowerCase()); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Welcome, Acc One')).toBeVisible(); const secret = (await page.getByLabel('Authenticator setup key').innerText()).replace(/\s/g, ''); expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await expect(page.getByRole('link', { name: /open it in your authenticator app/ })).toHaveAttribute('href', /^otpauth:\/\/totp\/CTU%20Vote:acc1\?secret=/); await axe(page, 'staff setup, enrolment step');
  await page.locator('#password').fill('short'); await page.locator('#confirm').fill('short'); await page.locator('#code').fill(totp(secret, 0)); await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 12');
  await page.locator('#password').fill(PW); await page.locator('#confirm').fill('different-password-1'); await page.getByRole('button', { name: 'Finish setup' }).click(); await expect(page.getByRole('alert')).toContainText('do not match');
  await page.locator('#confirm').fill(PW); await page.locator('#code').fill('000000'); await page.getByRole('button', { name: 'Finish setup' }).click(); await expect(page.getByRole('alert')).toContainText('did not match');
  expect(sql("SELECT status FROM admin.admins WHERE username='acc1'")).toBe('INVITED');                         // none of the refusals changed anything
  await page.locator('#code').fill(totp(secret, 0)); await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Your account is ready.')).toBeVisible();
  const recovery = (await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()).map((t) => t.trim()); expect(recovery).toHaveLength(10); expect(new Set(recovery).size).toBe(10);
  await expect(page.getByRole('link', { name: 'Go to sign-in' })).toHaveCount(0); await axe(page, 'staff setup, recovery codes'); await page.getByLabel('I have saved these recovery codes.').check(); await expect(page.getByRole('link', { name: 'Go to sign-in' })).toBeVisible();
  people.acc1 = { secret, recovery, password: PW };
  await page.goto('/staff/setup'); await page.locator('#username').fill('acc1'); await page.locator('#setup-code').fill(c1); await page.getByRole('button', { name: 'Continue' }).click(); await expect(page.getByRole('alert')).toContainText('do not match');   // used up
  people.acc2 = await setup(b, 'acc2', c2);
});

test('both administrators sign in; the console shows people and their own account, with no accessibility violations', async ({ page }) => {
  await signIn(page, 'acc1', people.acc1); await signedIn(page); await expect(page.getByRole('heading', { level: 1 })).toContainText('operations');
  await signIn(b, 'acc2', people.acc2); await signedIn(b);
  await expect(page.locator('#account')).toContainText('10 unused recovery codes'); await go(page, 'people');
  const row = page.locator('#people tbody tr').filter({ hasText: 'acc1' }); await expect(row).toContainText('Administrator'); await expect(row).toContainText('(you)'); await expect(row).toContainText('Active');
  for (const [n, w, h] of [['mobile', 390, 844], ['desktop', 1440, 1000]] as const) { await page.setViewportSize({ width: w, height: h }); await axe(page, `console people and account, ${n}`); }
});

test('change password: wrong current, mismatch and too short are refused; the change works and the old password stops working', async ({ page }) => {
  await signIn(page, 'acc1', people.acc1); await signedIn(page); const f = page.locator('#account');
  const attempt = async (cur: string, next: string, conf: string) => { await f.locator('#pw-current').fill(cur); await f.locator('#pw-next').fill(next); await f.locator('#pw-confirm').fill(conf); await f.getByRole('button', { name: 'Change password' }).click(); };
  await attempt('not-my-password', PW2, PW2); await expect(f.getByRole('alert')).toContainText('not your current password');
  await attempt(PW, PW2, 'something-else-789'); await expect(f.getByRole('alert')).toContainText('do not match');
  await attempt(PW, 'short', 'short'); expect(await f.locator('#pw-next').evaluate((el) => (el as HTMLInputElement).checkValidity())).toBe(false);   // the browser itself refuses a short password; the server rule is tested in the backend suite
  await attempt(PW, PW2, PW2); await expect(f.getByRole('status')).toContainText('Password changed');
  await page.getByRole('button', { name: /Sign out/ }).click(); await expect(page).toHaveURL(/\/staff\/login/);
  await refusedAtPassword(page, 'acc1', PW);                                                                        // the old password
  people.acc1.password = PW2; await signIn(page, 'acc1', people.acc1); await signedIn(page);
});

test('replace the authenticator: the old one works until the new one proves itself, then only the new one works', async ({ page }) => {
  await signIn(page, 'acc1', people.acc1); await signedIn(page); const f = page.locator('#account');
  await f.locator('#auth-password').fill('wrong-password-xx'); await f.getByRole('button', { name: 'Start replacing' }).click(); await expect(f.getByRole('alert')).toContainText('not your current password');
  await f.locator('#auth-password').fill(PW2); await f.getByRole('button', { name: 'Start replacing' }).click();
  const fresh = (await f.getByLabel('New authenticator setup key').innerText()).replace(/\s/g, ''); expect(fresh).not.toBe(people.acc1.secret);
  expect(sql("SELECT totp_secret IS NOT NULL AND pending_totp IS NOT NULL FROM admin.admins WHERE username='acc1'")).toBe('t');
  await f.locator('#auth-code').fill('000000'); await f.getByRole('button', { name: 'Confirm new authenticator' }).click(); await expect(f.getByRole('alert')).toContainText('did not match');
  relax('acc1'); await f.locator('#auth-code').fill(totp(fresh, 0)); await f.getByRole('button', { name: 'Confirm new authenticator' }).click(); await expect(f.getByRole('status')).toContainText('replaced');
  await page.getByRole('button', { name: /Sign out/ }).click(); const old = { ...people.acc1 };
  await signIn(page, 'acc1', old); await expect(page.getByRole('alert')).toContainText('did not work');                       // the old authenticator is dead
  people.acc1.secret = fresh; await signIn(page, 'acc1', people.acc1); await signedIn(page);
});

test('recovery codes: a new set replaces the old; a recovery sign-in works once, is flagged, and replacing the authenticator clears the flag', async ({ page }) => {
  await signIn(page, 'acc1', people.acc1); await signedIn(page); const f = page.locator('#account'), oldCode = people.acc1.recovery[0];
  await f.locator('#rec-password').fill('wrong-password-xx'); await f.getByRole('button', { name: 'Make new recovery codes' }).click(); await expect(f.getByRole('alert')).toContainText('not your current password');
  await f.locator('#rec-password').fill(PW2); await f.getByRole('button', { name: 'Make new recovery codes' }).click();
  await expect(f.getByRole('list', { name: 'New recovery codes' }).locator('li')).toHaveCount(10);
  const fresh = (await f.getByRole('list', { name: 'New recovery codes' }).locator('li').allInnerTexts()).map((t) => t.trim()); expect(fresh).toHaveLength(10); expect(fresh).not.toContain(oldCode);
  await f.getByRole('button', { name: 'Done, hide them' }).click(); await expect(f.getByRole('list', { name: 'New recovery codes' })).toHaveCount(0);
  await page.getByRole('button', { name: /Sign out/ }).click();
  await signIn(page, 'acc1', people.acc1, 'recovery', oldCode); await expect(page.getByRole('alert')).toContainText('recovery code did not work');           // the old set is dead
  await signIn(page, 'acc1', people.acc1, 'recovery', fresh[0].toLowerCase()); await signedIn(page);
  await expect(page.getByRole('alert').filter({ hasText: 'signed in with a recovery code' })).toBeVisible(); await expect(page.locator('#account')).toContainText('9 unused recovery codes');
  await page.getByRole('button', { name: /Sign out/ }).click(); await signIn(page, 'acc1', people.acc1, 'recovery', fresh[0]); await expect(page.getByRole('alert')).toContainText('recovery code did not work');   // once only
  await signIn(page, 'acc1', people.acc1, 'recovery', fresh[1]); await signedIn(page); await expect(page.getByRole('alert').filter({ hasText: 'signed in with a recovery code' })).toBeVisible();
  const g = page.locator('#account'); await g.locator('#auth-password').fill(PW2); await g.getByRole('button', { name: 'Start replacing' }).click();
  const secret = (await g.getByLabel('New authenticator setup key').innerText()).replace(/\s/g, ''); relax('acc1'); await g.locator('#auth-code').fill(totp(secret, 0)); await g.getByRole('button', { name: 'Confirm new authenticator' }).click();
  await expect(g.getByRole('status')).toContainText('replaced'); await expect(page.getByRole('alert').filter({ hasText: 'signed in with a recovery code' })).toHaveCount(0);
  people.acc1.secret = secret; people.acc1.recovery = fresh;
});

test('people: a proctor is invited by one administrator; an administrator needs a second one to approve; setup codes are shown once', async ({ page, browser }) => {
  test.setTimeout(90_000);   // many sign-ins in one test; Windows needs longer than 30 s
  await signIn(page, 'acc1', people.acc1); await signedIn(page); await ensureSignedIn(b, 'acc2', people.acc2); await signedIn(b); await go(page, 'people'); await go(b, 'people');
  const form = async (p: Page, name: string, user: string, role: string) => { await p.locator('#inv-name').fill(name); await p.locator('#inv-username').fill(user); await p.locator('#inv-role').selectOption(role); await p.getByRole('button', { name: 'Invite', exact: true }).click(); };
  await form(page, 'Prox Proctor', 'bad name', 'PROCTOR'); await expect(page.locator('#people').getByRole('alert')).toContainText('3 to 32 lower-case');
  await form(page, 'Prox Proctor', 'acc1', 'PROCTOR'); await expect(page.locator('#people').getByRole('alert')).toContainText('already in use');
  await form(page, 'Prox Proctor', 'prox', 'PROCTOR'); const proxCode = await revealed(page); expect(proxCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.reload(); await expect(page.locator('body')).not.toContainText(proxCode); await expect(page.locator('#people tbody tr').filter({ hasText: 'prox' })).toContainText('Waiting for setup');
  const ctxP = await browser.newContext(), prox = await ctxP.newPage(); people.prox = await setup(prox, 'prox', proxCode); await signIn(prox, 'prox', people.prox);
  await expect(prox.getByRole('heading', { name: 'This console is for administrators.' })).toBeVisible(); await expect(prox.locator('#account')).toBeVisible(); await expect(prox.locator('#people')).toHaveCount(0);   // a proctor manages only their own sign-in
  await form(page, 'Acc Three', 'acc3', 'ADMIN'); await expect(page.getByText('Request sent. A different administrator has to approve it.')).toBeVisible(); await expect(page.locator('body')).not.toContainText('Setup code for acc3');
  await expect(page.locator('#people').getByText('Waiting for another administrator.')).toBeVisible(); await expect(page.locator('#people').getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  expect(sql("SELECT count(*) FROM admin.admins WHERE username='acc3'")).toBe('0');
  await b.reload(); await expect(b.locator('#people').getByText(/Add administrator Acc Three · requested by Acc One/)).toBeVisible(); await axe(b, 'console people with a pending request');
  await b.getByRole('button', { name: /^Approve Add administrator/ }).click(); const acc3Code = await revealed(b);
  const ctx3 = await browser.newContext(), a3 = await ctx3.newPage(); people.acc3 = await setup(a3, 'acc3', acc3Code); expect(sql("SELECT status FROM admin.admins WHERE username='acc3'")).toBe('ACTIVE');
  await page.reload(); await form(page, 'Acc Four', 'acc4', 'ADMIN'); await b.reload(); await b.getByRole('button', { name: /^Decline Add administrator/ }).click(); await expect(b.getByText('The request was declined.')).toBeVisible();
  expect(sql("SELECT count(*) FROM admin.admins WHERE username='acc4'")).toBe('0');
  // disabling a proctor: one administrator; the proctor's open session ends at once
  await page.reload(); await page.locator('#people tbody tr').filter({ hasText: 'prox' }).getByRole('button', { name: /^Disable/ }).click();
  await expect(page.getByRole('group', { name: /Confirm: disable Prox Proctor/ })).toBeVisible(); await page.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(page.locator('#people tbody tr').filter({ hasText: 'prox' })).toContainText('Disabled');
  await prox.reload(); await expect(prox).toHaveURL(/\/staff\/login/); await expect(prox.getByText(/signed out after a few minutes/)).toBeVisible();
  await refusedAtPassword(prox, 'prox', people.prox.password);                                                      // a disabled account cannot even get to the code step
  await expect(page.locator('#people tbody tr').filter({ hasText: 'acc1' }).getByRole('button')).toHaveCount(0);   // you cannot disable yourself
  await ctxP.close(); await ctx3.close();
});
