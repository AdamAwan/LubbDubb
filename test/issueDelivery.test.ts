import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { deliveryHold, deliverySignalQuery } from '../src/delivery/delivery.js';
import type { Issue } from '../src/types.js';

// The `issue_deliveries` table and the mutual exclusion it holds against
// `issue_conclusions`. Mostly store-level: no world, no dispatcher, no agent —
// the exclusion lives in the write precisely so nothing above has to remember
// it. The tail of the file is the other half: the verdict reaching the cockpit,
// which for the whole life of the feature it did not.

function store(): Store {
  return new Store(':memory:');
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-delivery-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
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
  // own park, or rule `work-item-in-review` would return the item to pickup while the gate held it.
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

// -- the cockpit's half ------------------------------------------------------

/**
 * The verdict reached no surface at all until now, and neither of its neighbours
 * could stand in for it: `resolveIssueConclusion` sends the assessor's *positive*
 * verdict to this table, so it folds a delivered decomposed issue to
 * `{by: 'plan'}`, and `issuePickupStatus` answers its plan `parts` arm before the
 * delivery park, so the same issue reports `planning`. Both true; neither this.
 */
test('/api/state ships a standing delivery beside the conclusion and the pickup status', async () => {
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Make it better', body: 'the thing' });
  system.store.setWorldBaseline(await system.connector.getState());

  const shippedIssue = () => buildStateSnapshot(system).world.issues.find((i) => i.number === 12)!;

  // Nothing assessed: null, the same third reading `appraisal` ships.
  assert.equal(shippedIssue().delivery, null);

  system.store.recordDelivery({ originRef: 'issue:12', summary: 'every criterion is met', by: 'assessor' });
  const delivered = shippedIssue();
  assert.equal(delivered.delivery?.summary, 'every criterion is met');
  assert.equal(delivered.delivery?.by, 'assessor');
  assert.ok(delivered.delivery?.decidedAt, 'the instant world signal is measured against goes on the wire');

  // Cleared is absent, not a negative verdict — one representation, as in the store.
  system.store.clearDelivery('issue:12');
  assert.equal(shippedIssue().delivery, null);
  system.store.close?.();
});

/**
 * Standing-ness is the reading, not the row. A verdict the world has overtaken
 * is the same null as one that was never cast: the issue is back in play and
 * rule `issue-assess` will assess it again, so a cockpit still reporting it delivered would
 * be promising a park that has ended.
 */
test('/api/state drops a delivery the world has overtaken', async () => {
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Make it better', body: 'the thing' });
  system.store.setWorldBaseline(await system.connector.getState());
  system.store.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  const shipped = () => buildStateSnapshot(system).world.issues.find((i) => i.number === 12)!.delivery;
  assert.ok(shipped(), 'it stands until something ends it');

  // A transition on the issue after the verdict — phase 4's expiry arm, the same
  // one `deliveryHold` gives rule `issue-pickup`. The store stamps `createdAt` itself, and the
  // arm is a *strict* `>`, so the clock has to have moved between the two writes
  // or the test asserts nothing on a fast machine.
  await new Promise((r) => setTimeout(r, 5));
  system.store.recordWorldEvents([{ kind: 'issue_linked', ref: 'issue:12', summary: 'a fresh PR was linked' }]);
  assert.equal(shipped(), null, 'the hold ended, so the reading does too');
  system.store.close?.();
});

test('a re-cast verdict holds against the transition that ended the last one', () => {
  // The three-step ordering nothing else drives: record → signal → record again.
  // Read through the harness's own path — `deliverySignalQuery` feeding
  // `listWorldEventsSince` — because the query window is half the defect: a
  // stale event fetched is a stale event compared against.
  let clock = Date.parse('2026-08-01T00:00:00.000Z');
  const s = new Store(':memory:', () => new Date(clock).toISOString());
  const issue: Issue = {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
  const held = (): string | null => {
    const q = deliverySignalQuery(s.listDeliveries());
    const signals = q ? s.listWorldEventsSince(q.since, q.refs) : [];
    return deliveryHold(s.getDelivery('issue:12'), issue, { signals });
  };

  const first = s.recordDelivery({ originRef: 'issue:12', summary: 'first pass', by: 'assessor' });
  assert.ok(held(), 'nothing has happened since');

  // A PR mentions the issue. That correctly ends the verdict standing now.
  clock += 60 * 60_000;
  s.recordWorldEvents([{ kind: 'issue_linked', ref: 'issue:12', summary: 'Issue #12 linked to PR #41' }]);
  assert.equal(held(), null);

  // The assessor delivers again, an hour after the link. `decided_at` is
  // preserved — the row still dates the first judgement — but the verdict being
  // asked about is the new one, and no transition has happened since it.
  clock += 60 * 60_000;
  const second = s.recordDelivery({ originRef: 'issue:12', summary: 'second pass', by: 'assessor' });
  assert.equal(second.decidedAt, first.decidedAt, 'the chip and the reason string still quote the first judgement');
  assert.ok(second.updatedAt > first.updatedAt);
  assert.ok(held(), 'the link predates this verdict — it cannot be what ends it');

  // And the arm still works, now stamped after the *second* verdict.
  clock += 60 * 60_000;
  s.recordWorldEvents([{ kind: 'issue_opened', ref: 'issue:12', summary: 'Issue #12 reopened' }]);
  assert.equal(held(), null);
  s.close();
});
