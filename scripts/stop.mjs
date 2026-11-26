// pnpm stop — shuts down the API and website started by pnpm start.
import { ROOT, WIN, findBash, run } from './lib.mjs';
const bash = findBash();
if (bash) run(bash, ['server/live-dev.sh', 'down'], { cwd: ROOT });
for (const port of [3000, 3001]) {
  if (WIN) {
    const out = run('netstat', ['-ano']).stdout || '';
    const pids = new Set(out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && /LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).pop()));
    for (const pid of pids) if (pid && pid !== '0') run('taskkill', ['/PID', pid, '/T', '/F']);
  } else run('sh', ['-c', `fuser -k ${port}/tcp 2>/dev/null || true`]);
}
console.log('Stopped. (Your database and its data are untouched.)');
