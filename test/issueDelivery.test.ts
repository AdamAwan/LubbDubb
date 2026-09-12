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
  const written = s.verdicts.recordDelivery({
    originRef: 'issue:12',
    summary: 'PR #40 merged and implements every acceptance criterion',
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
  });
  assert.equal(written.originRef, 'issue:12');
  assert.equal(written.by, 'assessor');
  assert.deepEqual(s.verdicts.getDelivery('issue:12'), written);
  assert.deepEqual(s.verdicts.listDeliveries(), [written]);
  assert.equal(s.verdicts.getDelivery('issue:99'), null);
  s.close();
});

test('re-assessing preserves decidedAt — it is what world signal is measured against', () => {
  const s = store();
  const first = s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'first pass', by: 'assessor' });
  const second = s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'second pass', by: 'operator' });

  assert.equal(second.decidedAt, first.decidedAt, 'refreshing it would keep moving the goalposts a signal must clear');
  assert.equal(second.summary, 'second pass');
  assert.equal(second.by, 'operator');
  assert.equal(s.verdicts.listDeliveries().length, 1, 'one row per issue, overwritten');
  s.close();
});

test('a delivery clears a standing conclusion, and a conclusion clears a standing delivery', () => {
  const s = store();

  s.verdicts.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'more_work',
    note: 'the API half is missing',
    by: 'agent',
  });
  s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'the API half landed in PR #41', by: 'assessor' });
  assert.equal(s.verdicts.getIssueConclusion('issue:12'), null, 'the later, better-informed verdict replaces');
  assert.ok(s.verdicts.getDelivery('issue:12'));

  s.verdicts.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'more_work',
    note: 'migration still missing',
    by: 'assessor',
  });
  assert.equal(s.verdicts.getDelivery('issue:12'), null);
  assert.equal(s.verdicts.getIssueConclusion('issue:12')?.by, 'assessor');
  s.close();
});

test('the exclusion is per issue — another issue is untouched', () => {
  const s = store();
  s.verdicts.recordIssueConclusion({ originRef: 'issue:13', verdict: 'done', note: 'shipped', by: 'agent' });
  s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  assert.ok(s.verdicts.getIssueConclusion('issue:13'), 'issue 13 kept its conclusion');
  assert.ok(s.verdicts.getDelivery('issue:12'));
  s.close();
});

test('clearing is a delete, so "not delivered" has exactly one representation', () => {
  const s = store();
  s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  assert.equal(s.verdicts.clearDelivery('issue:12'), true);
  assert.equal(s.verdicts.getDelivery('issue:12'), null);
  assert.deepEqual(s.verdicts.listDeliveries(), []);
  assert.equal(s.verdicts.clearDelivery('issue:12'), false, 'nothing to clear the second time');
  s.close();
});

test('/api/state ships a standing delivery beside the conclusion and the pickup status', async () => {
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Make it better', body: 'the thing' });
  system.store.world.setWorldBaseline(await system.connector.getState());

  const shippedIssue = () => buildStateSnapshot(system).world.issues.find((i) => i.number === 12)!;

  assert.equal(shippedIssue().delivery, null);

  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'every criterion is met', by: 'assessor' });
  const delivered = shippedIssue();
  assert.equal(delivered.delivery?.summary, 'every criterion is met');
  assert.equal(delivered.delivery?.by, 'assessor');
  assert.ok(delivered.delivery?.decidedAt, 'the instant world signal is measured against goes on the wire');

  system.store.verdicts.clearDelivery('issue:12');
  assert.equal(shippedIssue().delivery, null);
  system.store.close?.();
});

test('/api/state drops a delivery the world has overtaken', async () => {
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Make it better', body: 'the thing' });
  system.store.world.setWorldBaseline(await system.connector.getState());
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'delivered', by: 'assessor' });

  const shipped = () => buildStateSnapshot(system).world.issues.find((i) => i.number === 12)!.delivery;
  assert.ok(shipped(), 'it stands until something ends it');

  await new Promise((r) => setTimeout(r, 5));
  system.store.world.recordWorldEvents([{ kind: 'issue_linked', ref: 'issue:12', summary: 'a fresh PR was linked' }]);
  assert.equal(shipped(), null, 'the hold ended, so the reading does too');
  system.store.close?.();
});

test('a re-cast verdict holds against the transition that ended the last one', () => {
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
    const q = deliverySignalQuery(s.verdicts.listDeliveries());
    const signals = q ? s.world.listWorldEventsSince(q.since, q.refs) : [];
    return deliveryHold(s.verdicts.getDelivery('issue:12'), issue, { signals });
  };

  const first = s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'first pass', by: 'assessor' });
  assert.ok(held(), 'nothing has happened since');

  clock += 60 * 60_000;
  s.world.recordWorldEvents([{ kind: 'issue_linked', ref: 'issue:12', summary: 'Issue #12 linked to PR #41' }]);
  assert.equal(held(), null);

  clock += 60 * 60_000;
  const second = s.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'second pass', by: 'assessor' });
  assert.equal(second.decidedAt, first.decidedAt, 'the chip and the reason string still quote the first judgement');
  assert.ok(second.updatedAt > first.updatedAt);
  assert.ok(held(), 'the link predates this verdict — it cannot be what ends it');

  clock += 60 * 60_000;
  s.world.recordWorldEvents([{ kind: 'issue_opened', ref: 'issue:12', summary: 'Issue #12 reopened' }]);
  assert.equal(held(), null);
  s.close();
});
