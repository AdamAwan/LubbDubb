import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { DeliveryCloseOutDesk } from '../src/delivery/closeOutDesk.js';
import type { Issue } from '../src/types.js';

// → docs/spec/24-environments.md#the-plan-verdict-row-is-retired

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

test('the desk files no plan-verdict row, even for a goal whose prediction was marked', () => {
  const store = new Store(':memory:');
  const predictions = store.openPredictions();
  predictions.recordPrediction({ originRef: 'issue:12', author: 'operator', slots: { locus: 'here' } });
  predictions.recordReveal('issue:12');
  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } }).ok);
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'it shipped', by: 'assessor' });
  const desk = new DeliveryCloseOutDesk(store, [], () => true);

  desk.run({ issues: [issue(12)] });
  const closeOut = store.humanTasks.listHumanTasksOfKind('close_out')[0]!;
  store.humanTasks.settleHumanTask(closeOut.id, 'done', 'closed it');
  desk.run({ issues: [issue(12)] });
  assert.deepEqual(store.humanTasks.listHumanTasksOfKind('outcome'), []);
  store.close();
});

test('a plan-verdict row left open from before is declined when the store opens', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-outcome-row-')), 'old.db');
  const before = new Store(path);
  const { task: row } = before.humanTasks.recordHumanTask({
    title: 'Say whether the plan for #12 turned out right',
    detail: null,
    originRef: 'issue:12',
    kind: 'outcome',
    agentId: null,
    taskId: null,
  });
  before.close();

  const after = new Store(path);
  assert.equal(after.humanTasks.getHumanTask(row.id)?.status, 'declined');
  after.close();
});
