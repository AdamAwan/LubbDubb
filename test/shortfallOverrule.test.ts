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

// Overruling a shortfall: the operator saying the assessment itself is wrong.
//
// The gap it closes is a loop rather than a missing button. The card offered
// accept — which spends an agent on a follow-up part for work already done — and
// reject, which deliberately leaves the verdict standing, so rule `issue-assess`
// dispatched again, the fresh assessor read the same repository and recorded the
// same shortfall. Neither arm is "that finding is mistaken", and nothing typed
// into the card survived: `shortfallRef` is nobody's dispatch origin, so
// `rejectionGuidance` reaches no agent with the note.

const NOW = '2026-08-18T12:00:00.000Z';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-overrule-'));
  return buildSystem(
    loadConfig({
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
    system.store.recordShortfall({
      originRef: 'issue:1',
      cause: 'part',
      partSlug: 'remove-scan-check-pollers',
      summary: 'the cleanup migration the part claims to have added does not exist',
      by: 'assessor',
    });

    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(res.statusCode, 200);

    // The verdict. It clears the shortfall through the exclusion matrix rather
    // than by a `DELETE` of its own — the thing `recordVerdict` exists to stop a
    // new writer hand-rolling.
    assert.equal(system.store.getShortfall('issue:1'), null, 'the assessment it overrules does not stand as well');
    const delivery = system.store.getDelivery('issue:1');
    assert.equal(delivery?.summary, WHY, 'the operator’s reason is the delivery’s reason');
    assert.equal(delivery?.by, 'operator');

    // The correction. The harness never edits the ticket itself, so the
    // instruction block — which carries the tracker's own read/amend commands —
    // is the whole of how these words reach it.
    assert.deepEqual(
      system.store.listStandingInstructions('issue:1').map((i) => i.text),
      [WHY],
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule writes no conclusion, because one would clear the delivery it just wrote', async () => {
  // The sharp edge, and it is silent both ways: `VERDICT_EXCLUSIONS.conclusion`
  // lists `delivery`, so the `more_work` that ordinarily makes there *be* a next
  // dispatch would delete the park instead — un-holding the assessor and
  // re-blocking `issue-retro`, `validate-check` and the close-out, all three of
  // which gate on `deliveryParked`. Nothing errors; the goal simply goes back
  // round.
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.recordShortfall({
      originRef: 'issue:1',
      cause: null,
      partSlug: null,
      summary: 'not done',
      by: 'assessor',
    });
    await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(system.store.getIssueConclusion('issue:1'), null);
    assert.ok(system.store.getDelivery('issue:1'), 'so the delivery is still standing after the words landed');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an ordinary instruction on a delivered goal leaves the delivery standing', async () => {
  // The same edge reached by the other door: the **More work** control on a goal
  // that has already been assessed as delivered. The conclusion is skipped for
  // the same reason and the instruction still lands — on a delivered goal the
  // next dispatch is the retrospective, which `instructionsFor` deliberately
  // includes.
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.recordDelivery({ originRef: 'issue:1', summary: 'assessed as delivered', by: 'assessor' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/1/instruction',
      payload: { text: 'the cleanup is automatic' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(system.store.listStandingInstructions('issue:1').length, 1, 'the words still reach the next agent');
    assert.ok(system.store.getDelivery('issue:1'), 'and writing them did not retract the delivery');
    assert.equal(system.store.getIssueConclusion('issue:1'), null);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an instruction on a goal nothing has delivered still writes the verdict that gets it read', async () => {
  // The guard narrows one case and must leave the ordinary one exactly as it was:
  // rule `work-item-back-to-pickup` acts on an explicit `more_work` and nothing
  // else, so without it an instruction on a parked item is words nobody is
  // dispatched to read.
  const system = build();
  const { app } = await buildApp(system);
  try {
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'change the button' } });
    const conclusion = system.store.getIssueConclusion('issue:1');
    assert.equal(conclusion?.verdict, 'more_work');
    assert.equal(conclusion?.by, 'operator');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule with nothing standing is refused, and writes nothing', async () => {
  // Refused rather than degraded into a plain "mark it delivered": this route
  // says one specific thing — *that* verdict is wrong — and with nothing standing
  // there is no verdict to be wrong.
  const system = build();
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: WHY } });
    assert.equal(res.statusCode, 409);
    assert.equal(system.store.getDelivery('issue:1'), null);
    assert.equal(system.store.listStandingInstructions('issue:1').length, 0);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an overrule with no words is refused, and the shortfall is left where it was', async () => {
  // The words *are* the act. An overrule with an empty box records "delivered"
  // for a reason nobody can read, which is the assessment problem again with the
  // operator's name on it.
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.store.recordShortfall({
      originRef: 'issue:1',
      cause: null,
      partSlug: null,
      summary: 'not done',
      by: 'assessor',
    });
    const res = await app.inject({ method: 'POST', url: '/api/issues/1/shortfall/overrule', payload: { text: '  ' } });
    assert.equal(res.statusCode, 400);
    assert.ok(system.store.getShortfall('issue:1'), 'nothing is overruled by a blank box');
    assert.equal(system.store.getDelivery('issue:1'), null);
  } finally {
    await app.close();
    system.store.close();
  }
});

// -- what it stops, at the dispatcher ----------------------------------------

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
  // The loop, and the proof it is closed. `hasPriorWork` is satisfied and nothing
  // is in flight, so this issue is `issue-assess`'s exact precondition — the
  // shape that had a fresh assessor reading the same repository every cycle and
  // recording the same finding.
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
