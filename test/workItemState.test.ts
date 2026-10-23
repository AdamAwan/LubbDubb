import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink, SendResult, WorkItemStateInput } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { failAppraisalOpen, planWithOnePart, workedAsOnePart } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    prediction: { enabled: false },
    goalCriteria: { enabled: false },
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

function statePlan(number: number, state: string): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [{ type: 'set_work_item_state', number, state, reason: 'PR opened' }],
  } as unknown as DispatchResult;
}

function recordingSink(): { sink: ActionSink; states: WorkItemStateInput[] } {
  const states: WorkItemStateInput[] = [];
  const sink: ActionSink = {
    canCloseIssue: () => false,
    canReopenIssue: () => false,
    reopenIssue: (): never => {
      throw new Error('reopenIssue is not scripted in this test');
    },
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => true,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    async postPrReply(): Promise<SendResult> {
      return { ok: true };
    },
    async mergePr(): Promise<SendResult> {
      return { ok: true };
    },
    async setPrLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setIssueLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setWorkItemState(input): Promise<SendResult> {
      states.push(input);
      return { ok: true, ref: 'ok' };
    },
    async linkWorkItem(): Promise<SendResult> {
      return { ok: false };
    },
    async createIssue(): Promise<SendResult> {
      return { ok: true, ref: 'issue:1' };
    },
    async upsertIssueComment(): Promise<SendResult> {
      return { ok: true };
    },
    async createPullRequest(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullTitle(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullBody(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullBase(): Promise<SendResult> {
      return { ok: true };
    },
    async updatePrBranch(): Promise<SendResult> {
      return { ok: true };
    },
    async requeueCiCheck(): Promise<SendResult> {
      return { ok: true };
    },
    async deleteBranch(): Promise<SendResult> {
      return { ok: true };
    },
  };
  return { sink, states };
}

test('set_work_item_state routes to the sink and is audited (no auto-send gate)', async () => {
  const { sink, states } = recordingSink();
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    gitObserver: new FakeGitObserver(),
    backend: new FakePtyBackend(),
    sink,
  });
  await system.executor.execute('cyc', statePlan(101, 'In Review'));

  assert.deepEqual(states, [{ number: 101, state: 'In Review' }]);
  const decision = system.store.decisions.listDecisions().find((d) => d.action.type === 'set_work_item_state');
  assert.ok(decision, 'the transition is recorded');
  assert.equal(decision!.outcome, 'executed');
  assert.match(decision!.detail, /Set work item #101 to "In Review"/);
  assert.equal(system.store.escalations.listOpenEscalations().length, 0);
  system.store.close();
});

test('a failing transition is recorded as rejected, not escalated', async () => {
  const failingSink: ActionSink = {
    canCloseIssue: () => false,
    canReopenIssue: () => false,
    reopenIssue: (): never => {
      throw new Error('reopenIssue is not scripted in this test');
    },
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => true,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    async postPrReply(): Promise<SendResult> {
      return { ok: true };
    },
    async mergePr(): Promise<SendResult> {
      return { ok: true };
    },
    async setPrLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setIssueLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setWorkItemState(): Promise<SendResult> {
      throw new Error('boom');
    },
    async linkWorkItem(): Promise<SendResult> {
      return { ok: false };
    },
    async createIssue(): Promise<SendResult> {
      return { ok: true, ref: 'issue:1' };
    },
    async upsertIssueComment(): Promise<SendResult> {
      return { ok: true };
    },
    async createPullRequest(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullTitle(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullBody(): Promise<SendResult> {
      return { ok: true };
    },
    async setPullBase(): Promise<SendResult> {
      return { ok: true };
    },
    async updatePrBranch(): Promise<SendResult> {
      return { ok: true };
    },
    async requeueCiCheck(): Promise<SendResult> {
      return { ok: true };
    },
    async deleteBranch(): Promise<SendResult> {
      return { ok: true };
    },
  };
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    gitObserver: new FakeGitObserver(),
    backend: new FakePtyBackend(),
    sink: failingSink,
  });
  await system.executor.execute('cyc', statePlan(7, 'In Review'));

  const decision = system.store.decisions.listDecisions().find((d) => d.action.type === 'set_work_item_state');
  assert.equal(decision!.outcome, 'rejected');
  assert.match(decision!.detail, /Failed to set work item #7 state: boom/);
  assert.equal(system.store.escalations.listOpenEscalations().length, 0);
  system.store.close();
});

function walkSystem(
  states: Partial<Pick<Config, 'issuePickupStates' | 'issueInProgressState' | 'issueInReviewState'>>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-progress-'));
  const config = loadConfig({
    prediction: { enabled: false },
    goalCriteria: { enabled: false },
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...states,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    gitObserver: new FakeGitObserver(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

async function trackedIssue(system: System, number: number, state: string): Promise<void> {
  system.connector.inject({ kind: 'new_issue', number, title: `Issue ${number}` });
  await system.connector.setWorkItemState({ number, state });
}

function transitions(system: System): { number: number; state: string; rule: string | null; cycleId: string }[] {
  const moves: { number: number; state: string; rule: string | null; cycleId: string }[] = [];
  for (const d of system.store.decisions.listDecisions()) {
    if (d.action.type !== 'set_work_item_state') continue;
    const { number, state } = d.action;
    assert.equal(typeof number, 'number');
    assert.equal(typeof state, 'string');
    moves.push({ number: Number(number), state: String(state), rule: d.rule, cycleId: d.cycleId });
  }
  return moves.reverse();
}

test('in-progress: an item with a live work agent and no PR moves to the in-progress state', async () => {
  const system = walkSystem({
    issuePickupStates: ['Ready'],
    issueInProgressState: 'Doing',
    issueInReviewState: 'In Review',
  });
  await trackedIssue(system, 20, 'Ready');
  workedAsOnePart(system.store, 20);

  await system.harness.runCycle('manual');
  assert.deepEqual(transitions(system), [], 'nothing moves on the cycle that dispatches');
  assert.ok(
    system.store.tasks.listTasks().some((t) => t.originRef === 'issue:20:part:whole'),
    'a work agent was dispatched for the issue',
  );

  await system.harness.runCycle('manual');
  assert.deepEqual(
    transitions(system).map((t) => ({ number: t.number, state: t.state, rule: t.rule })),
    [{ number: 20, state: 'Doing', rule: 'work-item-in-progress' }],
  );

  await system.harness.runCycle('manual');
  assert.equal(transitions(system).length, 1, 'the move is not repeated once it has landed');
  system.store.close();
});

test('in-progress: a deliberation agent — a planner or an appraiser — moves nothing', async () => {
  const system = walkSystem({ issuePickupStates: ['Ready'], issueInProgressState: 'Doing' });
  await trackedIssue(system, 21, 'Ready');
  await trackedIssue(system, 22, 'Ready');
  failAppraisalOpen(system.store, 22);

  await system.harness.runCycle('manual');
  const origins = system.store.tasks.listTasks().map((t) => t.originRef);
  assert.ok(origins.includes('issue:21:appraisal'), 'an appraiser is on #21');
  assert.ok(origins.includes('issue:22:plan'), 'a planner is on #22');

  await system.harness.runCycle('manual');
  assert.deepEqual(transitions(system), [], 'a deliberation run leaves the item where it is');
  system.store.close();
});

test('in-progress: a planned item whose part is being worked is in progress, not in review', async () => {
  const system = walkSystem({
    issuePickupStates: ['Ready'],
    issueInProgressState: 'Doing',
    issueInReviewState: 'In Review',
  });
  await trackedIssue(system, 23, 'Ready');
  planWithOnePart(system.store, 23);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  const moves = transitions(system);
  assert.deepEqual(
    moves.map((m) => `${m.rule}:${m.state}`),
    ['work-item-in-progress:Doing'],
    'a part agent at work with no PR open is work in flight, which the plan alone does not override',
  );
  system.store.close();
});

test('in-progress and in-review never both fire for one item in one cycle', async () => {
  const system = walkSystem({
    issuePickupStates: ['Ready'],
    issueInProgressState: 'Doing',
    issueInReviewState: 'In Review',
  });
  await trackedIssue(system, 24, 'Ready');
  workedAsOnePart(system.store, 24);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'new_pr', number: 80, title: 'wip', branch: 'issue/24/whole', baseBranch: 'main' });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const moves = transitions(system);
  assert.deepEqual(
    moves.map((m) => `${m.rule}:${m.state}`),
    ['work-item-in-progress:Doing', 'work-item-in-review:In Review'],
    'the item walks Ready → Doing → In Review, one hop per rule',
  );
  const perCycle = new Map<string, string[]>();
  for (const m of moves) perCycle.set(m.cycleId, [...(perCycle.get(m.cycleId) ?? []), m.rule ?? '?']);
  for (const [cycleId, rules] of perCycle) {
    assert.ok(
      !(rules.includes('work-item-in-progress') && rules.includes('work-item-in-review')),
      `cycle ${cycleId} emitted both rules for one item: ${rules.join(', ')}`,
    );
  }
  system.store.close();
});

test('in-progress: nothing is emitted at all when the key is unset', async () => {
  const system = walkSystem({ issuePickupStates: ['Ready'], issueInReviewState: 'In Review' });
  await trackedIssue(system, 25, 'Ready');
  workedAsOnePart(system.store, 25);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.deepEqual(
    transitions(system).filter((m) => m.rule === 'work-item-in-progress'),
    [],
    'the rule is off without an in-progress state',
  );
  system.store.close();
});

test('in-review: a plan whose work has started, with nobody on it, parks the item in review', async () => {
  const system = walkSystem({
    issuePickupStates: ['Ready'],
    issueInProgressState: 'Doing',
    issueInReviewState: 'In Review',
  });
  await trackedIssue(system, 28, 'Ready');
  const plan = planWithOnePart(system.store, 28);
  const [part] = system.store.plans.listPlanParts(plan.id);
  system.store.plans.updatePlanPart(part!.id, { status: 'merged', branch: 'issue/28/whole' });

  await system.harness.runCycle('manual');
  assert.deepEqual(
    transitions(system).map((m) => `${m.rule}:${m.state}`),
    ['work-item-in-review:In Review'],
  );
  system.store.close();
});

test('a planned item parked in the review state stays there for the life of its plan', async () => {
  const system = walkSystem({ issuePickupStates: ['Ready'], issueInReviewState: 'In Review' });
  await trackedIssue(system, 26, 'In Review');
  planWithOnePart(system.store, 26);

  for (let i = 0; i < 5; i++) await system.harness.runCycle('manual');
  assert.deepEqual(
    transitions(system).map((m) => `${m.rule}:${m.state}`),
    [],
    'an in-flight plan reads as more_work, which must not send a decomposed item back to pickup',
  );
  system.store.close();
});

test('a work item moved too often in an hour is held and logged once', async () => {
  const { sink, states } = recordingSink();
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    gitObserver: new FakeGitObserver(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    sink,
  });
  for (let i = 0; i < 8; i++) await system.executor.execute(`cyc${i}`, statePlan(9, i % 2 ? 'New' : 'Reviewing'));

  assert.equal(states.length, 6, 'the sixth move is the last one sent');
  const held = system.store.decisions
    .listDecisions()
    .filter((d) => d.action.type === 'set_work_item_state' && d.outcome === 'skipped');
  assert.equal(held.length, 2);
  assert.match(held[0]!.detail, /moved 6 times in the last hour/);
  const logged = system.store.errors.listErrors().filter((e) => /work item #9/.test(e.message));
  assert.equal(logged.length, 1, 'the hold is logged once, not every pulse');
  system.store.close();
});

test('a shortfall on an item in the review state asks a human once and never moves it back', async () => {
  const system = walkSystem({ issuePickupStates: ['Ready'], issueInReviewState: 'In Review' });
  await trackedIssue(system, 27, 'In Review');
  planWithOnePart(system.store, 27);
  system.store.verdicts.recordShortfall({
    originRef: 'issue:27',
    cause: 'goal',
    summary: 'the metric the ticket asks for is missing',
    by: 'assessor',
  });

  for (let i = 0; i < 4; i++) await system.harness.runCycle('manual');
  assert.deepEqual(transitions(system), [], 'the harness never moves a work item backwards');
  const asked = system.store.escalations
    .listEscalations()
    .filter((e) => e.context.originRef === 'issue:27:review-stranded');
  assert.equal(asked.length, 1, 'the operator is told once, not every pulse');
  assert.match(asked[0]!.prompt, /Move it back to "Ready"/);
  system.store.close();
});
