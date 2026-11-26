// pnpm start — database, API and website in one command. Ctrl+C stops everything.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, PORTS, WIN, findBash, findPgBin, findPgPort, getPassword, pgEnv, portFree, run, ok } from './lib.mjs';

const die = (m) => { console.error('\n' + m + '\nFor a full check-up run: pnpm doctor\n'); process.exit(1); };

const bash = findBash() || die('Git Bash was not found. Install Git for Windows (git-scm.com), then try again.');
const pgBin = findPgBin() || die('PostgreSQL was not found. Install it from postgresql.org/download/windows, then try again.');
const port = findPgPort(pgBin) || die('PostgreSQL is not running. Start its service (Services → postgresql-x64-…), then try again.');
const pw = await getPassword(pgBin, port) ?? die('Could not sign in to PostgreSQL.');
ok(`PostgreSQL on port ${port}`);

// Close an old copy of ourselves first, so the ports are free.
run(bash, [path.join(ROOT, 'server/live-dev.sh'), 'down'], { cwd: ROOT, env: pgEnv(pgBin, port, pw) });
for (const p of Object.values(PORTS)) if (!(await portFree(p))) die(`Port ${p} is busy. Run: pnpm stop   (or close the other window using it).`);

const env = pgEnv(pgBin, port, pw);
console.log('Setting up the test election and starting the API (about 20 seconds)…');
const up = spawn(bash, ['server/live-dev.sh', 'up'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((r) => up.on('exit', r));
if (code !== 0) die('The API did not start. The message above says why.');

const idRun = run(bash, ['-c', '. /tmp/live.env; printf %s "$ELECTION_ID"'], { env });
const electionId = idRun.stdout.trim();
if (!electionId) die('Could not read the election id from /tmp/live.env.');

const vite = spawn(WIN ? 'pnpm.cmd' : 'pnpm', ['dev'], { cwd: ROOT, shell: WIN, stdio: 'inherit', env: { ...env, VITE_ELECTION_ID: electionId } });

let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  console.log('\nStopping…');
  run(bash, ['server/live-dev.sh', 'down'], { cwd: ROOT, env });
  if (WIN && vite.pid) run('taskkill', ['/PID', String(vite.pid), '/T', '/F']); else vite.kill();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop); vite.on('exit', stop);

setTimeout(() => console.log(`
  ┌───────────────────────────────────────────────────────┐
  │  Open:   http://localhost:${PORTS.web}                          │
  │  Staff:  http://localhost:${PORTS.web}/staff                    │
  │                                                       │
  │  Test voters   2026-00001 … 2026-00005                │
  │  Voucher codes DEMO-1 … DEMO-5                        │
  │  Staff users   a1  a2  a3  p1                         │
  │  Staff password  staff-pass-123                       │
  │  6-digit code  run in a second window:  pnpm code     │
  │                                                       │
  │  Stop everything: press Ctrl+C in this window         │
  └───────────────────────────────────────────────────────┘
`), 2500);
