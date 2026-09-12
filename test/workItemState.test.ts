import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink, SendResult, WorkItemStateInput } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { failAppraisalOpen, failPlanningOpen, planWithOnePart } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
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
  failPlanningOpen(system.store, 20);

  await system.harness.runCycle('manual');
  assert.deepEqual(transitions(system), [], 'nothing moves on the cycle that dispatches');
  assert.ok(
    system.store.tasks.listTasks().some((t) => t.originRef === 'issue:20'),
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

test('in-progress: a decomposed item belongs to the review state, not the in-progress one', async () => {
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
  assert.ok(
    !moves.some((m) => m.rule === 'work-item-in-progress'),
    `a decomposed item is the review state's business, got ${JSON.stringify(moves)}`,
  );
  assert.ok(
    moves.some((m) => m.rule === 'work-item-in-review' && m.state === 'In Review'),
    'the decomposed item is parked in the review state',
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
  failPlanningOpen(system.store, 24);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'new_pr', number: 80, title: 'wip', branch: 'issue/24', baseBranch: 'main' });
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
  failPlanningOpen(system.store, 25);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.deepEqual(transitions(system), [], 'the rule is off without an in-progress state');
  system.store.close();
});
