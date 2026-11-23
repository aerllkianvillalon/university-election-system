/// <reference lib="dom" />
// What a voter sees on the Results page after the staff spec has certified the election through the console (so the numbers are real, from the real tally).
// The expected counts were made independently by the staff spec from the decrypted ballots, before they were sealed. Runs after it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { rankContest } from '../src/lib/results';

const DB = process.env.LIVE_DB ?? 'evlive', E = process.env.ELECTION_ID ?? '';
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', DB, '-c', q]).toString().trim();
// read lazily: the staff spec writes this file while the suite runs, and Playwright loads every spec file before it starts
const counts = () => JSON.parse(fs.readFileSync('/tmp/live-expected.json', 'utf8')) as { ballots: number; expected: Record<string, { abstain: number; candidates: Record<string, number> }> };
test.describe.configure({ mode: 'serial' });

test('every contest shows exactly the counts made independently from the decrypted ballots, labelled by the tested rule', async ({ page }) => {
  const { ballots, expected } = counts(); await page.goto('/results');
  await expect(page.getByRole('heading', { name: `${ballots} ballots counted` })).toBeVisible();
  let ties = 0, short = 0;
  for (const [title, e] of Object.entries(expected)) {
    const list = Object.entries(e.candidates).map(([name, votes]) => ({ id: name, name, votes })).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const seats = Number(sql(`SELECT seats FROM election.positions WHERE election_id='${E}' AND title='${title}'`)), rank = rankContest(list, seats);
    const card = page.locator('section, div, article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
    const rows = (await card.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(rows, title).toEqual([...rank.rows.map((r) => `${r.name} ${r.votes} ${r.standing}`.trim()), `Abstained ${e.abstain}`]);
    if (rank.tie) ties++; if (rank.short) short++;
    await expect(card.getByText(/Tied for the last seat/)).toHaveCount(rank.tie ? 1 : 0);
  }
  await expect(page.getByText(/Tied for the last seat/)).toHaveCount(ties);
  await expect(page.getByText(/received votes/)).toHaveCount(short);                       // e.g. BSED Rep: nobody from that program voted
  expect(short).toBeGreaterThan(0);                                                        // the real data does exercise the "no votes" path
  await expect(page.locator('main')).not.toContainText(/\bElected\b|Sample archive|Certified outcome/);
  await expect(page.getByRole('button', { name: /archive/i })).toHaveCount(0);
});

test('the public endpoint holds nothing identifying, and the page agrees with it', async ({ page }) => {
  const { ballots } = counts(); await page.goto('/results');
  const raw = await page.evaluate(async (id) => (await fetch(`/api/elections/${id}/results`)).text(), E);
  expect(raw).not.toMatch(/voter|receipt|nonce|email|student/i);
  expect(JSON.parse(raw)).toMatchObject({ published: true, status: 'CERTIFIED', ballots });
});

test('anyone can verify the published tally offline, using only what the page shows', async ({ page }) => {
  await page.goto('/results'); await page.getByText('How to check these counts').click();
  const fp = sql(`SELECT left(encode(sha256(signing_key),'hex'),16) FROM election.elections WHERE id='${E}'`);
  await expect(page.locator('details')).toContainText(fp);
  const key = (await page.getByLabel('Signing key', { exact: true }).innerText()).trim(), tally = (await page.getByLabel('Signed tally for chain main').innerText()).trim();
  fs.writeFileSync('/tmp/live-pub-key.txt', key); fs.writeFileSync('/tmp/live-pub-tally.json', tally);
  const env = { ...process.env }; const run = (file: string) => { try { execFileSync('node', ['packages/cli/ev.mjs', 'verify-results', '--results', file, '--pub', '/tmp/live-pub-key.txt'], { env, stdio: 'pipe' }); return 0; } catch { return 1; } };
  expect(run('/tmp/live-pub-tally.json')).toBe(0);                                         // the genuine published copy verifies
  const t = JSON.parse(tally) as { body: string; signature: string }; fs.writeFileSync('/tmp/live-pub-bad.json', JSON.stringify({ ...t, body: t.body.replace(/"ballots":\d+/, '"ballots":999') }));
  expect(run('/tmp/live-pub-bad.json')).toBe(1);                                           // a doctored copy does not
});

for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
  test(`axe (WCAG 2.1 A/AA) on the certified results page, ${vp.name}`, async ({ page }) => {
    const { ballots } = counts(); await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/results'); await page.getByText('How to check these counts').click();
    await expect(page.getByRole('heading', { name: `${ballots} ballots counted` })).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations, JSON.stringify(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
  });
}
