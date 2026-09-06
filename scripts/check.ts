import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireCheckLock, resolveCoreBudget } from './checkLock.js';

interface Stage {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly weight: number;
}

interface Result {
  readonly stage: Stage;
  readonly ok: boolean;
  readonly ms: number;
  readonly output: string;
}

const CORES = resolveCoreBudget(process.env, availableParallelism());

const TEST_WORKERS = Math.max(1, availableParallelism() - 1);

const LOCK_PATH = join(tmpdir(), 'lubbdubb-check.lock');

const STAGES: readonly Stage[] = [
  { name: 'test', command: 'npm', args: ['run', '--silent', 'test'], weight: TEST_WORKERS },
  { name: 'knip', command: 'npm', args: ['run', '--silent', 'knip'], weight: 1 },
  { name: 'typecheck', command: 'npm', args: ['run', '--silent', 'typecheck'], weight: 1 },
  { name: 'typecheck:web', command: 'npm', args: ['run', '--silent', 'typecheck:web'], weight: 1 },
  { name: 'lint', command: 'npm', args: ['run', '--silent', 'lint'], weight: 1 },
  { name: 'format:check', command: 'npm', args: ['run', '--silent', 'format:check'], weight: 1 },
];

const run = (stage: Stage): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(stage.command, [...stage.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    const settle = (ok: boolean): void => resolve({ stage, ok, ms: Date.now() - started, output });
    child.on('error', (err) => {
      output += `${err.message}\n`;
      settle(false);
    });
    child.on('close', (code) => settle(code === 0));
  });

async function runAll(stages: readonly Stage[]): Promise<Result[]> {
  const queue = [...stages].sort((a, b) => b.weight - a.weight);
  const results: Result[] = [];
  const inFlight = new Set<Promise<Result>>();
  let load = 0;

  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0) {
      const next = queue[0]!;
      if (inFlight.size > 0 && load + next.weight > CORES) break;
      queue.shift();
      load += next.weight;
      process.stderr.write(`  … ${next.name}\n`);
      const p = run(next).then((r) => {
        inFlight.delete(p);
        load -= next.weight;
        results.push(r);
        process.stderr.write(`  ${r.ok ? '✓' : '✗'} ${label(r)}\n`);
        return r;
      });
      inFlight.add(p);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  return results;
}

const label = (r: Result): string => `${r.stage.name} (${(r.ms / 1000).toFixed(1)}s)`;

async function main(): Promise<void> {
  const lock = await acquireCheckLock({
    path: LOCK_PATH,
    onWait: (holder) => process.stderr.write(`check: already running (pid ${holder.pid}) — waiting for it to finish\n`),
  });
  const started = Date.now();
  process.stderr.write(`check: ${STAGES.length} stages, ${CORES} cores\n`);

  try {
    report(await runAll(STAGES), started);
  } finally {
    lock.release();
  }
}

function report(results: readonly Result[], started: number): void {
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    process.stdout.write(`\n${'─'.repeat(64)}\n✗ ${r.stage.name}\n${'─'.repeat(64)}\n`);
    process.stdout.write(r.output.trimEnd() + '\n');
  }

  const order = [...results].sort((a, b) => b.ms - a.ms);
  process.stdout.write('\nstage timings (slowest first):\n');
  for (const r of order) {
    process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.stage.name.padEnd(14)} ${(r.ms / 1000).toFixed(1)}s\n`);
  }
  const wall = (Date.now() - started) / 1000;
  const serial = results.reduce((s, r) => s + r.ms, 0) / 1000;
  process.stdout.write(`\n  wall ${wall.toFixed(1)}s (serial would be ${serial.toFixed(1)}s)\n`);

  if (failed.length > 0) {
    process.stdout.write(`\ncheck FAILED: ${failed.map((r) => r.stage.name).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\ncheck passed\n');
}

await main();
