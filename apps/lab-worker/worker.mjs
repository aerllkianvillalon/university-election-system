// Lab worker: sealer loop (min batch / max wait), chain verifier, clock-integrity heartbeat. Any fault freezes the lab and logs an incident.
import pg from 'pg'; import { pathToFileURL } from 'node:url';
const DRIFT_MS = 5000;
export async function tick(ctx) {   // ctx: {pool, election, chain, minBatch, maxWaitMs, wall(), mono(), state}
  const { pool, election: E, chain, state } = ctx; const wall = ctx.wall(), mono = ctx.mono();
  const freeze = async (kind, detail) => { await pool.query('SELECT ops.freeze_for_incident($1,$2,$3)', [E, kind, detail]); state.frozenBy = kind; };
  if (state.lastWall !== undefined) { const dw = wall - state.lastWall, dm = mono - state.lastMono;       // wall clock must advance like the monotonic clock
    if (dw < 0 || Math.abs(dw - dm) > DRIFT_MS) await freeze('CLOCK_FAULT', `wall moved ${dw} ms while monotonic moved ${dm} ms`); }
  state.lastWall = wall; state.lastMono = mono;
  const inbox = +(await pool.query('SELECT count(*) FROM ballots.inbox WHERE election_id=$1', [E])).rows[0].count;
  if (inbox === 0) state.firstSeen = undefined; else if (state.firstSeen === undefined) state.firstSeen = mono;
  if (inbox > 0) { const flush = mono - state.firstSeen >= ctx.maxWaitMs; await pool.query('CALL ballots.seal($1,$2,$3,$4)', [E, chain, ctx.minBatch, flush]); }
  const bad = +(await pool.query('SELECT ballots.verify_chain($1,$2) AS n', [E, chain])).rows[0].n;
  if (bad > 0) await freeze('CHAIN_FAILURE', `${bad} broken link(s) in ${chain}`);
  return { inbox, bad };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); const state = {};
  const ctx = { pool, election: process.env.ELECTION_ID, chain: process.env.CHAIN_ID, minBatch: +(process.env.SEAL_MIN_BATCH || 5), maxWaitMs: +(process.env.SEAL_MAX_WAIT_MS || 600000),
    wall: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), state };
  setInterval(() => tick(ctx).catch((e) => console.error('tick failed', e.message)), +(process.env.TICK_MS || 10000)); console.log('lab-worker running');
}
