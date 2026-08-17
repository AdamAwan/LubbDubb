/**
 * `npm run serve` — the server, with something in front of it that can replace it.
 *
 * **Why the app cannot do this itself.** Applying an update means `git pull`, then
 * `npm ci`, then rebuilding the cockpit bundle. `npm ci` deletes and rebuilds
 * `node_modules` — including two native modules (`better-sqlite3`, `node-pty`) the
 * running process has open. It also means releasing the port, the SQLite handle and
 * the MCP socket before the replacement claims them. None of that can be done by the process being replaced;
 * on Windows it cannot even be attempted, since the files are locked. So the split
 * is: the server decides *whether* to upgrade and gets the fleet to a safe place,
 * exits {@link UPGRADE_EXIT_CODE}, and everything that has to happen while it is
 * dead happens here.
 *
 * This is deliberately the whole of it. It is not a process manager — it does not
 * restart on a crash, and it should not: a server that fell over for an unrelated
 * reason coming back with its agents auto-restored is a loop nobody is watching.
 * Only the one distinguished code relaunches; every other exit is passed straight
 * out, so `npm run serve` under systemd, NSSM or a terminal behaves exactly as
 * `npm run start:server` does today.
 *
 * A deployment that does not want this can go on running `start:server`. The
 * cockpit reads {@link SUPERVISOR_ENV} and, absent it, prints the commands instead
 * of offering the button — the feature degrades to a notification, which is what it
 * was before the button existed.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { UPGRADE_EXIT_CODE } from '../src/selfUpdate/handoff.js';

/** Announces to the child that a relaunch is available. Read by `UpdateDesk`. */
const SUPERVISOR_ENV = 'LUBBDUBB_SUPERVISOR';

/** `npm` is a shell script on POSIX and a `.cmd` on Windows, which `spawn` needs told. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The update, applied between two dead processes.
 *
 * `--ff-only` is the whole safety argument: it refuses rather than merges, so a
 * checkout that has diverged — a local commit, a half-finished cherry-pick, a
 * branch someone left on — stops here instead of being resolved by a script with
 * nobody watching. The cockpit refuses to offer an upgrade in that state too
 * (`upgradability`), so reaching this is already the unlikely case of upstream or
 * the working tree moving between the click and the exit; it just must not be the
 * case that *silently* does something.
 *
 * A failure at any step leaves the old build in place and starts it again. That is
 * the recoverable direction: the fleet comes back on the code it went down on, and
 * the reason is on screen.
 */
function applyUpdate(): boolean {
  // Recorded *before* the pull: it is the only baseline that can answer what the
  // pull changed, and asking afterwards would compare HEAD with itself.
  const before = currentHead();
  if (!step('git pull --ff-only', 'git', ['pull', '--ff-only'])) return false;
  // The dependency tree, and only when the lockfile actually moved — `npm ci` is a
  // full delete-and-rebuild of two native modules, which would otherwise be a
  // minute added to every upgrade that touched no dependency.
  if (lockfileChanged(before) && !step('npm ci', NPM, ['ci'])) return false;
  // **Unconditional, unlike the install above.** The server needs no build step —
  // tsx runs it from source — but the cockpit does, `web/dist` is gitignored, and
  // the server serves whatever is there on an `existsSync` check with no version
  // stamp and no comparison against `web/src`
  // ([19](../docs/spec/19-development.md#scripts)). So an upgrade that skipped this
  // would leave the operator on the *previous* cockpit with nothing anywhere saying
  // so — the one failure this whole feature must not introduce, since the reason
  // they upgraded is usually something they expect to see.
  //
  // It is not gated on `web/` having changed the way the install is gated on the
  // lockfile. The bundle is a build artifact of the whole tree, the check to decide
  // would be a second opinion about what Vite reads, and being wrong about it is
  // silent. Seconds on an operation that already stopped the fleet is the right
  // trade for never being wrong here.
  return step('npm run web:build', NPM, ['run', 'web:build']);
}

/** One command, with its failure reported in the terms the operator will act on. */
function step(label: string, command: string, args: string[]): boolean {
  console.log(`[serve] ${label}`);
  const run: SpawnSyncReturns<Buffer> = spawnSync(command, args, { stdio: 'inherit' });
  if (run.status === 0) return true;
  console.error(`[serve] ${label} failed (${run.status ?? run.signal}); starting the previous build again`);
  return false;
}

/**
 * Did the pull move the lockfile? Both arms of "cannot tell" — no baseline, or a
 * diff that itself failed — take the slow, safe answer: installing dependencies
 * that were already installed costs a minute, and skipping ones that were not
 * costs a server that will not boot.
 */
function lockfileChanged(before: string | null): boolean {
  if (!before) return true;
  const diff = spawnSync('git', ['diff', '--name-only', before, 'HEAD', '--', 'package-lock.json'], {
    encoding: 'utf8',
  });
  return diff.status !== 0 || diff.stdout.trim().length > 0;
}

function currentHead(): string | null {
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return rev.status === 0 ? rev.stdout.trim() : null;
}

/**
 * Run the server once, and resolve with how it ended.
 *
 * Signals are forwarded rather than handled: the server's own SIGINT handler is
 * what interrupts the fleet cleanly, so this must not race it by exiting first.
 * The listeners are removed on every settle — a long-lived supervisor that added a
 * pair per launch would leak them, and Node warns at ten.
 */
function runServer(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, [SUPERVISOR_ENV]: '1' },
  });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve({ code, signal });
    });
  });
}

async function main(): Promise<void> {
  for (;;) {
    const { code, signal } = await runServer();
    if (code !== UPGRADE_EXIT_CODE) {
      // Every other ending is the server's, including a crash: pass it out whole so
      // whatever is watching *this* process sees what actually happened.
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    }
    console.log('[serve] the cockpit asked for an upgrade — applying it now');
    if (!applyUpdate()) console.log('[serve] the build is unchanged');
    console.log('[serve] restarting');
  }
}

main().catch((err: Error) => {
  console.error('[serve] fatal:', err);
  process.exit(1);
});
