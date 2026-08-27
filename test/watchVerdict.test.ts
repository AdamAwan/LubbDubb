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
  why: null,
  dryRunEnvironment: null,
  dryRunAt: null,
  dryRunVerdict: null,
  dryRunPresence: null,
  dryRunRows: null,
  dryRunDetail: null,
};

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
