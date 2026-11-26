// Shared helpers for start / stop / doctor. Plain Node, no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WIN = process.platform === 'win32';
const CFG = path.join(ROOT, '.dev-db.json');
export const PORTS = { web: 3000, api: 3001 };

export function readCfg() { try { return JSON.parse(readFileSync(CFG, 'utf8')); } catch { return {}; } }
export function saveCfg(c) { writeFileSync(CFG, JSON.stringify(c, null, 2)); }

/** Find a bash that is NOT the WSL stub. On Windows that means Git's bash.exe. */
export function findBash() {
  if (!WIN) return 'bash';
  const cands = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  return cands.find(existsSync) || null;
}

/** Directory holding psql and pg_isready. PATH first, then the usual install folders, newest version first. */
export function findPgBin() {
  const exe = WIN ? '.exe' : '';
  const dirs = [];
  if (process.env.PG_BIN) dirs.push(process.env.PG_BIN);
  const base = WIN ? (process.env.ProgramFiles || 'C:\\Program Files') + '\\PostgreSQL' : '/usr/lib/postgresql';
  try {
    const vs = readdirSync(base).filter((v) => /^\d+/.test(v)).sort((a, b) => parseInt(b) - parseInt(a));
    for (const v of vs) dirs.push(path.join(base, v, 'bin'));
  } catch { /* none */ }
  for (const d of dirs) if (existsSync(path.join(d, 'psql' + exe))) return d;
  const r = spawnSync(WIN ? 'where' : 'which', ['psql'], { encoding: 'utf8' });
  if (r.status === 0) return path.dirname(r.stdout.split(/\r?\n/)[0].trim());
  return null;
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

export function pgEnv(pgBin, port, password) {
  const sep = WIN ? ';' : ':';
  return {
    ...process.env,
    PATH: (pgBin ? pgBin + sep : '') + process.env.PATH,
    PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGPASSWORD: password || '',
  };
}

/** Which port is PostgreSQL answering on? */
export function findPgPort(pgBin) {
  const exe = pgBin && path.join(pgBin, 'pg_isready' + (WIN ? '.exe' : ''));
  const want = [process.env.PGPORT, readCfg().port, 5433, 5432, 5434].filter(Boolean).map(Number);
  for (const p of [...new Set(want)]) {
    const r = run(exe || 'pg_isready', ['-h', '127.0.0.1', '-p', String(p)]);
    if (r.status === 0) return p;
  }
  return null;
}

export function canLogin(pgBin, port, password) {
  const r = run(path.join(pgBin, 'psql' + (WIN ? '.exe' : '')), ['-X', '-tA', '-c', 'select 1'], { env: pgEnv(pgBin, port, password) });
  return r.status === 0;
}

export function ask(q, hidden = false) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

/** Password: env, then saved file, then ask once and remember. Returns null when nothing works. */
export async function getPassword(pgBin, port, { interactive = true } = {}) {
  const tried = [];
  for (const p of [process.env.PGPASSWORD, readCfg().password]) {
    if (p === undefined || tried.includes(p)) continue;
    tried.push(p);
    if (canLogin(pgBin, port, p)) return p;
  }
  if (!interactive) return null;
  for (let i = 0; i < 3; i++) {
    const p = await ask(`PostgreSQL password for user "postgres" (port ${port}): `);
    if (canLogin(pgBin, port, p)) { saveCfg({ ...readCfg(), port, password: p }); console.log('  Saved to .dev-db.json (kept on this computer only).'); return p; }
    console.log('  That did not work. Try again.');
  }
  return null;
}

export function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '0.0.0.0');
  });
}

export function nodeMajor() { return parseInt(process.versions.node, 10); }
export const ok = (m) => console.log('  ✓ ' + m);
export const bad = (m, fix) => { console.log('  ✗ ' + m); if (fix) console.log('      → ' + fix); };
