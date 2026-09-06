import { appendFileSync } from 'node:fs';

import { acquireCheckLock } from '../../scripts/checkLock.js';

const [lockPath, logPath, holdRaw] = process.argv.slice(2);
if (lockPath === undefined || logPath === undefined || holdRaw === undefined) {
  throw new Error('usage: checkLockChild <lockPath> <logPath> <holdMs>');
}
const holdMs = Number(holdRaw);

const lock = await acquireCheckLock({
  path: lockPath,
  pollMs: 25,
  onWait: (holder) => process.stderr.write(`waiting ${holder.pid}\n`),
});

appendFileSync(logPath, `enter ${process.pid}\n`);
process.stdout.write('acquired\n');

if (holdMs < 0) {
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  appendFileSync(logPath, `exit ${process.pid}\n`);
  lock.release();
}
