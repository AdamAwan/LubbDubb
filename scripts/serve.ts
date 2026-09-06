import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { UPGRADE_EXIT_CODE } from '../src/selfUpdate/handoff.js';

const SUPERVISOR_ENV = 'LUBBDUBB_SUPERVISOR';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const NPM_SPAWN_OPTIONS = { shell: process.platform === 'win32' } as const;

function applyUpdate(): Outcome {
  const before = currentHead();
  if (!step('git pull --ff-only', 'git', ['pull', '--ff-only'])) return 'unchanged';
  if (lockfileChanged(before) && !installDependencies()) return 'source-moved';
  if (step('npm run web:build', NPM, ['run', 'web:build'], NPM_SPAWN_OPTIONS)) return 'applied';
  console.log('[serve] the cockpit build failed — reinstalling dependencies and trying it once more');
  if (!installDependencies()) return 'source-moved';
  return step('npm run web:build', NPM, ['run', 'web:build'], NPM_SPAWN_OPTIONS) ? 'applied' : 'source-moved';
}

type Outcome = 'applied' | 'source-moved' | 'unchanged';

type StepOptions = { shell?: boolean };

function step(label: string, command: string, args: string[], options: StepOptions = {}): boolean {
  console.log(`[serve] ${label}`);
  const run: SpawnSyncReturns<Buffer> = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (run.status === 0) return true;
  console.error(`[serve] ${label} failed (${describeFailure(run)})`);
  return false;
}

function describeFailure(run: SpawnSyncReturns<Buffer>): string {
  if (run.error) return run.error.message;
  if (run.signal) return `killed by ${run.signal}`;
  return `exit ${run.status ?? 'unknown'}`;
}

function installDependencies(): boolean {
  if (step('npm ci', NPM, ['ci'], NPM_SPAWN_OPTIONS)) return true;
  console.log('[serve] npm ci failed — repairing the dependency tree with npm install instead');
  return step('npm install', NPM, ['install'], NPM_SPAWN_OPTIONS);
}

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

function dependenciesUsable(): boolean {
  return existsSync(new URL('../node_modules/tsx/package.json', import.meta.url));
}

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
    if (!dependenciesUsable()) {
      console.error(
        '[serve] node_modules has no `tsx`, so the server cannot be started — the install above left ' +
          'the dependency tree incomplete. Fix the reason it failed (on Windows this is usually a file ' +
          'still held open: `taskkill /f /im esbuild.exe`), then run `npm ci && npm run web:build` here ' +
          'and start again with `npm run serve`.',
      );
      process.exit(1);
    }
    console.log('[serve] restarting');
  }
}

main().catch((err: Error) => {
  console.error('[serve] fatal:', err);
  process.exit(1);
});
