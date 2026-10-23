import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_PLANNING, planBranch, planOrigin, resolvePlanRoute } from '../src/plans/planning.js';
import { PLAN_FILE } from '../src/plans/planDocument.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Action, Decision, Issue, IssueInvestigation, Plan, PlanPart, WorldSnapshot } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import {
  planWithOnePart,
  onePartPlanRows,
  spentAppraisalAttempts,
  spentPlannerAttempts,
  failAppraisalOpen,
} from './support/plans.js';

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

test('a planner that spends its attempt cap escalates once, then holds', () => {
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: { kind: 'escalate', attempts: 3 } }), {
    route: 'escalated',
    raise: { attempts: 3 },
  });
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: { kind: 'hold' } }), { route: 'escalated', raise: null });
});

test('a capped replan with existing parts falls back to its parts', () => {
  for (const verdict of [{ kind: 'escalate', attempts: 3 }, { kind: 'hold' }] as const) {
    assert.deepEqual(resolvePlanRoute({ plan: null, verdict, existingParts: 2 }), { route: 'parts' });
    assert.deepEqual(resolvePlanRoute({ plan: plan('planning'), verdict, existingParts: 2 }), { route: 'parts' });
  }
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

test('rule `issue-plan` dispatches a planner, and only a planner, on its own branch', async () => {
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(context([issue(12)]));
  assert.equal(result.actions.length, 1, 'nothing is implemented before the plan');
  const action = result.actions[0]!;
  assert.equal(action.type, 'dispatch_code_agent');
  assert.equal(action.rule, 'issue-plan');
  assert.equal(action.originRef, planOrigin(12));
  assert.equal(action.type === 'dispatch_code_agent' && action.branch, planBranch(12));
  assert.equal(planBranch(12), 'plan/issue/12');
  assert.match(action.type === 'dispatch_code_agent' ? action.prompt : '', new RegExp(PLAN_FILE.replace('.', '\\.')));
  assert.ok(DISPATCH_RULES['issue-plan'], 'the rule is in the registry the cockpit ships');
});

test('planners rank ahead of plan parts for scarce headroom', async () => {
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(7), issue(12)], { ...onePartPlanRows(7), agentHeadroom: 1 }),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.rule, q.status]),
    [
      ['issue-plan', 'dispatching'],
      ['plan-part', 'waiting'],
    ],
  );
});

function escalations(actions: Action[]): Action[] {
  return actions.filter((a) => a.type === 'escalate_to_human');
}

function acted(actions: Action[]): Action[] {
  return actions.filter((a) => a.type !== 'no_op');
}

test('a planned issue is left to the part scheduler, and the retired `issue-pickup` never fires', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const plans: Plan[] = [{ ...plan('active'), id: 'plan_9', originRef: 'issue:9' }];
  const planParts = [{ ...part('a', 1, { status: 'in_review', prNumber: 21 }), id: 'plan_9:a', planId: 'plan_9' }];
  const result = await dispatcher.decide(
    context([issue(7), issue(9)], { plans, planParts, recentDecisions: spentPlannerAttempts(7) }),
  );
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [['issue-plan', 'escalate_to_human']],
    'the planned issue is left to the part scheduler, however few parts it has',
  );
  assert.ok(!result.actions.some((a) => a.rule === 'issue-pickup'));
  assert.ok(!(result.upcoming ?? []).some((q) => q.rule === 'issue-pickup'));
});

test('a capped planner with no plan escalates once and dispatches nothing', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const result = await dispatcher.decide(context([issue(12)], { recentDecisions: spentPlannerAttempts(12) }));
  assert.equal(result.actions.length, 1, 'no implementation agent, and no planner');
  const [escalation] = escalations(result.actions);
  assert.ok(escalation && escalation.type === 'escalate_to_human');
  assert.equal(escalation.rule, 'issue-plan');
  assert.equal(escalation.admission, 'cooldown-escalate');
  assert.deepEqual(escalation.context, { originRef: planOrigin(12), taskTitle: 'Plan issue #12' });
  assert.equal(
    escalation.prompt,
    defaultPromptTemplates().render('issue-plan-escalation', {
      number: 12,
      title: 'Issue 12',
      attempts: DEFAULT_COOLDOWN.maxAttempts,
    }),
  );
});

test('once escalated, a capped planner holds and raises nothing more', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const first = await dispatcher.decide(context([issue(12)], { recentDecisions: spentPlannerAttempts(12) }));
  const raised: Decision = {
    id: 'dec_escalation',
    cycleId: 'cyc_escalation',
    action: first.actions[0]!,
    outcome: 'executed',
    detail: '',
    rule: 'issue-plan',
    admission: 'cooldown-escalate',
    createdAt: '2026-07-25T01:00:00.000Z',
  };
  const second = await dispatcher.decide(
    context([issue(12)], { recentDecisions: [...spentPlannerAttempts(12), raised] }),
  );
  assert.deepEqual(acted(second.actions), []);
});

test('a capped replan with existing parts raises no escalation and no planner', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const result = await dispatcher.decide(
    context([issue(12)], {
      plans: [plan('planning')],
      planParts: [part('a', 1, { status: 'in_review', prNumber: 21 })],
      recentDecisions: spentPlannerAttempts(12, '2026-07-25T01:00:00.000Z'),
    }),
  );
  assert.deepEqual(escalations(result.actions), []);
  assert.ok(!result.actions.some((a) => a.rule === 'issue-plan'));
});

test('a capped planner raises no escalation while an appraisal holds the issue', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const result = await dispatcher.decide({
    ...context([]),
    world: world([issue(12)]),
    recentDecisions: spentPlannerAttempts(12),
  });
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [['issue-appraisal', 'dispatch_code_agent']],
  );
});

test('a capped planner raises no escalation while an investigation holds the issue', async () => {
  const labelled = issue(12, { labels: ['investigate'] });
  const investigation: IssueInvestigation = {
    originRef: 'issue:12',
    goalRef: goalFingerprint(labelled.title, labelled.body),
    by: 'a1',
    reproduction: 'Run it.',
    rootCause: 'A bug.',
    confidence: 'high',
    locations: 'src/x.ts:1',
    blastRadius: 'Only x.',
    recommendation: 'plan',
    decidedAt: '2026-07-25T00:00:00.000Z',
    resolution: null,
    resolvedAt: null,
  };
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const result = await dispatcher.decide(
    context([labelled], { investigations: [investigation], recentDecisions: spentPlannerAttempts(12) }),
  );
  assert.deepEqual(acted(result.actions), [], 'held for the operator: no escalation, and not re-investigated');
});

function pickupCtx(extra: Partial<IssuePickupContext> = {}): IssuePickupContext {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' },
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

  assert.deepEqual(issuePickupStatus(issue(12), pickupCtx({ ...on, recentDecisions: spentPlannerAttempts(12) })), {
    eligible: false,
    status: 'escalated',
    reasons: ['3 planner attempts wrote no plan — escalated to a human'],
  });
});

function systemWithPlanning(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    prediction: { enabled: false },
    goalCriteria: { enabled: false },
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

test('an injected issue routes through the planner, and its plan hands the issue to the part scheduler', async () => {
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
