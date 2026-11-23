// node --test tests/results-rank.test.ts   (Node 22 runs TypeScript directly)
import test from 'node:test'; import assert from 'node:assert/strict';
import { rankContest } from '../src/lib/results.ts';
const L = (...v: number[]) => v.map((votes, i) => ({ id: String(i), name: `C${i + 1}`, votes }));
const standings = (v: number[], seats: number) => rankContest(L(...v), seats).rows.map((r) => r.standing);

test('one seat, clear leader', () => { const r = rankContest(L(5, 3, 1), 1); assert.deepEqual([r.tie, r.short], [false, false]); assert.deepEqual(standings([5, 3, 1], 1), ['Highest votes', '', '']); });
test('one seat, tie for first: both tied, neither marked highest', () => { const r = rankContest(L(3, 3, 1), 1); assert.equal(r.tie, true); assert.deepEqual(standings([3, 3, 1], 1), ['Tied', 'Tied', '']); });
test('a tie among three for one seat marks all three', () => assert.deepEqual(standings([2, 2, 2], 1), ['Tied', 'Tied', 'Tied']));
test('two seats, clear top two', () => { const r = rankContest(L(5, 4, 1), 2); assert.equal(r.tie, false); assert.deepEqual(standings([5, 4, 1], 2), ['Highest votes', 'Highest votes', '']); });
test('two seats, tie for the last seat: the leader stays highest, the tied pair is tied', () => { const r = rankContest(L(5, 3, 3), 2); assert.equal(r.tie, true); assert.deepEqual(standings([5, 3, 3], 2), ['Highest votes', 'Tied', 'Tied']); });
test('two seats, tie for FIRST place that does not reach the cutoff is not a tie for a seat', () => { const r = rankContest(L(4, 4, 1), 2); assert.equal(r.tie, false); assert.deepEqual(standings([4, 4, 1], 2), ['Highest votes', 'Highest votes', '']); });
test('everyone on zero: no tie, no highest, and flagged as short', () => { const r = rankContest(L(0, 0), 1); assert.deepEqual([r.tie, r.short], [false, true]); assert.deepEqual(standings([0, 0], 1), ['', '']); });
test('fewer candidates with votes than seats: short, and a zero-vote candidate is never "highest"', () => { const r = rankContest(L(3, 0, 0), 2); assert.deepEqual([r.tie, r.short], [false, true]); assert.deepEqual(standings([3, 0, 0], 2), ['Highest votes', '', '']); });
test('as many candidates as seats: nobody can be tied out of a seat', () => { const r = rankContest(L(2, 2), 2); assert.equal(r.tie, false); assert.deepEqual(standings([2, 2], 2), ['Highest votes', 'Highest votes']); });
test('a single candidate, unopposed, with votes', () => { const r = rankContest(L(7), 1); assert.deepEqual([r.tie, r.short], [false, false]); assert.deepEqual(standings([7], 1), ['Highest votes']); });
test('a single candidate with no votes', () => { const r = rankContest(L(0), 1); assert.deepEqual([r.tie, r.short], [false, true]); });
test('empty list', () => { const r = rankContest([], 1); assert.deepEqual([r.tie, r.short, r.rows], [false, true, []]); });
test('the input is not modified', () => { const input = L(3, 3); const copy = JSON.stringify(input); rankContest(input, 1); assert.equal(JSON.stringify(input), copy); });
