// pnpm doctor — checks everything the app needs, in plain words.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, PORTS, WIN, findBash, findPgBin, findPgPort, canLogin, getPassword, portFree, nodeMajor, ok, bad } from './lib.mjs';

let problems = 0;
const fail = (m, f) => { problems++; bad(m, f); };
console.log('\nChecking this computer…\n');

nodeMajor() >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} is too old`, 'Install Node 20 or newer from nodejs.org');
existsSync(path.join(ROOT, 'node_modules')) ? ok('Website packages installed') : fail('Website packages are missing', 'Run: pnpm install');
existsSync(path.join(ROOT, 'server', 'node_modules')) ? ok('Server packages installed') : fail('Server packages are missing', 'Run: cd server && pnpm install   (then cd ..)');
existsSync(path.join(ROOT, 'src/lib/api/mock-data.ts')) ? fail('An old file is left over: src/lib/api/mock-data.ts', 'Delete it: rm src/lib/api/mock-data.ts') : ok('No leftover files from older versions');

const bash = findBash();
bash ? ok('bash found' + (WIN ? ` (${bash})` : '')) : fail('Git Bash was not found', 'Install Git for Windows from git-scm.com');

const pgBin = findPgBin();
if (!pgBin) fail('PostgreSQL was not found', 'Install PostgreSQL 16 or newer from postgresql.org/download/windows');
else {
  ok(`PostgreSQL tools found (${pgBin})`);
  const port = findPgPort(pgBin);
  if (!port) fail('PostgreSQL is installed but not running', WIN ? 'Open Services, start "postgresql-x64-18" (or your version)' : 'Start the PostgreSQL service');
  else {
    ok(`PostgreSQL is running on port ${port}`);
    const pw = await getPassword(pgBin, port, { interactive: false });
    pw !== null ? ok('PostgreSQL password works') : fail('PostgreSQL password is not saved yet', 'Run: pnpm start   (it will ask once and remember)');
  }
}
for (const [name, p] of Object.entries(PORTS)) {
  (await portFree(p)) ? ok(`Port ${p} is free for the ${name}`) : fail(`Port ${p} is already in use`, WIN ? 'Run: taskkill //F //IM node.exe   (closes old copies), or run: pnpm stop' : 'Run: pnpm stop');
}
console.log(problems ? `\n${problems} thing(s) to fix. Fix them, then run: pnpm doctor again.\n` : '\nAll good. Run: pnpm start\n');
process.exit(problems ? 1 : 0);
