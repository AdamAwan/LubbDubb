import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchCheckVerdict } from '../src/environments/watchVerdict.js';
import { parseWatchResult, unanswered } from '../src/environments/watchResult.js';
import { watchRow } from '../src/environments/fakeObserver.js';
import type { GoalWatch } from '../src/types.js';

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

const measured = (rows: Record<string, unknown>[]) => parseWatchResult(JSON.stringify(rows), MEASURE.id, 'measure');

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
  const verdict = watchCheckVerdict({
    check: { ...CHECK, presence: null },
    environment: 'liveUk',
    presence: null,
    reading: answered([]),
  });
  assert.equal(verdict.verdict, 'clean');
});

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
  const verdict = watchCheckVerdict({
    check: { ...CHECK, expectUnder: 0, expectBaseline: true, baselineValue: null },
    environment: 'liveUk',
    presence: answered([watchRow(CHECK.id, { runs: 96 })]),
    reading: answered([]),
  });
  assert.deepEqual(verdict, { verdict: 'clean', rows: 0, detail: null });
});
