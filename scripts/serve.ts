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
 * Windows only: `npm.cmd` is a batch file, and since the CVE-2024-27980 fix (Node
 * 18.20.2 / 20.12.2 / 22) `spawn` **refuses** to run one without a shell — it fails
 * `EINVAL` before the command exists, so every `npm` step here dies instantly and the
 * upgrade always lands on `source-moved` with the previous cockpit. Only `npm` needs
 * this; `git` is a real executable. Every argument passed under it is a literal from
 * this file, never operator input, so there is nothing for `cmd.exe` to reinterpret.
 */
const NPM_SPAWN_OPTIONS = { shell: process.platform === 'win32' } as const;

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
 * A failure at the pull leaves the old build in place and starts it again — the
 * recoverable direction, the fleet comes back on the code it went down on. Past the
 * pull the source has already moved and there is no way back to it here, so the
 * relaunch says loudly which half it got, and the reason is always on screen.
 */
function applyUpdate(): Outcome {
  // Recorded *before* the pull: it is the only baseline that can answer what the
  // pull changed, and asking afterwards would compare HEAD with itself.
  const before = currentHead();
  if (!step('git pull --ff-only', 'git', ['pull', '--ff-only'])) return 'unchanged';
  // The dependency tree, and only when the lockfile actually moved — `npm ci` is a
  // full delete-and-rebuild of two native modules, which would otherwise be a
  // minute added to every upgrade that touched no dependency.
  if (lockfileChanged(before) && !step('npm ci', NPM, ['ci'], NPM_SPAWN_OPTIONS)) return 'source-moved';
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
  if (step('npm run web:build', NPM, ['run', 'web:build'], NPM_SPAWN_OPTIONS)) return 'applied';
  // The one retry in here, and it is not optimism about a flake. Nearly every way this
  // step fails on a machine that was serving a moment ago is `node_modules` not matching
  // the tree that was just pulled — a dev dependency the bundle newly needs, a native
  // module built against another Node, an install the *previous* upgrade left half
  // applied — and all of them are the install the lockfile gate above decided to skip.
  // Running it now costs a minute on the one path that is already broken, and the
  // alternative is coming back on a cockpit bundle nothing says is stale.
  console.log('[serve] the cockpit build failed — reinstalling dependencies and trying it once more');
  if (!step('npm ci', NPM, ['ci'], NPM_SPAWN_OPTIONS)) return 'source-moved';
  return step('npm run web:build', NPM, ['run', 'web:build'], NPM_SPAWN_OPTIONS) ? 'applied' : 'source-moved';
}

/**
 * How far the update got, because "it failed" is two different situations to come back
 * from and only one of them is the recoverable one the spec promises.
 *
 * `unchanged` is the pull refusing: the checkout is on the commit it went down on, so
 * the relaunch is genuinely the previous build. Past that the source **has** moved, and
 * saying "unchanged" there is a lie the operator acts on — the fleet comes back running
 * new server code behind whatever `web/dist` happened to be lying around, which is the
 * stale-cockpit failure this feature exists to avoid.
 */
type Outcome = 'applied' | 'source-moved' | 'unchanged';

/** What a step needs beyond `stdio: 'inherit'` — today only the Windows shell above. */
type StepOptions = { shell?: boolean };

/** One command, with its failure reported in the terms the operator will act on. */
function step(label: string, command: string, args: string[], options: StepOptions = {}): boolean {
  console.log(`[serve] ${label}`);
  const run: SpawnSyncReturns<Buffer> = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (run.status === 0) return true;
  // `spawnSync` reports a command that never *started* — npm off the PATH, a fork the
  // kernel refused, the OOM killer — as a null status **and** a null signal, with the
  // reason only on `error`. Dropped, it prints as `failed (null)`: the operator is told
  // an upgrade failed and given nothing whatsoever to act on, which is the state this
  // line was in.
  console.error(`[serve] ${label} failed (${describeFailure(run)})`);
  return false;
}

/** Why the command did not succeed, in whichever of the three ways `spawnSync` says it. */
function describeFailure(run: SpawnSyncReturns<Buffer>): string {
  if (run.error) return run.error.message;
  if (run.signal) return `killed by ${run.signal}`;
  return `exit ${run.status ?? 'unknown'}`;
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
    const outcome = applyUpdate();
    if (outcome === 'unchanged') console.log('[serve] the update was not applied; the build is unchanged');
    if (outcome === 'source-moved') {
      console.error(
        '[serve] the update was pulled but the cockpit bundle could not be rebuilt — the server is ' +
          'restarting on the new code with the PREVIOUS cockpit. Run `npm ci && npm run web:build` here ' +
          'and restart once the reason above is fixed.',
      );
    }
    console.log('[serve] restarting');
  }
}

main().catch((err: Error) => {
  console.error('[serve] fatal:', err);
  process.exit(1);
});
