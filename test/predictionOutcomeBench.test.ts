import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { closeOutPass } from '../src/delivery/closeOut.js';
import { DeliveryCloseOutDesk } from '../src/delivery/closeOutDesk.js';
import type { HumanTask, Issue, IssueDelivery } from '../src/types.js';

// → docs/spec/14-persistence.md#moment-two--was-the-plan-right

/** The strings the prediction holds. None of them may appear on a bench row. */
const SENTINELS = {
  locus: 'ZZQX-BENCH-LOCUS-SENTINEL',
  cause: 'ZZQX-BENCH-CAUSE-SENTINEL',
  split: 'ZZQX-BENCH-SPLIT-SENTINEL',
  avoid: 'ZZQX-BENCH-AVOID-SENTINEL',
} as const;

function delivery(number: number): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'it shipped',
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
  };
}

function issue(number: number): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Goal ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function task(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'hum_1',
    title: 'Close issue #12 in the tracker',
    detail: null,
    originRef: 'issue:12',
    partId: null,
    kind: 'close_out',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

const pass = (over: Partial<Parameters<typeof closeOutPass>[0]> = {}) =>
  closeOutPass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    shortfalls: [],
    existing: [],
    validation: new Map(),
    opened: null,
    validating: new Set(),
    watch: new Map(),
    watchCleared: null,
    canClose: true,
    ...over,
  });

test('a goal owing the second moment gets no row while its close-out is still open', () => {
  const steps = pass({ outcomeOwed: new Set(['issue:12']) });
  assert.deepEqual(
    steps.filter((s) => s.kind === 'file-outcome'),
    [],
    'the bench asks for one thing at a time — the close-out is in front of it',
  );
  assert.equal(steps.filter((s) => s.kind === 'file').length, 1);
});

test('once the close-out is dealt with, the second moment is the row', () => {
  const steps = pass({
    existing: [task({ status: 'done', resolution: 'closed it' })],
    outcomeOwed: new Set(['issue:12']),
  });
  const filed = steps.filter((s) => s.kind === 'file-outcome');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.kind === 'file-outcome' && filed[0]!.originRef, 'issue:12');
  assert.match(filed[0]!.kind === 'file-outcome' ? filed[0]!.title : '', /#12/);
});

test('a goal that owes nothing gets no row, and an open row is settled when it is answered', () => {
  assert.deepEqual(
    pass({ existing: [task({ status: 'done', resolution: 'closed it' })] }).filter((s) => s.kind === 'file-outcome'),
    [],
  );

  const settle = pass({
    existing: [task({ status: 'done', resolution: 'closed it' })],
    existingOutcome: [task({ id: 'hum_2', kind: 'outcome', title: 'Say whether the plan for #12 turned out right' })],
    outcomeOwed: new Set(),
  });
  assert.equal(settle.length, 1);
  assert.equal(settle[0]!.kind === 'settle' && settle[0]!.taskId, 'hum_2');
  assert.equal(settle[0]!.kind === 'settle' && settle[0]!.status, 'done');
});

test('a row whose goal went back into production is declined, not left standing', () => {
  const steps = pass({
    deliveries: [],
    existingOutcome: [task({ id: 'hum_2', kind: 'outcome' })],
    outcomeOwed: new Set(['issue:12']),
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind === 'settle' && steps[0]!.status, 'declined');
});

/**
 * The containment arm. A bench row is persisted and is served to surfaces that are
 * not the cockpit — the operator's own desktop channel reads every open row's detail
 * — so the prediction's own text must not be in it. The row names the goal; the
 * cockpit fetches the slots through `GET /api/goals/:number/prediction`.
 */
test('the bench row appears, carries no prediction text, and disappears once answered', () => {
  const store = new Store(':memory:');
  const predictions = store.openPredictions();
  predictions.recordPrediction({ originRef: 'issue:12', author: 'operator', slots: { ...SENTINELS } });
  predictions.recordReveal('issue:12');
  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } }).ok);

  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'it shipped', by: 'assessor' });
  const desk = new DeliveryCloseOutDesk(
    store,
    [],
    () => true,
    () => new Set(predictions.listOutcomeOwed()),
  );

  desk.run({ issues: [issue(12)] });
  assert.equal(store.humanTasks.listHumanTasksOfKind('outcome').length, 0, 'the close-out is asked for first');

  const closeOut = store.humanTasks.listHumanTasksOfKind('close_out')[0]!;
  store.humanTasks.settleHumanTask(closeOut.id, 'done', 'closed it in the tracker');

  desk.run({ issues: [issue(12)] });
  const rows = store.humanTasks.listHumanTasksOfKind('outcome');
  assert.equal(rows.length, 1, 'and then for the second moment');
  const row = rows[0]!;
  assert.equal(row.originRef, 'issue:12', 'the row carries the goal reference');
  assert.equal(row.status, 'open');

  // Non-vacuous: the sentinels really are findable where they legitimately live.
  assert.ok(JSON.stringify(predictions.getPrediction('issue:12')).includes(SENTINELS.split));
  const serialised = JSON.stringify(row);
  for (const sentinel of Object.values(SENTINELS))
    assert.ok(
      !serialised.includes(sentinel),
      'a close-out bench row carried the prediction. It is a measurement of the fleet and a bench row ' +
        'reaches surfaces that are not the cockpit — fix the row, not this assertion.',
    );

  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'missed' } }).ok);
  desk.run({ issues: [issue(12)] });
  assert.deepEqual(
    store.humanTasks.listHumanTasksOfKind('outcome').filter((t) => t.status === 'open'),
    [],
    'answered, so the row goes',
  );
  store.close();
});

test('with nothing owed the desk files no second-moment row at all', () => {
  const store = new Store(':memory:');
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'it shipped', by: 'assessor' });
  const desk = new DeliveryCloseOutDesk(store, [], () => true);
  desk.run({ issues: [issue(12)] });
  const closeOut = store.humanTasks.listHumanTasksOfKind('close_out')[0]!;
  store.humanTasks.settleHumanTask(closeOut.id, 'done', 'closed it');
  desk.run({ issues: [issue(12)] });
  assert.deepEqual(store.humanTasks.listHumanTasksOfKind('outcome'), []);
  store.close();
});
