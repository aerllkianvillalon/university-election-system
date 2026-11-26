/// <reference lib="dom" />
// The staff console in a real browser, against the real API and database. Two administrators sign in from separate browser contexts, because the
// two-person rule only means something if the second person approves from their own session. Ends with the whole closing story:
// close -> seal -> real offline tally -> import (forged files refused) -> certify. Runs after the voter specs; the Results spec runs after this one.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.LIVE_DB ?? 'evlive', E = process.env.ELECTION_ID ?? '', W = process.env.CEREMONY_DIR ?? '';
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', DB, '-c', q]).toString().trim();
const totp = (secret: string) => execFileSync('node', ['server/tools.mjs', 'code', secret]).toString().trim();
const PW = 'staff-pass-123';
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, user: string, secret: string) {
  await page.goto('/staff/login');
  await page.getByLabel('Username').fill(user); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('6-digit code').fill(totp(secret));   // the sixth digit signs in by itself
}
async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations, `${label}: ` + JSON.stringify(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
}
const flash = (page: Page) => page.getByRole('status').or(page.getByRole('alert')).last();
async function request(page: Page, action: RegExp, then = 'Send request') {
  await page.getByRole('button', { name: action }).click(); await page.getByRole('button', { name: then, exact: true }).click();
}
// Reversible actions (pause, resume, extend, lift the freeze) are approved with one click; the others ask for a confirmation first.
const approve = async (page: Page) => {
  await page.getByRole('button', { name: /^Approve \S/ }).first().click();
  const confirm = page.getByRole('button', { name: 'Approve', exact: true });
  if (await confirm.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await confirm.click();
};
const go = (p: Page, id: string) => p.evaluate((h) => { window.location.hash = h; }, id);   // the console shows one section at a time
const pill = (page: Page, text: string) => page.locator('.status-strip').getByText(text, { exact: true });

let c1: BrowserContext, c2: BrowserContext, a1: Page, a2: Page;
test.beforeAll(async ({ browser }: { browser: Browser }) => { c1 = await browser.newContext(); c2 = await browser.newContext(); a1 = await c1.newPage(); a2 = await c2.newPage(); });
test.afterAll(async () => { await c1?.close(); await c2?.close(); });

test('sign-in refuses a wrong password and a wrong code, and the console needs a session', async ({ browser }) => {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  await page.goto('/staff'); await expect(page).toHaveURL(/\/staff\/login/); await expect(page.getByText(/signed out after a few minutes/)).toBeVisible();
  await axe(page, 'staff sign-in, password step');
  await page.getByLabel('Username').fill('a3'); await page.getByLabel('Password').fill('not the password'); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('Check your username and password');
  await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible(); await axe(page, 'staff sign-in, code step');
  await page.getByLabel('6-digit code').fill('000000');   // sends itself on the sixth digit
  await expect(page.getByRole('alert')).toContainText('did not work');
  expect(await page.evaluate(async () => (await fetch('/api/staff/me')).status)).toBe(401);       // a password alone is not a session
  await ctx.close();
});

test('a proctor can sign in but the console tells them it is for administrators', async ({ browser }) => {
  const ctx = await browser.newContext(), page = await ctx.newPage(); await signIn(page, 'p1', process.env.P1_SECRET!);
  await expect(page.getByRole('heading', { name: 'This console is for administrators.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Request/ })).toHaveCount(0);
  await ctx.close();
});

test('two administrators sign in; the summary shows the real state, readiness and turnout', async () => {
  await signIn(a1, 'a1', process.env.A1_SECRET!); await signIn(a2, 'a2', process.env.A2_SECRET!);
  await expect(a1.getByRole('heading', { level: 1 })).toContainText('operations'); await expect(a1.getByText('Signed in as Admin One')).toBeVisible();
  await expect(pill(a1, 'Open')).toBeVisible();
  const items = await a1.locator('.readiness-list li').allInnerTexts(); expect(items.length).toBe(9); expect(items.every((t) => t.includes('Done'))).toBe(true);
  const voted = sql(`SELECT count(*) FROM participation.participation WHERE election_id='${E}'`);
  await expect(a1.locator('#summary .stat-card').filter({ hasText: 'Voted online' }).locator('strong')).toHaveText(voted);
  await expect(a1.locator('#summary .stat-card').filter({ hasText: 'Eligible voters' }).locator('strong')).toHaveText('6');
  for (const [name, w, h] of [['mobile', 390, 844], ['desktop', 1440, 1000]] as const) { await a1.setViewportSize({ width: w, height: h }); await axe(a1, `console summary, ${name}`); }
});

test('pause needs a second person: the requester cannot approve; the other administrator can', async () => {
  await go(a1, 'controls'); await go(a2, 'controls');
  await request(a1, /Request: Pause voting/);
  await expect(flash(a1)).toContainText('A different administrator has to approve');
  const mine = a1.locator('#controls').getByText(/Pause voting · requested by Admin One \(you\)/); await expect(mine).toBeVisible();
  await expect(a1.getByText('Waiting for another administrator.')).toBeVisible(); await expect(a1.getByRole('button', { name: /^Approve \S/ })).toHaveCount(0);
  expect(sql(`SELECT paused FROM election.elections WHERE id='${E}'`)).toBe('f');
  await a2.reload(); await expect(a2.locator('#controls').getByText(/Pause voting · requested by Admin One,/)).toBeVisible(); await axe(a2, 'console with a pending approval');
  await approve(a2); await expect(flash(a2)).toContainText('Done: Pause voting'); await expect(pill(a2, 'Paused')).toBeVisible();
  expect(sql(`SELECT paused FROM election.elections WHERE id='${E}'`)).toBe('t');
  expect(await a2.evaluate(async (id) => (await (await fetch(`/api/elections/${id}/info`)).json()).paused, E)).toBe(true);
});

test('declining and withdrawing take a request out of the queue; resume then works with the roles swapped', async () => {
  await a1.reload(); await request(a1, /Request: Resume voting/);
  await a2.reload(); await a2.getByRole('button', { name: /^Decline \S/ }).click(); await expect(flash(a2)).toContainText('declined');
  await expect(a2.getByLabel('Sensitive actions need two').getByText('Nothing is waiting.')).toBeVisible();
  await request(a2, /Request: Resume voting/); await a2.getByRole('button', { name: /^Withdraw \S/ }).click(); await expect(flash(a2)).toContainText('withdrawn');
  expect(sql(`SELECT count(*) FROM admin.approvals WHERE cancelled_at IS NOT NULL AND election_id='${E}'`)).toBe('2');
  await request(a2, /Request: Resume voting/); await a1.reload(); await approve(a1);
  await expect(flash(a1)).toContainText('Done: Resume voting'); expect(sql(`SELECT paused FROM election.elections WHERE id='${E}'`)).toBe('f');
  await expect(a1.getByText(/Resume voting: requested by Admin Two, approved by Admin One/)).toBeVisible();
});

test('extend adds the minutes; an impossible number is refused with a plain message', async () => {
  const before = Number(sql(`SELECT extract(epoch FROM closes_at) FROM election.elections WHERE id='${E}'`));
  await a1.getByRole('button', { name: /Request: Extend voting/ }).click(); await a1.getByLabel(/Minutes to add/).fill('5000'); await a1.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(a1.getByRole('alert')).toContainText('between 1 and 1,440');
  await a1.getByLabel(/Minutes to add/).fill('45'); await a1.getByRole('button', { name: 'Send request', exact: true }).click();
  await a2.reload(); await expect(a2.locator('#controls strong').filter({ hasText: 'Extend voting by 45 minutes' })).toBeVisible(); await approve(a2);
  await expect(flash(a2)).toContainText('Done: Extend voting');
  expect(Number(sql(`SELECT extract(epoch FROM closes_at) FROM election.elections WHERE id='${E}'`)) - before).toBe(45 * 60);
});

test('a freeze is started by one administrator and has to be confirmed by a different one', async () => {
  await a1.reload(); await a1.getByRole('button', { name: 'Freeze voting now' }).click(); await a1.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(pill(a1, 'Frozen')).toBeVisible(); await expect(a1.getByText(/You froze voting/)).toBeVisible();
  await expect(a1.getByRole('button', { name: 'Confirm the freeze' })).toHaveCount(0);            // the one who froze it is never offered the confirmation
  await a2.reload(); await expect(a2.getByText(/Another administrator froze voting/)).toBeVisible();
  await a2.getByRole('button', { name: 'Confirm the freeze' }).click(); await a2.getByRole('button', { name: 'Yes, do it' }).click();
  await expect(a2.getByText(/freeze was confirmed by a second administrator/)).toBeVisible();
  await request(a2, /Request: Lift the freeze/); await a1.reload(); await approve(a1);
  await expect(flash(a1)).toContainText('Done: Lift the freeze'); await expect(pill(a1, 'Frozen')).toHaveCount(0);
  expect(sql(`SELECT frozen FROM election.elections WHERE id='${E}'`)).toBe('f');
});

test('support queue: filing is visible, report addresses are inert text, status and note are saved, claim codes are shown once', async () => {
  await go(a1, 'support'); await a1.reload(); const list = a1.getByRole('list', { name: 'Support requests' });
  await expect(list.locator('> li').first()).toBeVisible();
  await a1.getByLabel('Show kind').selectOption('report');
  await expect(list.locator('> li')).toHaveCount(Number(sql(`SELECT count(*) FROM support.requests WHERE kind='report'`)));
  await expect(list).toContainText('http://ctu-vote.example'); await expect(a1.locator('#support a[href*="ctu-vote.example"]')).toHaveCount(0);   // never a clickable link to a phishing address
  await a1.getByLabel('Show kind').selectOption('dispute');
  await expect(list).toContainText('Account dispute'); await expect(list).not.toContainText('Fake-site report');   // wait for the filtered list before reading from it
  const ref = (await list.locator('> li').first().locator('strong').first().innerText()).trim();
  await a1.getByLabel(`Status of ${ref}`).selectOption('IN_REVIEW'); await a1.getByLabel(`Note for ${ref}`).fill('Called the registrar');
  await a1.getByRole('button', { name: `Save ${ref}` }).click(); await expect(flash(a1)).toContainText(`${ref} saved`);
  expect(sql(`SELECT status || '/' || note FROM support.requests WHERE ref='${ref}'`)).toBe('IN_REVIEW/Called the registrar');
  await a1.getByLabel('Show kind').selectOption(''); await a1.getByLabel('Show status').selectOption('IN_REVIEW'); await expect(list.locator('> li')).toHaveCount(1);
  await axe(a1, 'console support queue'); await a1.getByLabel('Show status').selectOption('');
  await a1.getByLabel('Student ID', { exact: true }).fill('NOBODY'); await a1.getByRole('button', { name: 'Issue claim code' }).click();
  await expect(a1.getByRole('alert').last()).toContainText('No online voter with that Student ID');
  await a1.getByLabel('Student ID', { exact: true }).fill('2026-00002'); await a1.getByRole('button', { name: 'Issue claim code' }).click();
  const code = (await a1.getByText(/Claim code for 2026-00002/).locator('strong').innerText()).trim(); expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  expect(sql(`SELECT disputed FROM identity.accounts a JOIN election.voters v ON v.id=a.voter_id WHERE v.student_id='2026-00002'`)).toBe('t');
  expect(sql(`SELECT count(*) FROM identity.claim_codes WHERE encode(code_hash,'escape') LIKE '%${code.replace('-', '')}%'`)).toBe('0');   // only a hash is stored
  await a1.reload(); await expect(a1.locator('body')).not.toContainText(code);                   // gone for good once the page is left
});

test('closing, the real tally, forged files refused, the genuine import and certification, all through the console', async () => {
  await go(a1, 'controls'); await go(a2, 'controls'); await request(a1, /Request: Close voting/); await a2.reload(); await approve(a2);
  await expect(flash(a2)).toContainText('Done: Close voting'); await expect(pill(a2, 'Closed')).toBeVisible();
  await go(a2, 'results'); const inbox = Number(sql('SELECT count(*) FROM ballots.inbox')); expect(inbox).toBeGreaterThan(0);
  await expect(a2.locator('#results')).toContainText(`${inbox} ballots waiting to be sealed`); await expect(a2.getByText('No ballots in any chain yet.')).toBeVisible();
  expect(await a2.evaluate(async (id) => (await fetch(`/api/elections/${id}/results`)).json(), E)).toEqual({ published: false, status: 'CLOSED' });
  await a2.goto('/results'); await expect(a2.getByRole('heading', { name: /not available yet/i })).toBeVisible();

  // The offline part, with the real tools. First an independent count from the decrypted inbox, to compare with what gets published.
  const dump = JSON.parse(execFileSync('node', ['server/inbox-dump.mjs'], { env: process.env }).toString()) as { selections: { contestId: string; candidateIds: string[]; abstain: boolean }[] }[];
  const title = (id: string) => sql(`SELECT title FROM election.positions WHERE id='${id}'`), cname = (id: string) => sql(`SELECT name FROM election.candidates WHERE id='${id}'`);
  const expected: Record<string, { abstain: number; candidates: Record<string, number> }> = {};
  for (const t of sql(`SELECT title FROM election.positions WHERE election_id='${E}'`).split(/\r?\n/)) expected[t] = { abstain: 0, candidates: Object.fromEntries(sql(`SELECT c.name FROM election.candidates c JOIN election.positions p ON p.id=c.position_id WHERE p.title='${t}'`).split(/\r?\n/).map((n) => [n, 0])) };
  for (const b of dump) for (const s of b.selections) { const t = title(s.contestId); if (s.abstain) expected[t].abstain++; for (const id of s.candidateIds) expected[t].candidates[cname(id)]++; }
  fs.writeFileSync(path.join(os.tmpdir(), 'live-expected.json'), JSON.stringify({ ballots: dump.length, expected }));
  const env = { ...process.env, PGHOST: process.env.PGHOST ?? '/var/run/postgresql', PGUSER: process.env.PGUSER ?? execFileSync('id', ['-un']).toString().trim() }, ev = 'packages/cli/ev.mjs';
  execFileSync('psql', ['-X', '-q', DB, '-c', `CALL ballots.seal('${E}','main',1,true)`]);
  execFileSync('node', [ev, 'export-ballots', '--db', `postgresql:///${DB}`, '--election', E, '--out', `${W}/export.json`], { env });
  execFileSync('node', [ev, 'tally', '--ballots', `${W}/export.json`, '--shares', [1, 3, 5].map((i) => `${W}/share-${i}.txt`).join(','), '--sign', `${W}/signing.key`, '--out', `${W}/results.json`], { env });
  const genuine = fs.readFileSync(`${W}/results.json`, 'utf8'), parsed = JSON.parse(genuine) as { body: string; signature: string };

  await go(a1, 'results'); await a1.reload(); await expect(a1.getByRole('cell', { name: 'Not imported yet' })).toBeVisible(); await expect(a1.getByRole('row', { name: new RegExp(`main ${dump.length}`) })).toBeVisible();
  const file = a1.getByLabel('Results file (results.json)');
  await file.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  await expect(a1.getByRole('alert')).toContainText('not a results file'); await expect(a1.getByRole('button', { name: 'Import tally' })).toBeDisabled();
  const forged = { ...parsed, signature: Buffer.from(Buffer.from(parsed.signature, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') };
  await file.setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(forged)) });
  await expect(a1.getByText(/Ready to import/)).toContainText(`${dump.length} ballots`); await a1.getByRole('button', { name: 'Import tally' }).click();
  await expect(a1.getByRole('alert').last()).toContainText('signature does not match'); expect(sql('SELECT count(*) FROM election.result_sets')).toBe('0');
  const inflated = { ...parsed, body: parsed.body.replace(`"ballots":${dump.length}`, `"ballots":${dump.length + 1}`) };       // wrong count, old signature
  await file.setInputFiles({ name: 'inflated.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(inflated)) }); await a1.getByRole('button', { name: 'Import tally' }).click();
  await expect(a1.getByRole('alert').last()).toContainText('signature does not match'); expect(sql('SELECT count(*) FROM election.result_sets')).toBe('0');

  await file.setInputFiles({ name: 'results.json', mimeType: 'application/json', buffer: Buffer.from(genuine) }); await axe(a1, 'console results import'); await a1.getByRole('button', { name: 'Import tally' }).click();
  await expect(flash(a1)).toContainText(`Tally for chain main imported (${dump.length} ballots)`); await expect(pill(a1, 'Tallied, not yet certified')).toBeVisible();
  await expect(a1.getByRole('cell', { name: 'Imported, matches the chain' })).toBeVisible(); await expect(a1.locator('#results')).toContainText('Ready to certify');
  await file.setInputFiles({ name: 'again.json', mimeType: 'application/json', buffer: Buffer.from(genuine) }); await a1.getByRole('button', { name: 'Import tally' }).click();
  await expect(a1.getByRole('alert').last()).toContainText('already imported');
  await a1.goto('/results'); await expect(a1.getByRole('heading', { name: /not available yet/i })).toBeVisible();   // tallied is still not public

  await a1.goto('/staff#controls'); await request(a1, /Request: Certify the results/); await a2.goto('/staff#controls'); await approve(a2);
  await expect(flash(a2)).toContainText('Done: Certify the results'); await expect(pill(a2, 'Certified')).toBeVisible();
  expect(sql(`SELECT status FROM election.elections WHERE id='${E}'`)).toBe('CERTIFIED');
  await go(a2, 'results'); await expect(a2.getByRole('link', { name: 'See the public results page' })).toBeVisible(); await expect(a2.getByRole('button', { name: /Request/ })).toHaveCount(0);   // nothing left to do
});

test('audit log: the day\'s actions are listed with who did them, and the chain check says intact', async () => {
  await go(a1, 'audit'); await a1.reload(); const sec = a1.locator('#audit');
  await expect(sec.getByRole('heading', { name: 'What was done, and by whom' })).toBeVisible();
  await expect(sec.getByRole('row', { name: /certified/i }).first()).toBeVisible();                 // the certification this very spec performed
  await expect(sec.getByRole('row', { name: /results imported/i }).first()).toContainText('a');   // names the administrator who did it
  expect(sql(`SELECT count(*) FROM ops.audit WHERE action='CERTIFIED' AND election_id='${E}'`)).toBe('1');
  await sec.getByRole('button', { name: 'Check the chain' }).click();
  await expect(sec.getByRole('status')).toContainText(/Chain intact: \d+ entries/);
  await axe(a1, 'console audit log');
});

test('sign out ends the server session, and a copied session cookie is dead', async ({ browser, playwright }) => {
  const ctx = await browser.newContext(), page = await ctx.newPage(); await signIn(page, 'a3', process.env.A3_SECRET!);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('operations');
  const cookies = await ctx.cookies(), header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  await page.getByRole('button', { name: /Sign out/ }).click(); await expect(page).toHaveURL(/\/staff\/login/);
  const req = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4174', extraHTTPHeaders: { cookie: header } });
  expect((await req.get('/api/staff/me')).status()).toBe(401);
  await page.goto('/staff'); await expect(page).toHaveURL(/\/staff\/login/); await ctx.close(); await req.dispose();
});
