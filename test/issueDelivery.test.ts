import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';

// The `issue_deliveries` table and the mutual exclusion it holds against
// `issue_conclusions`. Store-level: no world, no dispatcher, no agent — the
// exclusion lives in the write precisely so nothing above has to remember it.

function store(): Store {
  return new Store(':memory:');
}

test('a delivery round-trips and reads back as the standing verdict', () => {
  const s = store();
  const written = s.recordDelivery({
    originRef: 'issue:12',
    summary: 'PR #40 merged and implements every acceptance criterion',
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
  });
  assert.equal(written.originRef, 'issue:12');
  assert.equal(written.by, 'assessor');
  assert.deepEqual(s.getDelivery('issue:12'), written);
  assert.deepEqual(s.listDeliveries(), [written]);
  assert.equal(s.getDelivery('issue:99'), null);
  s.close();
});

test('re-assessing preserves decidedAt — it is what world signal is measured against', () => {
  const s = store();
  const first = s.recordDelivery({ originRef: 'issue:12', summary: 'first pass', by: 'assessor' });
  const second = s.recordDelivery({ originRef: 'issue:12', summary: 'second pass', by: 'operator' });

  assert.equal(second.decidedAt, first.decidedAt, 'refreshing it would keep moving the goalposts a signal must clear');
  assert.equal(second.summary, 'second pass');
  assert.equal(second.by, 'operator');
  assert.equal(s.listDeliveries().length, 1, 'one row per issue, overwritten');
  s.close();
});

test('a delivery clears a standing conclusion, and a conclusion clears a standing delivery', () => {
  const s = store();

  s.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'more_work',
    note: 'the API half is missing',
    by: 'agent',
  });
  s.recordDelivery({ originRef: 'issue:12', summary: 'the API half landed in PR #41', by: 'assessor' });
  assert.equal(s.getIssueConclusion('issue:12'), null, 'the later, better-informed verdict replaces');
  assert.ok(s.getDelivery('issue:12'));

  // And back the other way: an assessor that finds outstanding work retracts its
  // own park, or rule 3b would return the item to pickup while the gate held it.
  s.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'more_work',
    note: 'migration still missing',
    by: 'assessor',
  });
  assert.equal(s.getDelivery('issue:12'), null);
  assert.equal(s.getIssueConclusion('issue:12')?.by, 'assessor');
  s.close();
});

test('the exclusion is per issue — another issue is untouched', () => {
  const s = store();
  s.recordIssueConclusion({ originRef: 'issue:13', verdict: 'done', note: 'shipped', by: 'agent' });
  s.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  assert.ok(s.getIssueConclusion('issue:13'), 'issue 13 kept its conclusion');
  assert.ok(s.getDelivery('issue:12'));
  s.close();
});

test('clearing is a delete, so "not delivered" has exactly one representation', () => {
  const s = store();
  s.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  assert.equal(s.clearDelivery('issue:12'), true);
  assert.equal(s.getDelivery('issue:12'), null);
  assert.deepEqual(s.listDeliveries(), []);
  assert.equal(s.clearDelivery('issue:12'), false, 'nothing to clear the second time');
  s.close();
});
