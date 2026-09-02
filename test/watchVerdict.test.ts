import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchCheckVerdict } from '../src/environments/watchVerdict.js';
import { parseWatchResult, unanswered } from '../src/environments/watchResult.js';
import { watchRow } from '../src/environments/fakeObserver.js';
import type { GoalWatch } from '../src/types.js';

/**
 * The verdict fold, on its own. Pure, so the two rules that matter — `unknown`
 * never folding to `clean`, and nothing rolling up to a word — are unit
 * assertions rather than things a server has to be stood up to observe.
 */

const CHECK: GoalWatch = {
  originRef: 'issue:12',
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
  dryRunEnvironment: null,
  dryRunAt: null,
  dryRunVerdict: null,
  dryRunPresence: null,
  dryRunRows: null,
  dryRunDetail: null,
  baselineValue: null,
  baselineAt: null,
  live: true,
  proposal: null,
  authored: 'plan',
};

/**
 * A measure: one number, no presence query, and an expectation that is either a
 * threshold or the baseline taken at declaration.
 */
const MEASURE: GoalWatch = {
  ...CHECK,
  id: 'orders-p95',
  kind: 'measure',
  title: 'The orders proc is no slower than it was',
  query: 'requests | summarize value = percentile(duration, 95)',
  presence: null,
  expectBaseline: true,
  unit: 'ms',
};

/** A measure's stdout, through the real parser — the one-row, numeric-`value` contract. */
const measured = (rows: Record<string, unknown>[]) => parseWatchResult(JSON.stringify(rows), MEASURE.id, 'measure');

/** The command's own stdout, through the real parser — never a hand-made result. */
const answered = (rows: Record<string, unknown>[]) => parseWatchResult(JSON.stringify(rows), CHECK.id, 'signal');

test('presence answering and no matching rows is clean', () => {
  const verdict = watchCheckVerdict({
    check: CHECK,
    environment: 'liveUk',
    presence: answered([watchRow(CHECK.id, { runs: 96 })]),
    reading: answered([]),
  });
  assert.deepEqual(verdict, { verdict: 'clean', rows: 0, detail: null });
});

test('a presence query answering zero is unknown, and says why in words', () => {
  // The case that reads as success: an acceptance environment where the scheduled
  // job does not run, the queue is empty and no real traffic arrives.
  const verdict = watchCheckVerdict({
    check: CHECK,
    environment: 'testUk',
    presence: answered([]),
    reading: answered([]),
  });
  assert.equal(verdict.verdict, 'unknown', 'zero presence is never clean');
  assert.match(verdict.detail!, /could not read testUk/);
  assert.match(verdict.detail!, /has not run here/);
  assert.equal(verdict.rows, null, 'nothing was read, so there is no count to report');
});

test('an observation that did not answer is unknown, never a quiet one', () => {
  for (const failure of [
    unanswered('the observation was killed after SIGTERM'),
    parseWatchResult('', CHECK.id, 'signal'),
    parseWatchResult('not json', CHECK.id, 'signal'),
    // A stale wrapper: it ran something, and it was not the query it was given.
    parseWatchResult(JSON.stringify([{ role: 'worker' }]), CHECK.id, 'signal'),
  ]) {
    const verdict = watchCheckVerdict({
      check: CHECK,
      environment: 'liveUk',
      presence: answered([watchRow(CHECK.id)]),
      reading: failure,
    });
    assert.equal(verdict.verdict, 'unknown');
    assert.match(verdict.detail!, /could not read liveUk/);
  }
});

test('a presence that could not be read is unknown, and the check is not consulted', () => {
  const verdict = watchCheckVerdict({
    check: CHECK,
    environment: 'liveUk',
    presence: unanswered('the observation exited 127: az: not found'),
    // Whatever the check's own query would say about a code path the telemetry
    // could not be asked about is not a reading.
    reading: answered([]),
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.detail!, /az: not found/);
});

test('more rows than the check tolerates is regressed, with the numbers in the words', () => {
  const verdict = watchCheckVerdict({
    check: CHECK,
    environment: 'liveUk',
    presence: answered([watchRow(CHECK.id)]),
    reading: answered([watchRow(CHECK.id), watchRow(CHECK.id, { role: 'worker' })]),
  });
  assert.equal(verdict.verdict, 'regressed');
  assert.equal(verdict.rows, 2);
  assert.match(verdict.detail!, /answered 2 rows where the check declared none at all/);
});

test('a tolerance is a tolerance, not a synonym for zero', () => {
  const tolerant = { ...CHECK, tolerate: 3 };
  const three = [watchRow(CHECK.id), watchRow(CHECK.id), watchRow(CHECK.id)];
  const presence = answered([watchRow(CHECK.id)]);
  assert.equal(
    watchCheckVerdict({ check: tolerant, environment: 'liveUk', presence, reading: answered(three) }).verdict,
    'clean',
  );
  assert.equal(
    watchCheckVerdict({
      check: tolerant,
      environment: 'liveUk',
      presence,
      reading: answered([...three, watchRow(CHECK.id)]),
    }).verdict,
    'regressed',
  );
});

test('a check that declares no presence query is read on its own answer', () => {
  // Null presence is the only shape in which a missing presence read is
  // acceptable: it says the check declared none, not that one went unanswered.
  const verdict = watchCheckVerdict({
    check: { ...CHECK, presence: null },
    environment: 'liveUk',
    presence: null,
    reading: answered([]),
  });
  assert.equal(verdict.verdict, 'clean');
});

// --- measures ---------------------------------------------------------------

test('a measure inside its baseline is clean, and the number is the reading', () => {
  const verdict = watchCheckVerdict({
    check: { ...MEASURE, baselineValue: 8400 },
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 310 })]),
  });
  assert.equal(verdict.verdict, 'clean');
  assert.equal(verdict.detail, null);
});

test('a measure worse than its baseline is regressed, and says both numbers', () => {
  const verdict = watchCheckVerdict({
    check: { ...MEASURE, baselineValue: 310 },
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 8400 })]),
  });
  assert.equal(verdict.verdict, 'regressed');
  assert.match(verdict.detail!, /8400 ms/);
  assert.match(verdict.detail!, /310 ms/);
});

test('a measure whose baseline was never taken is unknown, not clean', () => {
  // The shape this whole guard exists for: a comparison against nothing is not a
  // comparison that passed, and read as clean it would report an optimisation
  // verified on a number nobody ever had a before for.
  const verdict = watchCheckVerdict({
    check: { ...MEASURE, baselineValue: null },
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 310 })]),
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.detail!, /no baseline was ever taken/);
  assert.match(verdict.detail!, /not the same as the reading being good/);
});

test('a measure answering two rows is unknown, not the first row', () => {
  // Refused by `parseWatchResult` rather than here — one implementation of the
  // output contract, and the fold folds its `unknown` forward rather than
  // re-deciding it.
  const verdict = watchCheckVerdict({
    check: { ...MEASURE, baselineValue: 8400 },
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 310 }), watchRow(MEASURE.id, { value: 12000 })]),
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.detail!, /exactly one row/);
});

test('a measure whose value is not a number is unknown', () => {
  const verdict = watchCheckVerdict({
    check: { ...MEASURE, baselineValue: 8400 },
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 'fast' })]),
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.detail!, /numeric "value"/);
});

test('an absolute threshold needs no baseline, and a reading past it is regressed', () => {
  // The right shape for new behaviour, which has no before. A threshold-only
  // measure is never held `unknown` for want of a baseline it never declared.
  const under: typeof MEASURE = { ...MEASURE, expectBaseline: false, expectUnder: 500, baselineValue: null };
  assert.equal(
    watchCheckVerdict({
      check: under,
      environment: 'liveUk',
      presence: null,
      reading: measured([watchRow(MEASURE.id, { value: 310 })]),
    }).verdict,
    'clean',
  );
  const past = watchCheckVerdict({
    check: under,
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 900 })]),
  });
  assert.equal(past.verdict, 'regressed');
  assert.match(past.detail!, /stay under 500 ms/);
});

test('a floor is the other direction, for a measure whose good news is a bigger number', () => {
  const over: typeof MEASURE = { ...MEASURE, expectBaseline: false, expectOver: 99.5, unit: '%' };
  const under = watchCheckVerdict({
    check: over,
    environment: 'liveUk',
    presence: null,
    reading: measured([watchRow(MEASURE.id, { value: 98 })]),
  });
  assert.equal(under.verdict, 'regressed');
  assert.match(under.detail!, /stay over 99.5 %/);
});

test('a signal keeps its own arm — a measure is a second one, not a reinterpretation', () => {
  // The regression this guards: folding both through one comparison would make a
  // signal's verdict depend on columns a signal never declares.
  const verdict = watchCheckVerdict({
    check: { ...CHECK, expectUnder: 0, expectBaseline: true, baselineValue: null },
    environment: 'liveUk',
    presence: answered([watchRow(CHECK.id, { runs: 96 })]),
    reading: answered([]),
  });
  assert.deepEqual(verdict, { verdict: 'clean', rows: 0, detail: null });
});
