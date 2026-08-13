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

// -- the pure route ----------------------------------------------------------

const enabled = { ...DEFAULT_PLANNING, enabled: true };

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
    discussing: false,
    statusCommentRef: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

/** One part row — a plan's **shape**: a plan with none is being delivered whole. */
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
    taskId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

test('the funnel is out entirely when planning is disabled', () => {
  // Off must mean off: no plan row, no cooldown state and a spent attempt cap all
  // route straight to `single`, so rule `issue-pickup` is un-narrowed and today's path holds.
  for (const verdict of [{ kind: 'dispatch' }, { kind: 'cooldown' }, { kind: 'hold' }] as const) {
    assert.deepEqual(resolvePlanRoute({ planning: { ...DEFAULT_PLANNING, enabled: false }, plan: null, verdict }), {
      route: 'single',
      failedOpen: false,
    });
  }
});

test('a persisted verdict decides the route; an unplanned issue awaits a planner', () => {
  const v = { kind: 'dispatch' } as const;
  assert.deepEqual(resolvePlanRoute({ planning: enabled, plan: null, verdict: v }), {
    route: 'planning',
    planner: 'dispatch',
  });
  assert.deepEqual(resolvePlanRoute({ planning: enabled, plan: null, verdict: { kind: 'cooldown' } }), {
    route: 'planning',
    planner: 'cooldown',
  });
  // The single arm is a plan being delivered with no live parts — the shape, read
  // off the graph rather than off a status that could only ever be one or the other.
  assert.deepEqual(resolvePlanRoute({ planning: enabled, plan: plan('active'), verdict: v, existingParts: 0 }), {
    route: 'single',
    failedOpen: false,
  });
  for (const status of ['active', 'complete', 'abandoned'] as const) {
    assert.deepEqual(resolvePlanRoute({ planning: enabled, plan: plan(status), verdict: v, existingParts: 2 }), {
      route: 'parts',
    });
  }
  // A row back in `planning` is a replan in flight — a planner is owed again.
  assert.equal(resolvePlanRoute({ planning: enabled, plan: plan('planning'), verdict: v }).route, 'planning');
});

test('a planner that spends its attempt cap fails the issue open to single', () => {
  // Without this, narrowing rule `issue-pickup` turns any planner crash into a permanently
  // parked issue. `failedOpen` marks how it got there.
  for (const verdict of [{ kind: 'escalate', attempts: 3 }, { kind: 'hold' }] as const) {
    assert.deepEqual(resolvePlanRoute({ planning: enabled, plan: null, verdict }), {
      route: 'single',
      failedOpen: true,
    });
  }
});

// -- the dispatcher rule -----------------------------------------------------

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
    recentDecisions: [],
    ...extra,
  };
}

test('rule `issue-plan` dispatches a planner instead of a pickup, on its own branch', async () => {
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(context([issue(12)]));
  assert.equal(result.actions.length, 1, 'the planner replaces the pickup, it does not join it');
  const action = result.actions[0]!;
  assert.equal(action.type, 'dispatch_code_agent');
  assert.equal(action.rule, 'issue-plan');
  assert.equal(action.originRef, planOrigin(12));
  // A namespace of its own: `issue/12/plan` could not coexist with `issue/12` as a
  // git ref, and `issue/12` is exactly what a `single` verdict's agent will want.
  assert.equal(action.type === 'dispatch_code_agent' && action.branch, planBranch(12));
  assert.equal(planBranch(12), 'plan/issue/12');
  assert.match(action.type === 'dispatch_code_agent' ? action.prompt : '', new RegExp(PLAN_FILE.replace('.', '\\.')));
  assert.ok(DISPATCH_RULES['issue-plan'], 'the rule is in the registry the cockpit ships');
});

test('planners rank ahead of pickups for scarce headroom', async () => {
  // #7 is already planned as one PR (a pickup); #12 needs a planner. One slot: the
  // planner takes it, because a planner unblocks work.
  const plans: Plan[] = [{ ...plan('active'), id: 'plan_7', originRef: 'issue:7' }];
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
    context([issue(7), issue(12)], { plans, agentHeadroom: 1 }),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.rule, q.status]),
    [
      ['issue-plan', 'dispatching'],
      ['issue-pickup', 'waiting'],
    ],
  );
});

test('rule `issue-pickup` fires only for a `single` plan, and is unchanged for one', async () => {
  const dispatcher = new RuleDispatcher({}, {}, undefined, 'main', enabled);
  // #7 is being delivered whole (no parts); #9 is decomposed, and its part row is
  // what says so — the plan rows are identical.
  const plans: Plan[] = [
    { ...plan('active'), id: 'plan_7', originRef: 'issue:7' },
    { ...plan('active'), id: 'plan_9', originRef: 'issue:9' },
  ];
  // In review, so #9 is decomposed *and* has nothing for rule `plan-part` to
  // dispatch — the assertion is about which rule fires for #7.
  const planParts = [{ ...part('a', 1, { status: 'in_review', prNumber: 21 }), id: 'plan_9:a', planId: 'plan_9' }];
  const planned = await dispatcher.decide(context([issue(7), issue(9)], { plans, planParts }));
  assert.deepEqual(
    planned.actions.map((a) => [a.rule, a.type === 'dispatch_code_agent' ? a.branch : null]),
    [['issue-pickup', 'issue/7']],
    'the parts issue is left to the part scheduler; the single one is picked up as before',
  );

  // Byte-for-byte: the action a `single` plan produces is what today's dispatcher
  // produces for the same issue with no funnel at all.
  const today = await new RuleDispatcher().decide(context([issue(7)]));
  assert.deepEqual(planned.actions, today.actions);
});

test('a spent planner attempt cap lets pickup run as it does today', async () => {
  // Three executed planner dispatches for issue 12 and no plan to show for it.
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
    'the issue falls open to single rather than parking forever',
  );
});

// -- the per-issue verdict the cockpit renders -------------------------------

function pickupCtx(extra: Partial<IssuePickupContext> = {}): IssuePickupContext {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-25T12:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    openPrs: [],
    headroom: 5,
    paused: false,
    ...extra,
  };
}

test('the pickup verdict explains an issue parked in the funnel', () => {
  // Funnel off: unchanged.
  assert.equal(issuePickupStatus(issue(12), pickupCtx()).status, 'eligible');

  const on = { planning: enabled };
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
        prompt: 'p',
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

  // A `single` verdict falls through to the ordinary eligible verdict.
  assert.equal(issuePickupStatus(issue(12), pickupCtx({ ...on, plans: [plan('active')] })).status, 'eligible');
});

// -- end to end --------------------------------------------------------------

function systemWithPlanning(planningEnabled: boolean): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    planning: { enabled: planningEnabled } as never,
    // Pinned off: all three default **on** now, and this file is about something
    // else — an extra agent in front of each issue would change what these
    // assertions see. Each has its own tests.
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  assert.equal(config.planning.maxConcurrentPartsPerIssue, 2, 'planning deep-merges onto its defaults');
  return buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
}

test('an injected issue routes through the planner when the funnel is on, straight to pickup when off', async () => {
  const off = systemWithPlanning(false);
  off.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
  await off.harness.runCycle('manual');
  assert.deepEqual(
    off.store.listTasks().map((t) => t.branch),
    ['issue/1'],
  );
  off.store.close();

  const on = systemWithPlanning(true);
  on.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
  await on.harness.runCycle('manual');
  const planTask = on.store.listTasks()[0];
  assert.equal(planTask?.branch, planBranch(1));
  assert.equal(planTask?.originRef, planOrigin(1));

  // The planner's verdict, once persisted, hands the issue back to normal pickup —
  // and the planner never runs again, because the row is the memory.
  on.store.upsertPlan({ originRef: 'issue:1', title: 'Ship the thing', status: 'active', reason: 'One PR.' });
  on.store.updateTask(planTask!.id, { status: 'done' });
  await on.harness.runCycle('manual');
  assert.deepEqual(
    on.store
      .listTasks()
      .map((t) => t.branch)
      .sort(),
    ['issue/1', planBranch(1)].sort(),
  );
  on.store.close();
});
