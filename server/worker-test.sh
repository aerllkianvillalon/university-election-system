#!/usr/bin/env bash
# Lab worker: min-batch/max-wait sealing, clock-jump freeze, tamper freeze. Injected clocks make the faults deterministic.
set -u; DB=evworker; E=aaaaaaaa-0000-4000-8000-000000000001; dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in 0001_core 0002_identity 0003_contests 0004_hardening 0005_admin_lifecycle 0006_least_privilege 0007_lab 0008_sync; do psql -X -q -v ON_ERROR_STOP=1 $DB -f db/migrations/shared/$f.sql >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
psql -X -q $DB << 'SQL'
INSERT INTO org.organizations(id,slug,name) VALUES ('cccccccc-0000-4000-8000-000000000001','wkorg','Worker Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','OPEN',now()-interval '1h',now()+interval '1h');
INSERT INTO ballots.inbox(election_id,round,receipt,ciphertext) SELECT 'aaaaaaaa-0000-4000-8000-000000000001',1,'\x00',gen_random_bytes(64) FROM generate_series(1,3);
SQL
export DBU=$(whoami); node --input-type=module << 'JS'
import { tick } from './apps/lab-worker/worker.mjs'; import pg from './apps/lab-worker/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgresql://' + process.env.DBU + '@/evworker?host=/var/run/postgresql' }); const E = 'aaaaaaaa-0000-4000-8000-000000000001';
let w = 1_000_000, m = 0; const ctx = { pool, election: E, chain: 'lab-1', minBatch: 5, maxWaitMs: 60000, wall: () => w, mono: () => m, state: {} };
const q = async (s) => (await pool.query(s)).rows[0]; const ok = (c, msg) => console.log((c ? 'PASS ' : 'FAIL ') + msg);
await tick(ctx); ok(+(await q('select count(*) from ballots.ballots')).count === 0, 'below min batch: nothing sealed yet');
w += 61000; m += 61000; await tick(ctx); ok(+(await q('select count(*) from ballots.ballots')).count === 3 && +(await q('select count(*) from ballots.inbox')).count === 0, 'max wait reached: inbox flushed, 3 sealed');
ok(!(await q(`select frozen from election.elections where id='${E}'`)).frozen, 'healthy lab is not frozen');
w += 3_600_000; m += 1000; await tick(ctx); ok((await q(`select frozen from election.elections where id='${E}'`)).frozen && (await q("select count(*) from ops.incidents where kind='CLOCK_FAULT'")).count === '1', 'clock jump forward freezes the lab and logs an incident');
await pool.query(`update election.elections set frozen=false`); w -= 7_200_000; m += 1000; await tick(ctx); ok((await q("select count(*) from ops.incidents where kind='CLOCK_FAULT'")).count === '2', 'clock jump backward is caught too');
await pool.query(`update election.elections set frozen=false`); w += 1000; m += 1000; await tick(ctx);
await pool.query('alter table ballots.ballots disable trigger ballots_no_ud'); await pool.query("update ballots.ballots set ciphertext='\\x00' where seq=2"); await pool.query('alter table ballots.ballots enable trigger ballots_no_ud');
w += 1000; m += 1000; await tick(ctx); ok((await q(`select frozen from election.elections where id='${E}'`)).frozen && (await q("select count(*) from ops.incidents where kind='CHAIN_FAILURE'")).count === '1', 'tampered ballot is detected and freezes the lab');
await pool.end();
JS
