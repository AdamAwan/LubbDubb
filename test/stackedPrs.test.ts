import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { basePrOf, inheritedCiFailure, prHealth } from '../src/prHealth.js';
import { DEFAULT_PLANNING, resolvePlanRoute, plannerVerdict } from '../src/plans/planning.js';
import { currentPlanSummary, ingestedPlanStatus, partsToRetire, planProgress } from '../src/plans/parts.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Decision, Issue, Plan, PlanPart, PullRequest, WorldSnapshot } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

const enabled = { ...DEFAULT_PLANNING, enabled: true };

function pr(number: number, branch: string, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch,
    ciStatus: 'passing',
    baseBranch: 'main',
    unresolvedComments: [],
    ...over,
  };
}

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
    ...over,
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
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
    ...over,
  };
}

function part(slug: string, seq: number, over: Partial<PlanPart> = {}): PlanPart {
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
    ...over,
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
    recentDecisions: [],
    ...extra,
  };
}

// -- CI attribution, as pure predicates --------------------------------------

test('the base PR of a stack is resolved from the world, not from a plan', () => {
  const bottom = pr(40, 'issue/12/schema');
  const middle = pr(41, 'issue/12/api', { baseBranch: 'issue/12/schema' });
  const prs = [bottom, middle];
  assert.equal(basePrOf(middle, prs)?.number, 40);
  // A PR on the integration branch has no base PR, and neither does one whose
  // base the provider never reported.
  assert.equal(basePrOf(bottom, prs), null);
  assert.equal(basePrOf(pr(42, 'x', { baseBranch: undefined }), prs), null);
  // A merged base is not a base worth attributing to: its commits are in the
  // integration branch and the provider retargets its children.
  assert.equal(basePrOf(middle, [{ ...bottom, merged: true }, middle]), null);
});

test('a red PR under a red base is inheriting; the bottom of the stack owns the failure', () => {
  const bottom = pr(40, 'issue/12/schema', { ciStatus: 'failing' });
  const middle = pr(41, 'issue/12/api', { baseBranch: 'issue/12/schema', ciStatus: 'failing' });
  const top = pr(42, 'issue/12/ui', { baseBranch: 'issue/12/api', ciStatus: 'failing' });
  const prs = [bottom, middle, top];
  assert.equal(inheritedCiFailure(bottom, prs), null, 'the bottom is where the failure actually is');
  assert.equal(inheritedCiFailure(middle, prs)?.number, 40);
  assert.equal(inheritedCiFailure(top, prs)?.number, 41);
  // A green PR inherits nothing, whatever is underneath it.
  assert.equal(inheritedCiFailure(pr(43, 'z', { baseBranch: 'issue/12/schema' }), prs), null);
});

test('an Optional failure on the base is attributed, so no agent lands on the child', () => {
  // A non-blocking check runs the base's commits exactly as a required one does,
  // so it propagates up the stack the same way. Attribution reads
  // `ciNeedsAttention` rather than the aggregate for precisely this: otherwise
  // one red format check at the bottom puts an agent on every PR above it, each
  // of them unable to fix anything.
  const optional = [{ name: 'Typescript Code Formatter Validation', status: 'failing' as const, blocking: false }];
  const base = pr(40, 'part-one', { ciStatus: 'passing', ciChecks: optional });
  const child = pr(41, 'part-two', { baseBranch: 'part-one', ciStatus: 'passing', ciChecks: optional });
  assert.equal(inheritedCiFailure(child, [base, child])?.number, 40);
  assert.equal(inheritedCiFailure(base, [base, child]), null, 'the base owns its own failure');
});

test('attribution walks past a base whose own CI has not reported yet', () => {
  // The middle PR is still building. Without the walk its `pending` would read as
  // "the failure above is yours", and an agent would be sent to fix the bottom
  // PR's bug on the top PR's branch.
  const prs = [
    pr(40, 'a', { ciStatus: 'failing' }),
    pr(41, 'b', { baseBranch: 'a', ciStatus: 'pending' }),
    pr(42, 'c', { baseBranch: 'b', ciStatus: 'failing' }),
  ];
  assert.equal(inheritedCiFailure(prs[2]!, prs)?.number, 40);
});

test('a base cycle the provider reports cannot spin the walk', () => {
  const prs = [pr(40, 'a', { baseBranch: 'b', ciStatus: 'failing' }), pr(41, 'b', { baseBranch: 'a' })];
  assert.equal(inheritedCiFailure(prs[0]!, prs), null);
});

test('health names the PR a failure was inherited from', () => {
  const bottom = pr(40, 'a', { ciStatus: 'failing' });
  const top = pr(41, 'b', { baseBranch: 'a', ciStatus: 'failing' });
  assert.deepEqual(prHealth(top, [bottom, top]).reasons, ['CI failing on base PR #40']);
  // Without stack context (and for the bottom of the stack) it reads as it always did.
  assert.deepEqual(prHealth(top).reasons, ['CI failing']);
  assert.deepEqual(prHealth(bottom, [bottom, top]).reasons, ['CI failing']);
});

// -- CI attribution, in the dispatcher ---------------------------------------

test('rule `pr-ci-failing` fires on the bottom of a red stack and is suppressed above it', async () => {
  const prs = [
    pr(40, 'issue/12/schema', { ciStatus: 'failing' }),
    pr(41, 'issue/12/api', { baseBranch: 'issue/12/schema', ciStatus: 'failing' }),
    pr(42, 'issue/12/ui', { baseBranch: 'issue/12/api', ciStatus: 'failing' }),
  ];
  const result = await new RuleDispatcher().decide({ ...context([]), world: world([], prs) });
  const dispatched = result.actions
    .filter((a) => a.rule === 'pr-ci-failing')
    .map((a) => (a.type === 'dispatch_code_agent' ? a.branch : ''));
  assert.deepEqual(dispatched, ['issue/12/schema'], 'one agent, on the branch whose code is actually broken');
});

test('an ignored PR still counts as the base its children inherit from', async () => {
  // The operator took the watch tag off the bottom PR, so the harness hides it from
  // the dispatch world. If attribution only looked at that filtered view, the
  // child's inherited failure would read as its own and get an agent it cannot use.
  const bottom = pr(40, 'issue/12/schema', { ciStatus: 'failing', labels: [] });
  const child = pr(41, 'issue/12/api', { baseBranch: 'issue/12/schema', ciStatus: 'failing' });
  const result = await new RuleDispatcher().decide({
    ...context([], { unwatchedPrs: [bottom] }),
    world: world([], [child]),
  });
  assert.deepEqual(
    result.actions.map((a) => a.rule),
    ['idle'],
  );
});

test('suppressing CI does not suppress restacking — a stack keeps following its parent', async () => {
  // Part 1 pushed, so part 2 went behind *and* red with part 1's failure. The CI
  // rule is held, but rule `pr-base-update` must still fire: without it the stack stops
  // restacking the moment its parent goes red, which is exactly when it moves.
  const prs = [
    pr(40, 'issue/12/schema', { ciStatus: 'failing' }),
    pr(41, 'issue/12/api', {
      baseBranch: 'issue/12/schema',
      ciStatus: 'failing',
      mergeableState: 'behind',
    }),
  ];
  const result = await new RuleDispatcher().decide({ ...context([]), world: world([], prs) });
  // The rung behind its parent is restacked without an agent (issue #332); the
  // red bottom of the stack still gets one.
  assert.deepEqual(
    result.actions.map((a) => [a.rule, a.type]),
    [
      ['pr-base-update', 'update_pr_branch'],
      ['pr-ci-failing', 'dispatch_code_agent'],
    ],
  );
  const restack = result.actions.find((a) => a.type === 'update_pr_branch');
  assert.ok(restack && restack.type === 'update_pr_branch');
  assert.equal(restack.prNumber, 41);
  assert.equal(restack.base, 'issue/12/schema', 'the parent branch, not the integration branch');
});

test('a conflict on an inheriting PR is still notified to its running agent', async () => {
  // The notify path is fed by the same concern list the dispatch path is, so a
  // suppressed CI concern must not take the surviving concerns down with it.
  const prs = [
    pr(40, 'issue/12/schema', { ciStatus: 'failing' }),
    pr(41, 'issue/12/api', { baseBranch: 'issue/12/schema', ciStatus: 'failing', mergeableState: 'dirty' }),
  ];
  const result = await new RuleDispatcher().decide({
    ...context([], {
      tasks: [task('t1', 'issue/12/api', 'issue:12:part:api')],
      agents: [{ id: 'a1', taskId: 't1', status: 'running' } as DispatchContext['agents'][number]],
    }),
    world: world([], prs),
  });
  const note = result.actions.find((a) => a.type === 'respond_to_agent');
  assert.ok(note && note.type === 'respond_to_agent');
  assert.match(note.response, /base branch issue\/12\/schema now conflicts/);
  assert.doesNotMatch(note.response, /CI is now failing/, "the child is not told to fix its parent's build");
});

// -- the concurrency cap stops being silent ----------------------------------

test('a part held by the per-plan cap is queued as `capped`, not skipped', async () => {
  const dispatcher = new RuleDispatcher({ priorityLabels: {}, defaultPriority: 0 }, {}, undefined, 'main', {
    ...enabled,
    maxConcurrentPartsPerIssue: 2,
  });
  const parts = [part('a', 1), part('b', 2), part('c', 3)];
  const result = await dispatcher.decide(context([issue(12)], { plans: [plan()], planParts: parts }));

  const queue = (result.upcoming ?? []).filter((q) => q.rule === 'plan-part');
  assert.deepEqual(
    queue.map((q) => [q.origin, q.status]),
    [
      ['issue:12:part:a', 'dispatching'],
      ['issue:12:part:b', 'dispatching'],
      ['issue:12:part:c', 'capped'],
    ],
    'the third part is visible and explained, rather than vanishing',
  );
  assert.match(queue[2]!.reason, /2-part concurrency cap/);
  // Visible is not dispatchable: headroom is 5, so only the cap is holding it.
  assert.deepEqual(
    result.actions.filter((a) => a.rule === 'plan-part').map((a) => (a.type === 'dispatch_code_agent' ? a.branch : '')),
    ['issue/12/a', 'issue/12/b'],
  );
});

// -- replan ------------------------------------------------------------------

test('an amended plan retires what it dropped, but never what has work in the world', () => {
  const existing = [
    part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' }),
    part('b', 2, { status: 'in_review', prNumber: 41, branch: 'issue/12/b' }),
    part('c', 3, { status: 'ready' }),
    part('d', 4, { status: 'pending' }),
  ];
  // The amendment keeps only "a" and "c".
  const retired = partsToRetire(existing, ['a', 'c']);
  assert.deepEqual(
    retired.map((p) => p.slug),
    ['d'],
    'b has an open PR — un-declaring it does not withdraw it',
  );
  // Already-retired rows are not retired twice, and a re-declared part comes back.
  assert.deepEqual(partsToRetire([part('e', 5, { status: 'retired' })], []), []);
});

test('an amendment lands on the same status whatever it does to the part count', () => {
  // What an amendment does to work already in flight is `partsToRetire`'s job
  // (above), and it is a question about *work*, not about shape. The status write
  // asks nothing else — there is no arm here for a plan collapsing to one part,
  // because a plan of one part is a plan.
  assert.equal(ingestedPlanStatus(), 'active');
  assert.equal(ingestedPlanStatus(true), 'awaiting_approval');
});

test('retired parts drop out of the progress count but stay in the graph', () => {
  const parts = [
    part('a', 1, { status: 'merged' }),
    part('b', 2, { status: 'ready' }),
    part('c', 3, { status: 'retired' }),
  ];
  assert.deepEqual(planProgress(parts), { settled: 1, total: 2 });
});

test('a replan carries the current plan into the prompt, slugs included', async () => {
  const parts = [
    part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' }),
    part('b', 2, { status: 'ready', dependsOn: ['a'] }),
  ];
  const dispatcher = new RuleDispatcher({ priorityLabels: {}, defaultPriority: 0 }, {}, undefined, 'main', enabled);
  const result = await dispatcher.decide(
    context([issue(12)], { plans: [plan({ status: 'planning' })], planParts: parts }),
  );
  const planner = result.actions.find((a) => a.rule === 'issue-plan');
  assert.ok(planner && planner.type === 'dispatch_code_agent');
  assert.equal(planner.branch, 'plan/issue/12', 'the planner keeps its own branch namespace');
  assert.match(planner.prompt, /Amend the existing plan/);
  assert.match(planner.prompt, /"a": The a part \[merged, PR #40\]/);
  assert.match(planner.prompt, /"b": The b part \[ready, no branch yet, stacks on "a"\]/);
  // The state summary itself is pure and directly testable.
  assert.match(currentPlanSummary(plan({ status: 'planning' }), parts), /It was split because: Schema first\./);
});

test('a replan is not throttled by the planner that produced the plan it is amending', () => {
  // The original planner ran two minutes ago; the cooldown is fifteen. Without a
  // window that starts at the replan request, the button would appear to do nothing.
  const attempt: Decision = {
    id: 'd1',
    cycleId: 'c1',
    action: {
      type: 'dispatch_code_agent',
      originRef: 'issue:12:plan',
      reason: 'plan it',
    } as unknown as Decision['action'],
    outcome: 'executed',
    detail: '',
    rule: 'issue-plan',
    admission: null,
    createdAt: '2026-07-25T11:58:00.000Z',
  };
  const now = '2026-07-25T12:00:00.000Z';
  const requested = plan({ status: 'planning', updatedAt: '2026-07-25T11:59:00.000Z' });
  assert.equal(plannerVerdict(12, requested, now, [attempt], DEFAULT_COOLDOWN).kind, 'dispatch');
  // A first-time planner (no plan row) still gets the full throttle.
  assert.equal(plannerVerdict(12, null, now, [attempt], DEFAULT_COOLDOWN).kind, 'cooldown');
});

test('an attempt stamped in the same millisecond as the replan request is the *previous* planner’s', () => {
  // The two writes are ordered by construction: the dispatch decision is recorded
  // by the cycle that ran *before* the operator asked, and `/replan` moves the plan
  // afterwards. A millisecond clock can still stamp them identically, and reading
  // that tie as "this replan already had an attempt" throttles the button for
  // fifteen minutes — the exact failure the narrowed window exists to prevent.
  const at = '2026-07-25T11:59:00.000Z';
  const attempt: Decision = {
    id: 'd1',
    cycleId: 'c1',
    action: {
      type: 'dispatch_code_agent',
      originRef: 'issue:12:plan',
      reason: 'plan it',
    } as unknown as Decision['action'],
    outcome: 'executed',
    detail: '',
    rule: 'issue-plan',
    admission: null,
    createdAt: at,
  };
  const requested = plan({ status: 'planning', updatedAt: at });
  assert.equal(plannerVerdict(12, requested, at, [attempt], DEFAULT_COOLDOWN).kind, 'dispatch');
});

test('a replan that spends its attempts falls back to the existing parts, never to unplanned', () => {
  const spent = { kind: 'hold' } as const;
  // Failing open here would point rule `issue-pickup` at the flat `issue/12`
  // branch, which git cannot create beside the existing `issue/12/<slug>` refs.
  assert.deepEqual(resolvePlanRoute({ plan: plan({ status: 'planning' }), verdict: spent, existingParts: 2 }), {
    route: 'parts',
  });
  // With nothing to fall back to, the original fail-open still applies.
  assert.deepEqual(resolvePlanRoute({ plan: null, verdict: spent }), { route: 'unplanned' });
});

test('a complete plan says how to get out of it, rather than reading as still in flight', () => {
  const parts = [part('a', 1, { status: 'merged' }), part('b', 2, { status: 'merged' })];
  const ctx: IssuePickupContext = {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-25T12:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    openPrs: [],
    plans: [plan({ status: 'complete' })],
    planParts: parts,
    headroom: 5,
    paused: false,
  };
  const verdict = issuePickupStatus(issue(12), ctx);
  assert.equal(verdict.status, 'planning');
  assert.match(verdict.reasons[0]!, /plan complete — all 2 parts finished; close the issue or replan/);
  // And replan really is the way out: the same plan back in `planning` owes a planner.
  assert.equal(
    resolvePlanRoute({
      plan: plan({ status: 'planning' }),
      verdict: { kind: 'dispatch' },
      existingParts: 2,
    }).route,
    'planning',
  );
});

// -- end to end --------------------------------------------------------------

function task(id: string, branch: string, originRef: string): DispatchContext['tasks'][number] {
  return {
    id,
    kind: 'code',
    title: 't',
    prompt: 'p',
    branch,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function systemWithPlans(): { system: System; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
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

test('the plan graph reaches the cockpit, and replan sends it back to a planner', async () => {
  const { system } = systemWithPlans();
  const { app } = await buildApp(system);
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
      touches: [],
      size: null,
      expectedKind: null,
    },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);

  // The graph is in the snapshot — until now it existed only in the database, and
  // the per-issue chip's "n/m parts done" was all a human could see.
  const snapshot = await buildStateSnapshot(system);
  assert.deepEqual(
    snapshot.planParts.map((p) => [p.slug, p.status]),
    [
      ['schema', 'pending'],
      ['api', 'pending'],
    ],
  );
  assert.equal(snapshot.plans[0]?.originRef, 'issue:12');

  const replanned = await app.inject({ method: 'POST', url: `/api/plans/${stored.id}/replan` });
  assert.equal(replanned.statusCode, 200);
  assert.equal(system.store.getPlanByOrigin('issue:12')?.status, 'planning');
  // Nothing was torn down: the parts are exactly as they were, so a replan that
  // never lands leaves the issue where it was rather than parking it.
  assert.deepEqual(
    system.store.listPlanParts(stored.id).map((p) => p.slug),
    ['schema', 'api'],
  );
  // And the cycle the endpoint kicked put a planner on the plan branch.
  const planner = system.store.listTasks().find((t) => t.originRef === 'issue:12:plan');
  assert.equal(planner?.branch, 'plan/issue/12');
  assert.match(planner!.prompt, /Amend the existing plan/);
  assert.match(planner!.prompt, /"schema": Schema/);

  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/replan' })).statusCode, 404);
  await app.close();
  system.store.close();
});

test("a part's stale stored base is harmless, because `ensure` is reuse-first", async () => {
  // When part 1 merges, the provider retargets part 2's PR onto the default
  // branch, and the store's idea of part 2's base goes stale. It never matters:
  // `ensure` hands back an existing branch untouched and ignores `base` entirely,
  // so a second dispatch onto a live part cannot move it out from under its agent.
  const repoRoot = gitRepo();
  const worktrees = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  const manager = new WorktreeManager(repoRoot, worktrees, { size: 4, held: () => false });

  execFileSync('git', ['branch', 'issue/12/schema'], { cwd: repoRoot });
  const first = await manager.ensure('issue/12/api', 'issue/12/schema');
  const parentSha = execFileSync('git', ['rev-parse', 'issue/12/api'], { cwd: repoRoot, encoding: 'utf8' }).trim();

  // Same branch, a *different* base — the stale-base case. Reuse wins.
  const second = await manager.ensure('issue/12/api', 'main');
  assert.equal(second, first);
  assert.equal(
    execFileSync('git', ['rev-parse', 'issue/12/api'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    parentSha,
  );

  // An unresolvable base still throws rather than silently forking off HEAD —
  // the property the parameter exists for, unchanged by the above.
  await assert.rejects(() => manager.ensure('issue/12/ui', 'no/such/branch'), /resolves to no commit/);
});
