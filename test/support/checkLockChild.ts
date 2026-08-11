/**
 * A separate *process* that takes the check lock, so the lock's tests exercise the
 * only thing it is for: two `npm run check` invocations that share nothing but a
 * filesystem. An in-process test of the helper would pass against an implementation
 * that is not a lock at all.
 *
 * argv: <lockPath> <logPath> <holdMs>   (holdMs < 0 holds until signalled)
 */
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
// stdout is the test's synchronisation point: it means the lock is held *now*.
process.stdout.write('acquired\n');

if (holdMs < 0) {
  // Held until the test signals or kills us; the timer just keeps the loop alive.
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  appendFileSync(logPath, `exit ${process.pid}\n`);
  lock.release();
}
