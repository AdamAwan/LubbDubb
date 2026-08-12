import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoApi } from '../web/src/demo/demoBackend.js';
import { buildDemoState } from '../web/src/demo/fixtures.js';

/**
 * The demo's Yield gauge and the panel behind it, checked against each other.
 *
 * The real pair cannot disagree — both fold `tallyRunOutcomes` over the same
 * agent rows — but the demo has no agents to fold, so both sides are authored and
 * nothing structural holds them together. That makes the demo the one place the
 * panel's central claim can quietly stop being true: click the gauge, and the
 * number changes. Two fixtures, one assertion.
 */
test('the demo panel opens agreeing with the demo gauge', async () => {
  const { state } = buildDemoState();
  const { insights } = await demoApi.getReliability();
  const gauge = state.runOutcomes;

  assert.equal(insights.runs.settled, gauge.settled);
  assert.equal(insights.runs.live, gauge.live);
  assert.equal(insights.runs.completed, gauge.completed);
  assert.equal(insights.runs.lost, gauge.lost);
  assert.equal(insights.runs.stopped, gauge.stopped);
  assert.equal(insights.runs.completionRate, gauge.completionRate);
});

/**
 * The authored rows are a *partition*, exactly as the real ones are. A demo whose
 * phase table sums to more runs than the fleet ever settled teaches an operator
 * to distrust the panel's arithmetic on the day it is right.
 */
test('the demo phase rows partition the demo fleet', async () => {
  const { insights } = await demoApi.getReliability();
  const { runs } = insights;
  const sum = (pick: (p: (typeof runs.byPhase)[number]) => number) => runs.byPhase.reduce((a, p) => a + pick(p), 0);

  assert.equal(
    sum((p) => p.settled),
    runs.settled,
  );
  assert.equal(
    sum((p) => p.completed),
    runs.completed,
  );
  assert.equal(
    sum((p) => p.lost),
    runs.lost,
  );
  assert.equal(
    sum((p) => p.stopped),
    runs.stopped,
  );
  assert.equal(
    runs.byOutcome.reduce((a, o) => a + o.runs, 0),
    runs.settled,
    'every settled run ended exactly one way',
  );
  assert.equal(
    insights.ci.timeline.buckets.reduce((a, b) => a + b.red, 0),
    insights.ci.reds,
    'the CI graph draws every red the headline counts',
  );
});
