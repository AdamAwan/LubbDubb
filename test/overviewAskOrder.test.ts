import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NeedKind, NeedRow } from '../web/src/view/needsYou.js';
import { byWeight } from '../web/src/console/overviews/asks.js';

/* The ask-led shapes order the queue with `byWeight`, and the stage is the cut
   this file is about: `holding` is zero on most asks, so what was left to order
   them was `raisedAt` — and the oldest ask on a deployment is almost always the
   one about work that never started.
   → docs/spec/17-cockpit.md#one-ask-at-a-time */

function row(kind: NeedKind, over: Partial<NeedRow> = {}): NeedRow {
  return {
    id: `${kind}:1`,
    kind,
    group: 'yours',
    urgency: 'next',
    title: kind,
    goalRef: 'issue:1',
    originRef: 'issue:1',
    opens: 'goal',
    agentId: null,
    agentLabel: null,
    holding: 0,
    raisedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('an intake hold sorts behind the asks about work already in flight, however old it is', () => {
  const rows = [
    row('intake', { raisedAt: '2026-01-01T00:00:00.000Z' }),
    row('bench', { raisedAt: '2026-06-01T00:00:00.000Z' }),
    row('reply', { raisedAt: '2026-06-02T00:00:00.000Z' }),
  ].sort(byWeight);

  assert.deepEqual(
    rows.map((r) => r.kind),
    ['reply', 'bench', 'intake'],
  );
});

/* The stage runs a part's own life backwards, so the ask one press from landing
   work is the one in front of the operator. */
test('a merge leads its tier, and the deployment’s own asks end it', () => {
  const rows = [row('config_gap'), row('escalation', { urgency: 'now' }), row('merge', { urgency: 'now' })].sort(
    byWeight,
  );

  assert.deepEqual(
    rows.map((r) => r.kind),
    ['merge', 'escalation', 'config_gap'],
  );
});

/* The stage decides ties and nothing more: an ask stalling four parts is stopping
   more work than one stalling none, whatever either is about. */
test('held work still outranks the stage', () => {
  const rows = [row('merge', { urgency: 'now' }), row('intake', { urgency: 'now', holding: 4 })].sort(byWeight);

  assert.deepEqual(
    rows.map((r) => r.kind),
    ['intake', 'merge'],
  );
});

/* Two asks of one kind holding the same amount of work are still the oldest
   first — the stage is inserted above that cut, not in place of it. */
test('within a stage the oldest ask still comes first', () => {
  const rows = [
    row('bench', { id: 'newer', raisedAt: '2026-06-02T00:00:00.000Z' }),
    row('bench', { id: 'older', raisedAt: '2026-06-01T00:00:00.000Z' }),
  ].sort(byWeight);

  assert.deepEqual(
    rows.map((r) => r.id),
    ['older', 'newer'],
  );
});
