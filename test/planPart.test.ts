import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import {
  bySlug,
  dependenciesOf,
  dependencySatisfied,
  partBase,
  partBranch,
  partDepth,
  partHasWork,
  partOrigin,
  partOutcomeKind,
  partOutcomeNote,
  partSettled,
  partsToRetire,
  siblingContext,
} from '../src/plans/parts.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Decision, Issue, Plan, PlanPart, PullRequest, WorldSnapshot } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import { pastTheFunnel, spentAppraisalAttempts } from './support/plans.js';

const enabled = { ...DEFAULT_PLANNING, enabled: true };

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema must land before the code that reads it.',
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
    ...overrides,
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

function world(issues: Issue[], pullRequests: PullRequest[] = []): WorldSnapshot {
  return { takenAt: '2026-07-25T12:00:00.000Z', pullRequests, issues };
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

test('a part gets its own origin and a branch under the issue', () => {
  assert.equal(partOrigin(12, 'schema'), 'issue:12:part:schema');
  assert.equal(partBranch(12, 'schema'), 'issue/12/schema');
});

test('depth is the chain length, and the base follows the dependency state', () => {
  const parts = [part('a', 1), part('b', 2, { dependsOn: ['a'] }), part('c', 3, { dependsOn: ['b'] })];
  const index = bySlug(parts);
  assert.deepEqual(
    parts.map((p) => partDepth(p, index)),
    [0, 1, 2],
  );
  assert.equal(partBase(parts[0]!, index, 12, 'main'), 'main');
  assert.equal(partBase(parts[1]!, index, 12, 'main'), 'issue/12/a');
  const merged = bySlug([part('a', 1, { status: 'merged' }), parts[1]!]);
  assert.equal(partBase(parts[1]!, merged, 12, 'main'), 'main');
});

test('dependenciesOf returns every declared dependency, skipping slugs the plan no longer holds', () => {
  const parts = [
    part('schema', 1),
    part('api', 2),
    part('wire', 3, { dependsOn: ['schema', 'api', 'dropped-by-a-replan'] }),
  ];
  const index = bySlug(parts);
  assert.deepEqual(
    dependenciesOf(parts[2]!, index).map((p) => p.slug),
    ['schema', 'api'],
  );
  assert.deepEqual(dependenciesOf(parts[0]!, index), []);
});

test('partDepth is the longest path, so a rejoin never sorts ahead of what it waits on', () => {
  const parts = [
    part('pr1', 1),
    part('pr2', 2, { dependsOn: ['pr1'] }),
    part('pr3', 3, { dependsOn: ['pr1'] }),
    part('pr4', 4, { dependsOn: ['pr2'] }),
    part('pr5', 5, { dependsOn: ['pr3', 'pr4'] }),
  ];
  const index = bySlug(parts);
  assert.deepEqual(
    parts.map((p) => partDepth(p, index)),
    [0, 1, 1, 2, 3],
  );
});

test('partDepth terminates on a cycle the store somehow holds', () => {
  const parts = [part('a', 1, { dependsOn: ['b'] }), part('b', 2, { dependsOn: ['a'] })];
  const index = bySlug(parts);
  for (const p of parts) assert.equal(Number.isFinite(partDepth(p, index)), true);
});

test('a rejoin bases on the integration branch; one dependency still in flight is stacked on', () => {
  const wire = part('wire', 3, { dependsOn: ['schema', 'api'] });

  const settled = bySlug([
    part('schema', 1, { status: 'merged', branch: 'issue/12/schema' }),
    part('api', 2, { status: 'concluded', outcomeKind: 'report', branch: null }),
    wire,
  ]);
  assert.equal(partBase(wire, settled, 12, 'main'), 'main');

  const oneOpen = bySlug([
    part('schema', 1, { status: 'merged', branch: 'issue/12/schema' }),
    part('api', 2, { status: 'in_review', branch: 'issue/12/api' }),
    wire,
  ]);
  assert.equal(partBase(wire, oneOpen, 12, 'main'), 'issue/12/api');
});

test('sibling context separates work that exists from work that is not yours', () => {
  const parts = [
    part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' }),
    part('b', 2, { status: 'ready' }),
    part('c', 3, { status: 'pending' }),
  ];
  const { done, remaining } = siblingContext(parts, parts[1]!, '#');
  assert.match(done, /The a part \[a, merged \(PR #40\)\]/);
  assert.doesNotMatch(done, /\[b,/, 'a part is never told about itself');
  assert.match(remaining, /\[c, pending\]/);
  assert.match(siblingContext(parts, parts[0]!, '#').done, /Nothing has landed yet/);
});

test('rule `plan-part` dispatches a ready part on its own branch, based on its dependency', async () => {
  const parts = [
    part('schema', 1, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 }),
    part('dispatcher', 2, { dependsOn: ['schema'], status: 'ready' }),
  ];
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(12)], { plans: [plan()], planParts: parts }),
  );
  assert.equal(result.actions.length, 1);
  const action = result.actions[0]!;
  assert.equal(action.type, 'dispatch_code_agent');
  if (action.type !== 'dispatch_code_agent') return;
  assert.equal(action.rule, 'plan-part');
  assert.equal(action.originRef, 'issue:12:part:dispatcher');
  assert.equal(action.branch, 'issue/12/dispatcher');
  assert.equal(action.base, 'main', 'the dependency merged, so there is nothing to stack on');
  assert.equal(action.partId, 'plan_1:dispatcher');
  assert.match(action.prompt, /The schema part \[schema, merged \(PR #40\)\]/);
  assert.match(action.prompt, /"part of #12" and never as "closes #12"/);
  assert.ok(DISPATCH_RULES['plan-part'], 'the rule is in the registry the cockpit ships');
});

test('a part stacks on its dependency while that dependency is still open', async () => {
  const parts = [
    part('schema', 1, { status: 'in_review', branch: 'issue/12/schema', prNumber: 40 }),
    part('dispatcher', 2, { dependsOn: ['schema'], status: 'ready' }),
  ];
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(12)], { plans: [plan()], planParts: parts }),
  );
  const action = result.actions[0]!;
  assert.equal(action.type === 'dispatch_code_agent' && action.base, 'issue/12/schema');
  assert.match(
    action.type === 'dispatch_code_agent' ? action.prompt : '',
    /into issue\/12\/schema/,
    'the PR must target the branch it stacks on, not the default branch',
  );
});

test('parts rank after planners, before pickups, bottom of the stack first', async () => {
  const plans: Plan[] = [{ ...plan(), id: 'plan_9', originRef: 'issue:9' }];
  const parts = [
    { ...part('b', 2, { dependsOn: ['a'] }), id: 'plan_9:b', planId: 'plan_9' },
    { ...part('a', 1), id: 'plan_9:a', planId: 'plan_9' },
  ];
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(7), issue(9), issue(14)], {
      plans,
      planParts: parts,
      agentHeadroom: 0,
      recentDecisions: pastTheFunnel(14),
    }),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.rule, q.origin]),
    [
      ['issue-plan', 'issue:7:plan'],
      ['plan-part', 'issue:9:part:a'],
      ['plan-part', 'issue:9:part:b'],
      ['issue-pickup', 'issue:14'],
    ],
  );
});

test('maxConcurrentPartsPerIssue caps how many parts of one plan get agents', async () => {
  const parts = [part('a', 1), part('b', 2), part('c', 3)];
  const dispatcher = new RuleDispatcher({
    defaultBranch: 'main',
    planning: { ...enabled, maxConcurrentPartsPerIssue: 2 },
  });
  const result = await dispatcher.decide(context([issue(12)], { plans: [plan()], planParts: parts }));
  assert.deepEqual(
    result.actions.map((a) => (a.type === 'dispatch_code_agent' ? a.branch : a.type)),
    ['issue/12/a', 'issue/12/b'],
    'the third ready part waits, even though there is headroom for it',
  );

  const staffed = await dispatcher.decide(
    context([issue(12)], {
      plans: [plan()],
      planParts: parts,
      tasks: [task('task_a', 'issue/12/a', partOrigin(12, 'a'))],
    }),
  );
  assert.deepEqual(
    staffed.actions.map((a) => (a.type === 'dispatch_code_agent' ? a.branch : a.type)),
    ['issue/12/b'],
  );
});

test('a cooling part does not consume a concurrency slot', async () => {
  const parts = [part('a', 1), part('b', 2), part('c', 3)];
  const recentExecuted: Decision = {
    id: 'dec_1',
    cycleId: 'cyc',
    action: {
      type: 'dispatch_code_agent',
      originRef: partOrigin(12, 'a'),
      reason: 'part a',
      rule: 'plan-part',
    },
    outcome: 'executed',
    detail: '',
    rule: 'plan-part',
    admission: null,
    createdAt: '2026-07-25T11:50:00.000Z',
  };
  const dispatcher = new RuleDispatcher({
    defaultBranch: 'main',
    planning: { ...enabled, maxConcurrentPartsPerIssue: 2 },
  });
  const result = await dispatcher.decide(
    context([issue(12)], {
      plans: [plan()],
      planParts: parts,
      recentDecisions: [recentExecuted],
    }),
  );
  assert.deepEqual(
    result.actions.map((a) => (a.type === 'dispatch_code_agent' ? a.branch : a.type)),
    ['issue/12/b', 'issue/12/c'],
    'parts b and c get dispatched even though part a is cooling, because cooling does not consume a slot',
  );
});

test('each part gets its own throttle, and a repeatedly failing one escalates', async () => {
  const attempts: Decision[] = [1, 2, 3].map((n) => ({
    id: `dec_${n}`,
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', originRef: partOrigin(12, 'a'), reason: 'part a', rule: 'plan-part' },
    outcome: 'executed',
    detail: '',
    rule: 'plan-part',
    admission: null,
    createdAt: '2026-07-25T00:00:00.000Z',
  }));
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(12)], { plans: [plan()], planParts: [part('a', 1), part('b', 2)], recentDecisions: attempts }),
  );
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.admission, a.type]),
    [
      ['plan-part', 'cooldown-escalate', 'escalate_to_human'],
      ['plan-part', null, 'dispatch_code_agent'],
    ],
    'the failing part escalates rather than looping; its sibling is untouched by that origin',
  );
  const escalation = result.actions[0]!;
  assert.match(escalation.type === 'escalate_to_human' ? escalation.prompt : '', /Part "The a part" of issue #12/);
  assert.equal(
    result.actions[1]!.type === 'dispatch_code_agent' && result.actions[1]!.branch,
    'issue/12/b',
    'per-part origins mean one part is throttled without throttling the plan',
  );
});

test('parts inherit the parent issue, not its PR: un-watching stops them, a part PR does not', async () => {
  const pickup = {
    watchLabel: 'lubbdubb-watch',
    priorityLabels: {},
    defaultPriority: 0,
  };
  const dispatcher = new RuleDispatcher({ pickup, defaultBranch: 'main', planning: enabled });
  const watched = issue(12, { labels: ['lubbdubb-watch'] });

  const linked = { ...watched, linkedPrNumber: 41 };
  const prs: PullRequest[] = [
    { id: 'pr_41', number: 41, title: 'Part a', branch: 'issue/12/a', ciStatus: 'passing', unresolvedComments: [] },
  ];
  const scheduled = await dispatcher.decide({
    ...context([linked], {
      plans: [plan()],
      planParts: [part('a', 1, { status: 'in_review', prNumber: 41 }), part('b', 2)],
    }),
    world: world([linked], prs),
  });
  assert.deepEqual(
    scheduled.actions
      .filter((a) => a.rule === 'plan-part')
      .map((a) => (a.type === 'dispatch_code_agent' ? a.branch : '')),
    ['issue/12/b'],
  );

  const dropped = { ...watched, labels: [] };
  const stopped = await dispatcher.decide(context([dropped], { plans: [plan()], planParts: [part('a', 1)] }));
  assert.deepEqual(
    stopped.actions.map((a) => a.rule),
    ['idle'],
  );
});

test('the cockpit chip reports plan progress, not whichever part opened a PR last', () => {
  const parts = [part('a', 1, { status: 'merged' }), part('b', 2, { status: 'in_review', prNumber: 41 })];
  const ctx: IssuePickupContext = {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-25T12:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    openPrs: [
      { id: 'pr_41', number: 41, title: 'Part b', branch: 'issue/12/b', ciStatus: 'passing', unresolvedComments: [] },
    ],
    plans: [plan()],
    planParts: parts,
    headroom: 5,
    paused: false,
  };
  assert.deepEqual(issuePickupStatus(issue(12, { linkedPrNumber: 41 }), ctx), {
    eligible: false,
    status: 'planning',
    reasons: ['1/2 parts done'],
  });
});

test('rule `pr-merge-ready` holds a stacked PR and merges one that targets the integration branch', async () => {
  const settled = { ciStatus: 'passing' as const, approved: true, mergeable: true, unresolvedComments: [] };
  const prs: PullRequest[] = [
    { id: 'pr_40', number: 40, title: 'schema', branch: 'issue/12/schema', baseBranch: 'main', ...settled },
    { id: 'pr_41', number: 41, title: 'api', branch: 'issue/12/api', baseBranch: 'issue/12/schema', ...settled },
  ];
  const result = await new RuleDispatcher().decide({ ...context([]), world: world([], prs) });
  assert.deepEqual(
    result.actions.filter((a) => a.type === 'merge_pr').map((a) => (a.type === 'merge_pr' ? a.prNumber : 0)),
    [40],
    'the child waits for the provider to retarget it when its parent merges',
  );
});

function task(id: string, branch: string, originRef: string): DispatchContext['tasks'][number] {
  return {
    id,
    kind: 'code',
    title: 'part',
    branch,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function systemWithParts(): { system: System; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  return { system, repoRoot };
}

test('a persisted plan turns into real part branches, and the rows record it', async () => {
  const { system, repoRoot } = systemWithParts();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.' });
  const stored = system.store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  system.store.plans.upsertPlanParts(stored.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);
  await system.harness.runCycle('manual');

  const parts = system.store.plans.listPlanParts(stored.id);
  assert.deepEqual(
    parts.map((p) => [p.slug, p.status, p.branch]),
    [
      ['schema', 'dispatched', 'issue/12/schema'],
      ['api', 'dispatched', 'issue/12/api'],
    ],
  );
  assert.ok(
    parts.every((p) => p.taskId !== null),
    'each part records the task its agent runs under',
  );
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(branches, /issue\/12\/schema/);
  assert.match(branches, /issue\/12\/api/);
  assert.deepEqual(system.store.escalations.listProposals(), []);
  assert.deepEqual(system.store.escalations.listOpenEscalations(), []);
  system.store.close();
});

test('partSettled counts both terminals, and partOutcomeKind derives code from a merge', () => {
  assert.equal(partSettled(part('a', 1, { status: 'merged' })), true);
  assert.equal(partSettled(part('a', 1, { status: 'concluded' })), true);
  assert.equal(partSettled(part('a', 1, { status: 'in_review' })), false);
  assert.equal(partSettled(part('a', 1, { status: 'retired' })), false);

  assert.equal(partOutcomeKind(part('a', 1, { status: 'merged' })), 'code');
  assert.equal(partOutcomeKind(part('a', 1, { status: 'concluded', outcomeKind: 'report' })), 'report');
  assert.equal(partOutcomeKind(part('a', 1, { status: 'dispatched' })), null);
});

test('a concluded dependency is satisfied, and its dependent bases on the default branch', () => {
  const dep = part('probe', 1, { status: 'concluded', outcomeKind: 'report', branch: null });
  const dependent = part('build', 2, { dependsOn: ['probe'] });
  const index = bySlug([dep, dependent]);
  assert.equal(
    dependencySatisfied(dep, () => false),
    true,
  );
  assert.equal(partBase(dependent, index, 12, 'main'), 'main');
});

test('an amendment cannot retire a concluded part', () => {
  const concluded = part('probe', 1, { status: 'concluded', outcomeKind: 'determination' });
  assert.equal(partHasWork(concluded), true);
  assert.deepEqual(partsToRetire([concluded], []), []);
});

test('a part planned to produce no code is told how to finish, appended not interpolated', () => {
  assert.equal(partOutcomeNote(part('a', 1, { expectedKind: null })), '');
  assert.equal(partOutcomeNote(part('a', 1, { expectedKind: 'code' })), '');
  const note = partOutcomeNote(part('a', 1, { expectedKind: 'report' }));
  assert.match(note, /conclude_part/);
  assert.match(note, /report/);
  assert.doesNotMatch(note, /\{/);
});

test('a part concludes without a PR, its plan completes, and a second call changes nothing', () => {
  const { system } = systemWithParts();
  const stored = system.store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Investigate',
    status: 'active',
    reason: 'Measure before building.',
  });
  system.store.plans.upsertPlanParts(stored.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'report',
    },
  ]);
  const row = system.store.plans.listPlanParts(stored.id)[0]!;
  assert.equal(row.expectedKind, 'report');
  assert.equal(row.outcomeKind, null);

  system.store.plans.updatePlanPart(row.id, { status: 'dispatched' });
  const done = system.store.plans.concludePlanPart(row.id, {
    kind: 'determination',
    ref: 'finding:f_1',
    summary: 'Already fixed by #98.',
  });
  assert.equal(done?.status, 'concluded');
  assert.equal(done?.outcomeKind, 'determination');
  assert.equal(done?.outcomeRef, 'finding:f_1');
  assert.equal(done?.outcomeSummary, 'Already fixed by #98.');

  assert.equal(system.store.plans.rollUpPlanStatus(stored.id)?.status, 'complete');

  assert.equal(system.store.plans.concludePlanPart(row.id, { kind: 'report', ref: null, summary: 'again' }), null);
  system.store.close();
});

test('an amendment re-declaring a concluded part leaves what it produced alone', () => {
  const { system } = systemWithParts();
  const stored = system.store.plans.upsertPlan({ originRef: 'issue:12', title: 'T', status: 'active', reason: 'r' });
  const declare = (expectedKind: 'code' | 'report' | null) =>
    system.store.plans.upsertPlanParts(stored.id, [
      {
        slug: 'probe',
        seq: 1,
        title: 'Investigate',
        scope: 'src/',
        dependsOn: [],
        rationale: null,
        acceptance: null,
        touches: [],
        size: null,
        expectedKind,
      },
    ]);
  declare('report');
  const row = system.store.plans.listPlanParts(stored.id)[0]!;
  system.store.plans.updatePlanPart(row.id, { status: 'dispatched' });
  system.store.plans.concludePlanPart(row.id, { kind: 'report', ref: null, summary: 'Findings in docs/perf.md' });

  declare('code');
  const after = system.store.plans.listPlanParts(stored.id)[0]!;
  assert.equal(after.expectedKind, 'code');
  assert.equal(after.outcomeKind, 'report');
  assert.equal(after.outcomeSummary, 'Findings in docs/perf.md');
  assert.equal(after.status, 'concluded');
  system.store.close();
});

test('the plan comment never describes a non-code part as merged, and names a mismatch', () => {
  const parts = [
    part('a', 1, { title: 'Build it', status: 'merged', prNumber: 7 }),
    part('b', 2, {
      title: 'Write it up',
      status: 'concluded',
      expectedKind: 'report',
      touches: [],
      acceptanceMet: [],
      size: null,
      outcomeKind: 'report',
      outcomeSummary: 'Findings in docs/perf.md',
    }),
  ];
  const body = renderPlanComment(plan({ status: 'complete' }), parts, '#');
  assert.match(body, /all 2 parts finished/);
  assert.match(body, /Write it up.*report.*Findings in docs\/perf\.md/);
  assert.doesNotMatch(body, /Write it up.*merged/);

  const mismatched = renderPlanComment(
    plan({ status: 'complete' }),
    [
      part('a', 1, {
        title: 'Build it',
        status: 'concluded',
        expectedKind: 'code',
        touches: [],
        acceptanceMet: [],
        size: null,
        outcomeKind: 'determination',
        outcomeSummary: 'Already fixed by #98',
      }),
    ],
    '#',
  );
  assert.match(mismatched, /planned as code/);
});

function wedgedParts(): PlanPart[] {
  const blocked = {
    status: 'blocked' as const,
    blockedReason: 'The branch issue/12 exists, and git cannot create it.',
  };
  return [part('a', 1, blocked), part('b', 2, blocked)];
}

test('every part blocked asks a human once, and dispatches nobody', async () => {
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(12)], { plans: [plan()], planParts: wedgedParts() }),
  );
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [['plan-blocked', 'escalate_to_human']],
    'no agent is dispatched, because none could help',
  );
  const asked = result.actions[0]!;
  assert.equal(asked.type === 'escalate_to_human' && asked.context.originRef, 'issue:12:plan');
  const prompt = asked.type === 'escalate_to_human' ? asked.prompt : '';
  assert.match(prompt, /The branch issue\/12 exists/);
  assert.match(prompt, /Replan from the plan sheet/);
});

test('the wedge is asked once — an open item or a recent one both settle it', async () => {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', planning: enabled });
  const open = await dispatcher.decide(
    context([issue(12)], {
      plans: [plan()],
      planParts: wedgedParts(),
      openEscalations: [{ id: 'esc_1', context: { originRef: 'issue:12:plan' } } as never],
    }),
  );
  assert.ok(
    open.actions.every((a) => a.rule !== 'plan-blocked'),
    'an open item on the origin is the visible state',
  );

  const recent = await dispatcher.decide(
    context([issue(12)], {
      plans: [plan()],
      planParts: wedgedParts(),
      recentDecisions: [
        {
          id: 'dec_1',
          cycleId: 'cyc',
          action: { type: 'escalate_to_human', context: { originRef: 'issue:12:plan' }, reason: 'x' },
          outcome: 'executed',
          detail: '',
          rule: 'plan-blocked',
          createdAt: '2026-07-25T00:00:00.000Z',
        } as never,
      ],
    }),
  );
  assert.ok(recent.actions.every((a) => a.rule !== 'plan-blocked'));
});

test('an unapproved wedged plan is not escalated — the ask already carries it', async () => {
  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: enabled }).decide(
    context([issue(12)], { plans: [{ ...plan(), status: 'awaiting_approval' }], planParts: wedgedParts() }),
  );
  assert.deepEqual(
    result.actions.map((a) => a.rule),
    ['plan-approval'],
  );
});
