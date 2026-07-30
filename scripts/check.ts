/**
 * `npm run check` — the one gate, run concurrently instead of as an `&&` chain.
 *
 * The stages are independent (five static analysers over the same tree, plus the
 * test suite), so serialising them left three of four cores idle for the ~37s the
 * static half took. What this does *not* change is what gets verified: the same six
 * commands, the same flags, and a non-zero exit if any of them fails — CI runs them
 * as separate steps and stays the source of truth.
 *
 * Two deliberate differences from the chain it replaces:
 *
 * - **Every stage runs even when one fails.** An `&&` chain stops at the first
 *   failure, so a formatting slip hid a type error until the next run. Fixing all
 *   of it in one pass is the whole point of having run all of it.
 * - **Output is buffered per stage, not interleaved.** Six concurrent writers to one
 *   terminal is unreadable, so a stage's output is held and printed under its own
 *   heading — failures first, then the timing summary.
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

interface Stage {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Roughly how many cores the stage uses on its own. The test runner spawns its
   * own worker pool (node's default is `availableParallelism() - 1`), so counting
   * it as one job would oversubscribe the box and make everything slower than the
   * serial chain it replaces.
   */
  readonly weight: number;
}

interface Result {
  readonly stage: Stage;
  readonly ok: boolean;
  readonly ms: number;
  readonly output: string;
}

const CORES = availableParallelism();

/** Node's test runner default; mirrored here so the weight matches what it spawns. */
const TEST_WORKERS = Math.max(1, CORES - 1);

/**
 * Declared slowest-first, which is the schedule and not just documentation: the
 * pool admits in this order (stably, within equal weight), so the long poles start
 * while there is still room and the short stages fill in behind them. Declared
 * fastest-first, `knip` ends up last and runs alone after everything else has
 * finished — adding its full duration to the wall time instead of hiding it under
 * the test suite. Only `test` is unaffected, since its weight sorts it first.
 */
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
    // `shell: true` on Windows only — `npm` is a shim there, not an executable.
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

/**
 * Weighted pool: start the heaviest stage first so its long tail overlaps the
 * short ones, and never let the in-flight weight exceed the core count. The
 * budget is a floor of one job, so a single-core machine still makes progress
 * (one stage at a time, i.e. the old behaviour).
 */
async function runAll(stages: readonly Stage[]): Promise<Result[]> {
  const queue = [...stages].sort((a, b) => b.weight - a.weight);
  const results: Result[] = [];
  const inFlight = new Set<Promise<Result>>();
  let load = 0;

  while (queue.length > 0 || inFlight.size > 0) {
    // Fill the pool: admit while there is room, always admitting at least one.
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
  const started = Date.now();
  process.stderr.write(`check: ${STAGES.length} stages, ${CORES} cores\n`);

  const results = await runAll(STAGES);
  const failed = results.filter((r) => !r.ok);

  // Failures first, each under its own heading — the reason output is buffered.
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
