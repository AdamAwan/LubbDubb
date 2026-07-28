import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
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

const enabled = { ...DEFAULT_PLANNING, enabled: true };

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema must land before the code that reads it.',
    risks: null,
    outOfScope: null,
    document: null,
    discussing: false,
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
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
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
  return { takenAt: '2026-07-25T12:00:00.000Z', pullRequests, issues, stories: [] };
}

function context(issues: Issue[], extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: world(issues),
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    steeringPriorities: [],
    agentHeadroom: 5,
    recentDecisions: [],
    ...extra,
  };
}

// -- the pure scheduling helpers ---------------------------------------------

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
  // No dependency -> the integration branch.
  assert.equal(partBase(parts[0]!, index, 12, 'main'), 'main');
  // Dependency still in flight -> stack on its branch. This is the whole point:
  // part b starts once a has *pushed*, not once a has merged.
  assert.equal(partBase(parts[1]!, index, 12, 'main'), 'issue/12/a');
  // Dependency merged -> back to the integration branch; nothing to stack on.
  const merged = bySlug([part('a', 1, { status: 'merged' }), parts[1]!]);
  assert.equal(partBase(parts[1]!, merged, 12, 'main'), 'main');
});

test('sibling context separates work that exists from work that is not yours', () => {
  const parts = [
    part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' }),
    part('b', 2, { status: 'ready' }),
    part('c', 3, { status: 'pending' }),
  ];
  const { done, remaining } = siblingContext(parts, parts[1]!);
  assert.match(done, /The a part \[a, merged \(PR #40\)\]/);
  assert.doesNotMatch(done, /\[b,/, 'a part is never told about itself');
  assert.match(remaining, /\[c, pending\]/);
  // The first part is told so plainly rather than being handed an empty list.
  assert.match(siblingContext(parts, parts[0]!).done, /Nothing has landed yet/);
});

// -- rule 4a -----------------------------------------------------------------

test('rule 4a dispatches a ready part on its own branch, based on its dependency', async () => {
  const parts = [
    part('schema', 1, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 }),
    part('dispatcher', 2, { dependsOn: ['schema'], status: 'ready' }),
  ];
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
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
  // Goal 3 of the design: a part agent knows what the others did and what remains.
  assert.match(action.prompt, /The schema part \[schema, merged \(PR #40\)\]/);
  // A part must never close the issue — the other parts still have to land.
  assert.match(action.prompt, /"part of #12" and never as "closes #12"/);
  assert.ok(DISPATCH_RULES['plan-part'], 'the rule is in the registry the cockpit ships');
});

test('a part stacks on its dependency while that dependency is still open', async () => {
  const parts = [
    part('schema', 1, { status: 'in_review', branch: 'issue/12/schema', prNumber: 40 }),
    part('dispatcher', 2, { dependsOn: ['schema'], status: 'ready' }),
  ];
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
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
  // #7 needs a planner, #9 is decomposed, #14 is a plain `single` pickup. One
  // ranked list: planner, then the plan bottom, then its dependent, then pickup.
  const plans: Plan[] = [
    { ...plan(), id: 'plan_9', originRef: 'issue:9' },
    { ...plan(), id: 'plan_14', originRef: 'issue:14', status: 'single' },
  ];
  const parts = [
    { ...part('b', 2, { dependsOn: ['a'] }), id: 'plan_9:b', planId: 'plan_9' },
    { ...part('a', 1), id: 'plan_9:a', planId: 'plan_9' },
  ];
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
    context([issue(7), issue(9), issue(14)], { plans, planParts: parts, agentHeadroom: 0 }),
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
  const dispatcher = new RuleDispatcher({}, {}, undefined, 'main', { ...enabled, maxConcurrentPartsPerIssue: 2 });
  const result = await dispatcher.decide(context([issue(12)], { plans: [plan()], planParts: parts }));
  assert.deepEqual(
    result.actions.map((a) => (a.type === 'dispatch_code_agent' ? a.branch : a.type)),
    ['issue/12/a', 'issue/12/b'],
    'the third ready part waits, even though there is headroom for it',
  );

  // The cap counts *agents*, so an already-staffed part uses one of the two slots.
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

test('each part gets its own throttle, and a repeatedly failing one escalates', async () => {
  // Three executed dispatches for part `a` and nothing to show for it.
  const attempts: Decision[] = [1, 2, 3].map((n) => ({
    id: `dec_${n}`,
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', originRef: partOrigin(12, 'a'), reason: 'part a', rule: 'plan-part' },
    outcome: 'executed',
    detail: '',
    rule: 'plan-part',
    createdAt: '2026-07-25T00:00:00.000Z',
  }));
  const result = await new RuleDispatcher({}, {}, undefined, 'main', enabled).decide(
    context([issue(12)], { plans: [plan()], planParts: [part('a', 1), part('b', 2)], recentDecisions: attempts }),
  );
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [
      ['cooldown-escalate', 'escalate_to_human'],
      ['plan-part', 'dispatch_code_agent'],
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

test('parts inherit the parent issue, not its PR: the ignore tag stops them, a part PR does not', async () => {
  const pickup = {
    watchLabel: 'lubbdubb-watch',
    ignoreLabel: 'lubbdubb-ignore',
    priorityLabels: {},
    defaultPriority: 0,
  };
  const dispatcher = new RuleDispatcher(pickup, {}, undefined, 'main', enabled);
  const watched = issue(12, { labels: ['lubbdubb-watch'] });

  // A part's PR is open and linked back to the issue — which is exactly what would
  // park the parent under the ordinary pickup gate. Parts must keep scheduling.
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

  // Tagged `-ignore` mid-flight: no *new* part is dispatched.
  const ignored = { ...watched, labels: ['lubbdubb-watch', 'lubbdubb-ignore'] };
  const stopped = await dispatcher.decide(context([ignored], { plans: [plan()], planParts: [part('a', 1)] }));
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
    // `linkedPrNumber` is sticky and points at a part's PR — the trap this ordering exists for.
    openPrs: [
      { id: 'pr_41', number: 41, title: 'Part b', branch: 'issue/12/b', ciStatus: 'passing', unresolvedComments: [] },
    ],
    plans: [plan()],
    planParts: parts,
    planning: enabled,
    headroom: 5,
    paused: false,
  };
  assert.deepEqual(issuePickupStatus(issue(12, { linkedPrNumber: 41 }), ctx), {
    eligible: false,
    status: 'planning',
    reasons: ['1/2 parts done'],
  });
});

// -- the merge gate a stack needs -------------------------------------------

test('rule 3 holds a stacked PR and merges one that targets the integration branch', async () => {
  // Brought forward from stage 4 deliberately: this is the first point at which
  // stacked PRs actually exist, and rule 3 unguarded would merge part 2 *into part
  // 1's branch* mid-flight.
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

// -- end to end --------------------------------------------------------------

function task(id: string, branch: string, originRef: string): DispatchContext['tasks'][number] {
  return {
    id,
    kind: 'code',
    title: 'part',
    prompt: 'p',
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

/** A throwaway git repo with one commit, so a real code dispatch can cut a worktree. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}

function systemWithParts(): { system: System; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot,
    // Pinned off: `requireApproval` now defaults on, and this test asserts the
    // ungated path (an `active` plan releases work with no proposal written).
    planning: { enabled: true, requireApproval: false } as never,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    // No remote on a throwaway repo, and no scripted branch reality needed here:
    // the parts below have no dependencies, so readiness is unconditional.
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  return { system, repoRoot };
}

test('a persisted plan turns into real part branches, and the rows record it', async () => {
  const { system, repoRoot } = systemWithParts();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.' });
  const stored = system.store.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  system.store.upsertPlanParts(stored.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
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
      expectedKind: null,
    },
  ]);
  // Reconciliation promotes both from `pending` to `ready` (no dependencies), and
  // the same cycle dispatches them — that same-pulse handover is intended.
  await system.harness.runCycle('manual');

  const parts = system.store.listPlanParts(stored.id);
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
  // `requireApproval` is pinned off above, which is *not* the default any more:
  // this is the ungated path, where an `active` plan is released work and the
  // approval gate writes nothing at all (issue #109 phase 3). The default's
  // behaviour is asserted in `planApproval.test.ts`; asserted here on the
  // existing path so the two arms are covered separately.
  assert.deepEqual(system.store.listProposals(), []);
  assert.deepEqual(system.store.listOpenEscalations(), []);
  system.store.close();
});

// -- Terminals that are not a merge (issue #160) ----------------------------

test('partSettled counts both terminals, and partOutcomeKind derives code from a merge', () => {
  assert.equal(partSettled(part('a', 1, { status: 'merged' })), true);
  assert.equal(partSettled(part('a', 1, { status: 'concluded' })), true);
  assert.equal(partSettled(part('a', 1, { status: 'in_review' })), false);
  // `retired` is not a terminal — it means "dropped before anything was started",
  // which is the opposite of a part that did its work and found nothing to build.
  assert.equal(partSettled(part('a', 1, { status: 'retired' })), false);

  assert.equal(partOutcomeKind(part('a', 1, { status: 'merged' })), 'code');
  assert.equal(partOutcomeKind(part('a', 1, { status: 'concluded', outcomeKind: 'report' })), 'report');
  assert.equal(partOutcomeKind(part('a', 1, { status: 'dispatched' })), null);
});

test('a concluded dependency is satisfied, and its dependent bases on the default branch', () => {
  // The guard that matters: a concluded part may never have pushed a branch at
  // all, so basing on it would hand WorktreeManager.ensure an unresolvable ref.
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
  // Appended text, never a template: an override that never learned a {kind}
  // placeholder would silently drop the one instruction the part needs.
  assert.doesNotMatch(note, /\{/);
});

test('a part concludes without a PR, its plan completes, and a second call changes nothing', () => {
  const { system } = systemWithParts();
  const stored = system.store.upsertPlan({
    originRef: 'issue:12',
    title: 'Investigate',
    status: 'active',
    reason: 'Measure before building.',
  });
  system.store.upsertPlanParts(stored.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: 'report',
    },
  ]);
  const row = system.store.listPlanParts(stored.id)[0]!;
  assert.equal(row.expectedKind, 'report');
  assert.equal(row.outcomeKind, null);

  system.store.updatePlanPart(row.id, { status: 'dispatched' });
  const done = system.store.concludePlanPart(row.id, {
    kind: 'determination',
    ref: 'finding:f_1',
    summary: 'Already fixed by #98.',
  });
  assert.equal(done?.status, 'concluded');
  assert.equal(done?.outcomeKind, 'determination');
  assert.equal(done?.outcomeRef, 'finding:f_1');
  assert.equal(done?.outcomeSummary, 'Already fixed by #98.');

  // The whole point: the one part that found nothing to build no longer holds the
  // decomposition — and its issue — open forever.
  assert.equal(system.store.rollUpPlanStatus(stored.id)?.status, 'complete');

  // Idempotence lives in the write, not in a read-then-check.
  assert.equal(system.store.concludePlanPart(row.id, { kind: 'report', ref: null, summary: 'again' }), null);
  system.store.close();
});

test('an amendment re-declaring a concluded part leaves what it produced alone', () => {
  const { system } = systemWithParts();
  const stored = system.store.upsertPlan({ originRef: 'issue:12', title: 'T', status: 'active', reason: 'r' });
  const declare = (expectedKind: 'code' | 'report' | null) =>
    system.store.upsertPlanParts(stored.id, [
      {
        slug: 'probe',
        seq: 1,
        title: 'Investigate',
        scope: 'src/',
        dependsOn: [],
        rationale: null,
        acceptance: null,
        expectedKind,
      },
    ]);
  declare('report');
  const row = system.store.listPlanParts(stored.id)[0]!;
  system.store.updatePlanPart(row.id, { status: 'dispatched' });
  system.store.concludePlanPart(row.id, { kind: 'report', ref: null, summary: 'Findings in docs/perf.md' });

  declare('code'); // the declaration changes; the outcome is progress and must not
  const after = system.store.listPlanParts(stored.id)[0]!;
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
      outcomeKind: 'report',
      outcomeSummary: 'Findings in docs/perf.md',
    }),
  ];
  const body = renderPlanComment(plan({ status: 'complete' }), parts);
  assert.match(body, /all 2 parts finished/);
  assert.match(body, /Write it up.*report.*Findings in docs\/perf\.md/);
  assert.doesNotMatch(body, /Write it up.*merged/);

  // Surfaced, never validated: a part planned as code that turned out to be a
  // duplicate must still be able to close truthfully.
  const mismatched = renderPlanComment(plan({ status: 'complete' }), [
    part('a', 1, {
      title: 'Build it',
      status: 'concluded',
      expectedKind: 'code',
      outcomeKind: 'determination',
      outcomeSummary: 'Already fixed by #98',
    }),
  ]);
  assert.match(mismatched, /planned as code/);
});
