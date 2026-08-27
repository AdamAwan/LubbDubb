import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idProjection, parseWatchResult, WATCH_ID_COLUMN, watchRowLabels } from '../src/environments/watchResult.js';
import { CommandEnvironmentObserver } from '../src/environments/observer.js';

/**
 * The output contract, which is all the schema the harness has — and the guard
 * that stands between a stale operator wrapper script and a confidently wrong
 * verdict.
 *
 * Every case here is a *silence*: each one has an obvious wrong answer that reads
 * as success, and the whole point of the module is that it never gives it.
 */

const rows = (checkId: string, ...extra: Record<string, unknown>[]): string =>
  JSON.stringify(extra.map((r) => ({ ...r, [WATCH_ID_COLUMN]: checkId })));

test('a result that omits the id echo is unknown, not an answer', () => {
  // The stale-wrapper case: the command ran *something*, and it was not the query
  // it was given. Read as an answer it is a verdict about the wrong question.
  const stale = JSON.stringify([{ role: 'worker', count: 3 }]);
  const result = parseWatchResult(stale, 'no-timeouts', 'signal');
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.rows, null);
  assert.match(result.detail!, /without the query it was given/);
});

test('a result echoing a different check is unknown', () => {
  const other = rows('some-other-check', { role: 'worker' });
  assert.equal(parseWatchResult(other, 'no-timeouts', 'signal').verdict, 'unknown');
});

test('a signal answering zero rows is an answer with zero rows, not a failure', () => {
  // Zero is a real reading *here*; what it means is the caller's fold, and the
  // caller refuses to call it clean without a firing presence query.
  const result = parseWatchResult('[]', 'no-timeouts', 'signal');
  assert.equal(result.verdict, 'answered');
  assert.deepEqual(result.rows, []);
});

test('an observation that printed nothing is unknown', () => {
  // A query with nothing to report and a broken query print the same thing.
  const result = parseWatchResult('   \n', 'no-timeouts', 'signal');
  assert.equal(result.verdict, 'unknown');
  assert.match(result.detail!, /printed nothing/);
});

test('output that is not a list of rows is unknown', () => {
  for (const bad of ['not json at all', '{"rows": []}', '[1, 2, 3]', 'null']) {
    assert.equal(parseWatchResult(bad, 'no-timeouts', 'signal').verdict, 'unknown', bad);
  }
});

test('a measure answering two rows is unknown, not the first row', () => {
  // The direction that reads as an answer: picking row one is a percentile from
  // whichever role happened to sort first, reported as the number.
  const two = rows('p95-checkout', { value: 310 }, { value: 8400 });
  const result = parseWatchResult(two, 'p95-checkout', 'measure');
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.value, null);
  assert.match(result.detail!, /exactly one row/);
});

test('a measure whose value is not a number is unknown', () => {
  for (const value of ['310', null, undefined, Number.NaN]) {
    const one = rows('p95-checkout', { value });
    assert.equal(parseWatchResult(one, 'p95-checkout', 'measure').verdict, 'unknown', String(value));
  }
  const good = rows('p95-checkout', { value: 310 });
  assert.equal(parseWatchResult(good, 'p95-checkout', 'measure').value, 310);
});

test('the projection carries the check id and leaves the declared query intact', () => {
  const query = "traces | where message has 'timeout'";
  const handed = idProjection(query, 'no-timeouts');
  assert.ok(handed.startsWith(query), 'the declared query is handed over unchanged');
  assert.match(handed, new RegExp(`${WATCH_ID_COLUMN} = "no-timeouts"`));
});

test('a row draws up to two label columns, and never the harness’s own', () => {
  const labels = watchRowLabels({ role: 'worker', operation: 'GET /x', extra: 'dropped', [WATCH_ID_COLUMN]: 'c' });
  assert.deepEqual(labels, [
    { name: 'role', value: 'worker' },
    { name: 'operation', value: 'GET /x' },
  ]);
});

/**
 * The real observer, against a real shell — the one place a test spawns one,
 * because the three failures below live in `exec`'s error and not in the parse.
 * No telemetry and no credential: the command is `sh` saying no.
 */
test('a command that exits non-zero, times out, or prints nothing is unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const observer = new CommandEnvironmentObserver(dir, 200);
    const ask = (command: string) =>
      observer.observe({ environment: 'testUk', command, checkId: 'no-timeouts', query: 'q', kind: 'signal' });

    const failed = await ask('echo "no such table" 1>&2; exit 3');
    assert.equal(failed.verdict, 'unknown');
    assert.match(failed.detail!, /exited 3/);

    const silent = await ask('true');
    assert.equal(silent.verdict, 'unknown');
    assert.match(silent.detail!, /printed nothing/);

    const hung = await ask('sleep 5');
    assert.equal(hung.verdict, 'unknown');
    assert.match(hung.detail!, /killed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the query reaches the command as a variable’s value and never as syntax', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const observer = new CommandEnvironmentObserver(dir, 5_000);
    // A query carrying shell metacharacters. Interpolated into the command string
    // this would run `touch pwned`; passed as a variable it is text.
    const result = await observer.observe({
      environment: 'testUk',
      command: `node -e 'process.stdout.write(JSON.stringify([{q: process.env.LUBBDUBB_WATCH_QUERY, ${JSON.stringify(WATCH_ID_COLUMN)}: process.env.LUBBDUBB_WATCH_ID}]))'`,
      checkId: 'no-timeouts',
      query: '"; touch pwned; echo "',
      kind: 'signal',
    });
    assert.equal(result.verdict, 'answered');
    assert.match(String(result.rows![0]!['q']), /touch pwned/);
    assert.equal(existsIn(dir, 'pwned'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsIn(dir: string, name: string): boolean {
  try {
    execFileSync('test', ['-e', join(dir, name)]);
    return true;
  } catch {
    return false;
  }
}
