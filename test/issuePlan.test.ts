import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_PLANNING, planBranch, planOrigin, resolvePlanRoute } from '../src/plans/planning.js';
import { PLAN_FILE } from '../src/plans/planDocument.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Decision, Issue, Plan, PlanPart, WorldSnapshot } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import { planWithOnePart, pastTheFunnel, spentAppraisalAttempts, failAppraisalOpen } from './support/plans.js';

const enabled = DEFAULT_PLANNING;

function plan(status: Plan['status']): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status,
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function part(slug: string, seq: number, overrides: Partial<PlanPart> = {}): PlanPart {
  return {
    id: `plan_1:${slug}`,
    planId: 'plan_1',
    slug,
    seq,
    title: `The ${slug} part`,
    scope: `src/${slug}/`,
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    touches: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

test('a persisted verdict decides the route; an unplanned issue awaits a planner', () => {
  const v = { kind: 'dispatch' } as const;
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: v }), {
    route: 'planning',
    planner: 'dispatch',
  });
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: { kind: 'cooldown' } }), {
    route: 'planning',
    planner: 'cooldown',
  });
  for (const status of ['active', 'complete', 'abandoned'] as const) {
    for (const existingParts of [1, 2, 8]) {
      assert.deepEqual(resolvePlanRoute({ plan: plan(status), verdict: v, existingParts }), { route: 'parts' });
    }
  }
  assert.equal(resolvePlanRoute({ plan: plan('planning'), verdict: v }).route, 'planning');
});

test('a planner that spends its attempt cap fails the issue open to unplanned pickup', () => {
  for (const verdict of [{ kind: 'escalate', attempts: 3 }, { kind: 'hold' }] as const) {
    assert.deepEqual(resolvePlanRoute({ plan: null, verdict }), { route: 'unplanned' });
  }
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: { kind: 'hold' }, existingParts: 2 }), { route: 'parts' });
});

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
    ...overrides,
  };
}

function world(issues: Issue[]): WorldSnapshot {
  return { takenAt: '2026-07-25T12:00:00.000Z', pullRequests: [], issues };
}

function context(issues: Issue[], extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: world(issues),
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    ...extra,
    recentDecisions: [...issues.flatMap((i) => spentAppraisalAttempts(i.number)), ...(extra.recentDecisions ?? [])],
  };
}

test('rule `issue-plan` dispatches a planner instead of a pickup, on its own branch', async () => {
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(context([issue(12)]));
  assert.equal(result.actions.length, 1, 'the planner replaces the pickup, it does not join it');
  const action = result.actions[0]!;
  assert.equal(action.type, 'dispatch_code_agent');
  assert.equal(action.rule, 'issue-plan');
  assert.equal(action.originRef, planOrigin(12));
  assert.equal(action.type === 'dispatch_code_agent' && action.branch, planBranch(12));
  assert.equal(planBranch(12), 'plan/issue/12');
  assert.match(action.type === 'dispatch_code_agent' ? action.prompt : '', new RegExp(PLAN_FILE.replace('.', '\\.')));
  assert.ok(DISPATCH_RULES['issue-plan'], 'the rule is in the registry the cockpit ships');
});

test('planners rank ahead of pickups for scarce headroom', async () => {
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
    context([issue(7), issue(12)], { recentDecisions: pastTheFunnel(7), agentHeadroom: 1 }),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.rule, q.status]),
    [
      ['issue-plan', 'dispatching'],
      ['issue-pickup', 'waiting'],
    ],
  );
});

test('rule `issue-pickup` fires only for the unplanned arm, and is unchanged for it', async () => {
  const dispatcher = new RuleDispatcher({}, {}, undefined, 'main', enabled);
  const plans: Plan[] = [{ ...plan('active'), id: 'plan_9', originRef: 'issue:9' }];
  const planParts = [{ ...part('a', 1, { status: 'in_review', prNumber: 21 }), id: 'plan_9:a', planId: 'plan_9' }];
  const planned = await dispatcher.decide(
    context([issue(7), issue(9)], { plans, planParts, recentDecisions: pastTheFunnel(7) }),
  );
  assert.deepEqual(
    planned.actions.map((a) => [a.rule, a.type === 'dispatch_code_agent' ? a.branch : null]),
    [['issue-pickup', 'issue/7']],
    'the planned issue is left to the part scheduler, however few parts it has',
  );

  const plain = await new RuleDispatcher().decide(context([issue(7)], { recentDecisions: pastTheFunnel(7) }));
  assert.deepEqual(planned.actions, plain.actions);
});

test('a spent planner attempt cap lets pickup run as it does today', async () => {
  const attempts: Decision[] = [1, 2, 3].map((n) => ({
    id: `dec_${n}`,
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', originRef: planOrigin(12), reason: 'plan it', rule: 'issue-plan' },
    outcome: 'executed',
    detail: '',
    rule: 'issue-plan',
    admission: null,
    createdAt: '2026-07-25T00:00:00.000Z',
  }));
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
    context([issue(12)], { recentDecisions: attempts }),
  );
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [['issue-pickup', 'dispatch_code_agent']],
    'the issue falls open to unplanned pickup rather than parking forever',
  );
});

function pickupCtx(extra: Partial<IssuePickupContext> = {}): IssuePickupContext {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-25T12:00:00.000Z',
    tasks: [],
    openPrs: [],
    headroom: 5,
    paused: false,
    ...extra,
    recentDecisions: [...spentAppraisalAttempts(12), ...(extra.recentDecisions ?? [])],
  };
}

test('the pickup verdict explains an issue parked in the funnel', () => {
  const on = {};
  assert.deepEqual(issuePickupStatus(issue(12), pickupCtx(on)), {
    eligible: false,
    status: 'planning',
    reasons: ['awaiting a planning agent'],
  });

  const running = pickupCtx({
    ...on,
    tasks: [
      {
        id: 'task_1',
        kind: 'code',
        title: 'Plan issue #12',
        branch: planBranch(12),
        originRef: planOrigin(12),
        originTitle: null,
        originSummary: null,
        dispatchReason: null,
        status: 'running',
        agentId: 'agent_1',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(issuePickupStatus(issue(12), running).reasons, ['planning agent running']);

  const split = pickupCtx({ ...on, plans: [plan('active')], planParts: [part('a', 1)] });
  assert.deepEqual(issuePickupStatus(issue(12), split), {
    eligible: false,
    status: 'planning',
    reasons: ['0/1 parts done'],
  });

  assert.equal(
    issuePickupStatus(issue(12), pickupCtx({ ...on, recentDecisions: pastTheFunnel(12) })).status,
    'eligible',
  );
});

function systemWithPlanning(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  assert.equal(config.planning.maxConcurrentPartsPerIssue, 2, 'planning deep-merges onto its defaults');
  return buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
}

test('an injected issue routes through the planner, and its verdict hands the issue back to pickup', async () => {
  const on = systemWithPlanning();
  on.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
  failAppraisalOpen(on.store, 1);
  await on.harness.runCycle('manual');
  const planTask = on.store.tasks.getTask(on.store.tasks.listTasks()[0]!.id);
  assert.equal(planTask?.branch, planBranch(1));
  assert.equal(planTask?.originRef, planOrigin(1));

  planWithOnePart(on.store, 1, 'Ship the thing');
  on.store.tasks.updateTask(planTask!.id, { status: 'done' });
  await on.harness.runCycle('manual');
  assert.deepEqual(
    on.store.tasks
      .listTasks()
      .map((t) => t.branch)
      .sort(),
    ['issue/1/whole', planBranch(1)].sort(),
  );
  on.store.close();
});
