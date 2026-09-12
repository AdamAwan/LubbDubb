import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Issue, Task } from '../src/types.js';

const NOW = '2026-08-18T12:00:00.000Z';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-overrule-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

const WHY = 'The flags/lease cleanup is automatic — no migration was ever expected here.';

test('an overrule records the verdict and the correction, in the operator’s words', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.verdicts.recordShortfall({
      originRef: 'issue:1',
      cause: 'part',
      partSlug: 'remove-scan-check-pollers',
      summary: 'the cleanup migration the part claims to have added does not exist',
      by: 'assessor',
    });

    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(res.statusCode, 200);

    assert.equal(
      system.store.verdicts.getShortfall('issue:1'),
      null,
      'the assessment it overrules does not stand as well',
    );
    const delivery = system.store.verdicts.getDelivery('issue:1');
    assert.equal(delivery?.summary, WHY, 'the operator’s reason is the delivery’s reason');
    assert.equal(delivery?.by, 'operator');

    assert.deepEqual(
      system.store.instructions.listStandingInstructions('issue:1').map((i) => i.text),
      [WHY],
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule writes no conclusion, because one would clear the delivery it just wrote', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.verdicts.recordShortfall({
      originRef: 'issue:1',
      cause: null,
      partSlug: null,
      summary: 'not done',
      by: 'assessor',
    });
    await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(system.store.verdicts.getIssueConclusion('issue:1'), null);
    assert.ok(system.store.verdicts.getDelivery('issue:1'), 'so the delivery is still standing after the words landed');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an ordinary instruction on a delivered goal retracts the delivery, where an overrule keeps it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.verdicts.recordDelivery({ originRef: 'issue:1', summary: 'assessed as delivered', by: 'assessor' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/1/instruction',
      payload: { text: 'the cleanup is automatic' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      system.store.instructions.listStandingInstructions('issue:1').length,
      1,
      'the words still reach the next agent',
    );
    assert.equal(system.store.verdicts.getDelivery('issue:1'), null, 'and the goal is no longer parked as delivered');
    const conclusion = system.store.verdicts.getIssueConclusion('issue:1');
    assert.equal(conclusion?.verdict, 'more_work');
    assert.equal(conclusion?.by, 'operator');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule with nothing standing is refused, and writes nothing', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(res.statusCode, 409);
    assert.equal(system.store.verdicts.getDelivery('issue:1'), null);
    assert.equal(system.store.instructions.listStandingInstructions('issue:1').length, 0);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule with no words is refused, and the shortfall is left where it was', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.verdicts.recordShortfall({
      originRef: 'issue:1',
      cause: null,
      partSlug: null,
      summary: 'not done',
      by: 'assessor',
    });
    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: '  ' } });
    assert.equal(res.statusCode, 400);
    assert.ok(system.store.verdicts.getShortfall('issue:1'), 'nothing is overruled by a blank box');
    assert.equal(system.store.verdicts.getDelivery('issue:1'), null);
  } finally {
    await app.close();
    system.store.close();
  }
});

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    number: 1,
    title: 'Remove the scan-check pollers',
    body: 'the goal',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function task(): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #1',
    prompt: 'do it',
    branch: 'issue/1',
    originRef: 'issue:1',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [task()],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

test('the delivery an overrule writes is what stops the assessor re-deriving the shortfall', async () => {
  const dispatcher = (): RuleDispatcher => new RuleDispatcher({}, {}, undefined, 'main');
  const assessments = (actions: { rule?: unknown }[]): number =>
    actions.filter((a) => a.rule === 'issue-assess').length;

  const asked = await dispatcher().decide(ctx());
  assert.equal(assessments(asked.actions), 1, 'without a verdict the assessor goes again — the loop being fixed');

  const overruled = await dispatcher().decide(
    ctx({
      deliveries: [
        {
          originRef: 'issue:1',
          summary: WHY,
          detail: null,
          by: 'operator',
          agentId: null,
          taskId: null,
          decidedAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  assert.equal(
    assessments(overruled.actions),
    0,
    'and with one standing it does not, so the operator is asked once rather than every cycle',
  );
});
